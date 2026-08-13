import { keyText } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "../ui/rendering.ts";

/**
 * Shared helpers for the ccstyle (Claude Code style) rendering layer.
 *
 * Ported from pi-cc-extensions (MIT, minuque/pi-cc-extensions v0.8.54) —
 * trimmed to the pieces pico needs: tool-card summaries, grouping, and the
 * expanded Input/Output view. No mouse interaction, no rich diff, no compact
 * round summary in this port.
 */

/** pico 定制工具中 summarizeToolCall 有有意义输出的那些。 */
export const PICO_TOOL_SUMMARIES: Record<string, true> = {
  askUserQuestion: true,
  todoWrite: true,
  lsp: true,
  memory: true,
  visionAnalyze: true,
  webSearch: true,
  webFetch: true,
};

export const TOOL_LOADING_INTERVAL_MS = 80;

const BRAILLE_LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Rotating braille spinner frame for pending tool calls. */
export function toolLoadingIcon(now = Date.now()): string {
  return BRAILLE_LOADING_FRAMES[
    Math.floor(now / TOOL_LOADING_INTERVAL_MS) % BRAILLE_LOADING_FRAMES.length
  ]!;
}

/** "ctrl+o to show more" — resolves the actual bound expand shortcut. */
export function ccHint(): string {
  return `${keyText("app.tools.expand")} to show more`;
}

/** Collapse whitespace and truncate to max chars — for one-line summaries. */
export function oneLine(text: string, max = 96): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Strip ANSI/control sequences from tool result text before it reaches the
 * terminal. Like pico's sanitizeTerminalText but stricter: results can carry
 * stray ESC bytes that survived CSI stripping, plus CRLF from captured
 * terminal output. Optional maxChars bounds the work for preview paths.
 */
export function sanitizeToolResultText(value: string, maxChars?: number): string {
  const source =
    typeof maxChars === "number" && maxChars >= 0 && value.length > maxChars
      ? value.slice(0, maxChars)
      : value;
  return sanitizeTerminalText(source)
    .replace(/\x1B/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}
