/**
 * Web extension tests — cache hit, search parsing, domain filter, html→md.
 *
 * fetch() is mocked by swapping globalThis.fetch in afterEach so other suites
 * don't see our stubs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { LRU } from "../src/extensions/web/cache.ts";
import {
  clearWebFetchCache,
  fetchAndConvert,
  htmlToMarkdown,
  webFetchCacheSize,
} from "../src/extensions/web/fetch.ts";
import {
  formatWebFetchDisplay,
  formatWebSearchDisplay,
} from "../src/extensions/web/render.ts";
import {
  filterDomains,
  parseExaResponse,
  parseExaTextResults,
  webSearch,
  type SearchResult,
} from "../src/extensions/web/search.ts";

const realFetch = globalThis.fetch;
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearWebFetchCache();
});

describe("LRU", () => {
  test("evicts oldest beyond max", () => {
    const lru = new LRU<string, number>({ max: 2, ttlMs: 60_000 });
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe(2);
    expect(lru.get("c")).toBe(3);
  });

  test("expires by ttl", () => {
    let now = 1000;
    const lru = new LRU<string, number>({ max: 8, ttlMs: 100, now: () => now });
    lru.set("k", 1);
    now = 1099;
    expect(lru.get("k")).toBe(1);
    now = 1200;
    expect(lru.get("k")).toBeUndefined();
  });

  test("touch on get refreshes recency", () => {
    const lru = new LRU<string, number>({ max: 2, ttlMs: 60_000 });
    lru.set("a", 1);
    lru.set("b", 2);
    // Touch 'a' so 'b' becomes the eviction target.
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3);
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBe(1);
    expect(lru.get("c")).toBe(3);
  });
});

describe("htmlToMarkdown", () => {
  test("keeps headings, paragraphs, links, code, blockquote", () => {
    const html = `
      <html><body>
        <h1>Title</h1>
        <p>Hello <a href="https://x.test/y">world</a></p>
        <pre>code block</pre>
        <p>Inline <code>x = 1</code></p>
        <blockquote>quoted</blockquote>
        <ul><li>one</li><li>two</li></ul>
      </body></html>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("# Title");
    expect(md).toContain("[world](https://x.test/y)");
    expect(md).toContain("```");
    expect(md).toContain("code block");
    expect(md).toContain("`x = 1`");
    expect(md).toContain("> quoted");
    expect(md).toContain("- one");
    expect(md).toContain("- two");
  });

  test("drops script and style content", () => {
    const html = `<html><body>
      <script>alert("xss")</script>
      <style>body{color:red}</style>
      <p>visible</p>
    </body></html>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("visible");
    expect(md).not.toContain("alert");
    expect(md).not.toContain("color:red");
  });

  test("drops nav and footer", () => {
    const html = `<body><nav>menu link</nav><p>main body</p><footer>copyright</footer></body>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("main body");
    expect(md).not.toContain("menu link");
    expect(md).not.toContain("copyright");
  });
});

describe("fetchAndConvert", () => {
  test("hits the network once, then serves from cache", async () => {
    let calls = 0;
    globalThis.fetch = (async (_url: string) => {
      calls++;
      return new Response("<html><body><p>cached body</p></body></html>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as unknown as typeof fetch;

    const a = await fetchAndConvert("https://example.test/page");
    const b = await fetchAndConvert("https://example.test/page");
    expect(calls).toBe(1);
    expect(a.markdown).toContain("cached body");
    expect(b.markdown).toContain("cached body");
    expect(webFetchCacheSize()).toBe(1);
  });

  test("abort during body download rejects promptly (timeout scope covers body read)", async () => {
    // The injected fetcher mirrors real fetch semantics: aborting the request
    // signal errors the response body stream. If the abort listener were torn
    // down after the headers arrived (the old bug), reader.read() would hang.
    const fetcher = (async (_url: string, init?: { signal?: AbortSignal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(init.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const ac = new AbortController();
    const pending = fetchAndConvert("https://example.test/slow", {
      fetcher,
      bypassCache: true,
      signal: ac.signal,
    });
    // Headers have already been produced (fetcher body start() ran
    // synchronously) and the body read is pending; aborting now must reject
    // the in-flight body read rather than hang.
    ac.abort(new Error("user abort"));
    await expect(pending).rejects.toThrow(/abort/i);
  });

  test("upgrades http to https before fetching", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: string) => {
      seenUrl = url;
      return new Response("<p>ok</p>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    await fetchAndConvert("http://example.test/x");
    expect(seenUrl.startsWith("https://")).toBe(true);
  });

  test("public domains starting with fc/fd are not treated as private", async () => {
    globalThis.fetch = (async () => new Response("<p>ok</p>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
    const page = await fetchAndConvert("https://fcc.gov/status", { bypassCache: true });
    expect(page.status).toBe(200);
  });

  test("concurrent fetches of the same URL share one network request", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response("<p>shared</p>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const [a, b] = await Promise.all([
      fetchAndConvert("https://example.test/shared", { fetcher, bypassCache: true }),
      fetchAndConvert("https://example.test/shared", { fetcher, bypassCache: true }),
    ]);
    expect(calls).toBe(2); // bypassCache skips coalescing, one request each

    // Cold URL: the first call registers the in-flight promise synchronously;
    // the second call must coalesce into it instead of issuing another request.
    const [c, d] = await Promise.all([
      fetchAndConvert("https://example.test/coalesce", { fetcher }),
      fetchAndConvert("https://example.test/coalesce", { fetcher }),
    ]);
    expect(calls).toBe(3);
    expect(c.markdown).toBe(d.markdown);
  });

  test("alternate IPv4 spellings of loopback are refused as private", async () => {
    for (const host of ["2130706433", "0x7f000001"]) {
      await expect(
        fetchAndConvert(`https://${host}/status`, { fetcher: (async () => new Response("ok")) as unknown as typeof fetch }),
      ).rejects.toThrow(/private network/i);
    }
  });

  test("inet_aton IPv4 variants of loopback are refused as private", async () => {
    // Trailing dot, single-component shorthand, multi-component octal/hex —
    // all spellings resolvers accept, all rewrites of 127.0.0.1.
    for (const host of ["127.0.0.1.", "127.1", "127.0.1", "0177.0.0.1", "0x7f.0.0.1", "127.0.0.0x01"]) {
      await expect(
        fetchAndConvert(`https://${host}/status`, { fetcher: (async () => new Response("ok")) as unknown as typeof fetch }),
      ).rejects.toThrow(/private network/i);
    }
  });

  test("4xx/5xx responses are not cached and are flagged as errors", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("<html><body>Not Found</body></html>", {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const a = await fetchAndConvert("https://example.test/missing");
    expect(a.status).toBe(404);
    expect(a.markdown).toContain("Not Found");
    // Error pages must not populate the cache: a second fetch hits the network.
    await fetchAndConvert("https://example.test/missing");
    expect(calls).toBe(2);
  });

  test("returns the final URL after following redirects", async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seenUrls.push(url);
      if (url === "https://example.test/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "/final" },
        });
      }
      return new Response("<p>done</p>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const page = await fetchAndConvert("https://example.test/start");

    expect(seenUrls).toEqual(["https://example.test/start", "https://example.test/final"]);
    expect(page.url).toBe("https://example.test/final");
    expect(page.markdown).toContain("done");
  });

  test("rejects localhost and private network targets by default", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("should not fetch");
    }) as unknown as typeof fetch;

    await expect(fetchAndConvert("https://localhost/status")).rejects.toThrow(/private network/i);
    await expect(fetchAndConvert("https://127.0.0.1/status")).rejects.toThrow(/private network/i);
    await expect(fetchAndConvert("https://192.168.1.10/status")).rejects.toThrow(/private network/i);
    expect(calls).toBe(0);
  });

  test("rejects non-http protocols", async () => {
    await expect(fetchAndConvert("file:///etc/passwd")).rejects.toThrow(/https/i);
  });

  test("truncates output beyond 8KB and reports it", async () => {
    const big = "<p>" + "x".repeat(20_000) + "</p>";
    globalThis.fetch = (async () =>
      new Response(big, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const page = await fetchAndConvert("https://example.test/big");
    expect(page.truncated).toBe(true);
    expect(new TextEncoder().encode(page.markdown).length).toBeLessThanOrEqual(8 * 1024);
  });
});

describe("parseExaResponse", () => {
  test("parses plain JSON-RPC response", () => {
    const json = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "hello" }] },
    });
    const parsed = parseExaResponse(json);
    expect(parsed.result).toBeDefined();
    expect(parsed.error).toBeUndefined();
  });

  test("parses SSE-wrapped response", () => {
    const sse =
      "event: message\ndata: " +
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "hello" }] },
      }) +
      "\n";
    const parsed = parseExaResponse(sse);
    expect(parsed.result).toBeDefined();
  });

  test("parses multiple SSE events (takes first data: line)", () => {
    const event1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } });
    const event2 = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } });
    const sse = `event: message\ndata: ${event1}\n\nevent: message\ndata: ${event2}\n`;
    const parsed = parseExaResponse(sse);
    expect(parsed.result).toBeDefined();
  });

  test("detects JSON-RPC error", () => {
    const json = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    });
    const parsed = parseExaResponse(json);
    expect(parsed.error).toBeDefined();
    expect(parsed.error!.code).toBe(-32601);
  });

  test("throws on garbage input", () => {
    expect(() => parseExaResponse("not json")).toThrow();
  });
});

describe("parseExaTextResults", () => {
  const sample =
    "Title: First Hit\n" +
    "URL: https://example.com/a\n" +
    "Published: N/A\n" +
    "Author: N/A\n" +
    "Highlights:\n" +
    "> First snippet text here\n" +
    "...\n" +
    "---\n" +
    "Title: Second Hit\n" +
    "URL: https://other.test/page\n" +
    "Published: 2025-01-15\n" +
    "Author: Someone\n" +
    "Highlights:\n" +
    "Second snippet longer text\n" +
    "...\n" +
    "---\n" +
    "Title: Third Hit\n" +
    "URL: https://example.org/third\n" +
    "Highlights:\n" +
    "Third result description";

  test("extracts all results", () => {
    const results = parseExaTextResults(sample);
    expect(results.length).toBe(3);
  });

  test("parses title, url, and snippet correctly", () => {
    const results = parseExaTextResults(sample);
    expect(results[0]!.title).toBe("First Hit");
    expect(results[0]!.url).toBe("https://example.com/a");
    expect(results[0]!.snippet).toContain("First snippet");
    expect(results[1]!.title).toBe("Second Hit");
    expect(results[1]!.url).toBe("https://other.test/page");
    expect(results[1]!.snippet).toContain("Second snippet");
  });

  test("handles missing Highlights gracefully", () => {
    const text = "Title: No highlights\nURL: https://x.test/\nPublished: N/A\n";
    const results = parseExaTextResults(text);
    expect(results.length).toBe(1);
    expect(results[0]!.snippet).toBe("");
  });

  test("strips blockquote markers from snippet", () => {
    const text =
      "Title: Quote\nURL: https://x.test/\nHighlights:\n" +
      "> quoted line 1\n" +
      "> quoted line 2\n" +
      "...";
    const results = parseExaTextResults(text);
    expect(results[0]!.snippet).not.toContain(">");
    expect(results[0]!.snippet).toContain("quoted line 1");
    expect(results[0]!.snippet).toContain("quoted line 2");
  });

  test("skips blocks missing Title or URL", () => {
    const text =
      "Title: Only title\nURL: https://a.test/\nHighlights:\nx\n" +
      "---\n" +
      "URL: https://no-title.test/\nHighlights:\ny\n" +
      "---\n" +
      "Title: Missing url\nHighlights:\nz\n";
    const results = parseExaTextResults(text);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Only title");
  });
});

describe("filterDomains", () => {
  const sample: SearchResult[] = [
    { title: "A", url: "https://docs.example.com/a", snippet: "" },
    { title: "B", url: "https://other.test/b", snippet: "" },
    { title: "C", url: "https://example.com/c", snippet: "" },
  ];

  test("allowed list keeps only matching hosts (incl. subdomains)", () => {
    const out = filterDomains(sample, ["example.com"], undefined);
    expect(out.map((r) => r.url)).toEqual([
      "https://docs.example.com/a",
      "https://example.com/c",
    ]);
  });

  test("blocked list removes matching hosts", () => {
    const out = filterDomains(sample, undefined, ["other.test"]);
    expect(out.map((r) => r.url)).toEqual([
      "https://docs.example.com/a",
      "https://example.com/c",
    ]);
  });

  test("empty filters return input unchanged", () => {
    const out = filterDomains(sample, [], []);
    expect(out).toEqual(sample);
  });
});

describe("web tool TUI rendering", () => {
  test("webSearch collapsed display summarizes results without snippets", () => {
    const result = {
      content: [
        {
          type: "text" as const,
          text: "Search: q\nResults: 4\n\n1. A\n   https://a.test\n   long snippet body that should be hidden\n",
        },
      ],
      details: {
        count: 4,
        results: [
          { title: "A", url: "https://a.test", snippet: "long snippet body that should be hidden" },
          { title: "B", url: "https://b.test", snippet: "hidden b" },
          { title: "C", url: "https://c.test", snippet: "hidden c" },
          { title: "D", url: "https://d.test", snippet: "hidden d" },
        ],
      },
    };

    const collapsed = formatWebSearchDisplay(
      result,
      { expanded: false, isPartial: false },
      plainTheme,
      false,
      "Ctrl+O to expand",
    );
    expect(collapsed).toContain("Results: 4");
    expect(collapsed).toContain("https://a.test");
    expect(collapsed).toContain("… 1 more results");
    expect(collapsed).toContain("Ctrl+O to expand");
    expect(collapsed).not.toContain("long snippet body");

    const expanded = formatWebSearchDisplay(
      result,
      { expanded: true, isPartial: false },
      plainTheme,
      false,
      "Ctrl+O to expand",
    );
    expect(expanded).toContain("long snippet body that should be hidden");
  });

  test("webFetch collapsed display hides page body until expanded", () => {
    const result = {
      content: [
        {
          type: "text" as const,
          text: "URL: https://docs.test/page\n\n# Full page\nlarge page body should be hidden",
        },
      ],
      details: {
        status: 200,
        url: "https://docs.test/page",
        truncated: true,
        contentType: "text/html; charset=utf-8",
      },
    };

    const collapsed = formatWebFetchDisplay(
      result,
      { expanded: false, isPartial: false },
      plainTheme,
      false,
      "Ctrl+O to expand",
    );
    expect(collapsed).toContain("status 200");
    expect(collapsed).toContain("https://docs.test/page");
    expect(collapsed).toContain("truncated");
    expect(collapsed).toContain("Ctrl+O to expand");
    expect(collapsed).not.toContain("large page body");

    const expanded = formatWebFetchDisplay(
      result,
      { expanded: true, isPartial: false },
      plainTheme,
      false,
      "Ctrl+O to expand",
    );
    expect(expanded).toContain("large page body should be hidden");
  });
});

describe("webSearch end-to-end (mocked)", () => {
  const exaResponse = (text: string) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text }] },
    });

  test("Exa path, allowed_domains filter applied", async () => {
    const exaText =
      "Title: Allowed\nURL: https://allowed.test/a\nHighlights:\ngood\n" +
      "---\n" +
      "Title: Denied\nURL: https://denied.test/b\nHighlights:\nbad\n";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).params.name).toBe("web_search_exa");
      return new Response(exaResponse(exaText), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const results = await webSearch(
      { query: "x", allowed_domains: ["allowed.test"] },
      { env: {} },
    );
    expect(results.length).toBe(1);
    expect(results[0]!.url).toBe("https://allowed.test/a");
  });

  test("forced tavily without a key is an explicit error, not a silent fallback", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      webSearch({ query: "x" }, { env: { provider: "tavily" } }),
    ).rejects.toThrow(/TAVILY_API_KEY/);
    expect(fetchCalls).toBe(0);

    await expect(
      webSearch({ query: "x" }, { env: { provider: "google" } }),
    ).rejects.toThrow(/Unknown PICO_SEARCH_PROVIDER/);
    expect(fetchCalls).toBe(0);
  });

  test("max_results clamps the returned set", async () => {
    const blocks = Array.from(
      { length: 5 },
      (_, i) =>
        `Title: T${i}\nURL: https://h${i}.test/p\nHighlights:\ns${i}\n`,
    ).join("---\n");
    globalThis.fetch = (async () =>
      new Response(exaResponse(blocks), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const results = await webSearch({ query: "x", max_results: 2 }, { env: {} });
    expect(results.length).toBe(2);
  });

  test("Exa path respects max_results through clamp", async () => {
    const blocks = Array.from(
      { length: 30 },
      (_, i) =>
        `Title: T${i}\nURL: https://h${i}.test/p\nHighlights:\ns${i}\n`,
    ).join("---\n");
    globalThis.fetch = (async () =>
      new Response(exaResponse(blocks), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    // clamp(30, 1, 25) => 25, but Exa only sees 25 via max param.
    const results = await webSearch({ query: "x", max_results: 30 }, { env: {} });
    expect(results.length).toBeLessThanOrEqual(25);
  });

  test("Tavily path is taken when env opts in", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: string) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({
          results: [
            { title: "T", url: "https://t.test/x", content: "snippet body" },
          ],
        }),
        { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const results = await webSearch(
      { query: "hello" },
      { env: { provider: "tavily", tavilyKey: "k" } },
    );
    expect(seenUrl).toBe("https://api.tavily.com/search");
    expect(results[0]!.url).toBe("https://t.test/x");
    expect(results[0]!.snippet).toBe("snippet body");
  });

  test("Hybrid path queries both Exa and Tavily, dedups by URL", async () => {
    let callCount = 0;
    globalThis.fetch = (async (url: string) => {
      callCount++;
      if (url === "https://api.tavily.com/search") {
        return new Response(
          JSON.stringify({
            results: [
              { title: "Tavily Hit", url: "https://tavily.test/a", content: "tavily snippet" },
              { title: "Dup", url: "https://shared.test/dup", content: "dup from tavily" },
            ],
          }),
          { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
        );
      }
      // Exa MCP
      const exaText =
        "Title: Exa Hit\nURL: https://exa.test/b\nHighlights:\nexa snippet\n" +
        "---\n" +
        "Title: Dup\nURL: https://shared.test/dup\nHighlights:\ndup from exa\n";
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: exaText }] },
        }),
        { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const results = await webSearch(
      { query: "hello" },
      { env: { tavilyKey: "k" } }, // no provider set → hybrid
    );
    expect(callCount).toBe(2);
    // 3 unique results across both providers (one URL duplicated)
    expect(results.length).toBe(3);
    const urls = results.map((r) => r.url);
    expect(urls).toContain("https://exa.test/b");
    expect(urls).toContain("https://tavily.test/a");
    expect(urls).toContain("https://shared.test/dup");
  });

  test("Hybrid path reports an error when both providers fail", async () => {
    globalThis.fetch = (async (url: string) => {
      return new Response(url === "https://api.tavily.com/search" ? "bad tavily" : "bad exa", {
        status: 500,
        statusText: "Nope",
      });
    }) as unknown as typeof fetch;

    await expect(webSearch(
      { query: "hello" },
      { env: { tavilyKey: "k" } },
    )).rejects.toThrow(/Hybrid search failed/);
  });
});

test("fetchAndConvert refuses a redirect into a private network address", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    // A public URL 302-redirects to the cloud metadata endpoint.
    return new Response(null, {
      status: 302,
      headers: { location: "https://169.254.169.254/latest/meta-data" },
    });
  }) as unknown as typeof fetch;

  await expect(
    fetchAndConvert("https://example.com/start", { fetcher, bypassCache: true }),
  ).rejects.toThrow(/private network/i);
  // Stopped at the redirect boundary — never fetched the private target.
  expect(calls).toBe(1);
});

// ---- Fourth-round regression tests: charset / binary / 3xx / single-flight / SSE / dedup ----

test("fetchAndConvert decodes non-UTF-8 charsets from Content-Type", async () => {
  // "中文标题" in GBK (D6D0 CEC4 B1EA CCE2).
  const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2]);
  globalThis.fetch = (async () => new Response(gbkBytes, {
    status: 200,
    headers: { "content-type": "text/html; charset=gbk" },
  })) as unknown as typeof fetch;
  const page = await fetchAndConvert("https://example.test/gbk", { bypassCache: true });
  expect(page.markdown).toContain("中文标题");
});

test("fetchAndConvert marks binary content types instead of dumping bytes", async () => {
  globalThis.fetch = (async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), {
    status: 200,
    headers: { "content-type": "image/png" },
  })) as unknown as typeof fetch;
  const page = await fetchAndConvert("https://example.test/img.png", { bypassCache: true });
  expect(page.markdown).toContain("Binary content (image/png)");
});

test("fetchAndConvert rejects 3xx without Location and never caches it", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(null, { status: 302, headers: {} });
  }) as unknown as typeof fetch;
  await expect(
    fetchAndConvert("https://example.test/redir", { bypassCache: true }),
  ).rejects.toThrow(/Redirect \(302\) without Location/);
  // Second call must hit the network again (nothing cached).
  await expect(
    fetchAndConvert("https://example.test/redir", { bypassCache: true }),
  ).rejects.toThrow(/without Location/);
  expect(calls).toBe(2);
});

test("single-flight waiters observe their own abort signal", async () => {
  let release!: (r: Response) => void;
  const gate = new Promise<Response>((resolve) => { release = resolve; });
  const fetcher = (async () => gate) as unknown as typeof fetch;

  const first = fetchAndConvert("https://example.test/shared-abort", { fetcher });
  const controller = new AbortController();
  const second = fetchAndConvert("https://example.test/shared-abort", {
    fetcher,
    signal: controller.signal,
  });
  controller.abort(new Error("waiter cancelled"));
  await expect(second).rejects.toThrow(/waiter cancelled/);

  release(new Response("<p>late</p>", { status: 200, headers: { "content-type": "text/html" } }));
  await first;
});

test("parseExaResponse accepts data: without space and multi-line data events", () => {
  const noSpace = "event: message\ndata:{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"x\"}]}}\n\n";
  const parsed = parseExaResponse(noSpace);
  expect(parsed.result).toBeDefined();

  const multiLine = "data: {\"result\":{\"content\":[{\"type\":\"text\",\ndata: \"text\":\"y\"}]}}\n\n";
  const parsed2 = parseExaResponse(multiLine);
  expect(parsed2.result).toBeDefined();
});

test("exaSearch returns as soon as the SSE data event parses (keep-alive safe)", async () => {
  // A stream that never closes: the first chunk carries the full result event,
  // later chunks are heartbeats. EOF-based reading would hang; incremental
  // reading returns immediately.
  const chunks = [
    "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"Title: T\\nURL: https://example.com/a\\n\"}]}}\n\n",
    ": heartbeat\n",
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      // Note: no close() — the connection stays open.
    },
  });
  globalThis.fetch = (async () => new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })) as unknown as typeof fetch;

  const { webSearch } = await import("../src/extensions/web/search.ts");
  const results = await webSearch({ query: "hello" }, { maxResults: 3 } as never);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0]!.url).toBe("https://example.com/a");
});
