import { expect, test } from "bun:test";
import { missingPrintPrompt } from "../src/runtime/print-guard.ts";

test("rejects bare -p / --print with no prompt", () => {
  expect(missingPrintPrompt(["-p"])).toBe(true);
  expect(missingPrintPrompt(["--print"])).toBe(true);
});

test("rejects -p followed by an empty string", () => {
  expect(missingPrintPrompt(["-p", ""])).toBe(true);
  expect(missingPrintPrompt(["--print", "  "])).toBe(true);
});

test("accepts -p with an immediate prompt value", () => {
  expect(missingPrintPrompt(["-p", "只回复：OK"])).toBe(false);
  expect(missingPrintPrompt(["--print", "hello"])).toBe(false);
});

test("accepts -p whose prompt is a later positional (subagent spawn pattern)", () => {
  const args = ["--mode", "json", "-p", "--session", "/tmp/x.jsonl", "--model", "m", "Task: hello"];
  expect(missingPrintPrompt(args)).toBe(false);
});

test("rejects -p with flags but no prompt anywhere", () => {
  const args = ["--mode", "json", "-p", "--session", "/tmp/x.jsonl", "--model", "m"];
  expect(missingPrintPrompt(args)).toBe(true);
});

test("accepts -p when a positional appears after an unrelated flag", () => {
  expect(missingPrintPrompt(["-p", "--tools", "read,write", "Task: hi"])).toBe(false);
});

test("accepts -p with prompt before trailing flags", () => {
  expect(missingPrintPrompt(["-p", "需求", "--model", "m"])).toBe(false);
});

test("flag value that looks like text is not mistaken for a prompt", () => {
  // --session consumes /tmp/x.jsonl; no real prompt exists.
  expect(missingPrintPrompt(["-p", "--session", "/tmp/x.jsonl"])).toBe(true);
  expect(missingPrintPrompt(["-p", "--session=/tmp/x.jsonl"])).toBe(true);
});

test("non-print args never trigger the guard", () => {
  expect(missingPrintPrompt([])).toBe(false);
  expect(missingPrintPrompt(["--help"])).toBe(false);
  expect(missingPrintPrompt(["plain message"])).toBe(false);
});

test("second -p without a prompt still errors", () => {
  expect(missingPrintPrompt(["-p", "a", "-p"])).toBe(true);
});
