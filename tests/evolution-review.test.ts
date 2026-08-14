/**
 * evolution review tests — 提示词组装、消息摘录、输出 JSON 解析容错（纯函数，
 * 不涉及真实模型调用）。
 */
import { expect, test } from "bun:test";
import {
  buildReviewPrompt,
  formatExcerpt,
  parseReviewOutput,
} from "../src/extensions/evolution/review.ts";
import type { ExtractableMessage } from "../src/extensions/evolution/state.ts";

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------

test("buildReviewPrompt includes existing skills and untrusted-data warning", () => {
  const messages: ExtractableMessage[] = [{ role: "user", content: "fix the auth bug" }];
  const prompt = buildReviewPrompt(messages, [{ name: "debug-node", description: "Debug Node services" }]);
  expect(prompt).toContain("debug-node — Debug Node services");
  expect(prompt).toContain("untrusted external content");
  expect(prompt).toContain("fix the auth bug");
  expect(prompt).toContain("At most 1 create");
});

test("buildReviewPrompt renders empty existing-skill list as (none)", () => {
  const prompt = buildReviewPrompt([{ role: "user", content: "hi" }], []);
  expect(prompt).toContain("(none)");
});

// ---------------------------------------------------------------------------
// formatExcerpt
// ---------------------------------------------------------------------------

test("formatExcerpt renders messages newest-last and truncates oldest first", () => {
  const messages: ExtractableMessage[] = [
    { role: "user", content: "old message that will be dropped" },
    { role: "assistant", content: "latest reply" },
  ];
  const excerpt = formatExcerpt(messages, 50);
  expect(excerpt).toContain("latest reply");
  expect(excerpt).not.toContain("old message");
});

test("formatExcerpt extracts text blocks and caps per-message length", () => {
  const messages: ExtractableMessage[] = [
    { role: "tool", content: [{ type: "text", text: "x".repeat(5_000) }] },
  ];
  const excerpt = formatExcerpt(messages, 1_000_000);
  expect(excerpt.length).toBeLessThan(5_000);
  expect(excerpt.endsWith("…")).toBe(true);
});

// ---------------------------------------------------------------------------
// parseReviewOutput
// ---------------------------------------------------------------------------

test("parseReviewOutput parses bare JSON", () => {
  const out = parseReviewOutput('{"create":[{"name":"a-skill","description":"d","content":"c"}],"update":[]}');
  expect(out).toEqual({ create: [{ name: "a-skill", description: "d", content: "c" }], update: [] });
});

test("parseReviewOutput strips ```json fences", () => {
  const out = parseReviewOutput('```json\n{"create":[],"update":[{"name":"a","content":"c"}]}\n```');
  expect(out).toEqual({ create: [], update: [{ name: "a", content: "c" }] });
});

test("parseReviewOutput returns null for invalid JSON", () => {
  expect(parseReviewOutput("not json at all")).toBeNull();
  expect(parseReviewOutput("{broken")).toBeNull();
  expect(parseReviewOutput("")).toBeNull();
});

test("parseReviewOutput drops schema-invalid entries", () => {
  const out = parseReviewOutput(
    JSON.stringify({
      create: [
        { name: "ok", description: "d", content: "c" },
        { name: 42, description: "d", content: "c" }, // name 非 string
        { content: "no name" }, // 缺字段
        "not an object",
      ],
      update: [{ name: "u", content: "c" }, { description: "no content" }],
    }),
  );
  expect(out).toEqual({
    create: [{ name: "ok", description: "d", content: "c" }],
    update: [{ name: "u", content: "c" }],
  });
});

test("parseReviewOutput returns empty result for valid JSON with no entries", () => {
  expect(parseReviewOutput('{"create":[],"update":[]}')).toEqual({ create: [], update: [] });
  expect(parseReviewOutput('{"create":[],"update":[],"extra":"ignored"}')).toEqual({ create: [], update: [] });
});
