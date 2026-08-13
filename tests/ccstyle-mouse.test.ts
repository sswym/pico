import { afterEach, beforeEach, expect, test } from "bun:test";
import { Container, type Component, type TUI } from "@earendil-works/pi-tui";
import { ToolExecutionComponent, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  ToolGroupComponent,
  __resetCcstyleGroupingForTests,
  asTool,
  installToolGrouping,
} from "../src/extensions/ccstyle/grouping.ts";
import {
  __resetCcstyleRenderForTests,
  installDefaultMode,
} from "../src/extensions/ccstyle/render.ts";
import {
  __resetCcstyleMouseForTests,
  installMouseInteraction,
  teardownMouseInteraction,
} from "../src/extensions/ccstyle/mouse.ts";

/**
 * ccstyle mouse tests: fullscreen layout-tree hit testing for tool cards.
 * Drives the real ToolExecutionComponent / ToolGroupComponent render paths
 * through a fake lazy-proxy TUI and a hand-built layout tree.
 */

const stubTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_slot: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const stubTui = { requestRender: () => {} } as unknown as TUI;

let toolId = 0;

function makeTool(toolName: string, args: Record<string, unknown> = {}): ToolExecutionComponent {
  toolId++;
  return new ToolExecutionComponent(toolName, `call-${toolId}`, args, undefined, undefined, stubTui, "/tmp");
}

function settle(tool: ToolExecutionComponent, text = "ok"): void {
  tool.updateResult({ content: [{ type: "text", text }], details: undefined, isError: false }, false);
}

/** 惰性 Proxy 特征：requestRender 每次访问返回新函数。 */
function makeFakeTui(layoutRoot: unknown): Record<string, unknown> {
  const proto = {
    handleViewportInput(this: unknown, _data: string) {
      return undefined;
    },
  };
  const tui = Object.create(proto) as Record<string, unknown> & { requestRender(): void };
  tui.terminal = { columns: 100 };
  tui.hasOverlay = () => false;
  tui.currentLayout = { root: layoutRoot };
  Object.defineProperty(tui, "requestRender", {
    configurable: true,
    get: () => () => {},
  });
  return tui;
}

/** 布局树：单个容器铺满整个视口，渲染行来自容器真实渲染。 */
function makeLayout(container: Component, width = 100, height = 20): unknown {
  const lines = container.render(width).map((line) => String(line));
  return {
    clip: { x: 0, y: 0, width, height },
    rect: { x: 0, y: 0, width, height },
    children: [],
    lines,
    component: container,
  };
}

/** 行内 "to show more" hint 的命中列（1-based，点 hint 中间）。 */
function hintColumn(line: string): number {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  const idx = plain.indexOf("to show more");
  return idx >= 0 ? idx + 3 + 1 : -1;
}

/** 点击 (row 1-based, col 1-based) 并返回 handleViewportInput 的结果。 */
function click(tui: Record<string, unknown>, row: number, col: number): unknown {
  return (tui.handleViewportInput as (data: string) => unknown)(`\x1b[<0;${col};${row}M`);
}

beforeEach(() => {
  __resetCcstyleGroupingForTests();
  __resetCcstyleRenderForTests();
  __resetCcstyleMouseForTests();
  toolId = 0;
});

afterEach(() => {
  __resetCcstyleGroupingForTests();
  __resetCcstyleRenderForTests();
  __resetCcstyleMouseForTests();
});

initTheme();

function installMouse(tui: Record<string, unknown>, enabled = true): void {
  let widgetFactory: ((tui: TUI) => Component) | undefined;
  const ui = {
    setWidget: (_key: string, factory?: unknown) => {
      widgetFactory = factory as (tui: TUI) => Component;
    },
  };
  installMouseInteraction({ mode: "tui", hasUI: true, ui }, () => enabled);
  expect(widgetFactory).toBeTypeOf("function");
  widgetFactory!(tui as unknown as TUI);
}

// ── packet parsing ───────────────────────────────────────────────────────────

test("parseSgrMousePackets accepts pure SGR sequences", () => {
  const tui = makeFakeTui(null);
  installMouse(tui);
  // 解析在点击路径内验证：非 SGR 输入必须放行（不 consume）。
  expect(click(tui, 5, 10)).toBeUndefined(); // 普通输入放行
  teardownMouseInteraction();
});

test("click on a collapsed group hint expands the group", () => {
  const hooks = installToolGrouping(() => true);
  hooks.setTheme(stubTheme);
  const container = new Container();
  const bash1 = makeTool("bash", { command: "npm test" });
  const bash2 = makeTool("bash", { command: "bun build" });
  container.addChild(bash1);
  container.addChild(bash2);
  settle(bash1);
  settle(bash2);
  const group = container.children[0] as ToolGroupComponent;
  expect(group.expanded).toBe(false);

  const lines = container.render(100).map(String);
  // 组头行（含 hint）在第 2 行（0-based index 1）
  const headerLine = lines[1]!;
  const col = hintColumn(headerLine);
  expect(col).toBeGreaterThan(0);

  const tui = makeFakeTui(makeLayout(container));
  installMouse(tui);
  const result = click(tui, 2, col);
  expect(result).toEqual({ consume: true });
  expect(group.expanded).toBe(true);
  expect(asTool(bash1)?.expanded).toBe(true);
  teardownMouseInteraction();
});

