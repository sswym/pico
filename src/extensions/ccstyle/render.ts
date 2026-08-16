import { inspect } from "node:util";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
  Theme,
  ToolExecutionComponent,
  type AgentToolResult,
  type ThemeColor,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { TOOL_LOADING_INTERVAL_MS, toolLoadingIcon, ccHint, oneLine, sanitizeToolResultText, PICO_TOOL_SUMMARIES } from "./util.ts";
import { asTool, type ToolComponent } from "./grouping.ts";
import { summarizeToolCall } from "../tool-render.ts";

/**
 * CC-style tool-card rendering for pico — ported from pi-cc-extensions
 * (MIT, minuque/pi-cc-extensions v0.8.54, extensions/renderer/default-mode.ts
 * + tool/result.ts), trimmed to mode "on": single-line call summary, collapsed
 * result line, expanded Input/Output view. No rich diff, no compact mode.
 *
 * Only upstream built-in tools (toolDefinition === undefined) are taken over;
 * pico's own tools keep their registered renderers.
 */

const TOOL_VIEWPORT_WIDTH_RATIO = 0.8;
const EXPANDED_PREVIEW_MAX_LINES = 40;
const MAX_INPUT_CHARS = 8_000;

type ToolVisualState = "pending" | "success" | "error";

/** Renderer state stored per tool row in the render context. */
interface ToolCardState extends Record<string, unknown> {
  ccstyleToolVisualState?: ToolVisualState;
  ccstyleToolExpanded?: boolean;
  ccstyleAnimationScheduled?: boolean;
  ccstyleIoView?: unknown;
  ccstyleAutoExpanded?: boolean;
  ccstyleUserCollapsed?: boolean;
}

/**
 * Context passed to tool renderers — mirrors upstream ToolRenderContext
 * (core/extensions/types.d.ts), which the package root does not re-export.
 */
interface RenderContext {
  args: unknown;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  state: ToolCardState;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
}

/** Tool definition shape created by createCcstyleTool — only render surfaces matter. */
interface WrappedTool {
  name: string;
  label: string;
  renderShell: "self";
  renderCall(args: unknown, theme: Theme, context: RenderContext): Component;
  renderResult(
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContext,
  ): Component;
  /**
   * The tool's own renderResult, re-resolved on every updateDisplay (see the
   * getResultRenderer patch). Partial (isPartial) renders pass through to it
   * so live views — subagent's running panel, bash's elapsed timer — keep
   * updating instead of being frozen to "↳ Pending…".
   */
  originalRenderResult?: WrappedTool["renderResult"];
}

export function toolViewportWidth(width: number): number {
  return Math.max(1, Math.floor(width * TOOL_VIEWPORT_WIDTH_RATIO));
}

function rawTextFromResult(result: AgentToolResult<unknown>): string {
  const parts: string[] = [];
  for (const item of result.content) {
    if (item.type === "text") parts.push(String(item.text ?? ""));
  }
  return parts.join("\n");
}

function detailsFromResult(result: AgentToolResult<unknown>): string {
  if (result.details === undefined) return "";
  const details =
    typeof result.details === "string"
      ? result.details
      : inspect(result.details, { depth: 8, breakLength: 100, compact: false });
  return sanitizeToolResultText(details, 16_384);
}

function textFromResult(result: AgentToolResult<unknown>, expanded = false): string {
  // Compact previews only need short text; bound sanitize work.
  const content = sanitizeToolResultText(rawTextFromResult(result), 16_384);
  const details = detailsFromResult(result);
  if (!content) return details;
  if (!expanded || !details || details === content) return content;
  return `${content}\nDetails:\n${details}`;
}

function outputLineCount(result: AgentToolResult<unknown>): number {
  const text = rawTextFromResult(result).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return text ? text.split("\n").length : 0;
}

