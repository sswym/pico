import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, Spacer, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  ToolExecutionComponent,
  initTheme,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  ToolGroupComponent,
  __resetCcstyleGroupingForTests,
  __resetToolSummaryCacheForTests,
  __toolSummaryCacheSize,
  asTool,
  installToolGrouping,
} from "../src/extensions/ccstyle/grouping.ts";
import {
  ExpandedToolIoView,
  __resetCcstyleRenderForTests,
  installDefaultMode,
  setCcstyleTheme,
} from "../src/extensions/ccstyle/render.ts";
import { ccstyleExtension } from "../src/extensions/ccstyle/index.ts";
import { renderSubagentResult } from "../src/extensions/subagent/renderer.ts";

/**
 * ccstyle extension tests: tool grouping (Container.prototype patch),
 * CC-style tool card rendering, and the extension factory wiring.
 */

const stubTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_slot: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const stubTui = { requestRender: () => {} } as unknown as TUI;

let toolId = 0;

function makeTool(toolName: string, args: Record<string, unknown> = {}, toolDefinition?: unknown): ToolExecutionComponent {
  toolId++;
  return new ToolExecutionComponent(
    toolName,
    `call-${toolId}`,
    args,
    undefined,
    toolDefinition as unknown as ToolDefinition<any, any, any> | undefined,
    stubTui,
    "/tmp",
  );
}

function settle(tool: ToolExecutionComponent, text = "ok"): void {
  tool.updateResult({ content: [{ type: "text", text }], details: undefined, isError: false }, false);
}

type RendererContext = {
  args: unknown;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  state: Record<string, unknown>;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
};

function makeContext(partial: Partial<RendererContext> = {}): RendererContext {
  return {
    args: {},
    toolCallId: "t1",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/tmp",
    executionStarted: false,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: false,
    isError: false,
    ...partial,
  };
}

function renderersOf(tool: ToolExecutionComponent): { renderCall: unknown; renderResult: unknown } {
  const internals = tool as unknown as { getCallRenderer(): unknown; getResultRenderer(): unknown };
  return { renderCall: internals.getCallRenderer(), renderResult: internals.getResultRenderer() };
}

function contentBoxOf(tool: ToolExecutionComponent): { paddingX: number; paddingY: number } | undefined {
  const internals = tool as unknown as { contentBox?: { paddingX: number; paddingY: number } };
  return internals.contentBox;
}

beforeEach(() => {
  __resetCcstyleGroupingForTests();
  __resetCcstyleRenderForTests();
  __resetToolSummaryCacheForTests();
  toolId = 0;
});

// ToolExecutionComponent renderers use the upstream module-level theme, which
// needs initTheme() — in unit tests that falls back to the built-in dark theme.
initTheme();

afterEach(() => {
  __resetCcstyleGroupingForTests();
  __resetCcstyleRenderForTests();
  __resetToolSummaryCacheForTests();
});

// ── grouping ─────────────────────────────────────────────────────────────────

test("consecutive tool calls group into a single ToolGroupComponent", () => {
  installToolGrouping(() => true);
  const parent = new Container();
  parent.addChild(makeTool("bash", { command: "npm test" }));
  parent.addChild(makeTool("read", { path: "src/a.ts" }));
  parent.addChild(makeTool("grep", { pattern: "foo" }));

  expect(parent.children).toHaveLength(1);
  const group = parent.children[0];
  expect(group).toBeInstanceOf(ToolGroupComponent);
  const names = (group as ToolGroupComponent).children
    .map((child) => asTool(child)?.toolName)
    .filter((name): name is string => name !== undefined);
  expect(names).toEqual(["bash", "read", "grep"]);
});

test("edit/write/apply_patch never enter a group", () => {
  installToolGrouping(() => true);
  const parent = new Container();
  parent.addChild(makeTool("bash", { command: "x" }));
  parent.addChild(makeTool("edit", { file_path: "a.ts" }));
  parent.addChild(makeTool("write", { file_path: "b.ts" }));
  parent.addChild(makeTool("apply_patch", { old_string: "a" }));
  parent.addChild(makeTool("read", { path: "c.ts" }));

  expect(parent.children).toHaveLength(5);
});

