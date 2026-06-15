/**
 * webSearch tool — DuckDuckGo HTML scrape, with optional Tavily fallback.
 *
 * The default provider hits the no-JS DDG endpoint and parses `.result__a` /
 * `.result__snippet`. It's fragile but free and needs no API key. When
 * `SRCODE_SEARCH_PROVIDER=tavily` and `TAVILY_API_KEY` are both set we POST
 * to api.tavily.com instead.
 */
import { HTMLElement, parse as parseHTML } from "node-html-parser";

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

const DEFAULT_MAX = 10;

export async function webSearch(input: SearchInput, opts: SearchOptions = {}): Promise<SearchResult[]> {
  const env = opts.env ?? {
    provider: process.env.SRCODE_SEARCH_PROVIDER,
    tavilyKey: process.env.TAVILY_API_KEY,
  };
  const max = clamp(input.max_results ?? DEFAULT_MAX, 1, 25);

  let raw: SearchResult[];
  if (env.provider?.toLowerCase() === "tavily" && env.tavilyKey) {
    raw = await tavilySearch(input.query, max, env.tavilyKey, opts);
  } else {
    raw = await duckduckgoSearch(input.query, opts);
  }

  return filterDomains(raw, input.allowed_domains, input.blocked_domains).slice(0, max);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

async function duckduckgoSearch(query: string, opts: SearchOptions): Promise<SearchResult[]> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetcher(url, {
    headers: {
      "User-Agent": "srcode/0.2",
      Accept: "text/html, */*",
    },
    signal: opts.signal,
  });
  const body = await response.text();
  return parseDuckDuckGoHtml(body);
}

/**
 * Pull `.result` blocks out of a DDG HTML page. Exported for tests.
 */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const root = parseHTML(html);
  const results: SearchResult[] = [];
  // DDG wraps each hit in `.result` with a `.result__a` anchor and
  // `.result__snippet` body. Some skins use `.result__title > a`.
  const blocks = root.querySelectorAll(".result, .results_links");
  for (const block of blocks) {
    const anchor = block.querySelector(".result__a") as HTMLElement | null;
    if (!anchor) continue;
    const rawHref = anchor.getAttribute("href") ?? "";
    const url = unwrapDuckDuckGoUrl(rawHref);
    if (!url) continue;
    const snippet = block.querySelector(".result__snippet")?.textContent?.trim() ?? "";
    results.push({
      title: anchor.textContent.trim(),
      url,
      snippet: snippet.replace(/\s+/g, " "),
    });
  }
  return results;
}

/**
 * DDG wraps the real URL in `/l/?uddg=<encoded>&...`. Unwrap to the original
 * destination so domain filters and the LLM see the real host.
 */
function unwrapDuckDuckGoUrl(href: string): string | undefined {
  if (!href) return undefined;
  let url = href;
  if (url.startsWith("//")) url = "https:" + url;
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    if (/duckduckgo\.com$/.test(parsed.hostname) && parsed.pathname.startsWith("/l/")) {
      const target = parsed.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

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
