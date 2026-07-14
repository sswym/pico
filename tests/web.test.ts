/**
 * Web extension tests — cache hit, search parsing, domain filter, html→md.
 *
 * fetch() is mocked by swapping globalThis.fetch in afterEach so other suites
 * don't see our stubs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { LRU } from "../src/extensions/web/cache.ts";
import {
  clearWebFetchCache,
  fetchAndConvert,
  htmlToMarkdown,
  webFetchCacheSize,
} from "../src/extensions/web/fetch.ts";
import {
  filterDomains,
  parseExaResponse,
  parseExaTextResults,
  webSearch,
  type SearchResult,
} from "../src/extensions/web/search.ts";

const realFetch = globalThis.fetch;

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
});