test("spacers and empty assistant messages do not break grouping", () => {
  installToolGrouping(() => true);
  const parent = new Container();
  parent.addChild(makeTool("bash", { command: "x" }));
  parent.addChild(new Spacer(1));
  parent.addChild(makeTool("read", { path: "a.ts" }));

  expect(parent.children).toHaveLength(2); // group + spacer
  expect(parent.children[0]).toBeInstanceOf(ToolGroupComponent);
  expect(parent.children[1]).toBeInstanceOf(Spacer);
});

test("removing a tool from a group collapses it back to a bare tool", () => {
  installToolGrouping(() => true);
  const parent = new Container();
  const bash = makeTool("bash", { command: "x" });
  const read = makeTool("read", { path: "a.ts" });
  parent.addChild(bash);
  parent.addChild(read);
  expect(parent.children[0]).toBeInstanceOf(ToolGroupComponent);

  parent.removeChild(bash);
  expect(parent.children).toHaveLength(1);
  expect(parent.children[0]).toBe(read);
  expect(parent.children[0]).not.toBeInstanceOf(ToolGroupComponent);
});

test("clear releases every group", () => {
  installToolGrouping(() => true);
  const parent = new Container();
  parent.addChild(makeTool("bash"));
  parent.addChild(makeTool("read"));
  parent.addChild(makeTool("grep"));
  expect(parent.children).toHaveLength(1);

  parent.clear();
  expect(parent.children).toHaveLength(0);
});

test("setExpanded propagates to grouped tools", () => {
  installToolGrouping(() => true);
  const parent = new Container();
  const bash = makeTool("bash");
  const read = makeTool("read");
  parent.addChild(bash);
  parent.addChild(read);
  const group = parent.children[0] as ToolGroupComponent;

  group.setExpanded(true);
  expect(group.expanded).toBe(true);
  expect(asTool(bash)?.expanded).toBe(true);
  expect(asTool(read)?.expanded).toBe(true);

  group.setExpanded(false);
  expect(asTool(bash)?.expanded).toBe(false);
});

test("collapsed group renders a header with status counts and per-tool summaries", () => {
  const hooks = installToolGrouping(() => true);
  hooks.setTheme(stubTheme);
  const parent = new Container();
  const first = makeTool("bash", { command: "npm test" });
  const second = makeTool("bash", { command: "bun build" });
  parent.addChild(first);
  parent.addChild(second);
  settle(first);
  settle(second);
  const group = parent.children[0] as ToolGroupComponent;

  const lines = group.render(100).join("\n");
  expect(lines).toContain("● Bash: 2 done");
  expect(lines).toContain("Bash npm test");
  expect(lines).toContain("Bash bun build");
  expect(lines).toContain("show more");
});

test("group render memoizes per-tool summaries across animation frames", () => {
  const hooks = installToolGrouping(() => true);
  hooks.setTheme(stubTheme);
  const parent = new Container();
  const first = makeTool("bash", { command: "npm test" });
  const second = makeTool("read", { path: "src/a.ts" });
  parent.addChild(first);
  parent.addChild(second);
  settle(first);
  settle(second);
  const group = parent.children[0] as ToolGroupComponent;

  const firstRender = group.render(100).join("\n");
  expect(firstRender).toContain("Bash npm test");
  expect(firstRender).toContain("Read src/a.ts");
  // One cached summary per grouped tool.
  expect(__toolSummaryCacheSize()).toBe(2);

  // Re-render (the 200ms pending-animation path) reuses the cache: same
  // output, no additional computed entries.
  const secondRender = group.render(100).join("\n");
  expect(secondRender).toBe(firstRender);
  expect(__toolSummaryCacheSize()).toBe(2);

  // A new tool gets its own entry; existing ones stay cached.
  parent.addChild(makeTool("grep", { pattern: "foo" }));
  const thirdRender = group.render(100).join("\n");
  expect(thirdRender).toContain("Grep \"foo\"");
  expect(__toolSummaryCacheSize()).toBe(3);
});

