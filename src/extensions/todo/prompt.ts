/**
 * Tool prompt + UI rendering for the todo extension.
 *
 * The PROMPT below is a heavily-condensed version of claude-code's
 * TodoWriteTool prompt (see claude-code/packages/builtin-tools/.../prompt.ts).
 * We strip the long examples; the rules survive.
 */
import TODO_PROMPT from "../../prompts/todo-tool.md" with { type: "text" };
export {
  formatTodoList,
} from "./display.ts";

export { TODO_PROMPT };

export const TODO_DESCRIPTION =
  "Maintain a session task checklist. Call to create, update, or clear the list. Each entry needs `content` (imperative) and `activeForm` (present continuous). Mark exactly ONE item as in_progress; finish it before starting another. Update the list as work progresses, not in batches at the end.";
