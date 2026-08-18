import {
  AssistantMessageComponent,
  Theme,
  ToolExecutionComponent,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { TOOL_LOADING_INTERVAL_MS, toolLoadingIcon, ccHint, humanizeToolName, summaryOfTool } from "./util.ts";

/**
 * Tool-call grouping for pico — ported from pi-cc-extensions
 * (MIT, minuque/pi-cc-extensions v0.8.54, extensions/renderer/tool/grouping.ts).
 *
 * Patches Container.prototype.addChild/removeChild/clear so consecutive
 * ToolExecutionComponents are grouped into a ToolGroupComponent:
 *
 *   ● Bash: 2 done • 1 running • ctrl+o to show more
 *   ├ ✓ Bash npm test
 *   ├ ✓ Bash bun run build
 *   └ ● Bash bun test
 *
 * Collapsed: one summary line per tool. Expanded: each tool's full render
 * with tree branches on a user-message background.
 *
 * Install-safe across /reload: a fresh install deactivates the previous one
 * and ungroups its live components before taking over. Module state survives
 * /reload because pico's extension modules are statically imported once.
 */

/** Tools with bespoke rendering never enter a group (diff cards stay alone). */
const NON_GROUPABLE: Record<string, true> = { edit: true, write: true, apply_patch: true };

/**
 * Runtime shape of ToolExecutionComponent internals. Upstream's d.ts declares
 * these fields private, but they are plain public properties in the JS class
 * (toolName, args, result, isPartial, …) — single boundary cast in asTool().
 */
export interface ToolComponent extends Component {
  toolName: string;
  toolCallId: string;
  args: unknown;
  result?: { isError?: boolean };
  isPartial: boolean;
  executionStarted: boolean;
  toolDefinition?: { name?: string };
  builtInToolDefinition?: unknown;
  expanded: boolean;
  children: Component[];
  setExpanded?(expanded: boolean): void;
}

/** Boundary cast: d.ts hides runtime-public fields behind private modifiers. */
export function asTool(value: Component): ToolComponent | undefined {
  return value instanceof ToolExecutionComponent ? (value as unknown as ToolComponent) : undefined;
}

function asGroupable(value: unknown): ToolComponent | undefined {
  if (!(value instanceof ToolExecutionComponent)) return undefined;
  const tool = value as unknown as ToolComponent;
  return NON_GROUPABLE[toolName(tool)] === true ? undefined : tool;
}

function toolName(tool: ToolComponent): string {
  return tool.toolName || tool.toolDefinition?.name || "tool";
}

function isIgnorable(value: unknown): boolean {
  if (value instanceof Spacer) return true;
  if (!(value instanceof AssistantMessageComponent)) return false;
  // contentContainer is runtime-public; the d.ts marks it private.
  const internals = value as unknown as { contentContainer?: { children?: unknown[] } };
  const children = internals.contentContainer?.children;
  return Array.isArray(children) && children.length === 0;
}

function previousSibling(
  children: Component[],
  start: number,
): { child: Component; index: number } | undefined {
  let skipped = 0;
  for (let index = start; index >= 0; index--) {
    const child = children[index];
    if (child === undefined) continue;
    if (isIgnorable(child) && skipped < 3) {
      skipped++;
      continue;
    }
    return { child, index };
  }
  return undefined;
}

type ToolStatus = "pending" | "success" | "error";

function status(tool: ToolComponent): ToolStatus {
  if (tool.result?.isError) return "error";
  if (tool.isPartial === true || (tool.executionStarted && !tool.result)) return "pending";
  return tool.result ? "success" : "pending";
}

function statusIcon(value: ToolStatus): string {
  if (value === "success") return "✓";
  if (value === "error") return "✗";
  return toolLoadingIcon();
}

type Patch = {
  active: boolean;
  prototype: Container;
  original: ContainerMethods;
  installed: ContainerMethods;
  groups: Set<ToolGroupComponent>;
  enabled: () => boolean;
  generation: number;
  lastEnabled: boolean;
  theme?: Theme;
  animationTimer: Timer | undefined;
};

type ContainerMethods = {
  addChild: Container["addChild"];
  removeChild: Container["removeChild"];
  clear: Container["clear"];
};

/** tool/group → its direct parent container. */
const parentMap = new WeakMap<Component, Component>();
/** tool → the grouping generation that claimed it (guards stale groups). */
const generationMap = new WeakMap<ToolComponent, number>();

let currentPatch: Patch | undefined;

function scheduleGroupAnimation(patch: Patch): void {
  if (patch.animationTimer || !patch.active) return;
  patch.animationTimer = setTimeout(() => {
    patch.animationTimer = undefined;
    if (!patch.active) return;
    for (const group of patch.groups) {
      const hasPending = group.children.some((child) => {
        const tool = asTool(child);
        return tool !== undefined && status(tool) === "pending";
      });
      if (hasPending) group.invalidate();
    }
  }, TOOL_LOADING_INTERVAL_MS);
  patch.animationTimer.unref?.();
}

function visibleLines(lines: string[]): string[] {
  return lines.filter((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim());
}

function stripLeadingStatusIcon(line: string): string {
  return line.replace(
    /^((?:\x1b\[[0-9;]*m|[ \t]|[├└│─])*)(?:\x1b\[[0-9;]*m)*(?:[✓✗●○■⬤•·])(?:\x1b\[[0-9;]*m)*\s+/,
    "$1",
  );
}

function stripBackgroundAnsi(line: string): string {
  return line.replace(/\x1b\[(?:4[0-9]|10[0-7]|48(?:(?:;|:)[0-9]+)+|49)m/g, "");
}

function stripLeadingSpaces(line: string, count: number): string {
  let offset = 0;
  let removed = 0;
  let ansi = "";
  while (offset < line.length) {
    const control = line.slice(offset).match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0];
    if (control) {
      ansi += control;
      offset += control.length;
      continue;
    }
    if (removed < count && line[offset] === " ") {
      removed++;
      offset++;
      continue;
    }
    break;
  }
  return ansi + line.slice(offset);
}

/** One full-width row with a slot background — used for the expanded group card. */
function paddedBackgroundRow(
  theme: Theme | undefined,
  slot: "userMessageBg",
  content: string,
  width: number,
  bgAnsiOverride?: string,
): string {
  const innerWidth = Math.max(0, width - 2);
  const clipped = truncateToWidth(stripBackgroundAnsi(content), innerWidth, "");
  const row = ` ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} `;
  const bgAnsi =
    bgAnsiOverride ||
    (theme
      ? theme.getBgAnsi?.(slot) || theme.bg(slot, "").match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0] || ""
      : "");
  const stable = bgAnsi ? row.replace(/\x1b\[(?:0)?m/g, (reset) => reset + bgAnsi) : row;
  if (!bgAnsi) return theme ? theme.bg(slot, stable) : row;
  return `${bgAnsi}${stable}\x1b[49m`;
}



function summaryOf(tool: ToolComponent): { main: string; detail: string } {
  return summaryOfTool(tool.toolCallId, toolName(tool), tool.args);
}

function toolNameList(tools: ToolComponent[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(toolName(tool), (counts.get(toolName(tool)) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${name}${count > 1 ? `×${count}` : ""}`).join(", ");
}

let nextGroupId = 1;

export class ToolGroupComponent extends Container {
  readonly toolCallId = `ccstyle-tool-group-${nextGroupId++}`;
  readonly toolName = "Tool group";
  readonly ownerPatch: Patch;
  private _expanded = false;

  /** 分组是否展开（只读；测试与外部读状态用）。 */
  get expanded(): boolean {
    return this._expanded;
  }

  constructor(patch: Patch) {
    super();
    this.ownerPatch = patch;
    patch.groups.add(this);
  }

  addTool(tool: ToolComponent): void {
    this.children.push(tool);
    parentMap.set(tool, this);
  }

  releaseTools(): ToolComponent[] {
    const tools = this.children
      .map((child) => asTool(child))
      .filter((tool): tool is ToolComponent => tool !== undefined);
    this.children.length = 0;
    this.ownerPatch.groups.delete(this);
    return tools;
  }

  removeTool(tool: ToolComponent): void {
    const index = this.children.indexOf(tool);
    if (index >= 0) this.children.splice(index, 1);
    if (parentMap.get(tool) === this) parentMap.delete(tool);
  }

  setExpanded(expanded: boolean): void {
    this._expanded = expanded;
    for (const child of this.children) asTool(child)?.setExpanded?.(expanded);
  }

  /**
   * 展开时按局部行定位内部工具（null = 行属于 group 自身：空行/头行/尾行）。
   * 行数计算与 render 保持一致：宽度 width-2 + 空行过滤。供鼠标命中用。
   */
  childAtRow(localRow: number, width: number): { component: ToolComponent; row: number } | null {
    if (!this._expanded || localRow < 2) return null;
    let offset = 2;
    for (const child of this.children) {
      const tool = asTool(child);
      if (!tool) continue;
      let lines: string[] = [];
      try {
        const rendered = tool.render(Math.max(1, width - 2));
        if (Array.isArray(rendered)) lines = visibleLines(rendered.map((line) => String(line)));
      } catch {
        lines = [];
      }
      const lineCount = Math.max(1, lines.length);
      if (localRow < offset + lineCount) {
        return { component: tool, row: localRow - offset };
      }
      offset += lineCount;
    }
    return null;
  }

  override invalidate(): void {
    for (const child of this.children) child.invalidate();
  }

  override render(width: number): string[] {
    const theme = this.ownerPatch.theme;
    const fg = (color: ThemeColor, text: string) => theme?.fg(color, text) ?? text;
    const counts = { pending: 0, success: 0, error: 0 };
    const tools = this.children
      .map((child) => asTool(child))
      .filter((tool): tool is ToolComponent => tool !== undefined);
    for (const tool of tools) counts[status(tool)]++;
    const countText = (["pending", "success", "error"] as const)
      .filter((key) => counts[key])
      .map((key) => {
        const label = key === "pending" ? "running" : key === "success" ? "done" : "failed";
        const color: ThemeColor = key === "pending" ? "accent" : key;
        return `${fg(color, String(counts[key]))} ${label}`;
      })
      .join(` ${fg("dim", "•")} `);
    const names = new Set(tools.map(toolName));
    const label = names.size === 1 ? humanizeToolName(toolName(tools[0]!)) : "Multiple Tools";
    const overall: ToolStatus = counts.error ? "error" : counts.pending ? "pending" : "success";
    if (overall === "pending") scheduleGroupAnimation(this.ownerPatch);
    const overallColor: ThemeColor = overall === "pending" ? "accent" : overall;
    const nameList = names.size > 1 ? ` ${fg("dim", `• ${toolNameList(tools)}`)}` : "";
    const hint = `${fg("dim", "•")} ${fg("dim", ccHint())}`;
    const lines = [
      "",
      truncateToWidth(
        ` ${fg(overallColor, "●")} ${label}: ${countText}${nameList} ${hint}`,
        width,
        "…",
      ),
    ];
    const total = tools.length;
    const expandedLines: string[] = [];
    for (let index = 0; index < total; index++) {
      const tool = tools[index]!;
      const toolStatus = status(tool);
      const color: ThemeColor = toolStatus === "pending" ? "accent" : toolStatus;
      const branch = index === total - 1 ? "└" : "├";
      const continuation = index === total - 1 ? "  " : "│ ";
      if (!this._expanded) {
        const summary = summaryOf(tool);
        lines.push(
          truncateToWidth(
            ` ${fg("dim", branch)} ${fg(color, statusIcon(toolStatus))} ${fg("toolTitle", summary.main)}${fg("dim", summary.detail)}`,
            width,
            "…",
          ),
        );
        continue;
      }
      const rendered = visibleLines(tool.render(Math.max(1, width - 2)));
      if (rendered.length) {
        rendered[0] = stripLeadingStatusIcon(rendered[0]!)
          .replace(/^ +/, "")
          .replace(/^((?:\x1b\[[0-?]*[ -/]*[@-~])*) +/, "$1");
      }
      const childLines = rendered.length ? rendered : [summaryOf(tool).main];
      for (let lineIndex = 0; lineIndex < childLines.length; lineIndex++) {
        const content =
          // 续行只剥外层 Box 的 1 格 left pad，保留 Input/Output 相对缩进
          lineIndex === 0 ? childLines[lineIndex]! : stripLeadingSpaces(childLines[lineIndex]!, 1);
        const prefix =
          lineIndex === 0
            ? `${fg("dim", branch)} ${fg(color, statusIcon(toolStatus))} `
            : fg("dim", continuation);
        expandedLines.push(prefix + content);
      }
    }
    if (this._expanded) {
      // 展开面板统一用 user message 背景色，不按状态区分。
      const backgroundSlot = "userMessageBg" as const;
      for (const line of expandedLines) {
        lines.push(paddedBackgroundRow(theme, backgroundSlot, line, width));
      }
      lines.push(paddedBackgroundRow(theme, backgroundSlot, "", width));
    }
    return lines;
  }
}

function ungroup(patch: Patch): void {
  for (const group of [...patch.groups]) {
    // Groups are always mounted inside Containers (parentMap owner).
    const parent = parentMap.get(group) as Container | undefined;
    if (parent === undefined) {
      patch.groups.delete(group);
      continue;
    }
    const index = parent.children.indexOf(group);
    if (index < 0) {
      patch.groups.delete(group);
      continue;
    }
    const tools = group.releaseTools();
    for (const tool of tools) parentMap.set(tool, parent);
    parent.children.splice(index, 1, ...tools);
  }
}

function normalizeGroup(patch: Patch, group: ToolGroupComponent): void {
  if (group.children.length > 1) return;
  const parent = parentMap.get(group) as Container | undefined;
  const index = parent?.children.indexOf(group) ?? -1;
  const tools = group.releaseTools();
  parentMap.delete(group);
  if (index < 0) {
    for (const tool of tools) parentMap.delete(tool);
    return;
  }
  if (tools.length === 1) {
    parentMap.set(tools[0]!, parent!);
    parent!.children.splice(index, 1, tools[0]!);
  } else {
    parent!.children.splice(index, 1);
  }
}

function maybeGroup(patch: Patch, parent: Container, component: Component): void {
  const tool = asGroupable(component);
  if (!patch.active || !patch.enabled() || parent instanceof ToolGroupComponent || !tool) {
    return;
  }
  generationMap.set(tool, patch.generation);
  const children = parent.children;
  const index = children.indexOf(component);
  const prior = previousSibling(children, index - 1);
  if (!prior) return;
  if (prior.child instanceof ToolGroupComponent && prior.child.ownerPatch === patch) {
    children.splice(index, 1);
    prior.child.addTool(tool);
    return;
  }
  const priorTool = asGroupable(prior.child);
  if (!priorTool || generationMap.get(priorTool) !== patch.generation) return;
  const group = new ToolGroupComponent(patch);
  group.addTool(priorTool);
  group.addTool(tool);
  parentMap.set(group, parent);
  children[prior.index] = group;
  children.splice(index, 1);
}

/** /reload 不会重新 addChild；扫描当前 mounted roots，把已有工具重新送入同一分组规则。 */
function regroup(patch: Patch, root: unknown): void {
  if (!patch.active || !patch.enabled() || !root) return;
  const seen = new Set<unknown>();
  // Component trees at runtime are untyped beyond Component — duck-typed walk.
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const node = value as unknown as { children?: Component[]; getMountedRoots?: () => unknown };
    if (Array.isArray(node.children)) {
      const container = value as unknown as Container;
      for (const child of [...node.children]) {
        if (child && typeof child === "object") parentMap.set(child, container);
        maybeGroup(patch, container, child);
      }
      for (const child of [...node.children]) {
        if (!(child instanceof ToolGroupComponent) && asGroupable(child) === undefined) visit(child);
      }
    }
    try {
      const mounted = node.getMountedRoots?.();
      if (Array.isArray(mounted)) visit(mounted);
    } catch {
      // renderer 切换中的惰性 Proxy 可能暂时没有 mounted roots。
    }
  };
  visit(root);
}

function deactivatePatch(patch: Patch): void {
  if (!patch.active) return;
  patch.active = false;
  clearTimeout(patch.animationTimer);
  patch.animationTimer = undefined;
  patch.enabled = () => false;
  ungroup(patch);
  if (patch.prototype.addChild === patch.installed.addChild) {
    patch.prototype.addChild = patch.original.addChild;
  }
  if (patch.prototype.removeChild === patch.installed.removeChild) {
    patch.prototype.removeChild = patch.original.removeChild;
  }
  if (patch.prototype.clear === patch.installed.clear) {
    patch.prototype.clear = patch.original.clear;
  }
}

export type ToolGroupingHooks = {
  setTheme(theme: Theme): void;
  refresh(root?: unknown): void;
  shutdown(): void;
};

export function installToolGrouping(getEnabled: () => boolean): ToolGroupingHooks {
  const prototype = Container.prototype;
  const previous = currentPatch;
  if (previous) {
    previous.active = false;
    previous.enabled = () => false;
    clearTimeout(previous.animationTimer);
    previous.animationTimer = undefined;
    ungroup(previous);
  }
  const original: ContainerMethods = {
    addChild:
      previous && prototype.addChild === previous.installed.addChild
        ? previous.original.addChild
        : prototype.addChild,
    removeChild:
      previous && prototype.removeChild === previous.installed.removeChild
        ? previous.original.removeChild
        : prototype.removeChild,
    clear:
      previous && prototype.clear === previous.installed.clear
        ? previous.original.clear
        : prototype.clear,
  };
  const patch: Patch = {
    active: true,
    prototype,
    original,
    installed: undefined as unknown as ContainerMethods,
    groups: new Set(),
    enabled: getEnabled,
    generation: 0,
    lastEnabled: getEnabled(),
    animationTimer: undefined,
  };
  patch.installed = {
    addChild: function(this: Container, component: Component): void {
      patch.original.addChild.call(this, component);
      if (component && typeof component === "object") parentMap.set(component, this);
      maybeGroup(patch, this, component);
    },
    removeChild: function(this: Container, component: Component): void {
      const group = parentMap.get(component);
      if (group instanceof ToolGroupComponent && parentMap.get(group) === this) {
        const tool = asTool(component);
        if (tool) {
          group.removeTool(tool);
          normalizeGroup(patch, group);
        }
        return;
      }
      patch.original.removeChild.call(this, component);
      if (parentMap.get(component) === this) parentMap.delete(component);
      if (this instanceof ToolGroupComponent) normalizeGroup(patch, this);
      if (component instanceof ToolGroupComponent) {
        for (const tool of component.releaseTools()) parentMap.delete(tool);
      }
    },
    clear: function(this: Container): void {
      for (const child of [...this.children]) {
        if (child instanceof ToolGroupComponent) {
          for (const tool of child.releaseTools()) parentMap.delete(tool);
        }
        if (parentMap.get(child) === this) parentMap.delete(child);
      }
      if (this instanceof ToolGroupComponent) patch.groups.delete(this);
      patch.original.clear.call(this);
    },
  };
  prototype.addChild = patch.installed.addChild;
  prototype.removeChild = patch.installed.removeChild;
  prototype.clear = patch.installed.clear;
  currentPatch = patch;
  return {
    setTheme(theme: Theme) {
      patch.theme = theme;
    },
    refresh(root?: unknown) {
      const enabled = patch.enabled();
      if (enabled !== patch.lastEnabled) {
        patch.lastEnabled = enabled;
        if (enabled) patch.generation++;
      }
      if (enabled) regroup(patch, root);
      else ungroup(patch);
    },
    shutdown() {
      deactivatePatch(patch);
    },
  };
}

/** Test hook: deactivate any live grouping patch and reset ids. */
export function __resetCcstyleGroupingForTests(): void {
  if (currentPatch) deactivatePatch(currentPatch);
  nextGroupId = 1;
}

export { __resetToolSummaryCacheForTests, __toolSummaryCacheSize } from "./util.ts";
