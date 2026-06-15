/**
 * webFetch tool — fetch a URL and convert HTML → simplified Markdown.
 *
 * Scope is intentionally narrow:
 *   - Bun.fetch with a fixed UA string (HTTP→HTTPS upgrade).
 *   - HTML body parsed with node-html-parser; we keep h1-h6 / p / li / code /
 *     pre / a / blockquote / strong / em and strip script/style/nav/footer.
 *   - Output truncated to 8 KiB.
 *   - 15-min LRU cache (50 entries) keyed on the original URL.
 *   - The user-provided `prompt` is prepended to the result so the calling
 *     model can grep for the bit it wanted.
 */
import { HTMLElement, Node, NodeType, parse as parseHTML } from "node-html-parser";
import { LRU } from "./cache.ts";

export const FETCH_CACHE_TTL_MS = 15 * 60 * 1000;
export const FETCH_CACHE_MAX = 50;
export const FETCH_MAX_OUTPUT_BYTES = 8 * 1024;
const FETCH_UA = "srcode/0.2";

export interface FetchedPage {
  url: string;
  status: number;
  statusText: string;
  contentType: string;
  markdown: string;
  truncated: boolean;
}

const cache = new LRU<string, FetchedPage>({
  max: FETCH_CACHE_MAX,
  ttlMs: FETCH_CACHE_TTL_MS,
});

export function clearWebFetchCache(): void {
  cache.clear();
}

export function webFetchCacheSize(): number {
  return cache.size;
}

const DROP_TAGS = new Set([
  "script",
  "style",
  "nav",
  "footer",
  "noscript",
  "iframe",
  "svg",
  "form",
  "header",
]);

const KEEP_BLOCK = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "blockquote", "li", "pre"]);

/**
 * Walk the parsed DOM and emit a small, readable Markdown subset.
 *
 * Not a full HTML→MD conversion (turndown is ~1MB) — just enough that the
 * model can read content. Block elements get their own line; links become
 * `[text](href)`; code/pre wrap with backticks/fences.
 */
export function htmlToMarkdown(html: string): string {
  const root = parseHTML(html, {
    blockTextElements: { script: false, style: false, pre: true },
    comment: false,
  });
  const out: string[] = [];
  walk(root, out);
  // Collapse runs of blank lines and trim.
  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walk(node: Node, out: string[]): void {
  if (node.nodeType === NodeType.TEXT_NODE) {
    out.push(escapeText(node.rawText));
    return;
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) {
    // Comments / doctype — ignore.
    if (node.childNodes) for (const c of node.childNodes) walk(c, out);
    return;
  }

  const el = node as HTMLElement;
  const tag = (el.rawTagName || "").toLowerCase();

  if (DROP_TAGS.has(tag)) return;

  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(tag[1]);
      out.push("\n\n", "#".repeat(level), " ");
      for (const c of el.childNodes) walk(c, out);
      out.push("\n");
      return;
    }
    case "p":
      out.push("\n\n");
      for (const c of el.childNodes) walk(c, out);
      out.push("\n");
      return;
    case "br":
      out.push("\n");
      return;
    case "hr":
      out.push("\n\n---\n\n");
      return;
    case "li":
      out.push("\n- ");
      for (const c of el.childNodes) walk(c, out);
      return;
    case "ul":
    case "ol":
      out.push("\n");
      for (const c of el.childNodes) walk(c, out);
      out.push("\n");
      return;
    case "blockquote":
      out.push("\n\n> ");
      for (const c of el.childNodes) walk(c, out);
      out.push("\n");
      return;
    case "pre": {
      out.push("\n\n```\n", el.textContent ?? "", "\n```\n");
      return;
    }
    case "code":
      out.push("`", el.textContent ?? "", "`");
      return;
    case "a": {
      const href = el.getAttribute("href") ?? "";
      const text: string[] = [];
      for (const c of el.childNodes) walk(c, text);
      const flat = text.join("").trim();
      if (href && flat) out.push("[", flat, "](", href, ")");
      else if (flat) out.push(flat);
      else if (href) out.push(href);
      return;
    }
    case "strong":
    case "b":
      out.push("**");
      for (const c of el.childNodes) walk(c, out);
      out.push("**");
      return;
    case "em":
    case "i":
      out.push("*");
      for (const c of el.childNodes) walk(c, out);
      out.push("*");
      return;
    case "img": {
      const alt = el.getAttribute("alt") ?? "";
      const src = el.getAttribute("src") ?? "";
      if (src) out.push("![", alt, "](", src, ")");
      return;
    }
    default:
      // Unknown / generic container — recurse and drop the wrapper.
      for (const c of el.childNodes) walk(c, out);
      // Block-ish tags get a separator so paragraphs don't smash together.
      if (KEEP_BLOCK.has(tag) || tag === "div" || tag === "section" || tag === "article") {
        out.push("\n");
      }
  }
}

function escapeText(text: string): string {
  // node-html-parser already gives us decoded text; we just collapse the
  // runs of whitespace HTML treats as one space.
  return text.replace(/\s+/g, " ");
}

function truncateBytes(text: string, maxBytes: number): { out: string; truncated: boolean } {
  // UTF-8 byte length without re-encoding the whole thing.
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  if (bytes.length <= maxBytes) return { out: text, truncated: false };
  const dec = new TextDecoder("utf-8");
  // `fatal:false` would silently U+FFFD a split codepoint; instead nibble back
  // until we land on a complete codepoint boundary.
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  const out = dec.decode(bytes.subarray(0, cut));
  return { out, truncated: true };
}

export interface WebFetchOptions {
  /** Override fetch; primarily for tests. Defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  /** When true, skip the cache lookup. Cache write still happens. */
  bypassCache?: boolean;
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal;
}

export async function fetchAndConvert(url: string, opts: WebFetchOptions = {}): Promise<FetchedPage> {
  const upgraded = upgradeUrl(url);

  if (!opts.bypassCache) {
    const hit = cache.get(upgraded);
    if (hit) return hit;
  }

  const fetcher = opts.fetcher ?? globalThis.fetch;
  const response = await fetcher(upgraded, {
    headers: { "User-Agent": FETCH_UA, Accept: "text/markdown, text/html, */*" },
    signal: opts.signal,
    redirect: "follow",
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  let markdown: string;
  if (contentType.includes("text/html") || /<html[\s>]/i.test(body.slice(0, 256))) {
    markdown = htmlToMarkdown(body);
  } else {
    markdown = body;
  }

  const { out, truncated } = truncateBytes(markdown, FETCH_MAX_OUTPUT_BYTES);

  const page: FetchedPage = {
    url: upgraded,
    status: response.status,
    statusText: response.statusText,
    contentType,
    markdown: out,
    truncated,
  };
  cache.set(upgraded, page);
  return page;
}

function upgradeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:") {
      parsed.protocol = "https:";
      return parsed.toString();
    }
  } catch {
    // Caller will see fetch reject below.
  }
  return url;
}

export function formatFetchResult(page: FetchedPage, prompt: string | undefined): string {
  const lines: string[] = [];
  lines.push(`URL: ${page.url}`);
  lines.push(`Status: ${page.status} ${page.statusText}`);
  if (page.contentType) lines.push(`Content-Type: ${page.contentType}`);
  if (prompt && prompt.trim()) lines.push(`Prompt: ${prompt.trim()}`);
  if (page.truncated) lines.push(`Truncated to ${FETCH_MAX_OUTPUT_BYTES} bytes`);
  lines.push("");
  lines.push(page.markdown);
  return lines.join("\n");
}
