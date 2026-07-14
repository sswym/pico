import { Text } from "@earendil-works/pi-tui";
import {
  keyText,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_COLLAPSED_LINES = 8;
const DEFAULT_COLLAPSED_LINE_LENGTH = 180;

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
  if (!serialized) {
    text.setText(theme.fg("toolTitle", theme.bold(toolName)));
    return text;
  }
  const { preview, hiddenLines } = previewText(
    serialized,
    options?.collapsedLines ?? DEFAULT_COLLAPSED_LINES,
    options?.collapsedLineLength ?? DEFAULT_COLLAPSED_LINE_LENGTH,
  );
  const output =
    hiddenLines > 0
      ? `${theme.fg("toolTitle", theme.bold(toolName))}\n\n${theme.fg("toolOutput", preview)}\n${theme.fg("muted", "(")}${expandHint(theme)}${theme.fg("muted", ")")}`
      : `${theme.fg("toolTitle", theme.bold(toolName))}\n\n${theme.fg("toolOutput", preview)}`;
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
