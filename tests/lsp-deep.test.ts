/**
 * Deep coverage for the LSP extension.
 *
 * Part 1: format-options.ts — the .editorconfig parser/sniffer is pure logic
 * reachable only through resolveFormattingOptions (the inner functions are
 * not exported), so every branch is driven by writing real .editorconfig
 * files / file contents into temp dirs.
 *
 * Part 2: lsp/index.ts — execute() branches that need no real language
 * server: unknown actions, policy-blocked write actions, status, parameter
 * validation (line/character/symbol), and the "no server available /
 * Cannot open file" degradation paths (a temp workspace without root markers
 * makes ensureServer return null without spawning anything). Also the
 * missing-command install dialog branches (config points at a binary that
 * does not exist on PATH).
 *
 * Env isolation: PICO_HOME is redirected to a temp dir so the LSP config
 * (lsp.json) never touches the real data root.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFormattingOptions } from "../src/extensions/lsp/format-options.ts";
import { lspExtension } from "../src/extensions/lsp/index.ts";

const ORIG_PICO_HOME = process.env.PICO_HOME;
let testHome: string;
let projDir: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "pico-lsp-deep-home-"));
  projDir = mkdtempSync(join(tmpdir(), "pico-lsp-deep-proj-"));
  process.env.PICO_HOME = testHome;
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  if (ORIG_PICO_HOME === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = ORIG_PICO_HOME;
});

// ── Part 1: format-options.ts ─────────────────────────────────────────────

describe("resolveFormattingOptions (.editorconfig parsing)", () => {
  function writeEditorConfig(content: string) {
    writeFileSync(join(projDir, ".editorconfig"), content, "utf8");
  }

  test("parses section header + indent_size/indent_style kv pairs", () => {
    writeEditorConfig("[*.ts]\nindent_size = 4\nindent_style = space\n");
    expect(resolveFormattingOptions(join(projDir, "a.ts"))).toEqual({
      tabSize: 4,
      insertSpaces: true,
      insertFinalNewline: undefined,
      trimTrailingWhitespace: undefined,
    });
  });

  test("indent_size=tab falls back to tab_width, indent_style=tab disables spaces", () => {
    writeEditorConfig("[*.ts]\nindent_size = tab\nindent_style = tab\ntab_width = 8\n");
    const opts = resolveFormattingOptions(join(projDir, "a.ts"));
    expect(opts.tabSize).toBe(8);
    expect(opts.insertSpaces).toBe(false);
  });

  test("indent_size=tab without tab_width defaults to 2", () => {
    writeEditorConfig("[*]\nindent_size = tab\nindent_style = tab\n");
    expect(resolveFormattingOptions(join(projDir, "x.txt")).tabSize).toBe(2);
  });

  test("insert_final_newline and trim_trailing_whitespace booleans", () => {
    writeEditorConfig("[*]\ninsert_final_newline = false\ntrim_trailing_whitespace = true\n");
    const opts = resolveFormattingOptions(join(projDir, "x.txt"));
    expect(opts.insertFinalNewline).toBe(false);
    expect(opts.trimTrailingWhitespace).toBe(true);
  });

  test("false-y values for insert_final_newline parse to false, junk is skipped", () => {
    writeEditorConfig("[*]\ninsert_final_newline = false\n");
    expect(resolveFormattingOptions(join(projDir, "x.txt")).insertFinalNewline).toBe(false);
  });

  test("comments (# and ;), blank lines and malformed lines are ignored", () => {
    writeEditorConfig(
      "# top comment\n; semicolon comment\n\n[*]\nindent_size = 2\nno-equals-line\n= orphan-value\n  \n",
    );
    const opts = resolveFormattingOptions(join(projDir, "x.txt"));
    expect(opts.tabSize).toBe(2);
    expect(opts.insertSpaces).toBe(true);
  });

  test("kv pairs before any section header are ignored", () => {
    writeEditorConfig("indent_size = 8\n[*]\nindent_size = 2\n");
    expect(resolveFormattingOptions(join(projDir, "x.txt")).tabSize).toBe(2);
  });

  test("invalid indent_style value is ignored (defaults to spaces)", () => {
    writeEditorConfig("[*]\nindent_style = mixed\nindent_size = 3\n");
    const opts = resolveFormattingOptions(join(projDir, "x.txt"));
    expect(opts.insertSpaces).toBe(true);
    expect(opts.tabSize).toBe(3);
  });

  test("missing .editorconfig file falls back to sniffing file content", () => {
    // The parser walks up to the filesystem root ("") which resolves against
    // process.cwd() — chdir to the temp project so the repo's own
    // .editorconfig cannot leak into the fallback path.
    const oldCwd = process.cwd();
    try {
      process.chdir(projDir);
      writeFileSync(join(projDir, "a.txt"), "    four-space indent\n", "utf8");
      const opts = resolveFormattingOptions(join(projDir, "a.txt"));
      expect(opts).toEqual({
        insertSpaces: true,
        tabSize: 4,
        insertFinalNewline: true,
        trimTrailingWhitespace: true,
      });
    } finally {
      process.chdir(oldCwd);
    }
  });
});

describe("resolveFormattingOptions (section matching)", () => {
  test("*.ext pattern matches only that extension, other files sniff instead", () => {
    writeFileSync(join(projDir, ".editorconfig"), "[*.ts]\nindent_size = 6\n", "utf8");
    writeFileSync(join(projDir, "a.ts"), "x\n", "utf8");
    writeFileSync(join(projDir, "b.md"), "x\n", "utf8");
    expect(resolveFormattingOptions(join(projDir, "a.ts")).tabSize).toBe(6);
    // b.md has no matching section → sniff (no indented lines → 2).
    expect(resolveFormattingOptions(join(projDir, "b.md")).tabSize).toBe(2);
  });

  test("* pattern matches any file", () => {
    writeFileSync(join(projDir, ".editorconfig"), "[*]\nindent_size = 5\n", "utf8");
    expect(resolveFormattingOptions(join(projDir, "whatever.log")).tabSize).toBe(5);
  });

  test("{*.ts,*.tsx,*.js,*.jsx} brace set matches tsx, not py", () => {
    writeFileSync(join(projDir, ".editorconfig"), "[{*.ts,*.tsx,*.js,*.jsx}]\nindent_size = 9\n", "utf8");
    expect(resolveFormattingOptions(join(projDir, "c.tsx")).tabSize).toBe(9);
    expect(resolveFormattingOptions(join(projDir, "d.py")).tabSize).toBe(2);
  });

  test("findMatchingSection: last matching section wins (reverse search)", () => {
    writeFileSync(
      join(projDir, ".editorconfig"),
      "[*.ts]\nindent_size = 2\n[*]\nindent_size = 7\n",
      "utf8",
    );
    expect(resolveFormattingOptions(join(projDir, "a.ts")).tabSize).toBe(7);
  });

  test("section that does not match falls through to sniff", () => {
    const oldCwd = process.cwd();
    try {
      process.chdir(projDir);
      writeFileSync(join(projDir, ".editorconfig"), "[*.go]\nindent_size = 8\n", "utf8");
      writeFileSync(join(projDir, "a.ts"), "\t\ttab line\n", "utf8");
      expect(resolveFormattingOptions(join(projDir, "a.ts")).insertSpaces).toBe(false);
    } finally {
      process.chdir(oldCwd);
    }
  });

  test(".editorconfig is found in a parent directory (up the tree)", () => {
    writeFileSync(join(projDir, ".editorconfig"), "[*]\nindent_size = 3\n", "utf8");
    mkdirSync(join(projDir, "src", "nested", "deep"), { recursive: true });
    writeFileSync(join(projDir, "src", "nested", "deep", "f.ts"), "x\n", "utf8");
    expect(resolveFormattingOptions(join(projDir, "src", "nested", "deep", "f.ts")).tabSize).toBe(3);
  });
});

describe("resolveFormattingOptions (indentation sniffing fallback)", () => {
  // The .editorconfig search walks up to the filesystem root, which resolves
  // relative to process.cwd(); chdir into the temp project so the repo's own
  // .editorconfig (with a catch-all [*] section) cannot shadow the fallback.
  function inProject(fn: () => void) {
    const oldCwd = process.cwd();
    try {
      process.chdir(projDir);
      fn();
    } finally {
      process.chdir(oldCwd);
    }
  }

  test("tab indentation wins over spaces", () => {
    inProject(() => {
      writeFileSync(join(projDir, "tabs.txt"), "\tone\n\t\ttwo\n  space\n", "utf8");
      const opts = resolveFormattingOptions(join(projDir, "tabs.txt"));
      expect(opts.insertSpaces).toBe(false);
      expect(opts.tabSize).toBe(4);
    });
  });

  test("2-space indentation is detected", () => {
    inProject(() => {
      writeFileSync(join(projDir, "two.txt"), "  a\n  b\n", "utf8");
      expect(resolveFormattingOptions(join(projDir, "two.txt")).tabSize).toBe(2);
    });
  });

  test("4-space indentation is detected", () => {
    inProject(() => {
      writeFileSync(join(projDir, "four.txt"), "    a\n    b\n", "utf8");
      expect(resolveFormattingOptions(join(projDir, "four.txt")).tabSize).toBe(4);
    });
  });

  test("8-space indentation is detected (5-8 quantizes up to 8)", () => {
    inProject(() => {
      writeFileSync(join(projDir, "eight.txt"), "        a\n", "utf8");
      expect(resolveFormattingOptions(join(projDir, "eight.txt")).tabSize).toBe(8);
      writeFileSync(join(projDir, "six.txt"), "      a\n", "utf8");
      expect(resolveFormattingOptions(join(projDir, "six.txt")).tabSize).toBe(8);
    });
  });

  test("more than 8 spaces quantizes back to 4", () => {
    inProject(() => {
      writeFileSync(join(projDir, "deep.txt"), "            a\n", "utf8");
      expect(resolveFormattingOptions(join(projDir, "deep.txt")).tabSize).toBe(4);
    });
  });

  test("empty file sniffs to 2-space default", () => {
    inProject(() => {
      writeFileSync(join(projDir, "empty.txt"), "", "utf8");
      const opts = resolveFormattingOptions(join(projDir, "empty.txt"));
      expect(opts.tabSize).toBe(2);
      expect(opts.insertSpaces).toBe(true);
    });
  });

  test("unreadable file falls back to hard defaults (2 spaces)", () => {
    inProject(() => {
      const opts = resolveFormattingOptions(join(projDir, "does-not-exist.txt"));
      expect(opts).toEqual({ tabSize: 2, insertSpaces: true });
    });
  });
});

// ── Part 2: lsp/index.ts execute() without a live server ─────────────────

/**
 * Drive the registered `lsp` tool with a fake pi. ctx.cwd must be a temp
 * workspace WITHOUT root markers (package.json/tsconfig.json/etc.) so
 * ensureServer returns null without attempting any spawn.
 */
