import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { todoExtension } from "../src/extensions/todo/index.ts";
import {
  buildTodoWidgetLines,
  collapseTodoWidget,
  removeTodoWidgetState,
  resetTodoWidgetStateForTests,
  summarizeTodos,
  todoStatusText,
} from "../src/extensions/todo/widget.ts";
import type { Todo } from "../src/extensions/todo/schema.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function todo(content: string, status: Todo["status"], id = content, phase?: string): Todo {
  return phase === undefined
    ? { id, content, activeForm: `${content} active`, status }
    : { id, content, activeForm: `${content} active`, status, phase };
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
  expect(todoStatusText(todos)).toBe("todos 2 open");
  expect(todoStatusText([todo("done", "completed")])).toBeUndefined();
});

test("todo widget keeps the active window visible", () => {
  const todos = Array.from({ length: 12 }, (_, i) =>
    todo(`task ${i + 1}`, i < 8 ? "completed" : i === 8 ? "in_progress" : "pending"),
  );
  const lines = buildTodoWidgetLines(todos, plainTheme).join("\n");
  expect(lines).toContain("… 7 completed");
  expect(lines).toContain("task 9 active");
  expect(lines).toContain("F7 toggle panel");
});

test("todo widget renders phase groups as a tree with roman numerals", () => {
  const mk = (content: string, status: Todo["status"], phase: string): Todo =>
    ({ content, activeForm: `${content} active`, status, phase });
  const todos = [
    mk("阶段1: 实施", "completed", "实施"),
    mk("阶段2: 实施", "in_progress", "实施"),
    mk("阶段3: 实施", "pending", "实施"),
    mk("阶段4: 实施", "pending", "实施"),
    mk("阶段5: 实施", "pending", "实施"),
    mk("阶段6: 实施", "pending", "实施"),
    mk("阶段7: 实施", "pending", "实施"),
    mk("验证", "pending", "验证"),
    mk("收尾", "pending", "收尾"),
  ];
  const lines = buildTodoWidgetLines(todos, plainTheme).join("\n");
  // 根标题带激活阶段进度（激活 = 含 in_progress 的第一组）。
  expect(lines).toContain("Todos · 1/3");
  // 每个 phase 一行：罗马数字 + 名称 + 进度。
  expect(lines).toContain("├─ I. 实施 · 1/7");
  expect(lines).toContain("├─ II. 验证 · 0/1");
  expect(lines).toContain("└─ III. 收尾 · 0/1");
  // 激活组展开任务（树形连接线），折叠超出的任务。
  expect(lines).toContain("│  ├─ ● 阶段2: 实施 active");
  expect(lines).toContain("└─ … 2 more todos");
  // 非激活组只显示标题行，不展开任务。
  expect(lines).not.toContain("阶段8");
});

test("todo widget falls back to a flat task tree without phases", () => {
  const todos = [
    todo("first", "in_progress"),
    todo("second", "pending"),
  ];
  const lines = buildTodoWidgetLines(todos, plainTheme).join("\n");
  expect(lines).toContain("Todos");
  expect(lines).not.toContain("Todos · ");
  expect(lines).toContain("├─ ● #first first active");
  expect(lines).toContain("└─ ○ #second second");
});

test("todo widget renders an empty state without phases", () => {
  const lines = buildTodoWidgetLines([], plainTheme).join("\n");
  expect(lines).toContain("no active todos");
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

  expect(widgets[0]?.[0]).toBe("pico-todos");
  expect(statuses.at(-1)).toEqual(["todo", "todos 2 open"]);
  expect(fakePi.messages).toEqual([]);
  expect(fakePi.handlers.has("agent_end")).toBe(false);
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

  expect(widgets[0]?.[0]).toBe("pico-todos");
  expect(statuses.at(-1)).toEqual(["todo", undefined]);
});

test("todo widget re-registers after session_shutdown (reload path)", async () => {
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

  await fakePi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
  expect(widgets).toHaveLength(1);

  // /reload: shutdown (widgets dropped by pi) then session_start again.
  await fakePi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx);
  await fakePi.handlers.get("session_start")({ type: "session_start", reason: "reload" }, ctx);

  expect(widgets).toHaveLength(2);
  expect(widgets[1]?.[0]).toBe("pico-todos");
});

test("todo shortcut does not open an empty panel", async () => {
  resetTodoWidgetStateForTests();
  const fakePi = makeFakePi();
  todoExtension(fakePi as any);

  const statuses: Array<[string, string | undefined]> = [];
  const widgets: Array<[string, any]> = [];
  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "s1" },
    ui: {
      setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
      setWidget: (key: string, value: unknown) => widgets.push([key, value]),
    },
  };

  await fakePi.shortcuts.get("f7").handler(ctx);
  const component = widgets[0]![1]({}, plainTheme);

  expect(component.render(80)).toEqual([]);
  expect(statuses.at(-1)).toEqual(["todo", undefined]);
});