test("expanded group renders each tool's full body", () => {
  const hooks = installToolGrouping(() => true);
  hooks.setTheme(stubTheme);
  const parent = new Container();
  const bash = makeTool("bash", { command: "bun test" });
  const read = makeTool("read", { path: "a.ts" });
  parent.addChild(bash);
  parent.addChild(read);
  settle(bash, "BODY_MARKER_123");
  settle(read);
  const group = parent.children[0] as ToolGroupComponent;
  const collapsed = group.render(100).join("\n");
  expect(collapsed).toContain("Bash bun test");
  expect(collapsed).not.toContain("BODY_MARKER_123");

  group.setExpanded(true);
  const expanded = group.render(100).join("\n");
  // Expanded path renders the child body (native result text) on the card.
  expect(expanded).toContain("BODY_MARKER_123");
  expect(expanded).toContain("└ ✓");
});

test("reinstalling the patch ungroups components held by the previous install", () => {
  const first = installToolGrouping(() => true);
  const parent = new Container();
  parent.addChild(makeTool("bash"));
  parent.addChild(makeTool("read"));
  expect(parent.children[0]).toBeInstanceOf(ToolGroupComponent);

  const second = installToolGrouping(() => true);
  expect(parent.children).toHaveLength(2); // previous groups ungrouped
  expect(parent.children[0]).not.toBeInstanceOf(ToolGroupComponent);
  second.shutdown();
  first.shutdown();
});

test("shutdown restores the original Container methods", () => {
  const originalAddChild = Container.prototype.addChild;
  const hooks = installToolGrouping(() => true);
  hooks.shutdown();
  expect(Container.prototype.addChild).toBe(originalAddChild);

  const parent = new Container();
  parent.addChild(makeTool("bash"));
  parent.addChild(makeTool("read"));
  expect(parent.children).toHaveLength(2);
});

// ── tool card rendering ──────────────────────────────────────────────────────

test("built-in and pico custom tools are all taken over by ccstyle renderers", () => {
  const renderCall = (_args: unknown, _theme: Theme, _context: unknown): Component => new Text("ORIGINAL_CALL", 0, 0);
  const customDefinition = {
    name: "my_tool",
    label: "My Tool",
    description: "test",
    parameters: {},
    execute: async () => ({ content: [], details: undefined, isError: false }),
    renderCall,
  } as unknown as ToolDefinition<any, any, any>;

  const hooks = installDefaultMode();
  const builtin = makeTool("bash", { command: "npm test" });
  const custom = makeTool("my_tool", {}, customDefinition);

  // 全部接管：上游内置与 pico 定制工具都走 ccstyle 渲染器。
  expect(renderersOf(builtin).renderCall).not.toBe(undefined);
  expect(renderersOf(custom).renderCall).not.toBe(renderCall);
  hooks.shutdown();
});

test("ccstyle renderCall emits a single-line summary", () => {
  const hooks = installDefaultMode();
  const builtin = makeTool("bash", { command: "npm test" });
  const renderCall = renderersOf(builtin).renderCall as (
    args: unknown,
    theme: Theme,
    context: RendererContext,
  ) => Component;
  const component = renderCall({ command: "npm test" }, stubTheme, makeContext({ isPartial: false }));
  const lines = component.render(100);
  expect(lines.join("\n")).toContain("Bash npm test");
  expect(lines).toHaveLength(1);
  hooks.shutdown();
});

test("collapsed renderResult shows line count with an expand hint", () => {
  const hooks = installDefaultMode();
  const builtin = makeTool("bash");
  const renderResult = renderersOf(builtin).renderResult as (
    result: AgentToolResult<unknown>,
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: RendererContext,
  ) => Component;
  const result = {
    content: [{ type: "text", text: "line1\nline2\nline3" }],
    details: undefined,
    isError: false,
  } as unknown as AgentToolResult<unknown>;
  const component = renderResult(
    result,
    { expanded: false, isPartial: false },
    stubTheme,
    makeContext({ isPartial: false }),
  );
  const lines = (component as { render(width: number): string[] }).render(100);
  expect(lines.join("\n")).toContain("3 lines returned");
  expect(lines.join("\n")).toContain("show more");
  hooks.shutdown();
});

