/**
 * TodoWrite schema + constants.
 *
 * Mirrors the field shape used by claude-code's TodoWriteTool
 * (see claude-code/packages/builtin-tools/src/tools/TodoWriteTool/TodoWriteTool.ts:13-29)
 * but expressed as typebox so it composes with pi-coding-agent's tool runtime.
 */
import { Type, type Static } from "@earendil-works/pi-ai";

export const TodoStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
]);

export const TodoItem = Type.Object({
  content: Type.String({
    minLength: 1,
    maxLength: 200,
    description: "Imperative form describing the task. Example: 'Run tests'.",
  }),
  activeForm: Type.String({
    minLength: 1,
    maxLength: 400,
    description:
      "Present-continuous form shown while the task is in_progress. Example: 'Running tests'.",
  }),
  status: TodoStatus,
  id: Type.Optional(
    Type.String({
      maxLength: 64,
      description:
        "Stable identifier. Provide on first add to keep the same task across updates; auto-assigned otherwise.",
    }),
  ),
  phase: Type.Optional(
    Type.String({
      maxLength: 64,
      description:
        "Optional group label the task belongs to (e.g. a work phase like 'Foundation' or 'Verify'). Tasks sharing a phase are rendered together under one tree branch in the todo panel; omit for one-off tasks.",
    }),
  ),
});

export const TodoWriteParams = Type.Object({
  todos: Type.Array(TodoItem, {
    description:
      "Full updated todo list. Replaces the previous list — pass every item you want to keep, with their final statuses.",
  }),
});

export type Todo = Static<typeof TodoItem>;
