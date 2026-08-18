import { keyText } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "../ui/rendering.ts";
import { summarizeToolCall } from "../tool-render.ts";

/**
 * Shared helpers for the ccstyle (Claude Code style) rendering layer.
 *
 * Ported from pi-cc-extensions (MIT, minuque/pi-cc-extensions v0.8.54) —
 * trimmed to the pieces pico needs: tool-card summaries, grouping, and the
 * expanded Input/Output view. Mouse interaction and edit diff are implemented
 * (contrary to earlier comments).
 */

/** pico 定制工具中 summarizeToolCall 有有意义输出的那些。 */
export const PICO_TOOL_SUMMARIES: Record<string, true> = {
  askUserQuestion: true,
  todoWrite: true,
  lsp: true,
  memory: true,
  visionAnalyze: true,
  webSearch: true,
  webFetch: true,
};

export const TOOL_LOADING_INTERVAL_MS = 80;

const BRAILLE_LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Rotating braille spinner frame for pending tool calls. */
export function toolLoadingIcon(now = Date.now()): string {
  return BRAILLE_LOADING_FRAMES[
    Math.floor(now / TOOL_LOADING_INTERVAL_MS) % BRAILLE_LOADING_FRAMES.length
  ]!;
}

/** "ctrl+o to show more" — resolves the actual bound expand shortcut. */
export function ccHint(): string {
  return `${keyText("app.tools.expand")} to show more`;
}

/** Collapse whitespace and truncate to max chars — for one-line summaries. */
export function oneLine(text: string, max = 96): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Strip ANSI/control sequences from tool result text before it reaches the
 * terminal. Like pico's sanitizeTerminalText but stricter: results can carry
 * stray ESC bytes that survived CSI stripping, plus CRLF from captured
 * terminal output. Optional maxChars bounds the work for preview paths.
 */
