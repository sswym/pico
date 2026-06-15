/**
 * Web extension tests — cache hit, search parsing, domain filter, html→md.
 *
 * fetch() is mocked by swapping globalThis.fetch in afterEach so other suites
 * don't see our stubs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LRU } from "../src/extensions/web/cache.ts";
import {
  clearWebFetchCache,
  fetchAndConvert,
  htmlToMarkdown,
  webFetchCacheSize,
} from "../src/extensions/web/fetch.ts";
import {
  filterDomains,
  parseDuckDuckGoHtml,
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

describe("parseDuckDuckGoHtml", () => {
  test("extracts at least one result from a hand-written DDG payload", () => {
    const html = `
      <html><body>
        <div class="result results_links">
          <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">First Hit</a></h2>
          <a class="result__snippet" href="https://example.com/a">First snippet text here</a>
        </div>
        <div class="result results_links">
          <h2><a class="result__a" href="https://other.test/page">Second Hit</a></h2>
          <a class="result__snippet">Second snippet</a>
        </div>
      </body></html>`;
    const results = parseDuckDuckGoHtml(html);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]!.title).toBe("First Hit");
    expect(results[0]!.url).toBe("https://example.com/a");
    expect(results[0]!.snippet).toContain("First snippet");
    expect(results[1]!.url).toBe("https://other.test/page");
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
  test("DuckDuckGo path, allowed_domains filter applied", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://allowed.test/a">Allowed</a>
        <a class="result__snippet">good</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://denied.test/b">Denied</a>
        <a class="result__snippet">bad</a>
      </div>`;
    globalThis.fetch = (async () =>
      new Response(html, { status: 200, statusText: "OK", headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

    const results = await webSearch(
      { query: "x", allowed_domains: ["allowed.test"] },
      { env: {} },
    );
    expect(results.length).toBe(1);
    expect(results[0]!.url).toBe("https://allowed.test/a");
  });

  test("max_results clamps the returned set", async () => {
    const blocks = Array.from({ length: 5 }, (_, i) =>
      `<div class="result"><a class="result__a" href="https://h${i}.test/p">T${i}</a><a class="result__snippet">s${i}</a></div>`,
    ).join("");
    globalThis.fetch = (async () =>
      new Response(blocks, { status: 200, statusText: "OK", headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

    const results = await webSearch({ query: "x", max_results: 2 }, { env: {} });
    expect(results.length).toBe(2);
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
});