function countLines(text: string): number {
  return text
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

function hasExpandableResult(text: string): boolean {
  return countLines(text) > 1;
}

// ── pending animation ────────────────────────────────────────────────────────

const activeAnimationContexts = new Set<RenderContext>();
let sharedAnimationTimer: Timer | undefined;

function clearAnimation(context: RenderContext): void {
  if (!context.state.ccstyleAnimationScheduled) return;
  context.state.ccstyleAnimationScheduled = false;
  activeAnimationContexts.delete(context);
  if (activeAnimationContexts.size === 0 && sharedAnimationTimer) {
    clearTimeout(sharedAnimationTimer);
    sharedAnimationTimer = undefined;
  }
}

export function clearAllAnimations(): void {
  for (const context of activeAnimationContexts) {
    context.state.ccstyleAnimationScheduled = false;
  }
  activeAnimationContexts.clear();
  clearTimeout(sharedAnimationTimer);
  sharedAnimationTimer = undefined;
}

function scheduleAnimation(context: RenderContext): void {
  const state = context.state;
  if (state.ccstyleAnimationScheduled) return;
  state.ccstyleAnimationScheduled = true;
  activeAnimationContexts.add(context);
  if (!sharedAnimationTimer) {
    sharedAnimationTimer = setTimeout(() => {
      sharedAnimationTimer = undefined;
      const contexts = Array.from(activeAnimationContexts);
      activeAnimationContexts.clear();
      for (const current of contexts) {
        current.state.ccstyleAnimationScheduled = false;
        current.invalidate();
      }
    }, TOOL_LOADING_INTERVAL_MS);
  }
}

function setToolVisualState(context: RenderContext, visualState: ToolVisualState): void {
  if (visualState !== "pending") clearAnimation(context);
  if (context.state.ccstyleToolVisualState === visualState) return;
  context.state.ccstyleToolVisualState = visualState;
  // No synchronous invalidate from renderResult: the current render pass also
  // refreshes renderCall, so the settled icon still updates immediately.
}

function getToolVisualState(context: RenderContext): ToolVisualState | undefined {
  return context.state.ccstyleToolVisualState;
}

function resolveToolVisualState(context: RenderContext): ToolVisualState | undefined {
  const visualState = getToolVisualState(context);
  if (visualState || context.isPartial !== false) return visualState;
  const settled: ToolVisualState = context.isError ? "error" : "success";
  setToolVisualState(context, settled);
  return settled;
}

function toolIconColor(context: RenderContext): ThemeColor {
  const visualState = getToolVisualState(context);
  if (context.isError || visualState === "error") return "error";
  if (visualState === "success") return "success";
  if (context.isPartial || context.executionStarted || visualState === "pending") return "accent";
  return "muted";
}

function isToolExpanded(options: ToolRenderResultOptions, context: RenderContext): boolean {
  const local = context.state.ccstyleToolExpanded;
  return typeof local === "boolean" ? local : Boolean(options.expanded ?? context.expanded);
}

// ── truncation ───────────────────────────────────────────────────────────────

/** Truncate to width keeping the head — for summary lines and titles. */
function headTruncateToWidth(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return "…";
  let left = "";
  for (const char of Array.from(text)) {
    if (visibleWidth(left + "…" + char) > width) break;
    left += char;
  }
  return `${left}…`;
}

/** Truncate to width keeping head and tail — for collapsed result lines. */
function middleTruncateToWidth(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return "…";
  const chars = Array.from(text);
  const leftWidth = Math.ceil((width - 1) / 2);
  let left = "";
  let right = "";
  for (const char of chars) {
    if (visibleWidth(left + char) > leftWidth) break;
    left += char;
  }
  for (const char of chars.reverse()) {
    if (visibleWidth(left + "…" + char + right) > width) break;
    right = char + right;
  }
  return `${left}…${right}`;
}

function renderCollapsedToolResult(body: string, collapsedHint = ""): string {
  return `   ↳ ${body}${collapsedHint}`;
}

function renderCollapsedToolResultToWidth(
  body: string,
  collapsedHint: string,
  width: number,
  prefix = "   ↳ ",
): string {
  const previewWidth = toolViewportWidth(width);
  const bodyWidth = Math.max(1, previewWidth - visibleWidth(prefix) - visibleWidth(collapsedHint));
  return truncateToWidth(
    prefix + middleTruncateToWidth(body, bodyWidth) + collapsedHint,
    previewWidth,
    "",
  );
}

// ── expanded Input/Output view ───────────────────────────────────────────────

/** True when body needs truncation at the given line limit (source or wrapped rows). */
function bodyExceedsLineLimit(
  body: string,
  limit: number,
  contentWidth: number,
  asInput: boolean,
  theme: Theme,
  bodyColor: ThemeColor,
): boolean {
  const raw = body.replace(/\t/g, "   ").replace(/\n+$/, "");
  if (!raw.trim()) return false;
  const sourceLines = raw.split("\n");
  if (sourceLines.length > limit) return true;
  let total = 0;
  for (const source of sourceLines) {
    const styled = asInput ? styleInputLine(source, theme) : theme.fg(bodyColor, source);
    const parts = wrapTextWithAnsi(styled, contentWidth);
    total += Math.max(1, parts.length);
    if (total > limit) return true;
  }
  return false;
}

/** `key: value` input rows — dim keys, readable values. */
function styleInputLine(rawLine: string, theme: Theme): string {
  const match = rawLine.match(/^([A-Za-z_][\w.-]*)(:\s*)(.*)$/);
  if (!match) return theme.fg("muted", rawLine);
  const key = match[1]!;
  const sep = match[2]!;
  const rest = match[3] ?? "";
  return theme.fg("dim", key + sep) + theme.fg("muted", rest);
}

/**
 * Expanded tool body with clear Input / Output sections.
 *
 *   ├ Input  • ctrl+o to show more
 *   │ path: src/a.ts
 *   │
 *   └ Output  • ctrl+o to show more
 *     result line…
 *
 * flushLeft=true (always in pico): no leading space — the outer Box(1,1)
 * provides the padding.
 */
export class ExpandedToolIoView {
  private inputBody: string;
  private outputBody: string;
  private isError: boolean;
  private readonly theme: Theme;
  private readonly maxOutputLines: number;
  private readonly maxInputLines: number;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    theme: Theme,
    inputBody: string,
    outputBody: string,
    isError: boolean,
    maxOutputLines = EXPANDED_PREVIEW_MAX_LINES,
    maxInputLines = EXPANDED_PREVIEW_MAX_LINES,
  ) {
    this.theme = theme;
    this.inputBody = inputBody;
    this.outputBody = outputBody;
    this.isError = isError;
    this.maxOutputLines = Math.max(1, maxOutputLines);
    this.maxInputLines = Math.max(1, maxInputLines);
  }

  setContent(inputBody: string, outputBody: string, isError: boolean): void {
    if (
      this.inputBody === inputBody &&
      this.outputBody === outputBody &&
      this.isError === isError
    ) {
      return;
    }
    this.inputBody = inputBody;
    this.outputBody = outputBody;
    this.isError = isError;
    this.invalidate();
  }

  getInputBody(): string {
    return this.inputBody;
  }

  getOutputBody(): string {
    return this.outputBody.trim() ? this.outputBody : "Done";
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const theme = this.theme;
    const safeWidth = Math.max(1, Math.floor(width));
    const lead = "";
    const rail = `${lead}│ `;
    const railWidth = visibleWidth(rail);
    const bodyWidth = toolViewportWidth(safeWidth);
    const contentWidth = Math.max(1, bodyWidth - railWidth);
    const bodyColor: ThemeColor = this.isError ? "error" : "toolOutput";
    const lines: string[] = [];
    const truncated = { input: false, output: false };

    const pushHeader = (corner: "├" | "└", label: string, showMore: boolean): void => {
      const mark = theme.fg("dim", `${lead}${corner} `);
      const title = theme.fg("accent", theme.bold(label));
      const more = showMore ? `${theme.fg("dim", " •")} ${theme.fg("dim", ccHint())}` : "";
      lines.push(truncateToWidth(mark + title + more, safeWidth, ""));
    };

    const pushRailLine = (styledContent: string, continued = true): void => {
      // 续行 rail；Output 正文相对 └ 缩进 2 格
      const prefix = continued ? rail : `${lead}  `;
      lines.push(truncateToWidth(theme.fg("dim", prefix) + styledContent, safeWidth, ""));
    };

    const pushBlankRail = (): void => {
      lines.push(truncateToWidth(theme.fg("dim", `${lead}│`), safeWidth, ""));
    };

    const pushBody = (body: string, opts: { input?: boolean; limit: number; continued?: boolean }): void => {
      const raw = body.replace(/\t/g, "   ").replace(/\n+$/, "");
      if (!raw.trim()) {
        pushRailLine(theme.fg("dim", "(empty)"), opts.continued);
        return;
      }
      const sourceLines = raw.split("\n");
      const wrapped: string[] = [];
      for (const source of sourceLines) {
        const styled = opts.input ? styleInputLine(source, theme) : theme.fg(bodyColor, source);
        const parts = wrapTextWithAnsi(styled, contentWidth);
        if (parts.length === 0) wrapped.push(styled);
        else wrapped.push(...parts);
      }
      const exceeds = wrapped.length > opts.limit || sourceLines.length > opts.limit;
      const visible = exceeds ? wrapped.slice(0, Math.min(opts.limit, wrapped.length)) : wrapped;
      for (const line of visible) pushRailLine(line, opts.continued);
      if (exceeds) {
        const hidden = Math.max(0, wrapped.length - visible.length);
        if (hidden > 0) {
          pushRailLine(theme.fg("dim", `… +${hidden} more lines`), opts.continued);
        }
      }
    };

    const hasInput = this.inputBody.trim().length > 0;
    const outputText = this.getOutputBody();
    const inputWouldTruncate =
      hasInput && bodyExceedsLineLimit(this.inputBody, this.maxInputLines, contentWidth, true, theme, bodyColor);
    const outputWouldTruncate = bodyExceedsLineLimit(
      outputText,
      this.maxOutputLines,
      contentWidth,
      false,
      theme,
      bodyColor,
    );

    if (hasInput) {
      truncated.input = inputWouldTruncate;
      pushHeader("├", "Input", inputWouldTruncate);
      pushBody(this.inputBody, { input: true, limit: this.maxInputLines, continued: true });
      pushBlankRail();
      truncated.output = outputWouldTruncate;
      pushHeader("└", "Output", outputWouldTruncate);
      pushBody(outputText, { limit: this.maxOutputLines, continued: false });
    } else {
      truncated.output = outputWouldTruncate;
      pushHeader("└", "Output", outputWouldTruncate);
      pushBody(outputText, { limit: this.maxOutputLines, continued: false });
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

function isExpandedToolIoView(value: unknown): value is ExpandedToolIoView {
  return (
    value instanceof ExpandedToolIoView &&
    typeof value.getInputBody === "function" &&
    typeof value.getOutputBody === "function" &&
    typeof value.render === "function"
  );
}

// ── expanded rendering ───────────────────────────────────────────────────────

/** Pretty-print tool call args for the expanded Input section. */
function formatToolInputArgs(args: unknown, maxChars = MAX_INPUT_CHARS): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") {
    const text = sanitizeToolResultText(String(args));
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }
  if (Array.isArray(args)) {
    try {
      const json = JSON.stringify(args, null, 2);
      return json.length > maxChars ? `${json.slice(0, maxChars)}…` : json;
    } catch {
      return sanitizeToolResultText(String(args));
    }
  }

  const entries = Object.entries(args as Record<string, unknown>).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return "";

  // Stable, human-first field order for common tools.
  const preferred = [
    "path",
    "file_path",
    "command",
    "query",
    "pattern",
    "url",
    "name",
    "message",
    "content",
    "old_string",
    "new_string",
  ];
  entries.sort(([left], [right]) => {
    const li = preferred.indexOf(left);
    const ri = preferred.indexOf(right);
    if (li === -1 && ri === -1) return left.localeCompare(right);
    if (li === -1) return 1;
    if (ri === -1) return -1;
    return li - ri;
  });

  const lines: string[] = [];
  for (const [rawKey, value] of entries) {
    const key = sanitizeToolResultText(rawKey);
    if (typeof value === "string") {
      const safeValue = sanitizeToolResultText(value);
      if (safeValue.includes("\n")) {
        lines.push(`${key}:`);
        for (const line of safeValue.replace(/\t/g, "   ").split("\n")) {
          lines.push(`  ${line}`);
        }
      } else {
        lines.push(`${key}: ${safeValue}`);
      }
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      lines.push(`${key}: ${String(value)}`);
      continue;
    }
    try {
      const json = JSON.stringify(value, null, 2);
      if (json.includes("\n")) {
        lines.push(`${key}:`);
        for (const line of json.split("\n")) lines.push(`  ${line}`);
      } else {
        lines.push(`${key}: ${json}`);
      }
    } catch {
      lines.push(`${key}: [unserializable]`);
    }
  }
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function hasExpandableDetail(outputText: string, args: unknown): boolean {
  if (hasExpandableResult(outputText)) return true;
  return formatToolInputArgs(args).trim().length > 0;
}

function renderExpandedToolResult(
  body: string,
  theme: Theme,
  isError: boolean,
  lastComponent: Component | undefined,
  args?: unknown,
): Component {
  const inputBody = formatToolInputArgs(args);
  const outputBody = body;

  if (inputBody.trim() || outputBody.trim()) {
    if (isExpandedToolIoView(lastComponent)) {
      lastComponent.setContent(inputBody, outputBody, isError);
      return lastComponent;
    }
    return new ExpandedToolIoView(theme, inputBody, outputBody, isError);
  }
  return new Text(theme.fg(isError ? "error" : "muted", renderCollapsedToolResult("Done")), 0, 0);
}

// ── task tools ───────────────────────────────────────────────────────────────

/** edit 成功结果里的 diff 文本（details.diff，+/- 前缀行带行号）。 */
function editDiffOf(result: AgentToolResult<unknown>): string | undefined {
  if (result.details === undefined || result.details === null || typeof result.details !== "object") {
    return undefined;
  }
  if (!("diff" in result.details)) return undefined;
  const diff = (result.details as { diff?: unknown }).diff;
  return typeof diff === "string" ? diff : undefined;
}

/** 统计 diff 的增删行数，输出 "+N -M" 文本。 */
function diffStatsText(diff: string): string {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return `+${add} -${del}`;
}

/** 展开态渲染 edit 的 diff：新增/删除/上下文行分别着色（无词级高亮）。 */
function renderEditDiff(diff: string, theme: Theme): Text {
  const lines = diff.split("\n").map((line) => {
    const color: ThemeColor = line.startsWith("+")
      ? "toolDiffAdded"
      : line.startsWith("-")
        ? "toolDiffRemoved"
        : "toolDiffContext";
    return theme.fg(color, line);
  });
  return new Text(lines.join("\n"), 0, 0);
}

type ParsedTask = { id: string; status: string; subject: string };

function parseTaskList(text: string): ParsedTask[] {
  return text
    .split("\n")
    .map((line) => line.match(/^#(\d+) \[([^\]]+)] (.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ id: match[1]!, status: match[2]!, subject: match[3]! }));
}

function taskListSummary(tasks: ParsedTask[]): string {
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const task of tasks) {
    if (task.status in counts) counts[task.status as keyof typeof counts]++;
  }
  return [
    `${tasks.length} tasks`,
    counts.in_progress ? `${counts.in_progress} in progress` : "",
    counts.pending ? `${counts.pending} pending` : "",
    counts.completed ? `${counts.completed} completed` : "",
  ]
    .filter(Boolean)
    .join(" • ");
}

function renderExpandedTaskResult(
  toolName: string,
  text: string,
  theme: Theme,
  isError: boolean,
): Component | undefined {
  if (isError) return undefined;
  if (toolName === "TaskList") {
    const tasks = parseTaskList(text);
    if (!tasks.length) return undefined;
    const limit = EXPANDED_PREVIEW_MAX_LINES;
    const rows = tasks.slice(0, limit).map((task) => {
      const color: ThemeColor =
        task.status === "completed" ? "success" : task.status === "in_progress" ? "warning" : "muted";
      return `${theme.fg("accent", `#${task.id}`)} ${theme.fg(color, task.status)} ${theme.fg("dim", task.subject)}`;
    });
    if (tasks.length > rows.length) {
      rows.push(theme.fg("muted", `… ${tasks.length - rows.length} more tasks`));
    }
    // 贴左：外层展开卡片 Box(1,1) 提供 1 格 padding
    return new Text(
      `↳ ${theme.fg("muted", taskListSummary(tasks))}\n${rows.map((row) => `  ${row}`).join("\n")}`,
      0,
      0,
    );
  }
  const line = text.trim();
  if (!line || line.includes("\n")) return undefined;
  let formatted: string | undefined;
  let match: RegExpMatchArray | null;
  if (toolName === "TaskCreate" && (match = line.match(/^Task #(\d+) created successfully: (.+)$/))) {
    formatted = `${theme.fg("success", "Created task")} ${theme.fg("accent", `#${match[1] ?? ""}`)} ${theme.fg("muted", match[2] ?? "")}`;
  } else if (toolName === "TaskUpdate" && (match = line.match(/^Updated task #(\d+) (.+)$/))) {
    formatted = `${theme.fg("success", "Updated task")} ${theme.fg("accent", `#${match[1] ?? ""}`)} ${theme.fg("muted", match[2] ?? "")}`;
  } else if (toolName === "TaskExecute") {
    formatted = `${theme.fg("success", "Started")} ${theme.fg("muted", line)}`;
  } else if (toolName === "TaskStop") {
    formatted = `${theme.fg("success", "Stopped")} ${theme.fg("muted", line)}`;
  }
  return formatted ? new Text(`↳ ${formatted}`, 0, 0) : undefined;
}

// ── call summary ─────────────────────────────────────────────────────────────

function humanizeToolLabel(label: string): string {
  return label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function singleToolCallSummary(toolName: string, label: string, args: unknown): { main: string; detail: string } {
  const title = label === toolName ? humanizeToolLabel(label) : label;
  if (!args || typeof args !== "object") return { main: title, detail: "" };
  const record = args as Record<string, unknown>;
  const value = (fallback: string, ...keys: string[]) => {
    const found = keys
      .map((key) => record[key])
      .find((item): item is string => typeof item === "string" && item.length > 0);
    return `${title} ${oneLine(found || fallback, 96)}`;
  };
  // pico 定制工具：复用 tool-render 的摘要逻辑（todoWrite 统计、lsp 定位、
  // memory 命令、vision 图像路径、web 查询）。askUserQuestion 走下方通用
  // question 分支，subagent 有独立分支。
  if (PICO_TOOL_SUMMARIES[toolName]) {
    return { main: `${title} ${summarizeToolCall(toolName, args)}`, detail: "" };
  }
  if (toolName === "subagent" || toolName === "subagent_wait") {
    const role =
      record.subagent_type ?? record.agent ?? record.agent_type ?? record.description ?? record.prompt;
    return {
      main: `${title} ${oneLine(typeof role === "string" ? role : "run subagent", 96)}`,
      detail: "",
    };
  }
  if (toolName === "agents") {
    return { main: value("launch agents", "description", "prompt"), detail: "" };
  }
  if (toolName === "skill") return { main: value("run skill", "name"), detail: "" };
  if (toolName === "enterplanmode" || toolName === "enter_plan_mode") {
    return { main: `${title} enable read-only planning`, detail: "" };
  }
  if (toolName === "exitplanmode" || toolName === "exit_plan_mode") {
    return { main: `${title} present plan`, detail: "" };
  }
  if (toolName === "taskcreate") return { main: value("create task", "subject"), detail: "" };
  if (toolName === "tasklist") return { main: `${title} task list`, detail: "" };
  if (toolName === "taskget" || toolName === "taskupdate") {
    return { main: value("task", "taskId", "task_id"), detail: "" };
  }
  if (toolName === "taskoutput" || toolName === "taskstop") {
    return { main: value("background task", "task_id", "taskId"), detail: "" };
  }
  if (toolName === "taskexecute") {
    const rawIds = Array.isArray(record.task_ids) ? record.task_ids : Array.isArray(record.taskIds) ? record.taskIds : [];
    const ids = rawIds.filter((id): id is string | number => typeof id === "string" || typeof id === "number");
    return {
      main: `${title} ${ids.length ? `${ids[0]}${ids.length > 1 ? ` (+${ids.length - 1} tasks)` : ""}` : "start tasks"}`,
      detail: "",
    };
  }
  if (toolName === "read") {
    const details = [
      record.offset !== undefined ? `offset=${record.offset}` : "",
      record.limit !== undefined ? `limit=${record.limit}` : "",
    ].filter(Boolean);
    return {
      main: `${title}${typeof record.path === "string" ? ` ${oneLine(record.path, 96)}` : ""}`,
      detail: details.length ? ` (${details.join(", ")})` : "",
    };
  }
  const preferred =
    record.path ??
    record.file_path ??
    record.command ??
    record.query ??
    record.question ??
    record.pattern ??
    record.url ??
    record.name ??
    record.tool_use_id ??
    record.toolCallId ??
    record.id ??
    record.message;
  return {
    main:
      preferred !== undefined && preferred !== null && typeof preferred !== "object"
        ? `${title} ${oneLine(String(preferred), 96)}`
        : title,
    detail: "",
  };
}

// ── wrapped tool definition ──────────────────────────────────────────────────

/** CC-style call/result renderers wrapping any tool definition. */
function createCcstyleTool(originalTool: { name: string; label?: string }): WrappedTool {
  const toolName = originalTool.name;
  const label = originalTool.label || toolName;

  const wrapped: WrappedTool = {
    name: toolName,
    label,
    renderShell: "self",
    renderCall(args: unknown, theme: Theme, context: RenderContext): Component {
      const visualState = resolveToolVisualState(context);
      const isPending =
        visualState === "pending" ||
        (!visualState && (context.isPartial || context.executionStarted));
      if (isPending) scheduleAnimation(context);
      const rawIcon = isPending
        ? toolLoadingIcon()
        : visualState === "success"
          ? "✓"
          : visualState === "error"
            ? "✗"
            : "●";
      const icon = theme.fg(toolIconColor(context), rawIcon);
      const summary = singleToolCallSummary(toolName, label, args);
      const expanded = Boolean(context.expanded);
      let cachedWidth: number | undefined;
      let cachedLine: string | undefined;
      return {
        render(width: number): string[] {
          if (cachedLine !== undefined && cachedWidth === width) return [cachedLine];
          const viewportWidth = toolViewportWidth(width);
          // 展开态贴左（外层 Box 已 pad 1）；折叠 self-shell 保留 1 格前导空格
          const lead = expanded ? "" : " ";
          const callWidth = Math.max(0, viewportWidth - visibleWidth(icon) - 1 - (expanded ? 0 : 1));
          const mainWidth = Math.max(0, callWidth - visibleWidth(summary.detail));
          cachedWidth = width;
          cachedLine = `${lead}${icon} ${theme.fg("toolTitle", headTruncateToWidth(summary.main, mainWidth))}${theme.fg("dim", summary.detail)}`;
          return [truncateToWidth(cachedLine, viewportWidth, "")];
        },
        invalidate() {},
      };
    },
    renderResult(
      result: AgentToolResult<unknown>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: RenderContext,
    ): Component {
      // write/edit 结果落地时自动展开一次并保持展开（ccstyleToolExpanded 持久）；
      // 用户显式折叠（setExpanded(false) 包装）会清除该标记。
      const settled = !options.isPartial;
      const autoExpands = toolName === "write" || toolName === "edit";
      const firstSettle =
        autoExpands &&
        settled &&
        !context.state.ccstyleUserCollapsed &&
        context.state.ccstyleAutoExpanded === undefined;
      if (firstSettle) {
        context.state.ccstyleAutoExpanded = true;
        context.state.ccstyleToolExpanded = true;
      }
      const expanded = isToolExpanded(options, context);
      if (options.isPartial) {
        // 运行中（isPartial）透传原工具 renderResult：subagent 的运行中面板
        // （● agent (user) · 运行中… + turns/usage 实时增长）与 bash 的实时
        // 计时器不被折叠摘要吞掉。仅注册了 renderCall 的工具退回 Pending…。
        // getResultRenderer 补丁在每次 updateDisplay 时刷新 wrapped 上的
        // originalRenderResult（renderResult 以裸函数调用，不能依赖 this）。
        const original = wrapped.originalRenderResult;
        if (original) {
          return original(result, options, theme, context);
        }
        return new Text(theme.fg("muted", expanded ? "↳ Pending…" : "   ↳ Pending…"), 0, 0);
      }
      // 落地：清理 partial 透传期间原渲染器可能启动的计时器。上游 bash
      // renderResult 在 rendererState.interval 放 1s invalidate interval，
      // 只在 isPartial=false 调用时 clearInterval——ccstyle 接管后落地不再
      // 调用原渲染器，须在此兜底清理，避免组件永久每秒重渲染。
      if (context.state.interval !== undefined) {
        clearInterval(context.state.interval as ReturnType<typeof setInterval>);
        delete context.state.interval;
      }
      const isError = context.isError;
      setToolVisualState(context, isError ? "error" : "success");
      const text = textFromResult(result, expanded);
      const args = context.args;
      // edit 的成功结果带 details.diff（+/- 行带行号）——折叠统计、展开着色展示。
      const editDiff = toolName === "edit" && !isError ? editDiffOf(result) : undefined;
      if (expanded && editDiff) {
        return renderEditDiff(editDiff, theme);
      }
      if (expanded) {
        const taskResult = renderExpandedTaskResult(toolName, text, theme, isError);
        if (taskResult) return taskResult;
      }
      const tasks = !isError && toolName === "TaskList" ? parseTaskList(text) : [];
      const outputLines = outputLineCount(result) || countLines(text);
      const lineWord = outputLines === 1 ? "line" : "lines";
      const action = toolName === "read" ? "loaded" : "returned";
      // write 的结果首行是成功摘要（Successfully wrote N bytes to <path>），
      // 后续常有 LSP 诊断噪音行——折叠态只展示首行。
      const writeSummary =
        toolName === "write" && !isError && text ? oneLine(text.split("\n")[0] ?? "", 72) : "";
      const rendered = tasks.length
        ? taskListSummary(tasks)
        : isError
          ? text
            ? oneLine(text, 72)
            : "Failed"
          : editDiff
            ? diffStatsText(editDiff)
            : writeSummary || (outputLines ? `${outputLines} ${lineWord} ${action}` : "Done");
      if (expanded) {
        return renderExpandedToolResult(text || "", theme, isError, context.lastComponent, args);
      }
      context.state.ccstyleIoView = undefined;
      const expandable = tasks.length > 0 || editDiff !== undefined || hasExpandableDetail(text, args);
      const hint = expandable ? ` ${theme.fg("dim", `• ${ccHint()}`)}` : "";
      const color: ThemeColor = isError ? "error" : "muted";
      return {
        render(width: number): string[] {
          return [theme.fg(color, renderCollapsedToolResultToWidth(rendered, hint, width))];
        },
        invalidate() {},
      };
    },
  };
  return wrapped;
}

// ── global tool rendering patch ──────────────────────────────────────────────

type GlobalToolRenderPatch = {
  active: boolean;
  enabled: () => boolean;
  wrap: (tool: { name: string; label?: string }) => WrappedTool;
  byName: Map<string, WrappedTool>;
  downstream: PatchedMethods;
  installed: PatchedMethods;
  prototype: PatchedMethods;
};

/**
 * Prototype methods we override on ToolExecutionComponent. Upstream d.ts
 * declares them private, but they are plain prototype methods at runtime —
 * this is the documented monkey-patch boundary of the ccstyle port.
 */
type PatchedMethods = {
  hasRendererDefinition(...args: unknown[]): boolean;
  getRenderShell(...args: unknown[]): string;
  getCallRenderer(...args: unknown[]): unknown;
  getResultRenderer(...args: unknown[]): unknown;
  updateDisplay(...args: unknown[]): void;
  setExpanded(expanded: boolean): void;
};

const GLOBAL_TOOL_RENDER_PATCH = Symbol.for("pico.ccstyle.global-tool-render-patch");

let currentPatch: GlobalToolRenderPatch | undefined;
let currentTheme: Theme | undefined;
let currentHooks: DefaultModeHooks | undefined;

export function setCcstyleTheme(theme: Theme): void {
  currentTheme = theme;
}

function shouldGloballyStyleTool(component: ToolComponent): boolean {
  // 接管全部工具：上游内置与 pico 定制工具
  // （ask/lsp/memory/todo/subagent 等）统一走 ccstyle 卡片。渲染与执行
  // 解耦——替换渲染器不影响工具执行。pico 定制工具的折叠摘要由
  // singleToolCallSummary 的专用分支保证（见 summarizeToolCall 复用）。
  return currentPatch?.active === true && currentPatch.enabled();
}

/** Swap which shell container sits in the component's children. */
function syncToolShell(component: ToolComponent, shell: "default" | "self"): void {
  const internals = component as unknown as {
    contentBox?: Component;
    selfRenderContainer?: Component;
    contentText?: Component;
  };
  const target = shell === "self" ? internals.selfRenderContainer : internals.contentBox;
  if (!target) return;
  const candidates = new Set<Component>(
    [internals.contentText, internals.contentBox, internals.selfRenderContainer].filter(
      (item): item is Component => item !== undefined,
    ),
  );
  const indexes = component.children
    .map((child, index) => (candidates.has(child) ? index : -1))
    .filter((index) => index >= 0);
  const targetIndex = indexes[0];
  // 构造期 getRenderShell 先于 Pi 挂载 shell；此处勿挂载，否则构造器会二次添加。
  if (targetIndex === undefined) return;
  component.children[targetIndex] = target;
  for (const index of indexes.sort((left, right) => right - left)) {
    if (index !== targetIndex) component.children.splice(index, 1);
  }
}

function getGloballyStyledTool(name: string, patch: GlobalToolRenderPatch): WrappedTool {
  let wrapped = patch.byName.get(name);
  if (!wrapped) {
    wrapped = patch.wrap({ name, label: name });
    patch.byName.set(name, wrapped);
  }
  return wrapped;
}

function disconnectPatch(patch: GlobalToolRenderPatch | undefined): void {
  if (!patch) return;
  patch.active = false;
  patch.enabled = () => false;
  patch.byName.clear();
}

function installGlobalToolRendering(enabled: () => boolean): GlobalToolRenderPatch {
  const prototype = ToolExecutionComponent.prototype as unknown as PatchedMethods;
  const previous = currentPatch;
  // Snapshot method VALUES, not the prototype object: assigning
  // prototype.updateDisplay below must not mutate what downstream holds.
  const current: PatchedMethods = {
    hasRendererDefinition: prototype.hasRendererDefinition,
    getRenderShell: prototype.getRenderShell,
    getCallRenderer: prototype.getCallRenderer,
    getResultRenderer: prototype.getResultRenderer,
    updateDisplay: prototype.updateDisplay,
    setExpanded: prototype.setExpanded,
  };
  const downstream: PatchedMethods = previous
    ? {
        hasRendererDefinition:
          current.hasRendererDefinition === previous.installed.hasRendererDefinition
            ? previous.downstream.hasRendererDefinition
            : current.hasRendererDefinition,
        getRenderShell:
          current.getRenderShell === previous.installed.getRenderShell
            ? previous.downstream.getRenderShell
            : current.getRenderShell,
        getCallRenderer:
          current.getCallRenderer === previous.installed.getCallRenderer
            ? previous.downstream.getCallRenderer
            : current.getCallRenderer,
        getResultRenderer:
          current.getResultRenderer === previous.installed.getResultRenderer
            ? previous.downstream.getResultRenderer
            : current.getResultRenderer,
        updateDisplay:
          current.updateDisplay === previous.installed.updateDisplay
            ? previous.downstream.updateDisplay
            : current.updateDisplay,
        setExpanded:
          current.setExpanded === previous.installed.setExpanded
            ? previous.downstream.setExpanded
            : current.setExpanded,
      }
    : current;
  // 外部仍持有的旧 wrapper 先变为 pass-through，再挂新安装。
  disconnectPatch(previous);

  const patch: GlobalToolRenderPatch = {
    active: true,
    enabled,
    wrap: (tool) => createCcstyleTool(tool),
    byName: new Map(),
    downstream,
    installed: undefined as unknown as PatchedMethods,
    prototype,
  };

  patch.installed = {
    hasRendererDefinition: function (this: ToolExecutionComponent, ...args: unknown[]): boolean {
      const tool = asTool(this);
      if (tool !== undefined && shouldGloballyStyleTool(tool)) return true;
      return patch.downstream.hasRendererDefinition.apply(this, args);
    },
    getRenderShell: function (this: ToolExecutionComponent, ...args: unknown[]): string {
      if (!patch.active) return patch.downstream.getRenderShell.apply(this, args);
      const tool = asTool(this);
      const useCcstyle = tool !== undefined && shouldGloballyStyleTool(tool);
      const shell =
        useCcstyle && !tool.expanded ? "self" : useCcstyle ? "default" : patch.downstream.getRenderShell.apply(this, args);
      if (tool !== undefined) syncToolShell(tool, shell as "default" | "self");
      return shell;
    },
    getCallRenderer: function (this: ToolExecutionComponent, ...args: unknown[]): unknown {
      const tool = asTool(this);
      if (tool !== undefined && shouldGloballyStyleTool(tool)) {
        return getGloballyStyledTool(tool.toolName, patch).renderCall;
      }
      return patch.downstream.getCallRenderer.apply(this, args);
    },
    getResultRenderer: function (this: ToolExecutionComponent, ...args: unknown[]): unknown {
      const tool = asTool(this);
      if (tool !== undefined && shouldGloballyStyleTool(tool)) {
        const wrapped = getGloballyStyledTool(tool.toolName, patch);
        // 每次 updateDisplay 都会先解析再调用：把原渲染器挂到缓存的 wrapper
        // 上，供 renderResult 的 isPartial 分支透传（同一次 updateDisplay 内
        // 即时读取；无 renderResult 的工具为 undefined，退回 Pending…）。
        const original = patch.downstream.getResultRenderer.apply(this, args);
        wrapped.originalRenderResult =
          typeof original === "function" ? (original as WrappedTool["renderResult"]) : undefined;
        return wrapped.renderResult;
      }
      return patch.downstream.getResultRenderer.apply(this, args);
    },
    updateDisplay: function (this: ToolExecutionComponent, ...args: unknown[]): void {
      patch.downstream.updateDisplay.apply(this, args);
      const tool = asTool(this);
      if (!patch.active || !patch.enabled() || tool === undefined || !tool.expanded) return;
      const theme = currentTheme;
      if (!theme) return;
      const contentBox = boxOf(this);
      if (!contentBox) return;
      contentBox.paddingX = 1;
      contentBox.paddingY = 1;
      contentBox.setBgFn?.((text: string) => theme.bg("userMessageBg", text));
    },
    setExpanded: function (this: ToolExecutionComponent, expanded: boolean): void {
      if (!expanded) {
        // 用户在自动展开之后显式折叠（全局 ctrl+o / 鼠标点击收起）：
        // 清除自动展开标记并永久记住，避免下一次渲染又按 firstSettle 展开。
        // 组件创建时上游也调 setExpanded(false)，但那时 autoExpanded 尚未
        // 设置（undefined），此分支不触发。
        const internals = this as unknown as { rendererState?: Record<string, unknown> };
        const state = internals.rendererState;
        if (state && state.ccstyleAutoExpanded === true) {
          delete state.ccstyleAutoExpanded;
          delete state.ccstyleToolExpanded;
          state.ccstyleUserCollapsed = true;
        }
      }
      patch.downstream.setExpanded.apply(this, [expanded]);
    },
  };

  prototype.hasRendererDefinition = patch.installed.hasRendererDefinition;
  prototype.getRenderShell = patch.installed.getRenderShell;
  prototype.getCallRenderer = patch.installed.getCallRenderer;
  prototype.getResultRenderer = patch.installed.getResultRenderer;
  prototype.updateDisplay = patch.installed.updateDisplay;
  prototype.setExpanded = patch.installed.setExpanded;
  currentPatch = patch;
  return patch;
}

/** Runtime-only contentBox on ToolExecutionComponent (d.ts declares it private). */
function boxOf(component: ToolExecutionComponent): { paddingX: number; paddingY: number; setBgFn?(fn: (text: string) => string): void } | undefined {
  const internals = component as unknown as { contentBox?: { paddingX: number; paddingY: number; setBgFn?(fn: (text: string) => string): void } };
  return internals.contentBox;
}

export type DefaultModeHooks = {
  /** 本安装是否仍持有全局工具渲染补丁。 */
  isOwner(): boolean;
  shutdown(): void;
};

export function installDefaultMode(enabled: () => boolean = () => true): DefaultModeHooks {
  const patch = installGlobalToolRendering(enabled);
  const hooks: DefaultModeHooks = {
    isOwner() {
      return currentPatch === patch && patch.active;
    },
    shutdown() {
      if (currentPatch !== patch) return;
      disconnectPatch(patch);
      const prototype = patch.prototype;
      if (prototype.hasRendererDefinition === patch.installed.hasRendererDefinition) {
        prototype.hasRendererDefinition = patch.downstream.hasRendererDefinition;
      }
      if (prototype.getRenderShell === patch.installed.getRenderShell) {
        prototype.getRenderShell = patch.downstream.getRenderShell;
      }
      if (prototype.getCallRenderer === patch.installed.getCallRenderer) {
        prototype.getCallRenderer = patch.downstream.getCallRenderer;
      }
      if (prototype.getResultRenderer === patch.installed.getResultRenderer) {
        prototype.getResultRenderer = patch.downstream.getResultRenderer;
      }
      if (prototype.updateDisplay === patch.installed.updateDisplay) {
        prototype.updateDisplay = patch.downstream.updateDisplay;
      }
      if (prototype.setExpanded === patch.installed.setExpanded) {
        prototype.setExpanded = patch.downstream.setExpanded;
      }
      currentPatch = undefined;
    },
  };
  currentHooks = hooks;
  return hooks;
}

/** Test hook: deactivate any live render patch and reset shared state. */
export function __resetCcstyleRenderForTests(): void {
  currentHooks?.shutdown();
  currentHooks = undefined;
  currentTheme = undefined;
  clearAllAnimations();
}
