import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Todo } from "./schema.ts";
import {
  formatTodoLine,
  summarizeTodos,
} from "./display.ts";

export const TODO_WIDGET_KEY = "pico-todos";
export const TODO_STATUS_KEY = "todo";
export const TODO_SHORTCUT = Key.f7;
export const TODO_SHORTCUT_HINT = "F7";

const MAX_WIDGET_LINES = 14;
const BODY_WINDOW_LINES = 7;

interface TodoWidgetState {
  visible: boolean;
  collapsed: boolean;
  registered: boolean;
  openIds: Set<string>;
  openContent: Set<string>;
  tui?: { requestRender?: (force?: boolean) => void };
}

type TodoReader = (sessionKey: string) => Todo[];

const states = new Map<string, TodoWidgetState>();

function getState(sessionKey: string): TodoWidgetState {
  let state = states.get(sessionKey);
  if (!state) {
    state = { visible: false, collapsed: false, registered: false, openIds: new Set(), openContent: new Set() };
    states.set(sessionKey, state);
  }
  return state;
}

export function resetTodoWidgetStateForTests(): void {
  states.clear();
}

export { summarizeTodos };

function visibleTodoWindow(todos: Todo[]): { todos: Todo[]; start: number; hiddenBefore: number; hiddenAfter: number } {
  if (todos.length <= BODY_WINDOW_LINES) {
    return { todos, start: 0, hiddenBefore: 0, hiddenAfter: 0 };
  }

  const firstOpen = todos.findIndex((todo) => todo.status !== "completed");
  const anchor = firstOpen === -1 ? todos.length - BODY_WINDOW_LINES : firstOpen;
  const start = Math.max(0, Math.min(anchor - 1, todos.length - BODY_WINDOW_LINES));
  const window = todos.slice(start, start + BODY_WINDOW_LINES);
  return {
    todos: window,
    start,
    hiddenBefore: start,
    hiddenAfter: Math.max(0, todos.length - start - window.length),
  };
}

export function buildTodoWidgetLines(todos: Todo[], theme: Theme): string[] {
  const lines = [
    theme.fg("accent", theme.bold("todos")),
    theme.fg("dim", summarizeTodos(todos)),
    "",
  ];

  if (todos.length === 0) {
    lines.push(theme.fg("dim", "no active todos"));
  } else {
    const window = visibleTodoWindow(todos);
    if (window.hiddenBefore > 0) lines.push(theme.fg("dim", `… ${window.hiddenBefore} completed`));
    for (let i = 0; i < window.todos.length; i++) {
      const todo = window.todos[i]!;
      const index = `${window.start + i + 1}`.padStart(2);
      lines.push(` ${index}. ${formatTodoLine(todo, theme)}`);
    }
    if (window.hiddenAfter > 0) lines.push(theme.fg("dim", `… ${window.hiddenAfter} more`));
  }

  lines.push("", theme.fg("dim", `${TODO_SHORTCUT_HINT} toggle panel`));
  return lines.slice(0, MAX_WIDGET_LINES);
}

export function todoStatusText(todos: Todo[]): string | undefined {
  const active = todos.filter((todo) => todo.status !== "completed").length;
  if (active === 0) return undefined;
  return `todos ${active} open`;
}

function todoOpenId(todo: Todo, index: number): string {
  return todo.id ?? `${index}:${todo.content}`;
}

function sessionKey(ctx: { sessionManager?: { getSessionId?: () => string | undefined } }): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "__default__";
  } catch {
    return "__default__";
  }
}

function hasInteractiveUi(ctx: ExtensionContext): boolean {
  return (ctx as { hasUI?: boolean }).hasUI !== false;
}

function requestRender(session: string): void {
  states.get(session)?.tui?.requestRender?.();
}