test("todo widget stays collapsed for updates and reopens for new work", async () => {
  resetTodoWidgetStateForTests();
  const fakePi = makeFakePi();
  todoExtension(fakePi as any);
  const toolDef = fakePi.tools.get("todoWrite");

  const widgets: Array<[string, any]> = [];
  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "s1" },
    ui: {
      setStatus: () => {},
      setWidget: (key: string, value: unknown) => widgets.push([key, value]),
    },
  };

  await toolDef.execute("call-1", {
    todos: [todo("ship widget", "in_progress", "1")],
  }, undefined, undefined, ctx);
  const component = widgets[0]![1]({}, plainTheme);
  expect(component.render(80).join("\n")).toContain("ship widget active");

  collapseTodoWidget(ctx as any);
  expect(component.render(80)).toEqual([]);

  await toolDef.execute("call-2", {
    todos: [todo("ship widget", "pending", "1")],
  }, undefined, undefined, ctx);
  expect(component.render(80)).toEqual([]);

  await toolDef.execute("call-3", {
    todos: [
      todo("ship widget", "pending", "1"),
      todo("run tests", "in_progress", "2"),
    ],
  }, undefined, undefined, ctx);
  expect(component.render(80).join("\n")).toContain("run tests active");
});

test("todo widget truncates lines to the widget width on narrow terminals", async () => {
  resetTodoWidgetStateForTests();
  const fakePi = makeFakePi();
  todoExtension(fakePi as any);
  const toolDef = fakePi.tools.get("todoWrite");

  const widgets: Array<[string, any]> = [];
  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "s1" },
    ui: {
      setStatus: () => {},
      setWidget: (key: string, value: unknown) => widgets.push([key, value]),
    },
  };

  await toolDef.execute("call-1", {
    todos: [todo("a very long todo line that must be clipped down to the terminal width", "in_progress", "1")],
  }, undefined, undefined, ctx);
  const component = widgets[0]![1]({}, plainTheme);

  const lines = component.render(10);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(10);
  }
});

test("removeTodoWidgetState rebuilds a fresh state without old openIds", async () => {
  resetTodoWidgetStateForTests();
  const fakePi = makeFakePi();
  todoExtension(fakePi as any);
  const toolDef = fakePi.tools.get("todoWrite");

  const widgets: Array<[string, any]> = [];
  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "s1" },
    ui: {
      setStatus: () => {},
      setWidget: (key: string, value: unknown) => widgets.push([key, value]),
    },
  };

  await toolDef.execute("call-1", {
    todos: [todo("ship widget", "in_progress", "1")],
  }, undefined, undefined, ctx);
  expect(widgets).toHaveLength(1);
  const component = widgets[0]![1]({}, plainTheme);
  expect(component.render(80).join("\n")).toContain("ship widget active");

  // Collapse the panel: the same todos must NOT reopen it afterwards.
  collapseTodoWidget(ctx as any);
  expect(component.render(80)).toEqual([]);

  // Simulate session switch/fork: widget state for the old session is dropped.
  removeTodoWidgetState("s1");

  // Same todos, same session: the rebuilt state has no openIds residue, so
  // the work is treated as new and the panel re-registers and opens.
  await toolDef.execute("call-2", {
    todos: [todo("ship widget", "in_progress", "1")],
  }, undefined, undefined, ctx);
  expect(widgets).toHaveLength(2);
  const freshComponent = widgets[1]![1]({}, plainTheme);
  expect(freshComponent.render(80).join("\n")).toContain("ship widget active");
});

test("todo widget stays collapsed when the model re-issues fresh ids for the same tasks", async () => {
  resetTodoWidgetStateForTests();
  const fakePi = makeFakePi();
  todoExtension(fakePi as any);
  const toolDef = fakePi.tools.get("todoWrite");

  const widgets: Array<[string, any]> = [];
  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "s1" },
    ui: {
      setStatus: () => {},
      setWidget: (key: string, value: unknown) => widgets.push([key, value]),
    },
  };

  await toolDef.execute("call-1", {
    todos: [todo("ship widget", "in_progress", "a")],
  }, undefined, undefined, ctx);
  const component = widgets[0]![1]({}, plainTheme);
  expect(component.render(80).join("\n")).toContain("ship widget active");

  collapseTodoWidget(ctx as any);
  expect(component.render(80)).toEqual([]);

  // Same task, brand-new id: must NOT reopen the panel.
  await toolDef.execute("call-2", {
    todos: [todo("ship widget", "in_progress", "b")],
  }, undefined, undefined, ctx);
  expect(component.render(80)).toEqual([]);
});
