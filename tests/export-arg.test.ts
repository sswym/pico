import { describe, expect, test } from "bun:test";
import { validateExportArg } from "../src/runtime/args.ts";

describe("validateExportArg (L33: /export --path 预校验)", () => {
  test("accepts a normal --export with a path", () => {
    expect(validateExportArg(["--export", "session.jsonl", "out.html"])).toEqual({ ok: true });
    expect(validateExportArg(["--export", "session.jsonl"])).toEqual({ ok: true });
  });

  test("accepts when --export is absent", () => {
    expect(validateExportArg(["-p", "hi"])).toEqual({ ok: true });
    expect(validateExportArg([])).toEqual({ ok: true });
  });

  test("rejects a bare --export with no target", () => {
    const r = validateExportArg(["--export"]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("缺少输出路径");
  });

  test("rejects an option-like token after --export (the --path leak)", () => {
    const r = validateExportArg(["--export", "--path", "session.jsonl"]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("--path");
  });

  test("rejects another flag as the export target", () => {
    const r = validateExportArg(["--export", "--output"]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("--output");
  });
});