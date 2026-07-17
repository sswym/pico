import { Text } from "@earendil-works/pi-tui";
import {
  keyText,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_COLLAPSED_LINES = 8;
const DEFAULT_COLLAPSED_LINE_LENGTH = 180;
const SUMMARY_MAX_LENGTH = 120;

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stripTrailingCarriageReturns(text: string): string {
  return text.replace(/\r/g, "");
}

function collapseLine(line: string, maxLength: number): string {
  const clean = line.trimEnd();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function getObjectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function shortString(value: unknown, maxLength = SUMMARY_MAX_LENGTH): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function quote(value: string): string {
  return value ? `"${value}"` : "";
}

export function summarizeToolCall(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const action = shortString(getObjectValue(args, "action"), 32);
  const file = shortString(getObjectValue(args, "file") ?? getObjectValue(args, "path") ?? getObjectValue(args, "url"), 72);
  const query = shortString(getObjectValue(args, "query") ?? getObjectValue(args, "q"), 80);
  const todos = getObjectValue(args, "todos");

  if (toolName === "todoWrite" && Array.isArray(todos)) {
    const active = todos.filter((todo) =>
      Boolean(todo && typeof todo === "object" && (todo as { status?: unknown }).status !== "completed")
    ).length;
    return `${todos.length} items · ${active} active`;
  }

  if (toolName === "lsp") {
    const line = getObjectValue(args, "line");
    const loc = file && typeof line === "number" ? `${file}:${line}` : file;
    return [action, loc].filter(Boolean).join(" ");
  }

  if (toolName === "memory") {
    const fact = shortString(getObjectValue(args, "fact"), 80);
    return [action, query ? quote(query) : fact].filter(Boolean).join(" ");
  }

  if (toolName === "webSearch" || toolName === "webFetch") {
    return query ? quote(query) : file;
  }

  if (toolName === "visionAnalyze") {
    const image = shortString(getObjectValue(args, "image") ?? getObjectValue(args, "image_url"), 72);
    return image;
  }

  return [action, query ? quote(query) : file].filter(Boolean).join(" ");
}

function expandHint(theme: Theme): string {
  return `${theme.fg("dim", keyText("app.tools.expand"))}${theme.fg("muted", " to expand")}`;
}

export function previewText(
  text: string,
  maxLines = DEFAULT_COLLAPSED_LINES,
  maxLineLength = DEFAULT_COLLAPSED_LINE_LENGTH,
): { preview: string; hiddenLines: number } {
  const lines = stripTrailingCarriageReturns(text).split("\n");
  const collapsed = lines.slice(0, maxLines).map((line) => collapseLine(line, maxLineLength));
  return {
    preview: collapsed.join("\n").trimEnd(),
    hiddenLines: Math.max(0, lines.length - collapsed.length),
  };
}

export function renderToolCallText(
  toolName: string,
  args: unknown,
  theme: Theme,
  context: { lastComponent?: unknown },
  options?: { collapsedLines?: number; collapsedLineLength?: number },
): Text {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const serialized = stringifyValue(args).trim();
  const summary = summarizeToolCall(toolName, args);
  const title = summary
    ? `${theme.fg("muted", "• ")}${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", summary)}`
    : `${theme.fg("muted", "• ")}${theme.fg("toolTitle", theme.bold(toolName))}`;
  if (!serialized) {
    text.setText(title);
    return text;
  }
  const { preview, hiddenLines } = previewText(
    serialized,
    options?.collapsedLines ?? DEFAULT_COLLAPSED_LINES,
    options?.collapsedLineLength ?? DEFAULT_COLLAPSED_LINE_LENGTH,
  );
  const output =
    hiddenLines > 0
      ? `${title}\n\n${theme.fg("toolOutput", preview)}\n${theme.fg("muted", "(")}${expandHint(theme)}${theme.fg("muted", ")")}`
      : `${title}\n\n${theme.fg("toolOutput", preview)}`;
  text.setText(output);
  return text;
}

export function renderToolResultText(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { lastComponent?: unknown; isError?: boolean },
  renderOptions?: { collapsedLines?: number; collapsedLineLength?: number },
): Text {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const output = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");

  if (!output) {
    text.setText("");
    return text;
  }

  const color = context.isError ? "error" : "toolOutput";
  if (options.expanded) {
    text.setText(`\n${theme.fg(color, output)}`);
    return text;
  }

  const { preview, hiddenLines } = previewText(
    output,
    renderOptions?.collapsedLines ?? DEFAULT_COLLAPSED_LINES,
    renderOptions?.collapsedLineLength ?? DEFAULT_COLLAPSED_LINE_LENGTH,
  );
  const body = theme.fg(color, preview);
  if (hiddenLines <= 0) {
    text.setText(`\n${body}`);
    return text;
  }

  text.setText(
    `\n${body}\n${theme.fg("muted", "(")}${expandHint(theme)}${theme.fg("muted", ")")}`,
  );
  return text;
}
