/**
 * srcode web extension.
 *
 * Registers two tools:
 *   - webFetch  — fetch a URL, return simplified Markdown (15-min cache).
 *   - webSearch — query the web (DDG by default; Tavily when env opts in).
 *
 * Both are explicit network egress points; the prompt copy makes that
 * boundary visible to the model so it doesn't reach for them on internal
 * lookups that codegraph/grep would answer for free.
 */
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fetchAndConvert, formatFetchResult } from "./fetch.ts";
import { formatSearchResults, webSearch } from "./search.ts";

const WebFetchParams = Type.Object({
  url: Type.String({
    description:
      "Absolute URL to fetch. http:// is upgraded to https:// before the request.",
  }),
  prompt: Type.Optional(
    Type.String({
      description:
        "What you want to find on the page. Echoed back at the top of the result so you can re-find it; the page is NOT summarized for you.",
    }),
  ),
});

const WebSearchParams = Type.Object({
  query: Type.String({ description: "Free-text search query." }),
  max_results: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 25,
      description: "Cap on number of results returned. Default 10.",
    }),
  ),
  allowed_domains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Only return results whose hostname is in this list (or a subdomain). Empty/missing = no allowlist.",
    }),
  ),
  blocked_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Drop results whose hostname is in this list (or a subdomain).",
    }),
  ),
});

export const webExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerTool(
    defineTool({
      name: "webFetch",
      label: "Web Fetch",
      description:
        "Fetch a URL over the public network and return its content as simplified Markdown. " +
        "Performs network egress; results are cached in memory for 15 minutes. " +
        "Output is truncated to 8 KiB — for longer pages, fetch again with a more specific URL.",
      promptSnippet:
        "webFetch — fetch one URL and read it as Markdown. Public network access; cached 15 min; output capped at 8KB.",
      parameters: WebFetchParams,
      async execute(_id, params, signal) {
        try {
          const page = await fetchAndConvert(params.url, { signal });
          return {
            content: [{ type: "text" as const, text: formatFetchResult(page, params.prompt) }],
            details: {
              status: page.status,
              url: page.url,
              truncated: page.truncated,
              contentType: page.contentType,
            },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text" as const, text: `webFetch failed: ${msg}` }],
            details: undefined,
            isError: true,
          };
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "webSearch",
      label: "Web Search",
      description:
        "Search the public web. Default provider is DuckDuckGo (HTML scrape, no key). " +
        "Set SRCODE_SEARCH_PROVIDER=tavily plus TAVILY_API_KEY to use Tavily instead. " +
        "Performs network egress; not cached.",
      promptSnippet:
        "webSearch — query the public web (DuckDuckGo default; Tavily via env). Returns title/url/snippet triples.",
      parameters: WebSearchParams,
      async execute(_id, params, signal) {
        try {
          const results = await webSearch(
            {
              query: params.query,
              max_results: params.max_results,
              allowed_domains: params.allowed_domains,
              blocked_domains: params.blocked_domains,
            },
            { signal },
          );
          return {
            content: [
              { type: "text" as const, text: formatSearchResults(params.query, results) },
            ],
            details: { count: results.length, results },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text" as const, text: `webSearch failed: ${msg}` }],
            details: undefined,
            isError: true,
          };
        }
      },
    }),
  );
};

export default webExtension;
