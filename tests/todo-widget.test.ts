import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { todoExtension } from "../src/extensions/todo/index.ts";
import {
  buildTodoWidgetLines,
  resetTodoWidgetStateForTests,
  summarizeTodos,
  todoStatusText,
} from "../src/extensions/todo/widget.ts";
import type { Todo } from "../src/extensions/todo/schema.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function todo(content: string, status: Todo["status"], id = content): Todo {
  return { id, content, activeForm: `${content} active`, status };
}

function makeFakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const messages: any[] = [];
  return {
    tools,
    commands,
    shortcuts,
    messages,
    handlers: new Map<string, any>(),
    on(name: string, handler: unknown) {
      this.handlers.set(name, handler);
    },
    registerTool: (toolDef: { name: string }) => tools.set(toolDef.name, toolDef),
    registerCommand: (name: string, options: unknown) => commands.set(name, options),
    registerShortcut: (key: string, options: unknown) => shortcuts.set(key, options),
    sendMessage: (message: unknown) => messages.push(message),
    sendUserMessage: () => {},
  };
}

test("todo widget summarizes active work", () => {
  const todos = [
    todo("done", "completed"),
    todo("current", "in_progress"),
    todo("later", "pending"),
  ];
  expect(summarizeTodos(todos)).toBe("1/3 done · 2 active");
  expect(todoStatusText(todos)).toBe("todos 1/3 F7");
  expect(todoStatusText([todo("done", "completed")])).toBeUndefined();
});

test("todo widget keeps the active window visible", () => {
  const todos = Array.from({ length: 12 }, (_, i) =>
    todo(`task ${i + 1}`, i < 8 ? "completed" : i === 8 ? "in_progress" : "pending"),
  );
  const lines = buildTodoWidgetLines(todos, plainTheme).join("\n");
  expect(lines).toContain("… 5 completed");
  expect(lines).toContain("task 9 active");
  expect(lines).toContain("F7 / Enter / Esc");
});

test("todo extension registers shortcut and syncs widget status after writes", async () => {
  resetTodoWidgetStateForTests();
  const fakePi = makeFakePi();
  todoExtension(fakePi as any);

  expect(fakePi.shortcuts.has("f7")).toBe(true);
  const toolDef = fakePi.tools.get("todoWrite");
  expect(toolDef).toBeDefined();

  const statuses: Array<[string, string | undefined]> = [];
  const widgets: Array<[string, unknown]> = [];
  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "s1" },
    ui: {
      setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
      setWidget: (key: string, value: unknown) => widgets.push([key, value]),
    },
  };

  await toolDef.execute(
    "call-1",
    {
      todos: [
        todo("ship widget", "in_progress", "1"),
        todo("run tests", "pending", "2"),
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  expect(widgets[0]?.[0]).toBe("srcode-todos");
  expect(statuses.at(-1)).toEqual(["todo", "todos 0/2 F7"]);
  expect(fakePi.messages).toEqual([]);
});

test("todo extension installs a visible F7 entry on session start", async () => {
  resetTodoWidgetStateForTests();
  const fakePi = makeFakePi();
  todoExtension(fakePi as any);

  const statuses: Array<[string, string | undefined]> = [];
  const widgets: Array<[string, unknown]> = [];
  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "s1" },
    ui: {
      setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
      setWidget: (key: string, value: unknown) => widgets.push([key, value]),
    },
  };

  const handler = fakePi.handlers.get("session_start");
  expect(handler).toBeDefined();
  await handler({ type: "session_start", reason: "startup" }, ctx);

  expect(widgets[0]?.[0]).toBe("srcode-todos");
  expect(statuses.at(-1)).toEqual(["todo", undefined]);
});
