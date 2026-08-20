/**
 * pico web extension.
 *
 * Registers two tools:
 *   - webFetch  — fetch a URL, return simplified Markdown (15-min cache).
 *   - webSearch — query the web (Exa MCP by default; Tavily when env opts in).
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
import { fetchAndConvert, formatFetchResult, type FetchedPage } from "./fetch.ts";
import {
  renderWebFetchCall,
  renderWebFetchResult,
  renderWebSearchCall,
  renderWebSearchResult,
} from "./render.ts";
import { formatSearchResults, webSearchWithNotes, capSearchOutput } from "./search.ts";
import { toolError } from "../errors.ts";

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
  bypass_cache: Type.Optional(
    Type.Boolean({
      description:
        "Skip the 15-minute in-memory cache and re-fetch the page live. Use for dynamic pages (CI status, dashboards). Default false.",
    }),
  ),
  allow_private_network: Type.Optional(
    Type.Boolean({
      description:
        "Allow localhost / private-network addresses (intranet wikis, local doc servers). Off by default — public web fetch only.",
    }),
  ),
});

const WebSearchParams = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Free-text search query.",
  }),
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
      renderCall: renderWebFetchCall,
      renderResult: renderWebFetchResult,
      async execute(_id, params, signal) {
        let page: FetchedPage;
        try {
          page = await fetchAndConvert(params.url, {
            signal,
            bypassCache: params.bypass_cache === true,
            allowPrivateNetwork: params.allow_private_network === true,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Throw so the failure is marked as an error upstream (a returned
          // isError flag is dropped by the agent loop).
          return toolError("network", `webFetch failed: ${msg}`, { cause: e });
        }
        // 4xx/5xx are failures, not successful fetches — and a returned
        // isError flag is dropped by the agent loop. The page rides along
        // as the error cause so the details stay available.
        if (page.status >= 400) {
          return toolError("invalid_request", `webFetch failed: HTTP ${page.status} ${page.statusText}`, { cause: page });
        }
        return {
          content: [{ type: "text" as const, text: formatFetchResult(page, params.prompt) }],
          details: {
            status: page.status,
            url: page.url,
            truncated: page.truncated,
            contentType: page.contentType,
          },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "webSearch",
      label: "Web Search",
      description:
        "Search the public web. Default provider is Exa MCP (public, no key). " +
        "When TAVILY_API_KEY is available, Exa + Tavily are merged (hybrid mode). " +
        "Set PICO_SEARCH_PROVIDER=exa or =tavily to force a single provider.",
      promptSnippet:
        "webSearch — query the public web (Exa + Tavily hybrid by default; set PICO_SEARCH_PROVIDER to override). Returns title/url/snippet triples.",
      parameters: WebSearchParams,
      renderCall: renderWebSearchCall,
      renderResult: renderWebSearchResult,
      async execute(_id, params, signal) {
        try {
          const outcome = await webSearchWithNotes(
            {
              query: params.query,
              max_results: params.max_results,
              allowed_domains: params.allowed_domains,
              blocked_domains: params.blocked_domains,
            },
            { signal },
          );
          const body = formatSearchResults(params.query, outcome.results);
          const notes = outcome.notes.length > 0 ? `\n\n${outcome.notes.join("\n")}` : "";
          return {
            content: [
              { type: "text" as const, text: capSearchOutput(body + notes) },
            ],
            details: { count: outcome.results.length, results: outcome.results, notes: outcome.notes },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Throw so the failure is marked as an error upstream (a returned
          // isError flag is dropped by the agent loop).
          return toolError("network", `webSearch failed: ${msg}`, { cause: e });
        }
      },
    }),
  );
};

