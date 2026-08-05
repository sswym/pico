/**
 * Shared UI rendering helpers.
 *
 * Covers the pure formatting surface in src/extensions/ui/rendering.ts:
 * ellipsis truncation, tool titles, status/todo icon selection, and the
 * theme colour each status maps to. Terminal styling itself is not tested —
 * the theme is stubbed to return plain text.
 */
import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  ELLIPSIS,
  UI_ICONS,
  renderExpandHint,
  renderStatusIcon,
  renderToolTitle,
  todoStatusIcon,
  truncateWithEllipsis,
} from "../src/extensions/ui/rendering.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/** Theme that records the colour key each call requested. */
function recordingTheme(): { theme: Theme; colors: string[] } {
  const colors: string[] = [];
  const theme = {
    fg: (color: string, text: string) => {
      colors.push(color);
      return text;
    },
    bold: (text: string) => text,
  } as unknown as Theme;
  return { theme, colors };
}

test("truncateWithEllipsis leaves short text untouched", () => {
  expect(truncateWithEllipsis("short", 10)).toBe("short");
  // Exactly at the limit is not truncated.
  expect(truncateWithEllipsis("exactly10!", 10)).toBe("exactly10!");
});

test("truncateWithEllipsis truncates to maxLength including the ellipsis", () => {
  const out = truncateWithEllipsis("abcdefghij", 5);
  expect(out).toBe(`abcd${ELLIPSIS}`);
  expect(out).toHaveLength(5);
});

test("truncateWithEllipsis trims whitespace before the ellipsis", () => {
  expect(truncateWithEllipsis("abcd efghij", 6)).toBe(`abcd${ELLIPSIS}`);
});

test("truncateWithEllipsis clamps non-positive maxLength to a bare ellipsis", () => {
  expect(truncateWithEllipsis("abc", 0)).toBe(ELLIPSIS);
  expect(truncateWithEllipsis("abc", 1)).toBe(ELLIPSIS);
});

test("renderToolTitle appends the summary only when one is given", () => {
  expect(renderToolTitle(plainTheme, "memory")).toBe(`${UI_ICONS.tool} memory`);
  expect(renderToolTitle(plainTheme, "memory", "3 facts")).toBe(`${UI_ICONS.tool} memory 3 facts`);
});

test("renderToolTitle keeps an empty summary out of the title", () => {
  // "" is falsy, so no trailing separator should appear.
  expect(renderToolTitle(plainTheme, "web", "")).toBe(`${UI_ICONS.tool} web`);
});

test("renderStatusIcon maps every status to its icon", () => {
  expect(renderStatusIcon(plainTheme, "success")).toBe(UI_ICONS.success);
  expect(renderStatusIcon(plainTheme, "error")).toBe(UI_ICONS.error);
  expect(renderStatusIcon(plainTheme, "running")).toBe(UI_ICONS.running);
  expect(renderStatusIcon(plainTheme, "partial")).toBe(UI_ICONS.partial);
  expect(renderStatusIcon(plainTheme, "pending")).toBe(UI_ICONS.pending);
});

test("renderStatusIcon maps every status to its theme colour", () => {
  const { theme, colors } = recordingTheme();
  renderStatusIcon(theme, "success");
  renderStatusIcon(theme, "error");
  renderStatusIcon(theme, "pending");
  // running and partial share the warning colour.
  renderStatusIcon(theme, "running");
  renderStatusIcon(theme, "partial");
  expect(colors).toEqual(["success", "error", "dim", "warning", "warning"]);
});

test("todoStatusIcon distinguishes completed, in_progress, and pending", () => {
  expect(todoStatusIcon("completed")).toBe(UI_ICONS.success);
  expect(todoStatusIcon("in_progress")).toBe(UI_ICONS.running);
  expect(todoStatusIcon("pending")).toBe(UI_ICONS.pending);
});

test("renderExpandHint names the expand keybinding", () => {
  const hint = renderExpandHint(plainTheme);
  expect(hint).toContain("to expand");
  // The key label comes from upstream keybinding config; only require that
  // something was rendered in front of the suffix.
  expect(hint.length).toBeGreaterThan("to expand".length);
});

test("icons and ellipsis are single-width glyphs", () => {
  expect(ELLIPSIS).toBe("…");
  for (const icon of Object.values(UI_ICONS)) {
    expect(icon).toHaveLength(1);
  }
});

test("sanitizeTerminalText strips ANSI and control sequences", () => {
  const { sanitizeTerminalText } = require("../src/extensions/ui/rendering.ts") as typeof import("../src/extensions/ui/rendering.ts");
  expect(sanitizeTerminalText("plain text")).toBe("plain text");
  expect(sanitizeTerminalText("\x1b[31mred\x1b[0m")).toBe("red");
  expect(sanitizeTerminalText("\x1b]0;fake title\x07body")).toBe("body");
  expect(sanitizeTerminalText("a\x1bb")).toBe("ab");
  expect(sanitizeTerminalText("tab\there")).toBe("tab\there");
});

test("truncateWithEllipsis never splits a surrogate pair", () => {
  const { truncateWithEllipsis } = require("../src/extensions/ui/rendering.ts") as typeof import("../src/extensions/ui/rendering.ts");
  const emoji = "a".repeat(20) + "😀";
  const out = truncateWithEllipsis(emoji, 10);
  expect(out.includes("\ud83d")).toBe(false); // no lone high surrogate
  expect(out.endsWith("…")).toBe(true);
});
