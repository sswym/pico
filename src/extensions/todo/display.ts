import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Todo } from "./schema.ts";
import { todoStatusIcon } from "../ui/rendering.ts";

export function todoLabel(todo: Todo): string {
  return todo.status === "in_progress" ? todo.activeForm : todo.content;
}

export function summarizeTodos(todos: Todo[]): string {
  if (todos.length === 0) return "No todos";
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.length - completed;
  return `${completed}/${todos.length} done · ${active} active`;
}

export function formatTodoLine(todo: Todo, theme?: Theme): string {
  const icon = todoStatusIcon(todo.status);
  const id = todo.id ? ` #${todo.id}` : "";
  const label = todoLabel(todo);
  if (!theme) return `${icon}${id} ${label}`;
  if (todo.status === "completed") return `${theme.fg("success", icon)}${id} ${theme.fg("dim", label)}`;
  if (todo.status === "in_progress") return `${theme.fg("warning", icon)}${id} ${theme.fg("accent", theme.bold(label))}`;
  return `${theme.fg("dim", icon)}${id} ${label}`;
}

export function formatTodoList(todos: Todo[]): string {
  if (todos.length === 0) return "_(no tasks)_";
  return todos.map((todo) => formatTodoLine(todo)).join("\n");
}

// ── 2026-08: oh-my-pi 风格分组树状面板 ────────────────────────────────────
//
// 渲染目标（参考 oh-my-pi 的 Todos HUD）：
//   Todos · 1/3
//    ├─ I. 实施 · 0/7
//    │  ├─ ☐ 阶段1: ...
//    │  └─ … 2 more todos
//    ├─ II. 验证 · 0/1
//    └─ III. 收尾 · 0/1
//
// 规则：todo 按 `phase` 字段分组（首次出现顺序）；激活 phase（含 in_progress
// 条目）展开任务子树（每组成多显示 TODO_TASK_WINDOW 条，超出折叠为
// "… N more todos"）；其余 phase 只显示标题行。无 phase 数据时退化为单组
// 平铺任务树。

export interface TodoPhaseGroup {
  name: string;
  todos: Todo[];
}

/** 每个 phase 最多展开显示的任务数（超出折叠）。 */
export const TODO_TASK_WINDOW = 5;

export function groupTodosByPhase(todos: Todo[]): TodoPhaseGroup[] {
  const groups: TodoPhaseGroup[] = [];
  const byName = new Map<string, TodoPhaseGroup>();
  for (const todo of todos) {
    const name = (todo.phase ?? "").trim();
    let group = byName.get(name);
    if (!group) {
      group = { name, todos: [] };
      byName.set(name, group);
      groups.push(group);
    }
    group.todos.push(todo);
  }
  return groups;
}

const ROMAN_PAIRS: ReadonlyArray<[number, string]> = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
  [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
  [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];

export function romanNumeral(oneBasedIndex: number): string {
  if (oneBasedIndex <= 0) return "";
  let rem = oneBasedIndex;
  let out = "";
  for (const [value, symbol] of ROMAN_PAIRS) {
    while (rem >= value) {
      out += symbol;
      rem -= value;
    }
  }
  return out;
}

/**
 * 每组成多可见窗口：锚定第一个未完成任务（正在做的工作不被已完成条目挤出
 * 窗口），最多 `cap` 条，两侧隐藏计数供折叠行展示。
 */
export function visibleTodoWindow(
  todos: Todo[],
  cap: number,
): { todos: Todo[]; start: number; hiddenBefore: number; hiddenAfter: number } {
  if (todos.length <= cap) {
    return { todos, start: 0, hiddenBefore: 0, hiddenAfter: 0 };
  }
  const firstOpen = todos.findIndex((todo) => todo.status !== "completed");
  const anchor = firstOpen === -1 ? todos.length - cap : firstOpen;
  const start = Math.max(0, Math.min(anchor - 1, todos.length - cap));
  const window = todos.slice(start, start + cap);
  return {
    todos: window,
    start,
    hiddenBefore: start,
    hiddenAfter: Math.max(0, todos.length - start - window.length),
  };
}

/** 一个 phase 的任务子树：`${childPrefix}├─ ☐ …` / 折叠行 `${childPrefix}└─ … N more todos`。 */
function formatTaskTree(todos: Todo[], childPrefix: string, theme: Theme): string[] {
  const window = visibleTodoWindow(todos, TODO_TASK_WINDOW);
  const out: string[] = [];
  if (window.hiddenBefore > 0) {
    out.push(`${childPrefix}${theme.fg("dim", `… ${window.hiddenBefore} completed`)}`);
  }
  const shown = window.todos;
  const hidden = window.hiddenAfter;
  for (let i = 0; i < shown.length; i++) {
    const isLast = i === shown.length - 1 && hidden === 0;
    const branch = isLast ? "└─ " : "├─ ";
    out.push(`${childPrefix}${branch}${formatTodoLine(shown[i]!, theme)}`);
  }
  if (hidden > 0) {
    out.push(`${childPrefix}└─ ${theme.fg("dim", `… ${hidden} more todos`)}`);
  }
  return out;
}

/**
 * 渲染分组树状 todo 面板主体（不含尾部快捷键提示行）。
 *
 * - 根标题 `Todos · 激活阶段序号/阶段总数`（多阶段时）；
 * - 每个 phase 一行 `├─ I. 名称 · 完成数/总数`（罗马数字序号）；
 * - 激活 phase 后跟任务子树，其它 phase 只显示标题行；
 * - 空列表返回 "no active todos"。
 */
export function formatTodoPanelLines(todos: Todo[], theme: Theme): string[] {
  const groups = groupTodosByPhase(todos);
  if (groups.length === 0) {
    return [theme.fg("dim", "no active todos")];
  }

  const multiPhase = groups.length > 1 || groups[0]!.name.trim() !== "";
  const activeIdx = groups.findIndex((group) =>
    group.todos.some((todo) => todo.status === "in_progress"),
  );
  const active = activeIdx === -1 ? 0 : activeIdx;

  const root =
    theme.fg("accent", theme.bold("Todos")) +
    (multiPhase ? theme.fg("dim", ` · ${active + 1}/${groups.length}`) : "");
  const lines = [root];

  if (!multiPhase) {
    // 无 phase 数据：单组平铺为任务树（退化视图，无子前缀）。
    lines.push(...formatTaskTree(groups[0]!.todos, "", theme));
    return lines;
  }

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    const isLastPhase = i === groups.length - 1;
    const branch = isLastPhase ? "└─ " : "├─ ";
    const done = group.todos.filter((todo) => todo.status === "completed").length;
    const label = `${romanNumeral(i + 1)}. ${group.name || "Tasks"}`;
    lines.push(`${branch}${theme.fg("muted", label)}${theme.fg("dim", ` · ${done}/${group.todos.length}`)}`);
    if (i === active) {
      lines.push(...formatTaskTree(group.todos, isLastPhase ? "   " : "│  ", theme));
    }
  }
  return lines;
}
