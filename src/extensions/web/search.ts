/**
 * webSearch tool — Exa MCP API, with optional Tavily merge.
 *
 * The default provider calls the Exa MCP endpoint (public, no API key needed)
 * via JSON-RPC 2.0. Exa returns clean, semantically-ranked results with
 * title/URL/highlights.
 *
 * When `TAVILY_API_KEY` is available (from settings.json or environment),
 * the default mode is **hybrid**: Exa + Tavily are queried in parallel and
 * results are merged with URL-based dedup, giving broader coverage.
 *
 * Set `SRCODE_SEARCH_PROVIDER=exa` or `=tavily` to force a single provider.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchInput {
  query: string;
  max_results?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

export interface SearchOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  /** Test override of the env. */
  env?: { provider?: string; tavilyKey?: string };
}

interface ExaTextContent {
  type?: string;
  text?: string;
}

interface ExaToolResult {
  content: ExaTextContent[];
}

const DEFAULT_MAX = 10;
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

export async function webSearch(input: SearchInput, opts: SearchOptions = {}): Promise<SearchResult[]> {
  const env = opts.env ?? {
    provider: process.env.SRCODE_SEARCH_PROVIDER,
    tavilyKey: process.env.TAVILY_API_KEY,
  };
  const max = clamp(input.max_results ?? DEFAULT_MAX, 1, 25);
  const provider = env.provider?.toLowerCase();

  let raw: SearchResult[];
  if (provider === "tavily" && env.tavilyKey) {
    raw = await tavilySearch(input.query, max, env.tavilyKey, opts);
  } else if (provider === "exa" || !env.tavilyKey) {
    raw = await exaSearch(input.query, max, opts);
  } else {
    // Hybrid: both Exa and Tavily in parallel, merge & dedup by URL
    raw = await hybridSearch(input.query, max, env.tavilyKey, opts);
  }

  return filterDomains(raw, input.allowed_domains, input.blocked_domains).slice(0, max);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ─── Exa MCP ────────────────────────────────────────────────────────────────

const EXA_FETCH_UA = "srcode/0.2";

async function exaSearch(query: string, max: number, opts: SearchOptions): Promise<SearchResult[]> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const response = await fetcher(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": EXA_FETCH_UA,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query, numResults: max },
      },
    }),
    signal: opts.signal,
  });

  if (!response.ok) {
    throw new Error(`Exa search failed: ${response.status} ${response.statusText}`);
  }

  const raw = await response.text();
  const parsed = parseExaResponse(raw);

  if (parsed.error) {
    throw new Error(`Exa search error [${parsed.error.code ?? "?"}]: ${parsed.error.message ?? "unknown"}`);
  }

  if (!isExaToolResult(parsed.result)) {
    throw new Error("Exa search: unexpected response structure (missing result.content)");
  }

  // content is an array of { type: "text", text: "..." }
  const text = parsed.result.content
    .filter((c): c is ExaTextContent & { text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");

  return parseExaTextResults(text);
}

function isExaToolResult(value: unknown): value is ExaToolResult {
  if (typeof value !== "object" || value === null || !("content" in value)) return false;
  const content = (value as { content: unknown }).content;
  return Array.isArray(content);
}

/**
 * Parse an Exa MCP response, handling both plain JSON and SSE-wrapped formats.
 */
export function parseExaResponse(raw: string): { result?: unknown; error?: { code?: number; message?: string } } {
  // Try plain JSON first.
  try {
    return JSON.parse(raw) as { result?: unknown; error?: { code?: number; message?: string } };
  } catch {
    // SSE format — look for `data: <json>` lines.
    for (const line of raw.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          return JSON.parse(line.slice(6)) as { result?: unknown; error?: { code?: number; message?: string } };
        } catch {
          // Keep trying other data: lines.
        }
      }
    }
    throw new Error("Exa response is neither plain JSON nor SSE format");
  }
}

/**
 * Parse Exa's formatted text results into structured SearchResult[].
 *
 * Exa returns blocks like:
 *   Title: ...
 *   URL: ...
 *   Published: ...
 *   Author: ...
 *   Highlights:
 *   > ...
 *   ---
 */
export function parseExaTextResults(text: string): SearchResult[] {
  const results: SearchResult[] = [];
  // Split on the separator line (possibly with surrounding whitespace).
  const blocks = text.split(/\n?---\n?/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const title = extractField(trimmed, "Title");
    const url = extractField(trimmed, "URL");
    if (!title || !url) continue;

    // Snippet: extract the Highlights section (everything after "Highlights:").
    let snippet = "";
    const hlMatch = trimmed.match(/^Highlights:\n([\s\S]*)$/m);
    if (hlMatch) {
      snippet = hlMatch[1]!
        .replace(/^>\s*/gm, "")           // Remove blockquote markers
        .replace(/\s*\n\s*/g, " ")         // Collapse newlines within
        .replace(/\.\.\.$/, "")            // Trim trailing ellipsis
        .trim();
    }

    results.push({
      title: title.trim(),
      url: url.trim(),
      snippet,
    });
  }

  return results;
}

/** Extract the value of a named field (e.g. "Title: ...") from a block of text. */
function extractField(text: string, field: string): string | undefined {
  const re = new RegExp(`^${field}:\\s*(.+)$`, "m");
  const m = text.match(re);
  return m ? m[1]!.trim() : undefined;
}

// ─── Hybrid search ─────────────────────────────────────────────────────────

/**
 * Query Exa and Tavily in parallel, then merge results with URL-based
 * dedup. If one provider fails, the other's results still come through.
 */
async function hybridSearch(
  query: string,
  max: number,
  tavilyKey: string,
  opts: SearchOptions,
): Promise<SearchResult[]> {
  const [exaResults, tavilyResults] = await Promise.all([
    exaSearch(query, max, opts).catch(() => [] as SearchResult[]),
    tavilySearch(query, max, tavilyKey, opts).catch(() => [] as SearchResult[]),
  ]);

  // Merge with URL dedup, preserving interleaved ordering.
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const r of [...exaResults, ...tavilyResults]) {
    const key = r.url.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(r);
    }
  }
  return merged;
}

// ─── Tavily fallback ────────────────────────────────────────────────────────

interface TavilyAPIResult {
  title?: string;
  url?: string;
  content?: string;
}

async function tavilySearch(
  query: string,
  max: number,
  apiKey: string,
  opts: SearchOptions,
): Promise<SearchResult[]> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const response = await fetcher("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: max,
      search_depth: "basic",
    }),
    signal: opts.signal,
  });
  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { results?: TavilyAPIResult[] };
  return (data.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: (r.content ?? "").replace(/\s+/g, " ").trim(),
  }));
}

// ─── Shared domain filtering ───────────────────────────────────────────────

export function filterDomains(
  results: SearchResult[],
  allowed: string[] | undefined,
  blocked: string[] | undefined,
): SearchResult[] {
  if ((!allowed || allowed.length === 0) && (!blocked || blocked.length === 0)) return results;
  return results.filter((r) => {
    const host = safeHostname(r.url);
    if (!host) return false;
    if (allowed && allowed.length > 0 && !allowed.some((d) => hostMatches(host, d))) return false;
    if (blocked && blocked.length > 0 && blocked.some((d) => hostMatches(host, d))) return false;
    return true;
  });
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase().replace(/^\./, "");
  return host === p || host.endsWith("." + p);
}

// ─── Formatting ─────────────────────────────────────────────────────────────

export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No results for "${query}".`;
  }
  const lines: string[] = [`Search: ${query}`, `Results: ${results.length}`, ""];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}
