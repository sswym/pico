/**
 * Tool prompt + UI rendering for the todo extension.
 *
 * The PROMPT below is a heavily-condensed version of claude-code's
 * TodoWriteTool prompt (see claude-code/packages/builtin-tools/.../prompt.ts).
 * We strip the long examples; the rules survive.
 */
import type { Todo } from "./schema.ts";

export const TODO_DESCRIPTION =
  "Maintain a session task checklist. Call to create, update, or clear the list. Each entry needs `content` (imperative) and `activeForm` (present continuous). Mark exactly ONE item as in_progress; finish it before starting another. Update the list as work progresses, not in batches at the end.";

export const TODO_PROMPT = `Use this tool to track multi-step work in the current session. The list is visible to the user and helps them follow your progress.

## When to use

- Tasks with 3+ distinct steps
- Tasks where you might forget a step (rename across files, multi-feature work)
- The user provides a list of things to do (numbered or comma-separated)
- You discover new follow-up work mid-task — append it

## When NOT to use

- Single trivial step (one edit, one bash, one read)
- Pure Q&A or explanation
- Less than 3 real steps

## Rules

1. **Each item has two forms**:
   - \`content\`: imperative — "Fix the auth bug"
   - \`activeForm\`: present continuous — "Fixing the auth bug"
2. **Status values**: \`pending\` | \`in_progress\` | \`completed\`.
3. **Exactly one in_progress at a time**. Mark the previous task completed *before* starting the next.
4. **Mark completed only when fully done** — tests passing, file written, etc. Never call something done because you're tired of looking at it.
5. **Pass the full list every time** — the tool replaces, not patches. Drop entries that are no longer relevant.
6. **When every item is completed**, the next call will collapse the list to empty automatically; you don't need to clear it manually.
`;

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
