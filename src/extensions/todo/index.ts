/**
 * srcode todo extension.
 *
 * Registers a `todoWrite` tool that the LLM uses to maintain a session task
 * list, plus a `/todo` slash command for the user to peek/clear it. State
 * lives in-process (TodoStore) keyed by current session id.
 */
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { renderToolCallText, renderToolResultText } from "../tool-render.ts";
import { formatPendingReminder, formatTodoList, TODO_DESCRIPTION, TODO_PROMPT } from "./prompt.ts";
import { TodoWriteParams } from "./schema.ts";
import { TodoStore } from "./store.ts";

const SESSION_FALLBACK = "__default__";

function sessionKey(ctx: { sessionManager?: { getSessionId?: () => string | undefined } }): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? SESSION_FALLBACK;
  } catch {
    return SESSION_FALLBACK;
  }
}

export const todoExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const store = new TodoStore();

  pi.registerTool(
    defineTool({
      name: "todoWrite",
      label: "Todo",
      description: TODO_DESCRIPTION,
      promptSnippet:
        "todoWrite — manage the session task list. Use for multi-step work; mark exactly one task in_progress.",
      promptGuidelines: [TODO_PROMPT],
      parameters: TodoWriteParams,
      renderCall(args, theme, context) {
        return renderToolCallText("todoWrite", args, theme, context);
      },
      renderResult(result, options, theme, context) {
        return renderToolResultText(result, options, theme, context);
      },
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const key = sessionKey(ctx);
        const result = store.commit(key, params.todos);

        // Render the new list back into the chat so it stays anchored above
        // the user's next message. CCB renders in-place; pi has no in-place
        // tool view we can rewrite, so we just emit a custom message.
        try {
          pi.sendMessage({
            customType: "srcode.todo",
            content: formatTodoList(result.newTodos),
            display: true,
          });
        } catch {
          // If we're in a non-TUI mode that drops custom messages, ignore.
        }

        const warnings: string[] = [];
        if (result.multipleInProgress) {
          warnings.push(
            "More than one task is marked in_progress. The rule is: exactly one active task at a time. Adjust the list on the next call.",
          );
        }

        const summary = {
          status: "ok",
          oldCount: result.oldTodos.length,
          newCount: result.newTodos.length,
          collapsed: result.collapsed,
          warnings,
          newTodos: result.newTodos,
        };

        const text =
          warnings.length > 0
            ? `${warnings.join(" ")}\n\nList updated.`
            : "Todos updated. Continue working through the list.";

        return {
          content: [{ type: "text" as const, text }],
          details: summary,
        };
      },
    }),
  );

  pi.registerCommand("todo", {
    description: "Show or clear the session todo list",
    handler: async (args, ctx) => {
      const cmd = args.trim().toLowerCase();
      const key = sessionKey(ctx);
      const lines: string[] = [];

      if (cmd === "clear") {
        store.reset(key);
        lines.push("Todo list cleared.");
      } else if (cmd === "" || cmd === "list" || cmd === "show") {
        const list = store.get(key);
        lines.push(`Session todos (${list.length}):`);
        lines.push(formatTodoList(list));
      } else {
        lines.push("Usage:");
        lines.push("  /todo            — show the current list");
        lines.push("  /todo clear      — drop everything");
      }

      pi.sendMessage({
        customType: "srcode.todo",
        content: lines.join("\n"),
        display: true,
      });
    },
  });

  // Switching/forking sessions resets the per-session view.
  pi.on("session_before_switch", () => {
    // We don't know which key is leaving — easiest to reset everything; the
    // next commit on the new session repopulates only its own slot.
    store.resetAll();
    return {};
  });
  pi.on("session_before_fork", () => {
    store.resetAll();
    return {};
  });

  // Nudge the model if a turn ends with open todos. The agent_end event
  // doesn't carry session context, so we surface a reminder only when the
  // store tracks a single active list (the common case during a normal turn).
  pi.on("agent_end", () => {
    const lists = store.allLists();
    if (lists.length !== 1) return;
    const reminder = formatPendingReminder(lists[0]!);
    if (!reminder) return;
    try {
      pi.sendMessage({
        customType: "srcode.todo.reminder",
        content: reminder,
        display: true,
      });
    } catch {}
  });
};
