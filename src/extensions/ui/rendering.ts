import {
  keyText,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Todo } from "../todo/schema.ts";

export const ELLIPSIS = "…";

export const UI_ICONS = {
  success: "✓",
  error: "✗",
  running: "⏳",
  partial: "◐",
  toolCall: "→",
  tool: "•",
  pending: "○",
} as const;

export function truncateWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}${ELLIPSIS}`;
}

export function renderToolTitle(theme: Theme, toolName: string, summary?: string): string {
  const title = `${theme.fg("muted", `${UI_ICONS.tool} `)}${theme.fg("toolTitle", theme.bold(toolName))}`;
  return summary ? `${title} ${theme.fg("accent", summary)}` : title;
}

export function renderExpandHint(theme: Theme): string {
  return `${theme.fg("muted", "(")}${theme.fg("dim", keyText("app.tools.expand"))}${theme.fg("muted", " to expand)")}`;
}

export function renderStatusIcon(
  theme: Theme,
  status: "success" | "error" | "running" | "partial" | "pending",
): string {
  const color =
    status === "success" ? "success" :
    status === "error" ? "error" :
    status === "pending" ? "dim" :
    "warning";
  return theme.fg(color, UI_ICONS[status]);
}

export function todoStatusIcon(status: Todo["status"]): string {
  if (status === "completed") return UI_ICONS.success;
  if (status === "in_progress") return UI_ICONS.running;
  return UI_ICONS.pending;
}