test("expanded renderResult returns an Input/Output view", () => {
  const hooks = installDefaultMode();
  const builtin = makeTool("read");
  const renderResult = renderersOf(builtin).renderResult as (
    result: AgentToolResult<unknown>,
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: RendererContext,
  ) => Component;
  const result = {
    content: [{ type: "text", text: "file body" }],
    details: undefined,
    isError: false,
  } as unknown as AgentToolResult<unknown>;
  const component = renderResult(
    result,
    { expanded: true, isPartial: false },
    stubTheme,
    makeContext({ isPartial: false, args: { path: "src/a.ts" } }),
  );
  expect(component).toBeInstanceOf(ExpandedToolIoView);
  const lines = component.render(100).join("\n");
  expect(lines).toContain("Input");
  expect(lines).toContain("Output");
  expect(lines).toContain("src/a.ts");
  expect(lines).toContain("file body");
  hooks.shutdown();
});

test("error renderResult shows a condensed error summary", () => {
  const hooks = installDefaultMode();
  const builtin = makeTool("bash");
  const renderResult = renderersOf(builtin).renderResult as (
    result: AgentToolResult<unknown>,
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: RendererContext,
  ) => Component;
  const result = {
    content: [{ type: "text", text: "boom: something went wrong" }],
    details: undefined,
    isError: true,
  } as unknown as AgentToolResult<unknown>;
  const component = renderResult(
    result,
    { expanded: false, isPartial: false },
    stubTheme,
    makeContext({ isPartial: false, isError: true }),
  );
  const lines = (component as { render(width: number): string[] }).render(100);
  expect(lines.join("\n")).toContain("boom: something went wrong");
  hooks.shutdown();
});

test("isPartial results pass through to the original renderer (subagent running panel)", () => {
  // M8 回归：ccstyle 折叠态不得吞掉 subagent 运行中面板——isPartial 渲染必须
  // 透传原工具 renderResult（● worker (user) · 运行中… + turns/usage 实时增长），
  // 而不是固定显示 "↳ Pending…"。
  const hooks = installDefaultMode();
  const subagentDefinition = {
    name: "subagent",
    label: "Subagent",
    description: "Run a subagent",
    parameters: {},
    renderShell: "default",
    renderCall: () => new Text("call", 0, 0),
    renderResult: (
      result: unknown,
      options: { expanded: boolean },
      theme: Theme,
      context: { isPartial?: boolean },
    ) => renderSubagentResult(result, options.expanded, theme, context),
  } as unknown as ToolDefinition<any, any, any>;
  const tool = makeTool("subagent", { task: "sleep 60" }, subagentDefinition);

  // 子代理运行中：single 模式 + isPartial=true（exitCode 0 = 运行中信号）。
  tool.updateResult(
    {
      content: [{ type: "text", text: "(running...)" }],
      details: {
        mode: "single",
        results: [
          {
            agent: "worker",
            agentSource: "user",
            task: "sleep 60",
            step: 1,
            exitCode: 0,
            messages: [],
            stderr: "",
            usage: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 1500, turns: 3 },
            model: "test-model",
          },
        ],
      },
    } as never,
    true,
  );
  const plain = tool.render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  expect(plain).toContain("worker (user)");
  expect(plain).toContain("运行中");
  expect(plain).toContain("3 turns");
  expect(plain).not.toContain("Pending");
  hooks.shutdown();
});

test("extension-wrapped built-in tools (undo-redo style) are still taken over", () => {
  // undo-redo 的 buildDeferredTool 保留上游 template 的渲染器、只换 execute —
  // toolDefinition 存在但 builtInToolDefinition 也有 → ccstyle 必须接管。
  const wrappedDefinition = {
    name: "bash",
    label: "Bash",
    description: "Run a shell command",
    parameters: {},
    renderShell: "default",
    renderCall: () => new Text("WRAPPED", 0, 0),
    renderResult: () => new Text("WRAPPED", 0, 0),
    execute: async () => ({ content: [], details: undefined, isError: false }),
  } as unknown as ToolDefinition<any, any, any>;

  const hooks = installDefaultMode();
  const wrapped = makeTool("bash", { command: "npm test" }, wrappedDefinition);
  const renderCall = renderersOf(wrapped).renderCall as (
    args: unknown,
    theme: Theme,
    context: RendererContext,
  ) => Component;
  const component = renderCall({ command: "npm test" }, stubTheme, makeContext({ isPartial: false }));
  // ccstyle 接管：单行摘要组件（无 Text.setText）；上游/包装渲染器返回 Text。
  expect((component as { setText?: unknown }).setText).toBeUndefined();
  const lines = component.render(100);
  expect(lines.join("\n")).toContain("Bash npm test");
  hooks.shutdown();
});

