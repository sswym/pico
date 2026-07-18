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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyTextEditsToString } from "../src/extensions/lsp/edits.ts";
import { DiagnosticsLedger } from "../src/extensions/lsp/diagnostics-ledger.ts";
import { extractLocationFields, normalizeLocations, resolveSymbolColumn } from "../src/extensions/lsp/actions.ts";
import {
  executeCapabilitiesAction,
  executeRequestAction,
  executeStatusAction,
  executeWorkspaceDiagnosticsAction,
  formatDocumentSymbolsResult,
  formatWorkspaceSymbolsResult,
  isLspReadonlyInput,
  isLspWriteOrHighRiskInput,
} from "../src/extensions/lsp/executor.ts";
import { isLspReadonlyToolCall, isLspWriteOrHighRiskToolCall, lspExtension, resolveSessionFilePath } from "../src/extensions/lsp/index.ts";
import {
  __checkInitBackoffForTests,
  __getUnsupportedServerCommandReasonForTests,
  __recordInitFailureForTests,
  createLspManager,
  loadConfig,
  setIdleTimeout,
  syncDocument,
  stopServer,
} from "../src/extensions/lsp/manager.ts";
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

describe("LSP action risk classification", () => {
  test("read-only actions are classified as readonly", () => {
    for (const action of ["hover", "definition", "references", "diagnostics", "symbols", "status", "capabilities"]) {
      expect(isLspReadonlyToolCall({ action })).toBe(true);
      expect(isLspWriteOrHighRiskToolCall({ action })).toBe(false);
    }
  });

  test("code_actions is readonly unless apply=true", () => {
    expect(isLspReadonlyToolCall({ action: "code_actions" })).toBe(true);
    expect(isLspWriteOrHighRiskToolCall({ action: "code_actions" })).toBe(false);
    expect(isLspReadonlyToolCall({ action: "code_actions", apply: true })).toBe(false);
    expect(isLspWriteOrHighRiskToolCall({ action: "code_actions", apply: true })).toBe(true);
  });

  test("write and high-risk actions are not readonly", () => {
    for (const action of ["rename", "rename_file", "reload", "request"]) {
      expect(isLspReadonlyToolCall({ action })).toBe(false);
      expect(isLspWriteOrHighRiskToolCall({ action })).toBe(true);
    }
  });

  test("tool_call hook blocks write and high-risk actions on the lsp tool", async () => {
    const handlers: Record<string, Array<(event: any) => any>> = {};
    const fakePi: any = {
      on: (event: string, handler: (event: any) => any) => {
        (handlers[event] ??= []).push(handler);
      },
      registerTool: () => {},
    };
    lspExtension(fakePi);
    const toolCall = handlers["tool_call"]![0]!;

    expect(await toolCall({ toolName: "lsp", input: { action: "hover" } })).toBeUndefined();

    const blocked = await toolCall({ toolName: "lsp", input: { action: "rename", file: "a.ts", line: 1, character: 0, newName: "b" } });
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toMatch(/mutate files|permission tier/i);
  });

  test("registered tool description presents write and high-risk actions as blocked", () => {
    let registered: any = null;
    const fakePi: any = {
      on: () => {},
      registerTool: (tool: any) => {
        registered = tool;
      },
    };
    lspExtension(fakePi);

    expect(registered.description).toContain("Read-only actions:");
    expect(registered.description).toContain("High-risk/write actions are currently blocked");
    expect(registered.description).toContain("rename_file");
    expect(registered.parameters.properties.action.description).toContain("Currently blocked");
  });

  test("registered tool executor blocks write and high-risk actions before server startup", async () => {
    let registered: any = null;
    const fakePi: any = {
      on: () => {},
      registerTool: (tool: any) => {
        registered = tool;
      },
    };
    lspExtension(fakePi);

    const result = await registered.execute(
      "tc1",
      { action: "rename", file: "a.ts", line: 1, character: 0, newName: "b" },
      undefined,
      undefined,
      { cwd: process.cwd(), ui: { notify: () => {}, confirm: async () => false, setStatus: () => {} } },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/read-only/i);
  });
});

