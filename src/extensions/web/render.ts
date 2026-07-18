import { Text } from "@earendil-works/pi-tui";
import {
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  ELLIPSIS,
  renderExpandHint,
  renderToolTitle,
} from "../ui/rendering.ts";
import type { FetchedPage } from "./fetch.ts";
import type { SearchInput, SearchResult } from "./search.ts";

type WebFetchArgs = {
  url?: string;
  prompt?: string;
};

type WebFetchDetails = Pick<FetchedPage, "status" | "url" | "truncated" | "contentType">;

type WebSearchDetails = {
  count: number;
  results: SearchResult[];
};

const SEARCH_COLLAPSED_RESULTS = 3;

function textOutput(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function firstNonEmptyLines(text: string, maxLines: number): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines);
}

export function formatWebFetchCall(args: WebFetchArgs | undefined, theme: Theme): string {
  const url = args?.url ? args.url : ELLIPSIS;
  return renderToolTitle(theme, "webFetch", url);
}

export function formatWebSearchCall(args: Pick<SearchInput, "query"> | undefined, theme: Theme): string {
  const query = args?.query ? args.query : ELLIPSIS;
  return renderToolTitle(theme, "webSearch", query);
}

export function formatWebFetchDisplay(
  result: AgentToolResult<WebFetchDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  isError: boolean,
  expandHint = renderExpandHint(theme),
): string {
  const output = textOutput(result);
  if (isError || options.expanded) {
    return output ? `\n${theme.fg(isError ? "error" : "toolOutput", output)}` : "";
  }

  const details = result.details;
  if (details?.url) {
    const status = details.status ? `status ${details.status}` : "fetched";
    const truncated = details.truncated ? ", truncated" : "";
    const contentType = details.contentType ? `, ${details.contentType.split(";")[0]}` : "";
    return `\n${theme.fg("toolOutput", `${status}: ${details.url}${contentType}${truncated}`)}\n${expandHint}`;
  }

  const preview = firstNonEmptyLines(output, 2).join("\n");
  return preview
    ? `\n${theme.fg("toolOutput", preview)}\n${expandHint}`
    : "";
}

export function formatWebSearchDisplay(
  result: AgentToolResult<WebSearchDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  isError: boolean,
  expandHint = renderExpandHint(theme),
): string {
  const output = textOutput(result);
  if (isError || options.expanded) {
    return output ? `\n${theme.fg(isError ? "error" : "toolOutput", output)}` : "";
  }

  const results = result.details?.results ?? [];
  if (results.length === 0) {
    const preview = firstNonEmptyLines(output, 2).join("\n");
    return preview ? `\n${theme.fg("toolOutput", preview)}` : "";
  }

  const lines = [`Results: ${result.details?.count ?? results.length}`];
  for (const [index, item] of results.slice(0, SEARCH_COLLAPSED_RESULTS).entries()) {
    lines.push(`${index + 1}. ${item.title || item.url}`);
    if (item.url) lines.push(`   ${item.url}`);
  }

  const remaining = results.length - SEARCH_COLLAPSED_RESULTS;
  if (remaining > 0) {
    lines.push(`${ELLIPSIS} ${remaining} more results`);
  }

  return `\n${theme.fg("toolOutput", lines.join("\n"))}\n${expandHint}`;
}

export function renderWebFetchCall(
  args: any,
  theme: Theme,
  context: { lastComponent?: unknown },
) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(formatWebFetchCall(args as WebFetchArgs | undefined, theme));
  return text;
}

export function renderWebSearchCall(
  args: any,
  theme: Theme,
  context: { lastComponent?: unknown },
) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(formatWebSearchCall(args as Pick<SearchInput, "query"> | undefined, theme));
  return text;
}

export function renderWebFetchResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { lastComponent?: unknown; isError?: boolean },
) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(
    formatWebFetchDisplay(
      result as AgentToolResult<WebFetchDetails | undefined>,
      options,
      theme,
      context.isError ?? false,
    ),
  );
  return text;
}

export function renderWebSearchResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { lastComponent?: unknown; isError?: boolean },
) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(
    formatWebSearchDisplay(
      result as AgentToolResult<WebSearchDetails | undefined>,
      options,
      theme,
      context.isError ?? false,
    ),
  );
  return text;
}