test("edit and write are taken over like other built-in tools", () => {
  const hooks = installDefaultMode();
  const edit = makeTool("edit", { file_path: "a.ts" });
  const write = makeTool("write", { file_path: "b.ts" });
  const editRenderCall = renderersOf(edit).renderCall as (
    args: unknown,
    theme: Theme,
    context: RendererContext,
  ) => Component;
  const writeRenderCall = renderersOf(write).renderCall as (
    args: unknown,
    theme: Theme,
    context: RendererContext,
  ) => Component;
  const editComponent = editRenderCall(
    { file_path: "a.ts", edits: [{ oldText: "x", newText: "y" }] },
    stubTheme,
    makeContext({ argsComplete: true }),
  );
  const writeComponent = writeRenderCall({ file_path: "b.ts", content: "abc" }, stubTheme, makeContext({ isPartial: false }));
  // ccstyle 接管：单行摘要组件（{render, invalidate}），不是上游 Box/Text。
  expect((editComponent as { addChild?: unknown }).addChild).toBeUndefined();
  expect((writeComponent as { addChild?: unknown }).addChild).toBeUndefined();
  expect(editComponent.render(100).join("\n")).toContain("Edit a.ts");
  expect(writeComponent.render(100).join("\n")).toContain("Write b.ts");
  hooks.shutdown();
});

test("write collapsed result shows the success summary, not a line count", () => {
  const hooks = installDefaultMode();
  const write = makeTool("write");
  const result = {
    content: [
      { type: "text", text: "Successfully wrote 2345 bytes to /tmp/b.ts" },
      { type: "text", text: "\n[LSP] formatOnWrite failed; diagnostics still ran." },
      { type: "text", text: "\n[LSP] No diagnostics for /tmp/b.ts." },
    ],
    details: undefined,
    isError: false,
  } as unknown as AgentToolResult<unknown>;
  write.updateResult({ ...result, isError: false } as unknown as never, false);
  // 首次落地自动展开；用户折叠后验证折叠摘要（成功文本而非行数）。
  write.setExpanded(false);
  const lines = write.render(100).join("\n");
  expect(lines).toContain("Successfully wrote 2345 bytes");
  expect(lines).not.toContain("1 line returned");
  expect(lines).not.toContain("formatOnWrite failed");
  hooks.shutdown();
});

test("edit collapsed result shows diff stats", () => {
  const hooks = installDefaultMode();
  const edit = makeTool("edit");
  const result = {
    content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }],
    details: {
      diff: "+1 hello\n 2 world\n-3 old line\n+4 new line",
      patch: "--- a/a.ts\n+++ b/a.ts",
      firstChangedLine: 1,
    },
    isError: false,
  } as unknown as AgentToolResult<unknown>;
  edit.updateResult({ ...result, isError: false } as unknown as never, false);
  // 首次落地自动展开 diff；用户折叠后验证 +N -M 统计行。
  edit.setExpanded(false);
  const lines = edit.render(100).join("\n");
  expect(lines).toContain("+2 -1");
  expect(lines).toContain("show more");
  hooks.shutdown();
});

test("edit expanded result renders the colored diff", () => {
  const hooks = installDefaultMode();
  const edit = makeTool("edit");
  const renderResult = renderersOf(edit).renderResult as (
    result: AgentToolResult<unknown>,
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: RendererContext,
  ) => Component;
  const result = {
    content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }],
    details: {
      diff: "+1 hello\n 2 world\n-3 old line\n+4 new line",
      patch: "--- a/a.ts\n+++ b/a.ts",
      firstChangedLine: 1,
    },
    isError: false,
  } as unknown as AgentToolResult<unknown>;
  const component = renderResult(
    result,
    { expanded: true, isPartial: false },
    stubTheme,
    makeContext({ isPartial: false, args: { file_path: "a.ts" } }),
  );
  const lines = component.render(100).join("\n");
  expect(lines).toContain("+1 hello");
  expect(lines).toContain("-3 old line");
  hooks.shutdown();
});

