/**
 * srcode LSP extension unit tests.
 *
 * Tests the workspace edit engine (edits.ts) and diagnostics ledger
 * (diagnostics-ledger.ts) — the two new modules with testable pure logic.
 *
 * Does NOT test: actual LSP server communication, TUI rendering,
 * or extension event wiring (requires running language servers).
 */
import { afterEach, beforeEach, expect, test, describe } from "bun:test";
import { applyTextEditsToString } from "../src/extensions/lsp/edits.ts";
import { DiagnosticsLedger } from "../src/extensions/lsp/diagnostics-ledger.ts";
import type { TextEdit } from "../src/extensions/lsp/types.ts";

describe("applyTextEditsToString", () => {
  test("applies single-line edit", () => {
    const content = "hello world";
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "there" },
    ];
    expect(applyTextEditsToString(content, edits)).toBe("hello there");
  });

  test("applies multi-line edit", () => {
    const content = "line1\nline2\nline3";
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 4 }, end: { line: 2, character: 4 } }, newText: "X\nY\nZ" },
    ];
    expect(applyTextEditsToString(content, edits)).toBe("lineX\nY\nZ3");
  });

  test("applies multiple edits in reverse order", () => {
    const content = "aaa bbb ccc";
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } }, newText: "DDD" },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "AAA" },
    ];
    expect(applyTextEditsToString(content, edits)).toBe("AAA bbb DDD");
  });

  test("throws on overlapping edits", () => {
    const content = "hello";
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: "a" },
      { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, newText: "b" },
    ];
    expect(() => applyTextEditsToString(content, edits)).toThrow("Overlapping text edits");
  });

  test("handles empty edits", () => {
    expect(applyTextEditsToString("hello", [])).toBe("hello");
  });

  test("handles insert at position (empty range)", () => {
    const content = "ac";
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "b" },
    ];
    expect(applyTextEditsToString(content, edits)).toBe("abc");
  });
});

describe("DiagnosticsLedger", () => {
  test("first call returns all messages", () => {
    const ledger = new DiagnosticsLedger();
    const result = ledger.reduce("/foo.ts", ["1:1 ERROR: bad", "2:1 WARNING: warn"]);
    expect(result).toEqual(["1:1 ERROR: bad", "2:1 WARNING: warn"]);
  });

  test("second call returns only new messages", () => {
    const ledger = new DiagnosticsLedger();
    ledger.reduce("/foo.ts", ["1:1 ERROR: bad", "2:1 WARNING: warn"]);
    const result = ledger.reduce("/foo.ts", ["1:1 ERROR: bad", "3:1 ERROR: new"]);
    expect(result).toEqual(["3:1 ERROR: new"]);
  });

  test("clear resets all state", () => {
    const ledger = new DiagnosticsLedger();
    ledger.reduce("/foo.ts", ["1:1 ERROR: bad"]);
    ledger.clear();
    const result = ledger.reduce("/foo.ts", ["1:1 ERROR: bad"]);
    expect(result).toEqual(["1:1 ERROR: bad"]);
  });

  test("different files tracked independently", () => {
    const ledger = new DiagnosticsLedger();
    ledger.reduce("/foo.ts", ["1:1 ERROR: bad"]);
    const result = ledger.reduce("/bar.ts", ["1:1 ERROR: bad"]);
    expect(result).toEqual(["1:1 ERROR: bad"]);
  });

  test("empty diagnostics clears tracking for file", () => {
    const ledger = new DiagnosticsLedger();
    ledger.reduce("/foo.ts", ["1:1 ERROR: bad"]);
    ledger.reduce("/foo.ts", []);
    const result = ledger.reduce("/foo.ts", ["1:1 ERROR: bad"]);
    expect(result).toEqual(["1:1 ERROR: bad"]);
  });
});
