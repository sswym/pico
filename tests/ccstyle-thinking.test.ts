import { afterEach, beforeEach, expect, test } from "bun:test";
import { Container, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, getMarkdownTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  __resetThinkingCollapseForTests,
  asThinkingBlock,
  installThinkingCollapse,
  setThinkingTheme,
} from "../src/extensions/ccstyle/thinking.ts";
import {
  __resetCcstyleMouseForTests,
  installMouseInteraction,
  teardownMouseInteraction,
} from "../src/extensions/ccstyle/mouse.ts";

/**
 * ccstyle thinking-block tests: collapsible thinking runs inside assistant
 * messages — collapsed header by default, click to expand/collapse each run
 * independently, upstream semantics preserved when disabled or hideThinkingBlock.
 */

const stubTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_slot: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme;

function makeMessage(content: unknown[]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai",
    provider: "openai",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "end_turn",
    timestamp: 0,
  } as unknown as AssistantMessage;
}

function makeComponent(hideThinkingBlock: boolean, content: unknown[]): AssistantMessageComponent {
  return new AssistantMessageComponent(makeMessage(content), hideThinkingBlock, getMarkdownTheme(), "Thinking...", 1, []);
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
    get: () => () => { },
  });
  return tui;
}

function makeLayout(component: Component, width = 100, height = 50): unknown {
  const lines = component.render(width).map((line) => String(line));
  return {
    clip: { x: 0, y: 0, width, height },
    rect: { x: 0, y: 0, width, height },
    children: [],
    lines,
    component,
  };
}

function click(tui: Record<string, unknown>, row: number, col: number): unknown {
  return (tui.handleViewportInput as (data: string) => unknown)(`\x1b[<0;${col};${row}M`);
}

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

beforeEach(() => {
  __resetThinkingCollapseForTests();
  __resetCcstyleMouseForTests();
});

afterEach(() => {
  __resetThinkingCollapseForTests();
  __resetCcstyleMouseForTests();
});

// Same PI_PACKAGE_DIR-unset rationale as ccstyle.test.ts.
delete process.env.PI_PACKAGE_DIR;
initTheme();

test("thinking renders as a collapsed header with a click hint", () => {
  installThinkingCollapse(() => true);
  setThinkingTheme(stubTheme);
  const reasoning = "deep thought about the problem";
  const component = makeComponent(false, [{ type: "thinking", thinking: reasoning }]);

  const lines = component.render(100).map(String);
  expect(lines.join("\n")).toContain("Thinking...");
  expect(lines.join("\n")).toContain("click to expand");
  expect(lines.join("\n")).not.toContain(reasoning);
});

test("clicking the collapsed header expands the thinking block", () => {
  installThinkingCollapse(() => true);
  setThinkingTheme(stubTheme);
  const reasoning = "deep thought about the problem";
  const component = makeComponent(false, [{ type: "thinking", thinking: reasoning }]);
  const tui = makeFakeTui(makeLayout(component));
  installMouse(tui);

  const headerRow = component.render(100).map(String).findIndex((line) => line.includes("Thinking"));
  expect(headerRow).toBeGreaterThanOrEqual(0);
  expect(click(tui, headerRow + 1, 5)).toEqual({ consume: true });

  const lines = component.render(100).map(String);
  expect(lines.join("\n")).toContain(reasoning);
  expect(lines.join("\n")).not.toContain("click to expand");
  teardownMouseInteraction();
});

test("clicking the expanded body collapses it again", () => {
  installThinkingCollapse(() => true);
  setThinkingTheme(stubTheme);
  const reasoning = "a multi-line\nreasoning trace";
  const component = makeComponent(false, [{ type: "thinking", thinking: reasoning }]);
  const tui = makeFakeTui(makeLayout(component));
  installMouse(tui);

  const headerRow = component.render(100).map(String).findIndex((line) => line.includes("Thinking"));
  expect(click(tui, headerRow + 1, 5)).toEqual({ consume: true });
  const expandedLines = component.render(100).map(String);
  expect(expandedLines.join("\n")).toContain("a multi-line");
  expect(expandedLines.join("\n")).toContain("reasoning trace");

  // 展开态：内容区任意行点击 → 收起
  tui.currentLayout = { root: makeLayout(component) };
  const bodyRow = expandedLines.findIndex((line) => line.includes("reasoning trace"));
  expect(bodyRow).toBeGreaterThanOrEqual(0);
  expect(click(tui, bodyRow + 1, 5)).toEqual({ consume: true });
  expect(component.render(100).join("\n")).not.toContain("reasoning trace");
  teardownMouseInteraction();
});

