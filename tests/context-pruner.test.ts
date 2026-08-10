import { expect, test } from "bun:test";
import { normalizeReadPath, pruneSupersededReads, readPathFromArgs } from "../src/extensions/context-pruner/prune.ts";
import { contextPrunerExtension } from "../src/extensions/context-pruner/index.ts";

const MARKER = "[Superseded by a newer read of this file]";

function readCall(id: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: args }],
  };
}

function readResult(id: string, text: string) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
  };
}

// --- normalizeReadPath ------------------------------------------------------

test("normalizes relative paths against cwd", () => {
  expect(normalizeReadPath("src/foo.ts", "/repo")).toBe("/repo/src/foo.ts");
  expect(normalizeReadPath("./src/../src/foo.ts", "/repo")).toBe("/repo/src/foo.ts");
  expect(normalizeReadPath("/abs/path.ts", "/repo")).toBe("/abs/path.ts");
});

test("rejects non-path inputs", () => {
  expect(normalizeReadPath(undefined, "/repo")).toBeNull();
  expect(normalizeReadPath("", "/repo")).toBeNull();
  expect(normalizeReadPath("artifact://5", "/repo")).toBeNull();
  expect(normalizeReadPath("http://x/y", "/repo")).toBeNull();
});

test("readPathFromArgs reads path and file_path aliases", () => {
  expect(readPathFromArgs({ path: "a.ts" })).toBe("a.ts");
  expect(readPathFromArgs({ file_path: "b.ts" })).toBe("b.ts");
  expect(readPathFromArgs({ nope: 1 })).toBeUndefined();
  expect(readPathFromArgs(null)).toBeUndefined();
});

// --- pruneSupersededReads --------------------------------------------------

test("replaces non-latest full read of the same file", () => {
  const messages = [
    readCall("c1", { path: "src/foo.ts" }),
    readResult("c1", "OLD CONTENT"),
    readCall("c2", { path: "src/foo.ts" }),
    readResult("c2", "NEW CONTENT"),
  ];

  const result = pruneSupersededReads(messages, "/repo");

  const oldResult = result[1] as { content: { text: string }[] };
  const newResult = result[3] as { content: { text: string }[] };
  expect(oldResult.content[0]!.text).toBe(MARKER);
  expect(newResult.content[0]!.text).toBe("NEW CONTENT");
});

test("keeps the latest full read intact", () => {
  const messages = [
    readCall("c1", { path: "a.ts" }),
    readResult("c1", "ONE"),
    readCall("c2", { path: "a.ts" }),
    readResult("c2", "TWO"),
    readCall("c3", { path: "a.ts" }),
    readResult("c3", "THREE"),
  ];
  const result = pruneSupersededReads(messages, "/repo");
  expect((result[1] as any).content[0].text).toBe(MARKER);
  expect((result[3] as any).content[0].text).toBe(MARKER);
  expect((result[5] as any).content[0].text).toBe("THREE");
});

test("partial reads (offset/limit) are never superseded", () => {
  const messages = [
    readCall("c1", { path: "big.ts" }),
    readResult("c1", "RANGE1"),
    readCall("c2", { path: "big.ts", offset: 100, limit: 50 }),
    readResult("c2", "RANGE2"),
  ];
  const result = pruneSupersededReads(messages, "/repo");
  expect((result[1] as any).content[0].text).toBe("RANGE1");
  expect((result[3] as any).content[0].text).toBe("RANGE2");
});

test("different files and different selectors are untouched", () => {
  const messages = [
    readCall("c1", { path: "a.ts" }),
    readResult("c1", "A"),
    readCall("c2", { path: "b.ts" }),
    readResult("c2", "B"),
  ];
  const result = pruneSupersededReads(messages, "/repo");
  expect((result[1] as any).content[0].text).toBe("A");
  expect((result[3] as any).content[0].text).toBe("B");
});

test("single read and non-read messages are untouched", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    readCall("c1", { path: "a.ts" }),
    readResult("c1", "A"),
    { role: "toolResult", toolCallId: "g1", toolName: "grep", content: [{ type: "text", text: "matches" }], isError: false },
  ];
  const result = pruneSupersededReads(messages, "/repo");
  expect((result[2] as any).content[0].text).toBe("A");
  expect((result[3] as any).content[0].text).toBe("matches");
});

test("path alias file_path is honored", () => {
  const messages = [
    readCall("c1", { file_path: "x.ts" }),
    readResult("c1", "OLD"),
    readCall("c2", { path: "x.ts" }),
    readResult("c2", "NEW"),
  ];
  const result = pruneSupersededReads(messages, "/repo");
  expect((result[1] as any).content[0].text).toBe(MARKER);
});

// --- extension wiring ------------------------------------------------------

test("extension wires context event and prunes messages", () => {
  const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => any) => {
      (handlers[event] ??= []).push(handler);
    },
  };
  contextPrunerExtension(pi as any);

  const messages = [
    readCall("c1", { path: "src/a.ts" }),
    readResult("c1", "OLD"),
    readCall("c2", { path: "src/a.ts" }),
    readResult("c2", "NEW"),
  ];
  const handler = handlers["context"]?.[0];
  if (!handler) throw new Error("context handler not registered");
  const result = handler({ messages }, { cwd: "/repo" });

  expect(result.messages).toBeDefined();
  expect((result.messages[1] as any).content[0].text).toBe(MARKER);
  expect((result.messages[3] as any).content[0].text).toBe("NEW");
});
