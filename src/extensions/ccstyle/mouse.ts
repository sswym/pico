import type { Component, TUI } from "@earendil-works/pi-tui";
import { asTool, ToolGroupComponent, type ToolComponent } from "./grouping.ts";

/**
 * Fullscreen mouse interaction for tool cards — ported from pi-cc-extensions
 * (MIT, minuque/pi-cc-extensions v0.8.54, extensions/renderer/mouse/),
 * trimmed to the pico-relevant surface:
 *
 *   - pico defaults to `--tui-mode fullscreen` (TuiAltScreen), whose official
 *     input already enables SGR mouse reporting (1000/1002/1006) — clicks are
 *     available without patching terminal modes.
 *   - We wrap the instance-level handleViewportInput to consume left clicks on
 *     tool cards: click the collapsed "[to show more]" hint to expand (closing
 *     any other expanded card), click anywhere on an expanded card to collapse.
 *   - Not ported: hover highlight (needs 1003 all-motion, unreliable under
 *     tmux), show-more full preview, scroll-to-bottom button, wheel stepping.
 *
 * Hit-testing uses the official fullscreen layout tree (tui.currentLayout),
 * mapping screen coordinates → layout leaf box → component tree row.
 */

// ── SGR mouse protocol ───────────────────────────────────────────────────────

/** SGR 鼠标协议包（code;col;row + M/m 终结符）。 */
type SgrMousePacket = {
  code: number;
  col: number;
  row: number;
  final: "M" | "m";
};

/**
 * 解析整段终端输入为 SGR 鼠标包序列；数据必须完全由连续 SGR 包组成
 * （夹杂其他字节返回 null，交由常规输入链处理）。
 */
function parseSgrMousePackets(data: string): SgrMousePacket[] | null {
  const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  const packets: SgrMousePacket[] = [];
  let offset = 0;

  for (const match of data.matchAll(pattern)) {
    if (match.index !== offset) return null;
    offset = match.index + match[0].length;
    packets.push({
      code: Number(match[1]),
      col: Number(match[2]),
      row: Number(match[3]),
      final: match[4] as "M" | "m",
    });
  }

  return packets.length > 0 && offset === data.length ? packets : null;
}

/** 是否为左键按下（排除修饰键、32 表示 motion 事件）。 */
function isSgrLeftPress(packet: SgrMousePacket): boolean {
  const baseButton = packet.code & ~(4 | 8 | 16 | 32);
  return packet.final === "M" && baseButton === 0 && (packet.code & 32) === 0;
}