export function syncTodoWidget(ctx: ExtensionContext, readTodos: TodoReader): void {
  if (!hasInteractiveUi(ctx)) return;
  const session = sessionKey(ctx);
  const todos = readTodos(session);
  const state = getState(session);
  const status = todoStatusText(todos);
  const open = todos.filter((todo) => todo.status !== "completed");
  const nextOpenIds = new Set(open.map((todo, index) => todoOpenId(todo, index)));
  // A task is genuinely new when its content was not open before — id churn
  // (the model re-issuing fresh ids for the same tasks) must not count as
  // new work and force the panel open.
  const hasNewOpen = open.some((todo, index) => {
    const idKey = todoOpenId(todo, index);
    return !state.openIds.has(idKey) && !state.openContent.has(todo.content);
  });

  ctx.ui.setStatus(TODO_STATUS_KEY, status);
  if (open.length === 0) {
    state.visible = false;
    state.collapsed = false;
  } else if (hasNewOpen) {
    // Only genuinely new task content auto-opens the panel; a model
    // rewriting the list with fresh ids (same content) keeps it collapsed.
    state.visible = true;
    state.collapsed = false;
  } else {
    state.visible = !state.collapsed;
  }
  state.openIds = nextOpenIds;
  state.openContent = new Set(open.map((t) => t.content));
  requestRender(session);
}

export function collapseTodoWidget(ctx: ExtensionContext): void {
  if (!hasInteractiveUi(ctx)) return;
  const session = sessionKey(ctx);
  const state = getState(session);
  state.collapsed = true;
  state.visible = false;
  requestRender(session);
}

export function toggleTodoWidget(ctx: ExtensionContext, readTodos: TodoReader): void {
  if (!hasInteractiveUi(ctx)) return;
  const session = sessionKey(ctx);
  const state = getState(session);
  const todos = readTodos(session);
  const hasOpenTodos = todos.some((todo) => todo.status !== "completed");
  if (!hasOpenTodos) {
    state.collapsed = false;
    state.visible = false;
    ctx.ui.setStatus(TODO_STATUS_KEY, undefined);
    requestRender(session);
    return;
  }
  if (state.visible) {
    state.collapsed = true;
    state.visible = false;
  } else {
    state.collapsed = false;
    state.visible = true;
  }
  ctx.ui.setStatus(TODO_STATUS_KEY, todoStatusText(todos));
  requestRender(session);
}

export function ensureTodoWidget(ctx: ExtensionContext, readTodos: TodoReader): void {
  if (!hasInteractiveUi(ctx)) return;
  const session = sessionKey(ctx);
  const state = getState(session);
  if (state.registered) return;

  const component = (tui: unknown, theme: Theme): Component => {
    state.tui = tui as { requestRender?: (force?: boolean) => void };
    return {
      render(width: number): string[] {
        if (!state.visible) return [];
        const todos = readTodos(session);
        return buildTodoWidgetLines(todos, theme).map((line) =>
          truncateToWidth(line, Math.max(20, width - 2), "…"),
        );
      },
      // No handleInput: pi only routes keys to the focused editor, so any
      // key handling here would be dead code (and a future focus change
      // would double-fire with the F7 shortcut).
      invalidate(): void {
        state.tui = undefined;
      },
    };
  };

  ctx.ui.setWidget(TODO_WIDGET_KEY, component, { placement: "aboveEditor" });
  state.registered = true;
}

export function registerTodoShortcut(pi: ExtensionAPI, readCurrentTodos: (ctx: ExtensionContext) => Todo[]): void {
  pi.registerShortcut(TODO_SHORTCUT, {
    description: "Toggle todo panel",
    handler: (ctx) => {
      ensureTodoWidget(ctx, () => readCurrentTodos(ctx));
      toggleTodoWidget(ctx, () => readCurrentTodos(ctx));
    },
  });
}

export function clearTodoWidget(ctx: ExtensionContext): void {
  if (!hasInteractiveUi(ctx)) return;
  const session = sessionKey(ctx);
  const state = getState(session);
  state.visible = false;
  state.collapsed = false;
  state.openIds = new Set();
  ctx.ui.setStatus(TODO_STATUS_KEY, undefined);
  requestRender(session);
}

/**
 * Drop the session's widget registration so the next session_start (reload,
 * switch, fork) re-registers it. pi clears extension widgets on /reload, but
 * our `registered` flag survives — without this, the todo panel would stay
 * gone for the rest of the process.
 */
export function unregisterTodoWidget(ctx: ExtensionContext): void {
  if (!hasInteractiveUi(ctx)) return;
  const session = sessionKey(ctx);
  const state = getState(session);
  state.registered = false;
  clearTodoWidget(ctx);
}
