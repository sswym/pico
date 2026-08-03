/**
 * Tool render helpers.
 *
 * Covers the shared collapsed/expanded text renderer used by pico custom
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
  expect(out.truncatedLine).toBe(false);

  const oneLine = previewText("abcdefghi", 8, 5);
  expect(oneLine.preview).toBe("abcd…");
  expect(oneLine.hiddenLines).toBe(0);
  expect(oneLine.truncatedLine).toBe(true);
});

test("renderToolResultText shows an expand hint when a single line is truncated", () => {
  const result = {
    content: [{ type: "text" as const, text: "a very long single line that exceeds the collapsed width limit" }],
    details: undefined,
  };

  const collapsed = renderToolResultText(
    result,
    { expanded: false, isPartial: false },
    plainTheme,
    {},
    { collapsedLines: 3, collapsedLineLength: 20 },
  );
  const collapsedText = renderedText(collapsed);
  expect(collapsedText).not.toContain("exceeds the collapsed width");
  expect(collapsedText).toMatch(/to expand/i);

  const expanded = renderToolResultText(
    result,
    { expanded: true, isPartial: false },
    plainTheme,
    {},
    { collapsedLines: 3, collapsedLineLength: 20 },
  );
  expect(renderedText(expanded)).toContain("exceeds the collapsed width");
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
  const call = renderToolCallText("memory", { action: "search", query: "pico" }, plainTheme, {});
  const text = renderedText(call);
  expect(text).toContain("• memory");
  expect(text).toContain("memory");
  expect(text).toContain('search "pico"');
  expect(text).toContain('"action": "search"');
  expect(text).toContain('"query": "pico"');
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

test("summarizeToolCall uses visionAnalyze schema fields in priority order", () => {
  // image_path wins over the other fields.
  const byPath = summarizeToolCall("visionAnalyze", {
    image_path: "/tmp/a.png",
    image_base64: "iVBORw0KGgoAAAANSUhEUg==",
    image_url: "https://example.com/a.png",
  });
  expect(byPath).toBe("/tmp/a.png");

  // image_base64 is the fallback and gets truncated to a short prefix.
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const byBase64 = summarizeToolCall("visionAnalyze", { image_base64: base64 });
  expect(byBase64.length).toBeLessThan(base64.length);
  expect(byBase64).toContain(base64.slice(0, 20));

  // image_url is last.
  const byUrl = summarizeToolCall("visionAnalyze", { image_url: "https://example.com/a.png" });
  expect(byUrl).toBe("https://example.com/a.png");
});

test("renderToolCallText shows an expand hint when a single line is truncated", () => {
  const call = renderToolCallText(
    "memory",
    { query: "a very long query that definitely exceeds the collapsed line length limit" },
    plainTheme,
    {},
    { collapsedLines: 3, collapsedLineLength: 20 },
  );
  const text = renderedText(call);
  // The serialized JSON body is a single over-long line: hiddenLines is 0 but
  // the line was truncated, so the expand hint must still be shown.
  expect(text).toContain("a very…");
  expect(text).toMatch(/to expand/i);
});
