import {
  keyText,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Todo } from "../todo/schema.ts";

export const ELLIPSIS = "…";

export const UI_ICONS = {
  success: "✓",
  error: "✗",
  running: "●",
  partial: "◐",
  toolCall: "›",
  tool: "•",
  pending: "○",
} as const;

export function truncateWithEllipsis(text: string, maxLength: number): string {
  // Split by code points, not UTF-16 units: slicing raw units can split a
  // surrogate pair and render a lone half-emoji.
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, Math.max(0, maxLength - 1)).join("").trimEnd()}${ELLIPSIS}`;
}

/**
 * Strip ANSI/control sequences from untrusted tool output before it reaches
 * the terminal. Tool results (MCP server output, file contents via LSP,
 * memory text) can contain ESC sequences that would drive the terminal —
 * OSC 52 clipboard overwrite, title changes, cursor moves, fake UI. Mirrors
 * upstream's sanitizeBinaryOutput for built-in tools.
 */
export function sanitizeTerminalText(text: string): string {
  return text
    // OSC sequences: ESC ] ... (BEL | ESC \) — titles, clipboard, hyperlinks
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // DCS sequences: ESC P ... ESC \ (kitty graphics protocol, Sixel probes) —
    // can trigger image rendering or garbage in the terminal (2.1.8).
    .replace(/\x1bP[^\x1b]*(?:\x1b\\)/gs, "")
    // APC sequences: ESC _ ... ESC \ (application command protocol).
    .replace(/\x1b_[^\x1b]*(?:\x1b\\)/gs, "")
    // CSI sequences: ESC [ params intermediates final — colors, cursor, modes
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // Single-char ESC sequences: save/restore cursor (7/8), keypad (=/>),
    // line feed/index (D/E/M), full reset (c), SS2/SS3 (N/O), DECBI/FI (6/9),
    // and a DCS starter (P) that never got its terminator.
    .replace(/\x1b[=>6789DECHMcNOP]/g, "")
    // Two-byte ESC sequences: ESC intermediate final — charset selection
    // ("(B", "(0"), line attributes (#8), keypad remaps. Without this pass
    // the leftovers render as garbage like "(B" / "(0" in the TUI.
    .replace(/\x1b[()*+\-./#=>][A-Za-z0-9]/g, "")
    // Remaining C0 controls (incl. lone ESC) and DEL
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function renderToolTitle(theme: Theme, toolName: string, summary?: string): string {
  const title = `${theme.fg("dim", `${UI_ICONS.tool} `)}${theme.fg("toolTitle", theme.bold(toolName))}`;
  return summary ? `${title} ${theme.fg("muted", summary)}` : title;
}

export function renderExpandHint(theme: Theme): string {
  return theme.fg("dim", `${keyText("app.tools.expand")} to expand`);
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
