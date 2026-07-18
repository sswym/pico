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

export function summarizeTodosCompact(todos: Todo[]): string {
  const completed = todos.filter((todo) => todo.status === "completed").length;
  return `${completed}/${todos.length}`;
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

export function formatPendingReminder(todos: Todo[]): string {
  const open = todos.filter((todo) => todo.status !== "completed");
  if (open.length === 0) return "";
  const lines = open.map((todo) => {
    const id = todo.id ? ` #${todo.id}` : "";
    return `- ${todoStatusIcon(todo.status)}${id} ${todo.content}`;
  });
  return `## Open todos\n${lines.join("\n")}`;
}