test("click on an expanded group card collapses it", () => {
  const hooks = installToolGrouping(() => true);
  hooks.setTheme(stubTheme);
  const container = new Container();
  const bash1 = makeTool("bash", { command: "npm test" });
  const bash2 = makeTool("bash", { command: "bun build" });
  container.addChild(bash1);
  container.addChild(bash2);
  settle(bash1);
  settle(bash2);
  const group = container.children[0] as ToolGroupComponent;
  group.setExpanded(true);

  const tui = makeFakeTui(makeLayout(container));
  installMouse(tui);
  // 展开态组头行
  const result = click(tui, 2, 5);
  expect(result).toEqual({ consume: true });
  expect(group.expanded).toBe(false);
  teardownMouseInteraction();
});

test("clicking anywhere on a collapsed card expands it", () => {
  const hooks = installToolGrouping(() => true);
  hooks.setTheme(stubTheme);
  const container = new Container();
  const bash1 = makeTool("bash", { command: "npm test" });
  const bash2 = makeTool("bash", { command: "bun build" });
  container.addChild(bash1);
  container.addChild(bash2);
  settle(bash1);
  settle(bash2);
  const group = container.children[0] as ToolGroupComponent;

  const tui = makeFakeTui(makeLayout(container));
  installMouse(tui);
  // 摘要行（无 hint）任意列点击 → 展开（不再要求命中 hint 文本）。
  const result = click(tui, 3, 5);
  expect(result).toEqual({ consume: true });
  expect(group.expanded).toBe(true);
  teardownMouseInteraction();
});

test("single-expand: opening a second card collapses the first", () => {
  // 禁用分组 → 两个独立工具卡（ccstyle 渲染提供 hint）
  installToolGrouping(() => false);
  installDefaultMode();
  const container = new Container();
  const read1 = makeTool("read", { path: "a.ts" });
  const read2 = makeTool("read", { path: "b.ts" });
  container.addChild(read1);
  container.addChild(read2);
  settle(read1);
  settle(read2);

  const lines = container.render(100).map(String);
  const tui = makeFakeTui(makeLayout(container));
  installMouse(tui);

  const row1 = lines.findIndex((line) => line.includes("to show more"));
  expect(row1).toBeGreaterThanOrEqual(0);
  const col1 = hintColumn(lines[row1]!);
  expect(click(tui, row1 + 1, col1)).toEqual({ consume: true });
  expect(asTool(read1)?.expanded).toBe(true);

  // read1 已展开 → 布局行数变化，基于新布局定位第二个卡
  tui.currentLayout = { root: makeLayout(container) };
  const freshLines = ((tui.currentLayout as { root: { lines: string[] } }).root).lines;
  const secondLine = freshLines.findIndex((line) => line.includes("to show more"));
  expect(secondLine).toBeGreaterThanOrEqual(0);
  const col2 = hintColumn(freshLines[secondLine]!);
  expect(click(tui, secondLine + 1, col2)).toEqual({ consume: true });
  expect(asTool(read2)?.expanded).toBe(true);
  expect(asTool(read1)?.expanded).toBe(false);
  teardownMouseInteraction();
});

test("clicks outside tool cards fall through to the official chain", () => {
  const container = new Container();
  container.addChild(new Container()); // 空容器，无工具
  const tui = makeFakeTui(makeLayout(container));
  installMouse(tui);
  expect(click(tui, 2, 5)).toBeUndefined();
  teardownMouseInteraction();
});

test("mouse disabled (ccstyle off) lets all input through", () => {
  const hooks = installToolGrouping(() => true);
  hooks.setTheme(stubTheme);
  const container = new Container();
  const bash1 = makeTool("bash", { command: "npm test" });
  const bash2 = makeTool("bash", { command: "bun build" });
  container.addChild(bash1);
  container.addChild(bash2);
  settle(bash1);
  settle(bash2);
  const group = container.children[0] as ToolGroupComponent;

  const tui = makeFakeTui(makeLayout(container));
  installMouse(tui, false); // enabled=false
  const lines = container.render(100).map(String);
  const col = hintColumn(lines[1]!);
  const result = click(tui, 2, col);
  expect(result).toBeUndefined();
  expect(group.expanded).toBe(false);
  teardownMouseInteraction();
});

test("teardown restores the original handleViewportInput", () => {
  const container = new Container();
  container.addChild(makeTool("read", { path: "a.ts" }));
  const tui = makeFakeTui(makeLayout(container));
  const proto = Object.getPrototypeOf(tui) as { handleViewportInput: unknown };
  const original = proto.handleViewportInput;
  installMouse(tui);
  expect(tui.handleViewportInput).not.toBe(original);
  teardownMouseInteraction();
  expect(tui.handleViewportInput).toBe(original);
});

test("clicking a collapsed standalone tool hint expands it", () => {
  installDefaultMode();
  const container = new Container();
  const read = makeTool("read", { path: "a.ts" });
  container.addChild(read);
  settle(read, "body");

  const lines = container.render(100).map(String);
  const row = lines.findIndex((line) => line.includes("to show more"));
  expect(row).toBeGreaterThanOrEqual(0);
  const col = hintColumn(lines[row]!);
  const tui = makeFakeTui(makeLayout(container));
  installMouse(tui);

  expect(click(tui, row + 1, col)).toEqual({ consume: true });
  expect(asTool(read)?.expanded).toBe(true);
  teardownMouseInteraction();
});