export function sanitizeToolResultText(value: string, maxChars?: number): string {
  const source =
    typeof maxChars === "number" && maxChars >= 0 && value.length > maxChars
      ? value.slice(0, maxChars)
      : value;
  return sanitizeTerminalText(source)
    .replace(/\x1B/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

// ----------------------------------------------------------------------------
// 共享摘要逻辑（singleToolCallSummary 与 toolSummary 合并）
// ----------------------------------------------------------------------------

/** 工具名可读化 */
export function humanizeToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * 工具调用摘要：主函数，合并了 render.ts 的 singleToolCallSummary 与
 * grouping.ts 的 toolSummary 的所有分支。
 * @param toolName 工具名称（如 "bash"）
 * @param args 参数对象
 * @param label 可选显示标签，若与 toolName 不同则优先使用
 * @returns { main: 主摘要, detail: 附加信息（如 offset/limit）}
 */
export function toolCallSummary(
  toolName: string,
  args: unknown,
  label?: string,
): { main: string; detail: string } {
  const title = label && label !== toolName ? label : humanizeToolName(toolName);
  if (!args || typeof args !== "object") return { main: title, detail: "" };
  const record = args as Record<string, unknown>;
  const value = (fallback: string, ...keys: string[]) => {
    const found = keys
      .map((key) => record[key])
      .find((item): item is string => typeof item === "string" && item.length > 0);
    return `${title} ${oneLine(found || fallback, 96)}`;
  };
  const lowerName = toolName.toLowerCase();

  // pico 定制工具
  if (PICO_TOOL_SUMMARIES[toolName]) {
    return { main: `${title} ${summarizeToolCall(toolName, args)}`, detail: "" };
  }

  // subagent
  if (lowerName === "subagent" || lowerName === "subagent_wait") {
    const role = record.subagent_type ?? record.agent ?? record.agent_type ?? record.description ?? record.prompt;
    return {
      main: `${title} ${oneLine(typeof role === "string" ? role : "run subagent", 96)}`,
      detail: "",
    };
  }

  // agent / agents
  if (lowerName === "agent" || lowerName === "agents") {
    const displayName = record.subagent_type ?? record.agent_type ?? record.agent;
    if (typeof displayName === "string" && displayName) {
      return { main: `${title} ${displayName}`, detail: "" };
    }
    return {
      main: value(lowerName === "agent" ? "launch agent" : "launch agents", "description", "prompt"),
      detail: "",
    };
  }

  // get_subagent_result / steer_subagent
  if (lowerName === "get_subagent_result" || lowerName === "steer_subagent") {
    return {
      main: value(lowerName === "get_subagent_result" ? "agent result" : "steer agent", "agent_id"),
      detail: "",
    };
  }

  // skill
  if (lowerName === "skill") return { main: value("run skill", "name"), detail: "" };

  // plan 模式
  if (lowerName === "enterplanmode" || lowerName === "enter_plan_mode") {
    return { main: `${title} enable read-only planning`, detail: "" };
  }
  if (lowerName === "exitplanmode" || lowerName === "exit_plan_mode") {
    return { main: `${title} present plan`, detail: "" };
  }

  // Task 系列
  if (lowerName === "taskcreate") return { main: value("create task", "subject"), detail: "" };
  if (lowerName === "tasklist") return { main: `${title} task list`, detail: "" };
  if (lowerName === "taskget" || lowerName === "taskupdate") {
    return { main: value("task", "taskId", "task_id"), detail: "" };
  }
  if (lowerName === "taskoutput" || lowerName === "taskstop") {
    return { main: value("background task", "task_id", "taskId"), detail: "" };
  }
  if (lowerName === "taskexecute") {
    const rawIds = Array.isArray(record.task_ids) ? record.task_ids : Array.isArray(record.taskIds) ? record.taskIds : [];
    const ids = rawIds.filter((id): id is string | number => typeof id === "string" || typeof id === "number");
    return {
      main: `${title} ${ids.length ? `${ids[0]}${ids.length > 1 ? ` (+${ids.length - 1} tasks)` : ""}` : "start tasks"}`,
      detail: "",
    };
  }

  // read
  if (lowerName === "read") {
    const details = [
      record.offset !== undefined ? `offset=${record.offset}` : "",
      record.limit !== undefined ? `limit=${record.limit}` : "",
    ].filter(Boolean);
    return {
      main: `${title}${typeof record.path === "string" ? ` ${oneLine(record.path, 96)}` : ""}`,
      detail: details.length ? ` (${details.join(", ")})` : "",
    };
  }

  // bash
  if (lowerName === "bash") {
    return { main: `Bash ${oneLine(typeof record.command === "string" ? record.command : "...", 96)}`, detail: "" };
  }

  // grep
  if (lowerName === "grep") {
    const pattern = oneLine(typeof record.pattern === "string" ? record.pattern : "...", 96);
    return {
      main: `Grep ${JSON.stringify(pattern)}${typeof record.path === "string" ? ` in ${oneLine(record.path, 96)}` : ""}`,
      detail: "",
    };
  }

  // find
  if (lowerName === "find") {
    const pattern = oneLine(typeof record.pattern === "string" ? record.pattern : "...", 96);
    return {
      main: `Find ${JSON.stringify(pattern)}${typeof record.path === "string" ? ` in ${oneLine(record.path, 96)}` : ""}`,
      detail: "",
    };
  }

  // 通用 preferred（合并两个实现的字段）
  const preferred =
    record.agent_id ??
    record.path ??
    record.file_path ??
    record.command ??
    record.query ??
    record.question ??
    record.pattern ??
    record.url ??
    record.name ??
    record.description ??
    record.prompt ??
    record.action ??
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

// ----------------------------------------------------------------------------
// 摘要缓存（按 toolCallId）
// ----------------------------------------------------------------------------

const summaryCache = new Map<string, { main: string; detail: string }>();

/**
 * 获取缓存的工具摘要，若不存在则计算并缓存。
 * 用于 render.ts 的单卡和 grouping.ts 的分组，共享同一缓存。
 */
export function summaryOfTool(
  toolCallId: string,
  toolName: string,
  args: unknown,
  label?: string,
): { main: string; detail: string } {
  const cached = summaryCache.get(toolCallId);
  if (cached) return cached;
  const summary = toolCallSummary(toolName, args, label);
  summaryCache.set(toolCallId, summary);
  return summary;
}

/** 测试钩子：重置摘要缓存 */
export function __resetToolSummaryCacheForTests(): void {
  summaryCache.clear();
}

/** 测试钩子：缓存大小 */
export function __toolSummaryCacheSize(): number {
  return summaryCache.size;
}
