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
export const FETCH_MAX_RESPONSE_BYTES = 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;
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

/** In-flight fetches keyed by normalized URL — coalesces concurrent misses. */
const inflight = new Map<string, Promise<FetchedPage>>();

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
  /** Allow localhost/private network targets. Defaults to false. */
  allowPrivateNetwork?: boolean;
}

export async function fetchAndConvert(url: string, opts: WebFetchOptions = {}): Promise<FetchedPage> {
  const upgraded = normalizeUrl(url, opts);

  if (!opts.bypassCache) {
    const hit = cache.get(upgraded);
    if (hit) return hit;
    // Coalesce concurrent misses for the same URL into one network request.
    const pending = inflight.get(upgraded);
    if (pending) return pending;
  }

  const run = (async (): Promise<FetchedPage> => {
    const fetcher = opts.fetcher ?? globalThis.fetch;
    const timeout = withTimeoutSignal(opts.signal, FETCH_TIMEOUT_MS);
    let response!: Response;
    let finalUrl = upgraded;
    let body = "";
    try {
      // Follow redirects manually so every hop is re-validated against the
      // private-network guard. `redirect: "follow"` would let a public URL
      // bounce to localhost / 169.254.169.254 (cloud metadata) and slip past the
      // check that only ever ran on the original URL.
      let currentUrl = upgraded;
      const MAX_REDIRECTS = 5;
      for (let hop = 0; ; hop++) {
        response = await fetcher(currentUrl, {
          headers: { "User-Agent": FETCH_UA, Accept: "text/markdown, text/html, */*" },
          signal: timeout.signal,
          redirect: "manual",
        });
        finalUrl = currentUrl;
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get("location");
        if (!location) break;
        if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects");
        // Resolve relative Location against the current URL, then re-validate.
        currentUrl = normalizeUrl(new URL(location, currentUrl).toString(), opts);
      }
      // Body download stays inside the timeout/abort scope: a stalled body must
      // not hang the tool after the headers arrived.
      body = await readResponseText(response, FETCH_MAX_RESPONSE_BYTES);
    } finally {
      timeout.cleanup();
    }

    const contentType = response.headers.get("content-type") ?? "";

    let markdown: string;
    if (contentType.includes("text/html") || /<html[\s>]/i.test(body.slice(0, 256))) {
      markdown = htmlToMarkdown(body);
    } else {
      markdown = body;
    }

    const { out, truncated } = truncateBytes(markdown, FETCH_MAX_OUTPUT_BYTES);

    const page: FetchedPage = {
      url: finalUrl,
      status: response.status,
      statusText: response.statusText,
      contentType,
      markdown: out,
      truncated,
    };
    // Error pages are not cached as successful content — a cached 404/500 would
    // be re-served to later fetches for 15 minutes.
    if (response.status < 400) {
      cache.set(upgraded, page);
    }
    return page;
  })();

  if (!opts.bypassCache) {
    inflight.set(upgraded, run);
    run.finally(() => {
      if (inflight.get(upgraded) === run) inflight.delete(upgraded);
    }).catch(() => {});
  }
  return run;
}

function normalizeUrl(url: string, opts: WebFetchOptions): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL must be absolute and valid");
  }
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  if (parsed.protocol !== "https:") throw new Error("Only https:// URLs are supported");
  if (!opts.allowPrivateNetwork && isPrivateHost(parsed.hostname)) {
    throw new Error("Refusing to fetch localhost or private network address");
  }
  return parsed.toString();
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // ULA / link-local prefixes only apply to IPv6 literals. Plain domains that
  // merely start with "fc"/"fd" (fcc.gov, fda.gov, …) are public and must
  // not be refused as private-network addresses.
  if (host.includes(":")) {
    if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
  }

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1): unwrap and
  // re-check the embedded IPv4 so mapped loopback/metadata addresses are caught.
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped) {
    const inner = mapped[1]!;
    if (inner.includes(".")) return isPrivateHost(inner);
    const hex = inner.replace(/:/g, "");
    if (/^[0-9a-f]{1,8}$/.test(hex)) {
      const n = parseInt(hex, 16);
      return isPrivateHost(`${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`);
    }
  }

  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    // Non-dotted host: normalize alternate IPv4 spellings (decimal integer
    // 2130706433, hex 0x7f000001, octal 0177.0.0.1) and re-check, so the
    // private guard can't be bypassed with a rewritten loopback address.
    const numeric = parseNumericIpv4(host);
    return numeric !== null && isPrivateHost(numeric);
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** Parse a single-component IPv4 spelling (decimal / hex / octal) into dotted form. */
function parseNumericIpv4(host: string): string | null {
  const m = /^(0[xX][0-9a-fA-F]+|\d+)$/.exec(host);
  if (!m) return null;
  const raw = m[1]!;
  let n: number;
  if (raw.startsWith("0x") || raw.startsWith("0X")) {
    n = Number.parseInt(raw, 16);
  } else if (raw.length > 1 && raw.startsWith("0")) {
    n = Number.parseInt(raw, 8);
  } else {
    n = Number.parseInt(raw, 10);
  }
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

export function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`webFetch timed out after ${timeoutMs}ms`)), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        const remaining = Math.max(0, maxBytes - (total - value.length));
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8").decode(out);
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
