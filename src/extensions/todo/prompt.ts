/**
 * Tool prompt + UI rendering for the todo extension.
 *
 * The PROMPT below is a heavily-condensed version of claude-code's
 * TodoWriteTool prompt (see claude-code/packages/builtin-tools/.../prompt.ts).
 * We strip the long examples; the rules survive.
 */
import type { Todo } from "./schema.ts";
import TODO_PROMPT from "../../prompts/todo-tool.md" with { type: "text" };

export { TODO_PROMPT };

export const TODO_DESCRIPTION =
  "Maintain a session task checklist. Call to create, update, or clear the list. Each entry needs `content` (imperative) and `activeForm` (present continuous). Mark exactly ONE item as in_progress; finish it before starting another. Update the list as work progresses, not in batches at the end.";

export function formatTodoList(todos: Todo[]): string {
  if (todos.length === 0) return "_(no tasks)_";
  const icon = (s: Todo["status"]) =>
    s === "completed" ? "✓" : s === "in_progress" ? "⏳" : "☐";
  return todos
    .map((t) => {
      const label = t.status === "in_progress" ? t.activeForm : t.content;
      const id = t.id ? ` #${t.id}` : "";
      return `${icon(t.status)}${id} ${label}`;
    })
    .join("\n");
}

export function formatPendingReminder(todos: Todo[]): string {
  const open = todos.filter((t) => t.status !== "completed");
  if (open.length === 0) return "";
  const lines = open.map((t) => `- ${t.status === "in_progress" ? "⏳" : "☐"} ${t.content}`);
  return `## Open todos\n${lines.join("\n")}`;
}