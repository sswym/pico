import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

type FooterTui = {
  requestRender?: (force?: boolean) => void;
};

type FooterData = {
  getGitBranch?: () => string | undefined;
  getExtensionStatuses?: () => unknown;
  onBranchChange?: (handler: () => void) => () => void;
};

type FooterFactory = (
  tui: FooterTui,
  theme: Theme,
  footerData: FooterData,
) => Component;

type FooterContext = Pick<ExtensionContext, "model" | "sessionManager">;

function usageStats(ctx: FooterContext): { input: number; output: number; cost: number } {
  let input = 0;
  let output = 0;
  let cost = 0;
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message as Partial<AssistantMessage>;
    if (message.role !== "assistant" || !message.usage) continue;
    input += message.usage.input ?? 0;
    output += message.usage.output ?? 0;
    cost += message.usage.cost?.total ?? 0;
  }
  return { input, output, cost };
}

function compactNumber(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function cleanStatus(status: string): string {
  return status.replace(/\s+/g, " ").trim();
}

function extractStatusText(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value instanceof Map) {
    return Array.from(value.values()).map((item) => String(item));
  }
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).map((item) => String(item));
}

function compactModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-\d+(?:\.\d+)*$/, "")
    .replace(/-latest$/, "");
}

function joinSegments(theme: Theme, segments: string[]): string {
  return segments
    .filter((segment) => segment.length > 0)
    .map((segment, index) => index === 0 ? theme.fg("accent", segment) : theme.fg("dim", segment))
    .join(theme.fg("muted", " · "));
}

export function renderClaudeLikeFooterLine(
  width: number,
  ctx: FooterContext,
  theme: Theme,
  footerData: FooterData,
): string {
  const stats = usageStats(ctx);
  const branch = footerData.getGitBranch?.();
  const statuses = extractStatusText(footerData.getExtensionStatuses?.())
    .map(cleanStatus)
    .filter(Boolean)
    .slice(0, width < 90 ? 1 : 3);
  const model = ctx.model?.id ?? "no-model";

  const leftSegments = [
    "srcode",
    ...statuses,
    `↑${compactNumber(stats.input)} ↓${compactNumber(stats.output)}`,
    `$${stats.cost.toFixed(3)}`,
  ];
  const rightSegments = [
    model,
    branch ? `git:${branch}` : "",
  ];

  let left = joinSegments(theme, leftSegments);
  let right = joinSegments(theme, rightSegments);

  if (width < 72) {
    left = joinSegments(theme, ["srcode", ...statuses]);
    right = joinSegments(theme, [compactModel(model), branch ?? ""]);
  }

  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap <= 1) {
    return truncateToWidth(`${left}${theme.fg("muted", " · ")}${right}`, width);
  }
  return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width);
}

export function createClaudeLikeFooter(ctx: FooterContext): FooterFactory {
  return (tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender?.(true));
    return {
      render(width: number): string[] {
        return [renderClaudeLikeFooterLine(width, ctx, theme, footerData)];
      },
      invalidate(): void {},
      dispose(): void {
        unsubscribe?.();
      },
    };
  };
}

export function installClaudeLikeFooter(ctx: ExtensionContext): void {
  const ui = ctx.ui as ExtensionContext["ui"] & {
    setFooter?: (factory: FooterFactory | undefined) => void;
  };
  ui.setFooter?.(createClaudeLikeFooter(ctx));
}
