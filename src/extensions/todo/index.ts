/**
 * pico todo extension.
 *
 * Registers a `todoWrite` tool that the LLM uses to maintain a session task
 * list, plus a `/todo` slash command for the user to peek/clear it. State
 * lives in-process (TodoStore) keyed by current session id.
 */
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { renderToolCallText, renderToolResultText } from "../tool-render.ts";
import { subscribeSessionExtensionEvent } from "../events.ts";
import { formatTodoList, TODO_DESCRIPTION, TODO_PROMPT } from "./prompt.ts";
import { TodoWriteParams } from "./schema.ts";
import { TodoStore } from "./store.ts";
import {
  clearTodoWidget,
  collapseTodoWidget,
  restoreTodoWidget,
  ensureTodoWidget,
  registerTodoShortcut,
  removeTodoWidgetState,
  syncTodoWidget,
  unregisterTodoWidget,
} from "./widget.ts";

const SESSION_FALLBACK = "__default__";

/** Last session_start ctx — used by the plan_mode_changed subscriber to
 * collapse the panel of the active session. */
let lastSessionCtx: ExtensionContext | null = null;

function sessionKey(ctx: { sessionManager?: { getSessionId?: () => string | undefined } }): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? SESSION_FALLBACK;
  } catch {
    return SESSION_FALLBACK;
  }
}

export const todoExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const store = new TodoStore();
  const readTodos = (ctx: ExtensionContext) => store.get(sessionKey(ctx));

  registerTodoShortcut(pi, readTodos);

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
        ensureTodoWidget(ctx, (session) => store.get(session));
        syncTodoWidget(ctx, (session) => store.get(session));

        const warnings: string[] = [];
        if (result.multipleInProgress) {
          warnings.push(
            "More than one task is marked in_progress. The rule is: exactly one active task at a time. Adjust the list on the next call.",
          );
        }
        if (result.duplicateIds.length > 0) {
          warnings.push(
            `Duplicate todo ids were reassigned: ${Array.from(new Set(result.duplicateIds)).join(", ")}. Use the returned ids on the next call.`,
          );
        }

        const summary = {
          status: "ok",
          oldCount: result.oldTodos.length,
          writtenCount: result.writtenTodos.length,
          storedCount: result.storedTodos.length,
          collapsed: result.collapsed,
          warnings,
          writtenTodos: result.writtenTodos,
          storedTodos: result.storedTodos,
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
        clearTodoWidget(ctx);
        lines.push("Todo list cleared.");
      } else if (cmd === "" || cmd === "list" || cmd === "show") {
        const list = store.get(key);
        ensureTodoWidget(ctx, (session) => store.get(session));
        syncTodoWidget(ctx, (session) => store.get(session));
        lines.push(`Session todos (${list.length}):`);
        lines.push(formatTodoList(list));
      } else {
        lines.push("Usage:");
        lines.push("  /todo            — show the current list");
        lines.push("  /todo clear      — drop everything");
      }

      pi.sendMessage({
        customType: "pico.todo",
        content: lines.join("\n"),
        display: true,
      });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    lastSessionCtx = ctx;
    ensureTodoWidget(ctx, (session) => store.get(session));
    syncTodoWidget(ctx, (session) => store.get(session));
  });

  // Plan mode suspends the todo panel: entering plan mode collapses it so
  // the stale in-flight task list does not sit above the plan discussion,
  // and exiting restores it for the execution phase. Session-scoped: /reload
  // re-runs the factory, so the subscription must not accumulate.
  subscribeSessionExtensionEvent("plan_mode_changed", ({ active }) => {
    if (!lastSessionCtx) return;
    if (active) collapseTodoWidget(lastSessionCtx);
    else restoreTodoWidget(lastSessionCtx);
  });

  // Switching/forking sessions clears only the active session's transient list.
  // The widget state (openIds/openContent) is keyed by session and must not
  // survive either — otherwise the old session's collapse state leaks into the
  // rebuilt widget.
  pi.on("session_before_switch", (_event, ctx) => {
    store.reset(sessionKey(ctx));
    unregisterTodoWidget(ctx);
    removeTodoWidgetState(sessionKey(ctx));
    return {};
  });
  pi.on("session_before_fork", (_event, ctx) => {
    store.reset(sessionKey(ctx));
    unregisterTodoWidget(ctx);
    removeTodoWidgetState(sessionKey(ctx));
    return {};
  });

  // /reload tears down extension widgets (pi's resetExtensionUI) but re-fires
  // session_start — dropping the registration here lets session_start rebuild it.
  pi.on("session_shutdown", (_event, ctx) => {
    unregisterTodoWidget(ctx);
  });

};
