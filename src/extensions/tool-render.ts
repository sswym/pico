import { Text, visibleWidth } from "@earendil-works/pi-tui";
import {
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  renderExpandHint,
  renderToolTitle,
  sanitizeTerminalText,
  truncateWithEllipsis,
} from "./ui/rendering.ts";
import { friendlyErrorMessage } from "./errors.ts";

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

/** Truncate to a visible-column budget with a single-column ellipsis
 *  (2.1.3). pi-tui's truncateToWidth pads with its own multi-char ellipsis
 *  and can inject reset sequences; a hand-rolled code-point walk keeps the
 *  preview clean. */
function truncateByWidth(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  let used = 0;
  const out: string[] = [];
  for (const ch of Array.from(text)) {
    const w = visibleWidth(ch);
    if (used + w > maxWidth - 1) break;
    out.push(ch);
    used += w;
  }
  return `${out.join("").trimEnd()}…`;
}

function getObjectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function shortString(value: unknown, maxLength = SUMMARY_MAX_LENGTH): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return truncateWithEllipsis(clean, maxLength);
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

  if (toolName === "askUserQuestion") {
    const questions = getObjectValue(args, "questions");
    if (Array.isArray(questions) && questions.length > 0) {
      const first = questions[0];
      const question =
        first && typeof first === "object" ? getObjectValue(first, "question") : undefined;
      const text = typeof question === "string" && question ? shortString(question, 96) : `${questions.length} questions`;
      return questions.length > 1 ? `${text} (${questions.length} questions)` : text;
    }
    return "";
  }

  if (toolName === "visionAnalyze") {
    // Schema fields are image_path / image_base64 / image_url — a local path
    // is the most useful summary, base64 the noisiest, so prefer in that order.
    const image = shortString(
      getObjectValue(args, "image_path") ?? getObjectValue(args, "image_base64") ?? getObjectValue(args, "image_url"),
      72,
    );
    return image;
  }

  return [action, query ? quote(query) : file].filter(Boolean).join(" ");
}

export function previewText(
  text: string,
  maxLines = DEFAULT_COLLAPSED_LINES,
  maxLineLength = DEFAULT_COLLAPSED_LINE_LENGTH,
): { preview: string; hiddenLines: number; truncatedLine: boolean } {
  const lines = stripTrailingCarriageReturns(text).split("\n");
  // 2.1.3: the preview budget is measured in COLUMNS, not characters — a
  // 180-char Chinese line occupies ~360 columns at 2 cols/char and would
  // wrap far beyond the promised 8 rows. Budget = maxLines × maxLineLength
  // columns, and the TUI's wrap width is the terminal columns (≈maxLineLength),
  // so capping by column count makes "N lines" honest again.
  const budget = maxLines * maxLineLength;
  const collapsed: string[] = [];
  let used = 0;
  let index = 0;
  let truncatedLine = false;
  for (; index < lines.length; index++) {
    const clean = lines[index]!.trimEnd();
    const width = visibleWidth(clean);
    if (width > maxLineLength) {
      if (collapsed.length >= maxLines) {
        break;
      }
      collapsed.push(truncateByWidth(clean, Math.max(1, maxLineLength)));
      used += maxLineLength;
      truncatedLine = true;
      continue;
    }
    if (collapsed.length >= maxLines || used + width > budget) {
      break;
    }
    collapsed.push(clean);
    used += Math.max(1, width);
  }
  return {
    preview: collapsed.join("\n").trimEnd(),
    hiddenLines: Math.max(0, lines.length - index),
    truncatedLine,
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
  const serialized = sanitizeTerminalText((stringifyValue(args) ?? "").trim());
  const summary = sanitizeTerminalText(summarizeToolCall(toolName, args));
  const title = renderToolTitle(theme, toolName, summary);
  if (!serialized) {
    text.setText(title);
    return text;
  }
  const { preview, hiddenLines, truncatedLine } = previewText(
    serialized,
    options?.collapsedLines ?? DEFAULT_COLLAPSED_LINES,
    options?.collapsedLineLength ?? DEFAULT_COLLAPSED_LINE_LENGTH,
  );
  const output =
    hiddenLines > 0 || truncatedLine
      ? `${title}\n\n${theme.fg("toolOutput", preview)}\n${renderExpandHint(theme)}`
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

  // Tool output is not trusted (MCP servers, file contents, memory) — strip
  // ANSI/control sequences so it can never drive the terminal.
  const clean = sanitizeTerminalText(output);

  const color = context.isError ? "error" : "toolOutput";
  // Error results often carry upstream developer-format text (schema
  // violations with JSON dumps, provider HTTP envelopes) — condense it.
  const displayText = context.isError ? friendlyErrorMessage(clean) : clean;
  if (options.expanded) {
    // 2.1.4: expanding MB-scale output (large file reads, base64 images)
    // used to push the whole payload into the TUI diff — cap the render and
    // say where the full text lives.
    const { preview, hiddenLines, truncatedLine } = previewText(displayText, 5000, 5000);
    const capped = hiddenLines > 0 || truncatedLine
      ? `${preview}\n\n[Output truncated in view: ${hiddenLines} lines omitted. Full output preserved in tool details.]`
      : preview;
    text.setText(`\n${theme.fg(color, capped)}`);
    return text;
  }

  const { preview, hiddenLines, truncatedLine } = previewText(
    displayText,
    renderOptions?.collapsedLines ?? DEFAULT_COLLAPSED_LINES,
    renderOptions?.collapsedLineLength ?? DEFAULT_COLLAPSED_LINE_LENGTH,
  );
  const renderedBody = theme.fg(color, preview);
  if (hiddenLines <= 0 && !truncatedLine) {
    text.setText(`\n${renderedBody}`);
    return text;
  }

  text.setText(
    `\n${renderedBody}\n${renderExpandHint(theme)}`,
  );
  return text;
}