/** 仅剥离终端序列、保留原布局（换行/空白不动），用于命中区间计算。 */
function stripTerminalSequencesPreservingLayout(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

// ── layout-tree hit testing ──────────────────────────────────────────────────

/**
 * 运行时布局树（tui.currentLayout）的 box 结构 — 上游无公开类型，
 * 由 ccstyle 的布局遍历约定而来（clip 裁剪盒、rect 绘制盒、lines 渲染行）。
 */
type LayoutBox = {
  clip?: { x: number; y: number; width: number; height: number };
  rect?: { x: number; y: number; width: number; height: number };
  children?: unknown[];
  lines?: unknown[];
  component?: Component;
  parent?: LayoutBox;
  scrollView?: { getContentWidth?(width: number): number; isScrollbarVisible?: boolean };
};

/** 布局树点查询：返回 (x,y) 处最深含行 leaf box（屏幕行 → 组件局部行）。 */
function fullscreenLeafAt(
  layout: { root?: unknown },
  x: number,
  y: number,
): { box: LayoutBox; localRow: number } | null {
  const root = layout?.root;
  if (!root || typeof root !== "object") return null;
  const rootBox = root as unknown as LayoutBox;
  let best: { box: LayoutBox; localRow: number } | null = null;
  let bestDepth = -1;
  const visit = (box: LayoutBox, depth: number): void => {
    const clip = box.clip;
    if (!clip || x < clip.x || x >= clip.x + clip.width || y < clip.y || y >= clip.y + clip.height) {
      return;
    }
    const isLeaf = !Array.isArray(box.children) || box.children.length === 0;
    if (
      isLeaf &&
      y >= (box.rect?.y ?? 0) &&
      y < (box.rect?.y ?? 0) + Math.max(1, box.rect?.height ?? 1) &&
      depth > bestDepth
    ) {
      best = { box, localRow: Math.max(0, y - (box.rect?.y ?? 0)) };
      bestDepth = depth;
    }
    for (const child of box.children ?? []) {
      if (child && typeof child === "object") visit(child as unknown as LayoutBox, depth + 1);
    }
  };
  visit(rootBox, 0);
  return best;
}

/** leaf 自身不带 scrollView；内容宽度由最近的 scroll 祖先决定。 */
function fullscreenContentWidth(box: LayoutBox, terminalWidth: number): number {
  for (let current: LayoutBox | undefined = box; current; current = current.parent) {
    if (typeof current.scrollView?.getContentWidth === "function") {
      return Math.max(1, current.scrollView.getContentWidth(terminalWidth));
    }
  }
  return terminalWidth;
}

/** 点击列是否为官方滚动条列（放行官方拖动）。 */
function isScrollbarColumnAt(layout: { root?: unknown }, x: number): boolean {
  const root = layout?.root;
  if (!root || typeof root !== "object") return false;
  let hit = false;
  const visit = (box: LayoutBox): void => {
    if (hit) return;
    const rect = box.rect;
    if (box.scrollView?.isScrollbarVisible && rect && x === rect.x + rect.width - 1) {
      hit = true;
      return;
    }
    for (const child of box.children ?? []) {
      if (child && typeof child === "object") visit(child as unknown as LayoutBox);
    }
  };
  visit(root as unknown as LayoutBox);
  return hit;
}

type ComponentRowHit = {
  component: Component;
  row: number;
  /** 内部工具命中时所属的展开 group；普通卡点击仍折叠整个 group。 */
  group?: ToolGroupComponent;
};

/**
 * 布局 leaf box 的组件通常是容器（documentContainer/dock 容器等），工具卡与
 * widget 在其 children 内。按局部行遍历组件树，定位实际命中的子组件。
 */
function componentAtLocalRow(
  component: Component,
  localRow: number,
  width: number,
): ComponentRowHit | null {
  if (component instanceof ToolGroupComponent) {
    // 展开的 group：头两行（空行 + 头行）归 group，其余行映射到内部工具。
    const child = component.childAtRow(localRow, width);
    return child ? { ...child, group: component } : { component, row: localRow };
  }
  if (asTool(component)) {
    return { component, row: localRow };
  }
  // 容器组件（Container 子类）才有 children；Component 接口不声明它。
  const children = (component as unknown as { children?: Component[] }).children;
  if (!Array.isArray(children)) return null;
  let offset = 0;
  for (const child of children) {
    let lines: string[] = [];
    try {
      const rendered = child.render(width);
      if (Array.isArray(rendered)) lines = rendered.map((line) => String(line));
    } catch {
      lines = [];
    }
    if (localRow < offset + lines.length) {
      return (
        componentAtLocalRow(child, localRow - offset, width) ?? {
          component: child,
          row: localRow - offset,
        }
      );
    }
    offset += lines.length;
  }
  return null;
}

/** fullscreen single-expand：收集子树中的工具卡/分组（展开前收起其他）。 */
function collectFullscreenToolCards(component: Component, out: unknown[]): void {
  if (asTool(component) || component instanceof ToolGroupComponent) {
    out.push(component);
    return;
  }
  // 容器组件（Container 子类）才有 children；Component 接口不声明它。
  const children = (component as unknown as { children?: Component[] }).children;
  if (!Array.isArray(children)) return;
  for (const child of children) collectFullscreenToolCards(child, out);
}

// ── click handling ───────────────────────────────────────────────────────────

/**
 * 官方 fullscreen 工具卡点击：collapsed 卡 hint 点击展开
 * （有且仅保持一个展开：展开前收起其他工具卡），expanded 整卡二次点击收起。
 * 滚动条列、含 OSC8 链接行、非工具区域放行官方。
 */
function handleFullscreenToolClick(tui: TUI, packet: SgrMousePacket): boolean {
  const layout = (tui as unknown as { currentLayout?: { root?: unknown } }).currentLayout;
  if (!layout?.root) return false;
  // 官方事件坐标 0-based；SGR packet 1-based。
  const x = packet.col - 1;
  const y = packet.row - 1;
  if (isScrollbarColumnAt(layout, x)) return false;
  const hit = fullscreenLeafAt(layout, x, y);
  if (!hit) return false;
  const width = Math.max(1, Number(tui.terminal?.columns) || 80);
  // 布局树用 scroll 的 contentWidth 渲染内容（滚动条占用时 = width-1）；
  // 行号定位必须用同一宽度，否则换行差异导致组件行错位。
  const contentWidth = fullscreenContentWidth(hit.box, width);
  const target = componentAtLocalRow(hit.box.component ?? (hit.box as unknown as Component), hit.localRow, contentWidth);
  if (!target) return false;
  const component = target.component;
  const card = target.group ?? component;
  const line = hit.box.lines?.[hit.localRow];
  if (typeof line !== "string" || /\x1b]8;[^;]*;/.test(line)) return false;
  const tool = asTool(component);
  const isGroup = component instanceof ToolGroupComponent;
  if (!tool && !isGroup) return false;
  const targetTool = tool ?? (component as ToolComponent);
  if (!targetTool.expanded) {
    // 折叠态整卡可点击展开（不再要求命中 hint 列区间；OSC8 链接行已在上方放行）。
    // single-expand：展开前收起其他已展开工具卡/group。
    const others: unknown[] = [];
    const root = hit.box.component ?? (hit.box as unknown as Component);
    collectFullscreenToolCards(root, others);
    for (const other of others) {
      if (other === component) continue;
      const otherTool = asTool(other as Component);
      if (otherTool === undefined || !otherTool.expanded) continue;
      otherTool.setExpanded?.(false);
      otherTool.invalidate();
    }
    targetTool.setExpanded?.(true);
  } else {
    // 整卡二次点击：内部工具仍归所属 group，保持整体展开/收起语义。
    const cardTool = asTool(card);
    if (cardTool) cardTool.setExpanded?.(false);
    else if (card instanceof ToolGroupComponent) card.setExpanded(false);
  }
  card.invalidate?.();
  tui.requestRender?.();
  return true;
}