test("askUserQuestion collapsed call shows the question text", () => {
  const hooks = installDefaultMode();
  const args = {
    questions: [
      {
        question: "你想让我对 snake.py 做什么修改？",
        header: "修改方向",
        options: [{ label: "修复 bug" }],
      },
    ],
  };
  const ask = makeTool("askUserQuestion", args);
  const renderCall = renderersOf(ask).renderCall as (
    args: unknown,
    theme: Theme,
    context: RendererContext,
  ) => Component;
  const component = renderCall(args, stubTheme, makeContext({ isPartial: false }));
  const lines = component.render(100).join("\n");
  expect(lines).toContain("你想让我对 snake.py 做什么修改？");
  expect(lines).not.toContain('"questions"'); // 不再是 JSON 预览
  hooks.shutdown();
});

test("todoWrite and lsp calls keep their pico summaries", () => {
  const hooks = installDefaultMode();
  const todo = makeTool("todoWrite", { todos: [{ status: "completed" }, { status: "in_progress" }] });
  const todoRender = renderersOf(todo).renderCall as (
    args: unknown,
    theme: Theme,
    context: RendererContext,
  ) => Component;
  const todoLines = todoRender({ todos: [{ status: "completed" }, { status: "in_progress" }] }, stubTheme, makeContext({ isPartial: false })).render(100).join("\n");
  expect(todoLines).toContain("2 items · 1 active");

  const lsp = makeTool("lsp", { action: "definition", file: "src/a.ts", line: 12 });
  const lspRender = renderersOf(lsp).renderCall as (
    args: unknown,
    theme: Theme,
    context: RendererContext,
  ) => Component;
  const lspLines = lspRender({ action: "definition", file: "src/a.ts", line: 12 }, stubTheme, makeContext({ isPartial: false })).render(100).join("\n");
  expect(lspLines).toContain("definition src/a.ts:12");
  hooks.shutdown();
});

test("grouped askUserQuestion shows the question text in its summary line", () => {
  const hooks = installToolGrouping(() => true);
  hooks.setTheme(stubTheme);
  const parent = new Container();
  const bash = makeTool("bash", { command: "ls" });
  const ask = makeTool("askUserQuestion", {
    questions: [
      {
        question: "你想让我对 snake.py 做什么修改？",
        header: "修改方向",
        options: [{ label: "修复 bug" }],
      },
    ],
  });
  parent.addChild(bash);
  parent.addChild(ask);
  settle(bash);
  settle(ask);
  const group = parent.children[0] as ToolGroupComponent;
  const lines = group.render(100).join("\n");
  expect(lines).toContain("Ask User Question 你想让我对 snake.py 做什么修改？");
  expect(lines).not.toContain('"questions"');
});

test("write auto-expands on result and stays expanded until user collapse", () => {
  const hooks = installDefaultMode();
  const write = makeTool("write", { file_path: "/tmp/a.ts", content: "abc" });
  write.updateResult(
    { content: [{ type: "text", text: "Successfully wrote 18 bytes to /tmp/a.ts" }], details: undefined, isError: false },
    false,
  );

  // 结果落地自动展开（Input/Output 视图），且后续重渲染保持展开。
  const expandedLines = write.render(100).join("\n");
  expect(expandedLines).toContain("Input");
  expect(expandedLines).toContain("Output");
  const againLines = write.render(100).join("\n");
  expect(againLines).toContain("Output"); // 不是首帧后就被折叠

  // 用户显式折叠（ctrl+o / 点击收起）→ 清除自动展开 → 回到折叠行。
  write.setExpanded(false);
  const collapsedLines = write.render(100).join("\n");
  expect(collapsedLines).not.toContain("Output");
  expect(collapsedLines).toContain("Successfully wrote 18 bytes");
  hooks.shutdown();
});

