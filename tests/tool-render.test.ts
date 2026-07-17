/**
 * Tool render helpers.
 *
 * Covers the shared collapsed/expanded text renderer used by srcode custom
 * tools. It does not test terminal color styling or keybinding configuration.
 */
import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  previewText,
  renderToolCallText,
  renderToolResultText,
  summarizeToolCall,
} from "../src/extensions/tool-render.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function renderedText(component: { render: (width: number) => string[] }): string {
  return component.render(120).join("\n");
}

test("previewText limits lines and truncates long lines", () => {
  const out = previewText("one\ntwo\nthree long line", 2, 6);
  expect(out.preview).toBe("one\ntwo");
  expect(out.hiddenLines).toBe(1);

  const oneLine = previewText("abcdefghi", 8, 5);
  expect(oneLine.preview).toBe("abcd…");
  expect(oneLine.hiddenLines).toBe(0);
});

test("renderToolResultText collapses by default and expands full output", () => {
  const result = {
    content: [{ type: "text" as const, text: "line1\nline2\nline3\nline4\nline5" }],
    details: undefined,
  };

  const collapsed = renderToolResultText(
    result,
    { expanded: false, isPartial: false },
    plainTheme,
    {},
    { collapsedLines: 3 },
  );
  const collapsedText = renderedText(collapsed);
  expect(collapsedText).toContain("line1");
  expect(collapsedText).toContain("line3");
  expect(collapsedText).not.toContain("line4");

  const expanded = renderToolResultText(
    result,
    { expanded: true, isPartial: false },
    plainTheme,
    {},
    { collapsedLines: 3 },
  );
  expect(renderedText(expanded)).toContain("line5");
});

test("renderToolCallText keeps tool arguments visible", () => {
  const call = renderToolCallText("memory", { action: "search", query: "srcode" }, plainTheme, {});
  const text = renderedText(call);
  expect(text).toContain("• memory");
  expect(text).toContain("memory");
  expect(text).toContain('search "srcode"');
  expect(text).toContain('"action": "search"');
  expect(text).toContain('"query": "srcode"');
});

test("summarizeToolCall renders high-signal summaries", () => {
  expect(summarizeToolCall("lsp", { action: "diagnostics", file: "src/index.ts", line: 12 })).toBe(
    "diagnostics src/index.ts:12",
  );
  expect(
    summarizeToolCall("todoWrite", {
      todos: [
        { content: "one", activeForm: "one", status: "completed" },
        { content: "two", activeForm: "two", status: "in_progress" },
      ],
    }),
  ).toBe("2 items · 1 active");
});