// ── install / teardown ───────────────────────────────────────────────────────

/** 0.84+ 的 tui 引用是惰性 Proxy：函数属性每次 get 返回新包装。 */
function isLazyProxyTui(tui: unknown): boolean {
  if (!tui || typeof tui !== "object") return false;
  const requestRender = (tui as { requestRender?: unknown }).requestRender;
  return typeof requestRender === "function" && requestRender !== (tui as { requestRender?: unknown }).requestRender;
}

const VIEWPORT_PATCH_KEY = Symbol.for("pico.ccstyle.viewport-patch");
const VIEWPORT_ORIGINAL_KEY = Symbol.for("pico.ccstyle.viewport-original");

let currentTui: TUI | null = null;
let mouseEnabled: () => boolean = () => true;

/**
 * 实例级包装 TuiAltScreen.handleViewportInput（惰性 Proxy 安全）：
 * 原型方法取 original（绕开 proxy 函数包装），实例 own property 装 wrapper
 * （constructor arrow 动态查找命中）。仅在 fullscreen 且无 overlay 时先消费
 * 工具卡左键点击，其余全部放行官方 selection/scrollbar/URL/键盘链。
 */
function patchViewportInput(tui: TUI): void {
  // handleViewportInput 是 TuiAltScreen 的运行时方法，d.ts 未声明；经惰性 Proxy
  // set 落到实例 own property（constructor arrow 动态查找命中）。
  const host = tui as unknown as {
    [VIEWPORT_PATCH_KEY]?: boolean;
    [VIEWPORT_ORIGINAL_KEY]?: unknown;
    handleViewportInput?: unknown;
  };
  if (host[VIEWPORT_PATCH_KEY] || !isLazyProxyTui(tui)) return;
  const proto = Object.getPrototypeOf(tui) as { handleViewportInput?: unknown } | null;
  const original = proto?.handleViewportInput;
  if (typeof original !== "function") return;
  host[VIEWPORT_PATCH_KEY] = true;
  host[VIEWPORT_ORIGINAL_KEY] = original;
  host.handleViewportInput = function (this: TUI, data: string) {
    if (mouseEnabled() && !tui.hasOverlay?.()) {
      const packets = parseSgrMousePackets(data);
      if (packets) {
        for (const packet of packets) {
          if (isSgrLeftPress(packet) && handleFullscreenToolClick(tui, packet)) {
            return { consume: true };
          }
        }
      }
    }
    return Reflect.apply(original as (...args: unknown[]) => unknown, this, [data]);
  };
}

function restoreViewportInput(tui: TUI): void {
  const host = tui as unknown as {
    [VIEWPORT_PATCH_KEY]?: boolean;
    [VIEWPORT_ORIGINAL_KEY]?: unknown;
    handleViewportInput?: unknown;
  };
  if (!host[VIEWPORT_PATCH_KEY]) return;
  const proto = Object.getPrototypeOf(tui) as { handleViewportInput?: unknown } | null;
  if (typeof proto?.handleViewportInput === "function") {
    host.handleViewportInput = proto.handleViewportInput;
  }
  delete host[VIEWPORT_PATCH_KEY];
  delete host[VIEWPORT_ORIGINAL_KEY];
}

const MOUSE_WIDGET_KEY = "pico-ccstyle-mouse";

let mouseUi: { setWidget(key: string, content?: unknown): unknown } | null = null;

export function installMouseInteraction(
  ctx: { mode: string; hasUI: boolean; ui: { setWidget(key: string, content?: unknown): unknown } },
  enabled: () => boolean,
): void {
  teardownMouseInteraction();
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  mouseEnabled = enabled;
  mouseUi = ctx.ui;
  // setWidget 的 factory 拿到 TUI 引用（扩展 API 里唯一能接触 tui 的通道）。
  ctx.ui.setWidget(MOUSE_WIDGET_KEY, (tui: TUI) => {
    currentTui = tui;
    patchViewportInput(tui);
    // 空 widget：只借 factory 捕获 tui，不渲染任何内容。
    return { render: () => [] as string[], invalidate() {} };
  });
}

export function teardownMouseInteraction(): void {
  if (currentTui) restoreViewportInput(currentTui);
  currentTui = null;
  mouseUi?.setWidget?.(MOUSE_WIDGET_KEY, undefined);
  mouseUi = null;
  mouseEnabled = () => true;
}

/** Test hook: detach the live mouse interaction. */
export function __resetCcstyleMouseForTests(): void {
  teardownMouseInteraction();
}