test("edit auto-expands to the colored diff and collapses on user action", () => {
  const hooks = installDefaultMode();
  const edit = makeTool("edit");
  edit.updateResult(
    {
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }],
      details: { diff: "+1 hello\n 2 world\n-3 old line", patch: "--- a/a.ts\n+++ b/a.ts", firstChangedLine: 1 },
      isError: false,
    },
    false,
  );

  // 首次落地自动展开 diff，保持展开。
  const expandedLines = edit.render(100).join("\n");
  expect(expandedLines).toContain("+1 hello");
  expect(expandedLines).toContain("-3 old line");
  const againLines = edit.render(100).join("\n");
  expect(againLines).toContain("+1 hello");

  // 用户折叠 → diff 统计行。
  edit.setExpanded(false);
  const collapsedLines = edit.render(100).join("\n");
  expect(collapsedLines).toContain("+1 -1");
  expect(collapsedLines).not.toContain("old line");
  hooks.shutdown();
});

test("shutdown restores the upstream renderers", () => {
  const prototype = ToolExecutionComponent.prototype as unknown as { getCallRenderer: unknown };
  const original = prototype.getCallRenderer;

  const hooks = installDefaultMode();
  expect(prototype.getCallRenderer).not.toBe(original);

  hooks.shutdown();
  expect(prototype.getCallRenderer).toBe(original);
});

test("expanded tool calls get a user-message background on the content box", () => {
  const hooks = installDefaultMode();
  setCcstyleTheme(stubTheme);
  const tool = makeTool("bash");
  tool.setExpanded(true);

  const box = contentBoxOf(tool);
  expect(box?.paddingX).toBe(1);
  expect(box?.paddingY).toBe(1);
  hooks.shutdown();
});

// ── extension factory ────────────────────────────────────────────────────────

type FakeHandler = (event: unknown, ctx: unknown) => unknown;