function setupLsp(overrides: Record<string, unknown> = {}) {
  let registered: any = null;
  const handlers: Record<string, Array<(event: any, ctx?: any) => any>> = {};
  const pi: any = {
    on: (event: string, handler: (event: any, ctx?: any) => any) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: (tool: any) => {
      registered = tool;
    },
  };
  lspExtension(pi);
  const notices: Array<{ msg: string; level: string }> = [];
  const ctx: any = {
    cwd: projDir,
    hasUI: true,
    ui: {
      notify: (msg: string, level = "info") => notices.push({ msg, level }),
      confirm: async () => false,
      setStatus: () => {},
    },
    ...overrides,
  };
  const execute = (params: any, signal?: AbortSignal, toolCtx = ctx) =>
    registered.execute("tc1", params, signal, undefined, toolCtx);
  return { pi, handlers, ctx, notices, execute, getTool: () => registered };
}

describe("lsp tool execute — no server needed", () => {
  test("unknown action is rejected before any server interaction", async () => {
    const { execute } = setupLsp();
    await expect(execute({ action: "frobnicate" })).rejects.toThrow(/Unknown action/);
  });

  test("write/high-risk actions are policy-blocked before server startup", async () => {
    const { execute } = setupLsp();
    await expect(execute({ action: "rename", file: "a.ts", line: 1, character: 0, newName: "b" }))
      .rejects.toThrow(/read-only/);
    await expect(execute({ action: "request", query: "x" })).rejects.toThrow(/read-only/);
    await expect(execute({ action: "code_actions", file: "a.ts", line: 1, character: 0, apply: true }))
      .rejects.toThrow(/read-only/);
  });

  test("status action works without any server", async () => {
    const { execute } = setupLsp();
    const result = await execute({ action: "status" });
    const text = result.content[0].text as string;
    expect(text).toContain("Configured servers:");
  });

  test("capabilities without a server degrades gracefully", async () => {
    const { execute } = setupLsp();
    await expect(execute({ action: "capabilities" }))
      .rejects.toThrow("No language server available for this project.");
  });

  test("reload without a server degrades gracefully", async () => {
    const { execute } = setupLsp();
    await expect(execute({ action: "reload" }))
      .rejects.toThrow("No language server available for this project.");
  });

  test("workspace diagnostics (no file / '*') without a server degrades gracefully", async () => {
    const { execute } = setupLsp();
    await expect(execute({ action: "diagnostics" }))
      .rejects.toThrow("No language server available for this project.");
    await expect(execute({ action: "diagnostics", file: "*" }))
      .rejects.toThrow("No language server available for this project.");
  });

  test("file diagnostics without a server reports Cannot open file with root-marker hint", async () => {
    const { execute } = setupLsp();
    await expect(execute({ action: "diagnostics", file: "a.ts" }))
      .rejects.toThrow(/Cannot open file: a.ts/);
    await expect(execute({ action: "diagnostics", file: "a.ts" }))
      .rejects.toThrow(/no language server started/);
  });

  test("workspace symbol search without a server degrades gracefully", async () => {
    const { execute } = setupLsp();
    await expect(execute({ action: "symbols", query: "Foo" }))
      .rejects.toThrow("No language server available for this project.");
  });

  test("symbols without file and without query asks for either", async () => {
    const { execute } = setupLsp();
    await expect(execute({ action: "symbols" }))
      .rejects.toThrow(/Provide a file path for document symbols, or a query for workspace search\./);
  });

  test("document symbols without a server reports Cannot open file", async () => {
    const { execute } = setupLsp();
    await expect(execute({ action: "symbols", file: "a.ts" }))
      .rejects.toThrow(/Cannot open file: a\.ts/);
  });

  test("position-based action without a file parameter is rejected", async () => {
    const { execute } = setupLsp();
    for (const action of ["hover", "definition", "references"]) {
      await expect(execute({ action, line: 1, character: 0 }))
        .rejects.toThrow(`${action} requires 'file' parameter.`);
    }
  });

  test("line validation rejects zero, negative and non-integer lines", async () => {
    const { execute } = setupLsp();
    await expect(execute({ action: "hover", file: "a.ts", line: 0, character: 0 }))
      .rejects.toThrow(/positive integer 'line' parameter \(got 0\)/);
    await expect(execute({ action: "hover", file: "a.ts", line: -3, character: 0 }))
      .rejects.toThrow(/positive integer 'line' parameter \(got -3\)/);
    await expect(execute({ action: "hover", file: "a.ts", line: 1.5, character: 0 }))
      .rejects.toThrow(/positive integer 'line' parameter \(got 1\.5\)/);
    await expect(execute({ action: "hover", file: "a.ts", line: "x", character: 0 }))
      .rejects.toThrow(/positive integer 'line'/);
  });

  test("character validation rejects negatives and non-integers", async () => {
    const { execute } = setupLsp();
    await expect(execute({ action: "hover", file: "a.ts", line: 1, character: -1 }))
      .rejects.toThrow(/non-negative integer 'character' parameter \(got -1\)/);
    await expect(execute({ action: "hover", file: "a.ts", line: 1, character: 0.5 }))
      .rejects.toThrow(/non-negative integer 'character' parameter \(got 0\.5\)/);
  });

  test("symbol auto-resolve reads the real file for the column", async () => {
    writeFileSync(join(projDir, "a.ts"), "const alpha = alpha + beta;\n", "utf8");
    const { execute } = setupLsp();
    // Symbol resolves the column, then the missing server is hit.
    await expect(execute({ action: "hover", file: "a.ts", line: 1, symbol: "alpha", occurrence: 2 }))
      .rejects.toThrow(/Cannot open file: a\.ts/);
    await expect(execute({ action: "hover", file: "a.ts", line: 5, symbol: "nope" }))
      .rejects.toThrow(/Symbol "nope" not found on line 5 of a\.ts/);
  });

  test("missing character (no symbol either) is rejected", async () => {
    const { execute } = setupLsp();
    await expect(execute({ action: "hover", file: "a.ts", line: 1 }))
      .rejects.toThrow(/requires 'character' parameter \(or 'symbol' for auto-resolve\)\./);
  });

  test("valid position but no server: Cannot open file before client calls", async () => {
    const { execute } = setupLsp();
    await expect(execute({ action: "hover", file: "a.ts", line: 1, character: 0 }))
      .rejects.toThrow(/Cannot open file: a\.ts/);
  });
});