describe("LSP config", () => {
  test("loadConfig reads user config from SRCODE_HOME and parses formatOnWrite", () => {
    const oldHome = process.env.SRCODE_HOME;
    const home = mkdtempSync(join(tmpdir(), "srcode-lsp-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "srcode-lsp-workspace-"));
    process.env.SRCODE_HOME = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "lsp.json"), JSON.stringify({ formatOnWrite: true, idleTimeoutMs: 1234 }), "utf8");

    try {
      const config = loadConfig(workspace);
      expect(config.formatOnWrite).toBe(true);
      expect(config.idleTimeoutMs).toBe(1234);
    } finally {
      if (oldHome === undefined) delete process.env.SRCODE_HOME;
      else process.env.SRCODE_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("LspManager runtime state", () => {
  test("resolveSessionFilePath resolves relative paths from session cwd", () => {
    expect(resolveSessionFilePath("/repo/session", "src/a.ts")).toBe(join("/repo/session", "src/a.ts"));
    expect(resolveSessionFilePath("/repo/session", "/tmp/a.ts")).toBe("/tmp/a.ts");
  });

  test("init failure backoff is isolated per manager state", () => {
    const a = createLspManager();
    const b = createLspManager();

    __recordInitFailureForTests(a, "tsserver", "boom");

    expect(() => __checkInitBackoffForTests(a, "tsserver")).toThrow(/failed to start recently/);
    expect(() => __checkInitBackoffForTests(b, "tsserver")).not.toThrow();
  });

  test("typescript-native skips tsc commands without native LSP support", () => {
    const dir = mkdtempSync(join(tmpdir(), "srcode-lsp-probe-"));
    const oldTsc = join(dir, "old-tsc");
    const nativeTsc = join(dir, "native-tsc");

    try {
      writeFileSync(oldTsc, "#!/bin/sh\necho 'Version 5.9.0'\n", "utf8");
      writeFileSync(nativeTsc, "#!/bin/sh\necho 'Options: --lsp --stdio'\n", "utf8");
      chmodSync(oldTsc, 0o755);
      chmodSync(nativeTsc, 0o755);

      expect(__getUnsupportedServerCommandReasonForTests("typescript-native", oldTsc, dir)).toContain(
        "does not advertise TypeScript native LSP support",
      );
      expect(__getUnsupportedServerCommandReasonForTests("typescript-native", nativeTsc, dir)).toBeNull();
      expect(__getUnsupportedServerCommandReasonForTests("typescript-language-server", oldTsc, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("idle timeout checker is stored per manager state", async () => {
    const a = createLspManager();
    const b = createLspManager();

    setIdleTimeout(a, 1000);
    expect(a.runtime.idleCheckInterval).not.toBeNull();
    expect(b.runtime.idleCheckInterval).toBeNull();

    setIdleTimeout(b, 2000);
    expect(b.runtime.idleCheckInterval).not.toBeNull();
    expect(a.runtime.idleCheckInterval).not.toBe(b.runtime.idleCheckInterval);

    await stopServer(a);
    expect(a.runtime.idleCheckInterval).toBeNull();
    expect(b.runtime.idleCheckInterval).not.toBeNull();

    await stopServer(b);
    expect(b.runtime.idleCheckInterval).toBeNull();
  });

  test("syncDocument resolves relative paths from session cwd, not process cwd", () => {
    const processDir = mkdtempSync(join(tmpdir(), "srcode-lsp-process-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "srcode-lsp-session-"));
    const oldCwd = process.cwd();
    writeFileSync(join(processDir, "same.ts"), "const fromProcess = true;\n", "utf8");
    writeFileSync(join(sessionDir, "same.ts"), "const fromSession = true;\n", "utf8");

    const opened: Array<{ filePath: string; text: string; languageId: string }> = [];
    const state = createLspManager();
    state.servers.set("tsserver", {
      config: { fileTypes: [".ts"], isLinter: false },
      client: {
        ready: true,
        ensureOpen: (filePath: string, text: string, languageId: string) => {
          opened.push({ filePath, text, languageId });
          return `file://${filePath}`;
        },
      },
      openDocuments: new Map(),
      lastActivity: Date.now(),
    } as any);

    try {
      process.chdir(processDir);
      const uri = syncDocument(state, sessionDir, "same.ts");
      expect(uri).toBe(`file://${join(sessionDir, "same.ts")}`);
      expect(opened).toEqual([
        {
          filePath: join(sessionDir, "same.ts"),
          text: "const fromSession = true;\n",
          languageId: "typescript",
        },
      ]);
    } finally {
      process.chdir(oldCwd);
      rmSync(processDir, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

describe("LSP action helpers", () => {
  test("normalizeLocations handles Location and LocationLink results", () => {
    const location = {
      uri: "file:///a.ts",
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
    };
    expect(normalizeLocations(location)).toEqual([location]);

    const links = [
      {
        targetUri: "file:///b.ts",
        targetRange: { start: { line: 3, character: 0 }, end: { line: 4, character: 0 } },
      },
    ];
    expect(normalizeLocations(links)).toEqual([
      {
        uri: "file:///b.ts",
        range: links[0]!.targetRange,
      },
    ]);
  });

  test("extractLocationFields validates location-like shapes", () => {
    expect(extractLocationFields({
      uri: "file:///x.ts",
      range: { start: { line: 9 } },
    })).toEqual({ uri: "file:///x.ts", line: 9 });
    expect(extractLocationFields({ uri: "file:///x.ts", range: {} })).toBeNull();
    expect(extractLocationFields(null)).toBeNull();
  });

  test("resolveSymbolColumn finds the requested occurrence on a 1-based line", () => {
    const dir = mkdtempSync(join(tmpdir(), "srcode-lsp-action-"));
    const file = join(dir, "sample.ts");
    writeFileSync(file, "const alpha = alpha + beta;\nconst beta = 1;\n", "utf8");
    try {
      expect(resolveSymbolColumn(file, 1, "alpha", 1)).toBe(6);
      expect(resolveSymbolColumn(file, 1, "alpha", 2)).toBe(14);
      expect(resolveSymbolColumn(file, 2, "alpha", 1)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LSP executor helpers", () => {
  test("input risk helpers classify readonly and write/high-risk actions", () => {
    expect(isLspReadonlyInput({ action: "hover" })).toBe(true);
    expect(isLspReadonlyInput({ action: "code_actions" })).toBe(true);
    expect(isLspReadonlyInput({ action: "code_actions", apply: true })).toBe(false);
    expect(isLspWriteOrHighRiskInput({ action: "rename_file" })).toBe(true);
    expect(isLspWriteOrHighRiskInput({ action: "code_actions", apply: true })).toBe(true);
  });

  test("executeStatusAction reports configured and active servers", () => {
    const state = createLspManager();
    state.config = {
      servers: {
        tsserver: { command: "typescript-language-server", args: [] },
      },
      filetypes: {},
    } as any;

    const noActive: any = executeStatusAction(state, "/repo");
    expect(noActive.content[0].text).toContain("Configured servers: tsserver");

    state.servers.set("tsserver", {
      client: {
        ready: true,
        displayVersion: "1.2.3",
        status: "running",
        getAllDiagnostics: () => new Map([["file:///a.ts", []]]),
      },
    } as any);
    const active: any = executeStatusAction(state, "/repo");
    expect(active.content[0].text).toContain("tsserver v1.2.3");
    expect(active.details).toEqual({ action: "status", success: true });
  });

  test("executeCapabilitiesAction formats supported capabilities", () => {
    const result: any = executeCapabilitiesAction({
      serverName: "tsserver",
      capabilities: {
        hoverProvider: true,
        completionProvider: { triggerCharacters: ["."] },
        ignored: false,
      },
    });

    expect(result.content[0].text).toContain("hoverProvider: supported");
    expect(result.content[0].text).toContain('completionProvider: {"triggerCharacters":["."]}');
    expect(result.content[0].text).not.toContain("ignored");
  });

  test("executeRequestAction validates query and formats success or failure", async () => {
    const missing: any = await executeRequestAction({ rawRequest: async () => ({}) }, undefined, null);
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("requires 'query'");

    const okResult: any = await executeRequestAction({ rawRequest: async (_method, payload) => ({ payload }) }, "x/y", { a: 1 });
    expect(okResult.content[0].text).toContain('"a": 1');

    const failed: any = await executeRequestAction({
      rawRequest: async () => {
        throw new Error("boom");
      },
    }, "x/y", null);
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe("LSP request failed: boom");
  });

  test("executeWorkspaceDiagnosticsAction formats diagnostics from active clients", () => {
    const state = createLspManager();
    state.servers.set("tsserver", {
      client: {
        ready: true,
        getAllDiagnostics: () => new Map([
          ["file:///repo/a.ts", [
            {
              range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } },
              severity: 1,
              code: "TS1",
              source: "ts",
              message: "bad",
            },
            {
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
              severity: 2,
              message: "warn",
            },
          ]],
        ]),
      },
    } as any);

    const result: any = executeWorkspaceDiagnosticsAction(state);
    expect(result.content[0].text).toContain("Workspace diagnostics (2):");
    expect(result.content[0].text).toContain("/repo/a.ts:1:2 ERROR [TS1] (ts): bad");
    expect(result.content[0].text).toContain("/repo/a.ts:2:0 WARNING: warn");
    expect(result.details).toEqual({ action: "diagnostics", success: true });
  });

  test("symbol formatters handle workspace and document symbol shapes", () => {
    const workspace: any = formatWorkspaceSymbolsResult("Alpha", [
      {
        name: "Alpha",
        kind: 12,
        location: {
          uri: "file:///repo/a.ts",
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
        },
      },
      { name: "Beta", kind: 13, location: null },
    ]);
    expect(workspace.content[0].text).toContain('Workspace symbols matching "Alpha" (2):');
    expect(workspace.content[0].text).toContain("Alpha [12] /repo/a.ts:3");
    expect(workspace.content[0].text).toContain("Beta [13] (no location)");

    const flat: any = formatDocumentSymbolsResult("a.ts", [
      {
        name: "Gamma",
        kind: 12,
        containerName: "Container",
        location: {
          uri: "file:///repo/a.ts",
          range: { start: { line: 4, character: 0 }, end: { line: 4, character: 5 } },
        },
      },
    ]);
    expect(flat.content[0].text).toContain("Symbols in a.ts (1):");
    expect(flat.content[0].text).toContain("Gamma [12] /repo/a.ts:5 (Container)");

    const none: any = formatDocumentSymbolsResult("a.ts", []);
    expect(none.content[0].text).toBe("No symbols found in a.ts.");
  });
});