function makeFakePi() {
  const handlers: Record<string, FakeHandler[]> = {};
  const commands = new Map<
    string,
    { description: string; handler: (args: string, ctx: never) => Promise<void> }
  >();
  const notices: string[] = [];
  return {
    handlers,
    commands,
    notices,
    on: (event: string, handler: FakeHandler) => {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand: (
      name: string,
      opts: { description: string; handler: (args: string, ctx: never) => Promise<void> },
    ) => {
      commands.set(name, opts);
    },
  };
}

const tuiCtx = {
  mode: "tui",
  hasUI: true,
  ui: { notify: (message: string) => undefined, theme: stubTheme },
} as never;

test("ccstyle extension registers the command and session_start handler", async () => {
  const home = mkdtempSync(join(tmpdir(), "pico-ccstyle-"));
  const previousHome = process.env.PICO_HOME;
  process.env.PICO_HOME = home;
  mkdirSync(join(home, "agent"), { recursive: true });
  writeFileSync(join(home, "agent", "settings.json"), JSON.stringify({ ccstyle: { enabled: false } }), "utf-8");
  try {
    const pi = makeFakePi();
    ccstyleExtension(pi as unknown as ExtensionAPI);

    expect(pi.commands.has("ccstyle")).toBe(true);
    expect(pi.handlers["session_start"]).toHaveLength(1);
    expect(pi.handlers["session_shutdown"]).toHaveLength(1);

    const notices: string[] = [];
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: { notify: (message: string) => notices.push(message), theme: stubTheme },
    } as never;
    const handler = pi.commands.get("ccstyle")!.handler;
    await handler("status", ctx);
    expect(notices).toContain("Claude Code style: off");

    await handler("on", ctx);
    const saved = JSON.parse(readFileSync(join(home, "agent", "settings.json"), "utf-8")) as {
      ccstyle?: { enabled?: boolean };
    };
    expect(saved.ccstyle?.enabled).toBe(true);
  } finally {
    if (previousHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("/ccstyle off fully disables the render patch — new and mounted tools render natively", async () => {
  // D1 问题 4 回归：off 不只关分组，单行摘要渲染补丁也必须失效（命令描述
  // "Use Pi's native tool rendering"）。
  const home = mkdtempSync(join(tmpdir(), "pico-ccstyle-"));
  const previousHome = process.env.PICO_HOME;
  process.env.PICO_HOME = home;
  mkdirSync(join(home, "agent"), { recursive: true });
  writeFileSync(join(home, "agent", "settings.json"), JSON.stringify({ ccstyle: { enabled: true } }), "utf-8");
  try {
    const pi = makeFakePi();
    ccstyleExtension(pi as unknown as ExtensionAPI);
    const ui = {
      notify: () => {},
      theme: stubTheme,
      setWidget: (_key: string, _content?: unknown) => undefined,
    };
    const sessionCtx = { mode: "tui", hasUI: true, ui } as never;
    await pi.handlers["session_start"]![0]!({}, sessionCtx);

    const renderCall = () => new Text("NATIVE CALL", 0, 0);
    const renderResult = () => new Text("NATIVE RESULT", 0, 0);
    const definition = {
      name: "custom",
      renderCall,
      renderResult,
    } as unknown as ToolDefinition<any, any, any>;

    // on：ccstyle 接管（renderers 被包装，不是原函数）
    const on = makeTool("custom", {}, definition);
    expect(renderersOf(on).renderCall).not.toBe(renderCall);
    expect(renderersOf(on).renderResult).not.toBe(renderResult);

    // /ccstyle off：新工具渲染恢复上游原生 renderers
    await pi.commands.get("ccstyle")!.handler("off", sessionCtx);
    const off = makeTool("custom", {}, definition);
    expect(renderersOf(off).renderCall).toBe(renderCall);
    expect(renderersOf(off).renderResult).toBe(renderResult);

    // 已挂载工具的下一次 updateDisplay 也回退到原生渲染（不残留 ccstyle 摘要）
    on.updateResult({ content: [{ type: "text", text: "done" }], details: undefined, isError: false }, false);
    const lines = on.render(100).join("\n");
    expect(lines).toContain("NATIVE CALL");
    expect(lines).toContain("NATIVE RESULT");

    await pi.handlers["session_shutdown"]![0]!({}, {});
  } finally {
    if (previousHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("ccstyle.enabled=false at startup leaves tool rendering native until /ccstyle on", async () => {
  // D5 P2 / D1 问题 4 回归：settings.json ccstyle.enabled=false 时渲染补丁
  // 必须完全失效（全新会话不再显示 ccstyle 单行摘要 / "↳ Pending…"）。
  const home = mkdtempSync(join(tmpdir(), "pico-ccstyle-"));
  const previousHome = process.env.PICO_HOME;
  process.env.PICO_HOME = home;
  mkdirSync(join(home, "agent"), { recursive: true });
  writeFileSync(join(home, "agent", "settings.json"), JSON.stringify({ ccstyle: { enabled: false } }), "utf-8");
  try {
    const pi = makeFakePi();
    ccstyleExtension(pi as unknown as ExtensionAPI);
    const ui = {
      notify: () => {},
      theme: stubTheme,
      setWidget: (_key: string, _content?: unknown) => undefined,
    };
    const sessionCtx = { mode: "tui", hasUI: true, ui } as never;
    await pi.handlers["session_start"]![0]!({}, sessionCtx);

    const renderCall = () => new Text("NATIVE CALL", 0, 0);
    const renderResult = () => new Text("NATIVE RESULT", 0, 0);
    const definition = {
      name: "custom",
      renderCall,
      renderResult,
    } as unknown as ToolDefinition<any, any, any>;

    const tool = makeTool("custom", {}, definition);
    expect(renderersOf(tool).renderCall).toBe(renderCall);
    expect(renderersOf(tool).renderResult).toBe(renderResult);

    // /ccstyle on 之后新工具被接管
    await pi.commands.get("ccstyle")!.handler("on", sessionCtx);
    const on = makeTool("custom", {}, definition);
    expect(renderersOf(on).renderCall).not.toBe(renderCall);
    expect(renderersOf(on).renderResult).not.toBe(renderResult);

    await pi.handlers["session_shutdown"]![0]!({}, {});
  } finally {
    if (previousHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