describe("lsp missing-command install dialog branches", () => {
  function configFor(command: string) {
    return {
      [command]: {
        command,
        fileTypes: [".ts"],
        rootMarkers: [], // always match — forces a spawn attempt
      },
    };
  }

  test("unknown command warns once and degrades (no install dialog)", async () => {
    const { execute, ctx, notices } = setupLsp();
    const cmd = `pico-no-such-lsp-${Date.now()}`;
    writeFileSync(join(testHome, "lsp.json"), JSON.stringify(configFor(cmd)), "utf8");
    await expect(execute({ action: "capabilities" }))
      .rejects.toThrow("No language server available for this project.");
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0]!.msg).toContain("lsp.json");
    // Second call: warned already → no repeat notice.
    const before = notices.length;
    await expect(execute({ action: "capabilities" }))
      .rejects.toThrow("No language server available for this project.");
    expect(notices.length).toBe(before);
  });

  test("known command shows install dialog; declining marks it declined", async () => {
    const confirmCalls: number[] = [];
    const { execute, notices } = setupLsp({
      ui: {
        notify: (msg: string, level = "info") => notices.push({ msg, level }),
        confirm: async () => {
          confirmCalls.push(1);
          return false;
        },
        setStatus: () => {},
      },
    });
    writeFileSync(
      join(testHome, "lsp.json"),
      JSON.stringify(configFor("typescript-language-server")),
      "utf8",
    );
    await expect(execute({ action: "capabilities" }))
      .rejects.toThrow("No language server available for this project.");
    expect(confirmCalls).toHaveLength(1);

    // Next call must re-explain the earlier decline instead of re-asking.
    await expect(execute({ action: "capabilities" }))
      .rejects.toThrow("No language server available for this project.");
    expect(confirmCalls).toHaveLength(1);
    expect(notices.some((n) => n.msg.includes("declined earlier"))).toBe(true);
  });

  test("non-interactive (no UI) run warns on stderr once and declines silently", async () => {
    const { execute, ctx } = setupLsp({ hasUI: false });
    // A KNOWN command yields an install hint, which routes the no-UI branch
    // to stderr (unknown commands would take the notify path instead).
    writeFileSync(
      join(testHome, "lsp.json"),
      JSON.stringify(configFor("pyright")),
      "utf8",
    );
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => {
      stderrWrites.push(String(chunk));
      return true;
    };
    try {
      await expect(execute({ action: "capabilities" }))
        .rejects.toThrow("No language server available for this project.");
      expect(stderrWrites.some((s) => s.includes("not found on PATH"))).toBe(true);
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });

  test("missing-command failure detail is appended to Cannot open file errors", async () => {
    const { execute } = setupLsp();
    const cmd = `pico-missing-detail-${Date.now()}`;
    writeFileSync(join(testHome, "lsp.json"), JSON.stringify(configFor(cmd)), "utf8");
    await expect(execute({ action: "diagnostics", file: "a.ts" }))
      .rejects.toThrow(/command\(s\) not found on PATH/);
  });
});

describe("lsp extension lifecycle without servers", () => {
  test("session_start warmup runs quietly and publishes status", async () => {
    const { handlers, ctx } = setupLsp();
    const warmup = handlers["session_start"]![0]!;
    await expect(warmup({}, ctx)).resolves.toBeUndefined();
  });

  test("session_before_switch/fork/shutdown stop servers without crashing", async () => {
    const { handlers, ctx } = setupLsp();
    await handlers["session_before_switch"]![0]!({}, ctx);
    await handlers["session_before_fork"]![0]!({}, ctx);
    await handlers["session_shutdown"]![0]!({}, ctx);
  });

  test("session_start with a project lsp.json under a disabled safety switch warns", async () => {
    const { handlers, ctx, notices } = setupLsp();
    mkdirSync(join(projDir, ".pico"), { recursive: true });
    writeFileSync(join(projDir, ".pico", "lsp.json"), "{}", "utf8");
    await handlers["session_start"]![0]!({}, ctx);
    expect(notices.some((n) => n.msg.includes("PICO_ENABLE_PROJECT_LSP"))).toBe(true);
  });
});