test("hideThinkingBlock keeps the upstream inert label (no click hint)", () => {
  installThinkingCollapse(() => true);
  setThinkingTheme(stubTheme);
  const reasoning = "deep thought about the problem";
  const component = makeComponent(true, [{ type: "thinking", thinking: reasoning }]);
  const tui = makeFakeTui(makeLayout(component));
  installMouse(tui);

  const lines = component.render(100).map(String);
  expect(lines.join("\n")).toContain("Thinking...");
  expect(lines.join("\n")).not.toContain("click to expand");
  expect(lines.join("\n")).not.toContain(reasoning);

  // 静态标签不可点击：点击放行官方输入链
  const headerRow = lines.findIndex((line) => line.includes("Thinking"));
  expect(click(tui, headerRow + 1, 5)).toBeUndefined();
  expect(component.render(100).join("\n")).not.toContain(reasoning);
  teardownMouseInteraction();
});

test("ccstyle off renders thinking natively (full expansion, no header)", () => {
  installThinkingCollapse(() => false);
  setThinkingTheme(stubTheme);
  const reasoning = "deep thought about the problem";
  const component = makeComponent(false, [{ type: "thinking", thinking: reasoning }]);

  const lines = component.render(100).map(String);
  expect(lines.join("\n")).toContain(reasoning);
  expect(lines.join("\n")).not.toContain("click to expand");
});

test("multiple thinking runs collapse and expand independently", () => {
  installThinkingCollapse(() => true);
  setThinkingTheme(stubTheme);
  const first = "first reasoning";
  const second = "second reasoning";
  const component = makeComponent(false, [
    { type: "thinking", thinking: first },
    { type: "text", text: "answer text" },
    { type: "thinking", thinking: second },
  ]);
  const tui = makeFakeTui(makeLayout(component));
  installMouse(tui);

  const renderLines = () => component.render(100).map(String);
  expect(renderLines().join("\n")).not.toContain(first);
  expect(renderLines().join("\n")).not.toContain(second);

  // 展开第一个 run
  const firstHeader = renderLines().findIndex((line) => line.includes("Thinking"));
  expect(click(tui, firstHeader + 1, 5)).toEqual({ consume: true });
  const afterFirst = renderLines();
  expect(afterFirst.join("\n")).toContain(first);
  expect(afterFirst.join("\n")).not.toContain(second);
  expect(afterFirst.join("\n")).toContain("click to expand"); // 第二个 run 仍是折叠标题

  // 展开第二个 run
  tui.currentLayout = { root: makeLayout(component) };
  const secondHeader = renderLines().findIndex((line) => line.includes("Thinking"));
  expect(secondHeader).toBeGreaterThanOrEqual(0);
  expect(click(tui, secondHeader + 1, 5)).toEqual({ consume: true });
  const afterSecond = renderLines();
  expect(afterSecond.join("\n")).toContain(first);
  expect(afterSecond.join("\n")).toContain(second);
  teardownMouseInteraction();
});

test("expansion state survives subsequent updates on the same component", () => {
  installThinkingCollapse(() => true);
  setThinkingTheme(stubTheme);
  const component = makeComponent(false, [{ type: "thinking", thinking: "first pass" }]);
  const tui = makeFakeTui(makeLayout(component));
  installMouse(tui);

  const headerRow = component.render(100).map(String).findIndex((line) => line.includes("Thinking"));
  expect(click(tui, headerRow + 1, 5)).toEqual({ consume: true });
  expect(component.render(100).join("\n")).toContain("first pass");

  // 流式/新消息续接到同一组件：同 run 展开态保留
  component.updateContent(makeMessage([{ type: "thinking", thinking: "second pass" }]));
  const lines = component.render(100).map(String);
  expect(lines.join("\n")).toContain("second pass");
  expect(lines.join("\n")).not.toContain("click to expand");
  teardownMouseInteraction();
});

test("teardown restores the original updateContent", () => {
  const prototype = AssistantMessageComponent.prototype as unknown as { updateContent: unknown };
  const original = prototype.updateContent;
  installThinkingCollapse(() => true);
  expect(prototype.updateContent).not.toBe(original);
  __resetThinkingCollapseForTests();
  expect(prototype.updateContent).toBe(original);
});

test("asThinkingBlock rejects plain containers", () => {
  expect(asThinkingBlock(new Container())).toBeUndefined();
});