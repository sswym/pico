/**
 * pico LSP extension unit tests.
 *
 * Tests the workspace edit engine (edits.ts) and diagnostics ledger
 * (diagnostics-ledger.ts) — the two new modules with testable pure logic.
 *
 * Does NOT test: actual LSP server communication, TUI rendering,
 * or extension event wiring (requires running language servers).
 */
import { afterEach, beforeEach, expect, test, describe } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyTextEditsToString } from "../src/extensions/lsp/edits.ts";
import { DiagnosticsLedger } from "../src/extensions/lsp/diagnostics-ledger.ts";
import { extractLocationFields, normalizeLocations, resolveSymbolColumn } from "../src/extensions/lsp/actions.ts";
import {
  ACTIONS,
  BLOCKED_WRITE_OR_HIGH_RISK_ACTIONS,
  executeCapabilitiesAction,
  executeRequestAction,
  executeStatusAction,
  executeWorkspaceDiagnosticsAction,
  fail,
  formatDocumentSymbolsResult,
  formatWorkspaceSymbolsResult,
  isLspReadonlyInput,
  isLspWriteOrHighRiskInput,
  LSP_ACTION_METADATA,
  READONLY_ACTIONS,
} from "../src/extensions/lsp/executor.ts";
import { ToolError } from "../src/extensions/errors.ts";
import { isLspReadonlyToolCall, isLspWriteOrHighRiskToolCall, lspExtension, resolveSessionFilePath, waitForFreshDiagnostics, __resetSlowServerTrackingForTests, resetSlowServerTracking } from "../src/extensions/lsp/index.ts";
import {
  __checkInitBackoffForTests,
  __getUnsupportedServerCommandReasonForTests,
  __recordInitFailureForTests,
  createLspManager,
  ensureNamedServer,
  ensureServer,
  findLocalTypescriptDir,
  loadConfig,
  setIdleTimeout,
  syncDocument,
  syncDocumentForFile,
  stopServer,
  friendlyLspInitError,
} from "../src/extensions/lsp/manager.ts";
import { LspClient, LspError, COMMAND_NOT_FOUND } from "../src/extensions/lsp/client.ts";
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
    for (const action of ["rename", "rename_file", "request"]) {
      expect(isLspReadonlyToolCall({ action })).toBe(false);
      expect(isLspWriteOrHighRiskToolCall({ action })).toBe(true);
    }
  });

  test("reload is no longer blocked: it restarts servers but never touches the filesystem", () => {
    expect(isLspReadonlyToolCall({ action: "reload" })).toBe(false);
    expect(isLspWriteOrHighRiskToolCall({ action: "reload" })).toBe(false);
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

    const run = registered.execute(
      "tc1",
      { action: "rename", file: "a.ts", line: 1, character: 0, newName: "b" },
      undefined,
      undefined,
      { cwd: process.cwd(), ui: { notify: () => {}, confirm: async () => false, setStatus: () => {} } },
    );

    // Tool failures are expressed by throwing (the agent loop derives isError
    // from thrown exceptions, not returned objects).
    await expect(run).rejects.toThrow(/read-only/i);
  });
});

describe("LSP action metadata table", () => {
  test("LSP_ACTION_METADATA flags representative actions", () => {
    expect(LSP_ACTION_METADATA.hover).toEqual({ readonly: true, writeCapable: false });
    expect(LSP_ACTION_METADATA.rename).toEqual({ readonly: false, writeCapable: true });
    expect(LSP_ACTION_METADATA.request).toEqual({ readonly: false, writeCapable: true });
  });

  test("LSP_ACTION_METADATA covers every action with the expected permissions", () => {
    const expected: Record<string, { readonly: boolean; writeCapable: boolean }> = {
      hover: { readonly: true, writeCapable: false },
      definition: { readonly: true, writeCapable: false },
      type_definition: { readonly: true, writeCapable: false },
      implementation: { readonly: true, writeCapable: false },
      references: { readonly: true, writeCapable: false },
      diagnostics: { readonly: true, writeCapable: false },
      symbols: { readonly: true, writeCapable: false },
      capabilities: { readonly: true, writeCapable: false },
      status: { readonly: true, writeCapable: false },
      code_actions: { readonly: true, writeCapable: true },
      rename: { readonly: false, writeCapable: true },
      rename_file: { readonly: false, writeCapable: true },
      request: { readonly: false, writeCapable: true },
      reload: { readonly: false, writeCapable: false },
    };
    expect(Object.keys(LSP_ACTION_METADATA).sort()).toEqual(Object.keys(expected).sort());
    for (const action of ACTIONS) {
      expect(LSP_ACTION_METADATA[action]).toEqual(expected[action]!);
    }
  });

  test("READONLY_ACTIONS keeps its public value", () => {
    expect(READONLY_ACTIONS).toEqual([
      "hover", "definition", "type_definition", "implementation", "references",
      "diagnostics", "symbols", "code_actions", "capabilities", "status",
    ]);
  });

  test("BLOCKED_WRITE_OR_HIGH_RISK_ACTIONS keeps its public value", () => {
    expect(BLOCKED_WRITE_OR_HIGH_RISK_ACTIONS).toEqual([
      "rename", "rename_file", "request", "code_actions apply=true",
    ]);
  });

  test("fail() throws a coded ToolError", () => {
    expect(() => fail("boom")).toThrow("boom");
    let thrown: unknown;
    try {
      fail("blocked by policy", undefined, undefined, "blocked");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).code).toBe("blocked");
    expect((thrown as ToolError).message).toBe("blocked by policy");
  });
});

describe("LSP config", () => {
  test("loadConfig reads user config from PICO_HOME and parses formatOnWrite", () => {
    const oldHome = process.env.PICO_HOME;
    const home = mkdtempSync(join(tmpdir(), "pico-lsp-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "pico-lsp-workspace-"));
    process.env.PICO_HOME = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "lsp.json"), JSON.stringify({ formatOnWrite: true, idleTimeoutMs: 1234 }), "utf8");

    try {
      const config = loadConfig(workspace);
      expect(config.formatOnWrite).toBe(true);
      expect(config.idleTimeoutMs).toBe(1234);
    } finally {
      if (oldHome === undefined) delete process.env.PICO_HOME;
      else process.env.PICO_HOME = oldHome;
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

  test("typescript-native skips tsc commands without native LSP support", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-lsp-probe-"));
    const oldTsc = join(dir, "old-tsc");
    const nativeTsc = join(dir, "native-tsc");

    try {
      writeFileSync(oldTsc, "#!/bin/sh\necho 'Version 5.9.0'\n", "utf8");
      writeFileSync(nativeTsc, "#!/bin/sh\necho 'Options: --lsp --stdio'\n", "utf8");
      chmodSync(oldTsc, 0o755);
      chmodSync(nativeTsc, 0o755);

      expect(await __getUnsupportedServerCommandReasonForTests("typescript-native", oldTsc, dir)).toContain(
        "does not advertise TypeScript native LSP support",
      );
      expect(await __getUnsupportedServerCommandReasonForTests("typescript-native", nativeTsc, dir)).toBeNull();
      expect(await __getUnsupportedServerCommandReasonForTests("typescript-language-server", oldTsc, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("typescript-native probe carries install hint when workspace ships typescript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-lsp-hint-"));
    const oldTsc = join(dir, "old-tsc");
    const nodeModulesTs = join(dir, "node_modules", "typescript", "lib");

    try {
      writeFileSync(oldTsc, "#!/bin/sh\necho 'Version 5.9.0'\n", "utf8");
      chmodSync(oldTsc, 0o755);
      mkdirSync(nodeModulesTs, { recursive: true });
      writeFileSync(join(nodeModulesTs, "tsserver.js"), "// fake tsserver\n", "utf8");

      const reason = await __getUnsupportedServerCommandReasonForTests("typescript-native", oldTsc, dir);
      expect(reason).not.toBeNull();
      expect(reason).toContain("typescript-language-server");
      expect(reason).toContain("bun add -d typescript-language-server");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("findLocalTypescriptDir resolves up to 4 levels of node_modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-lsp-find-"));
    try {
      expect(findLocalTypescriptDir(dir)).toBeNull();
      const pkg = join(dir, "a", "b", "node_modules", "typescript");
      mkdirSync(join(pkg, "lib"), { recursive: true });
      writeFileSync(join(pkg, "lib", "tsserver.js"), "// fake\n", "utf8");
      expect(findLocalTypescriptDir(join(dir, "a", "b", "src", "deep"))).toBe(pkg);
      expect(findLocalTypescriptDir(join(dir, "a", "b"))).toBe(pkg);
      // Beyond 4 levels → null (5 dirs up hits the depth cap)
      expect(findLocalTypescriptDir(join(dir, "a", "b", "src", "deep", "x", "y"))).toBeNull();
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
    const processDir = mkdtempSync(join(tmpdir(), "pico-lsp-process-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "pico-lsp-session-"));
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

  test("syncDocumentForFile uses the server matching the target file type", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pico-lsp-file-server-"));
    writeFileSync(join(sessionDir, "app.ts"), "const app = true;\n", "utf8");
    writeFileSync(join(sessionDir, "script.py"), "print('ok')\n", "utf8");

    const opened: Array<{ server: string; filePath: string; text: string; languageId: string }> = [];
    const state = createLspManager();
    state.config = {
      servers: {
        tsserver: { command: "typescript-language-server", args: [], fileTypes: [".ts"], rootMarkers: [] },
        pyright: { command: "pyright-langserver", args: [], fileTypes: [".py"], rootMarkers: [] },
      },
    };
    state.configured = true;
    for (const [name, fileTypes] of [["tsserver", [".ts"]], ["pyright", [".py"]]] as const) {
      state.servers.set(name, {
        name,
        config: { fileTypes, isLinter: false },
        client: {
          ready: true,
          ensureOpen: (filePath: string, text: string, languageId: string) => {
            opened.push({ server: name, filePath, text, languageId });
            return `file://${filePath}`;
          },
          didChange: () => {},
        },
        openDocuments: new Map(),
        lastActivity: Date.now(),
      } as any);
    }

    try {
      const doc = await syncDocumentForFile(state, sessionDir, "script.py");
      expect(doc?.serverName).toBe("pyright");
      expect(opened).toEqual([
        {
          server: "pyright",
          filePath: join(sessionDir, "script.py"),
          text: "print('ok')\n",
          languageId: "python",
        },
      ]);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test("syncDocument sends didChange when an open file changed on disk", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pico-lsp-didchange-"));
    const filePath = join(sessionDir, "same.ts");
    writeFileSync(filePath, "const before = true;\n", "utf8");

    const changes: Array<{ uri: string; version: number; text: string }> = [];
    const state = createLspManager();
    const client = {
      ready: true,
      ensureOpen: (path: string) => `file://${path}`,
      didChange: (uri: string, version: number, text: string) => {
        changes.push({ uri, version, text });
      },
    };
    state.servers.set("tsserver", {
      name: "tsserver",
      config: { fileTypes: [".ts"], isLinter: false },
      client,
      openDocuments: new Map(),
      lastActivity: Date.now(),
    } as any);

    try {
      const uri = syncDocument(state, sessionDir, "same.ts");
      expect(uri).toBe(`file://${filePath}`);

      writeFileSync(filePath, "const after = true;\n", "utf8");
      const sameUri = syncDocument(state, sessionDir, "same.ts");

      expect(sameUri).toBe(uri);
      expect(changes).toEqual([
        { uri: `file://${filePath}`, version: 2, text: "const after = true;\n" },
      ]);
    } finally {
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
    const dir = mkdtempSync(join(tmpdir(), "pico-lsp-action-"));
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

  test("executeRequestAction validates query and formats success or throws on failure", async () => {
    const missing: Promise<any> = executeRequestAction({ rawRequest: async () => ({}) }, undefined, null);
    await expect(missing).rejects.toThrow("requires 'query'");

    const okResult: any = await executeRequestAction({ rawRequest: async (_method, payload) => ({ payload }) }, "x/y", { a: 1 });
    expect(okResult.content[0].text).toContain('"a": 1');

    const failed: Promise<any> = executeRequestAction({
      rawRequest: async () => {
        throw new Error("boom");
      },
    }, "x/y", null);
    await expect(failed).rejects.toThrow("LSP request failed: boom");
  });

  test("executeWorkspaceDiagnosticsAction formats diagnostics from active clients", () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-lsp-diag-"));
    const existingFile = join(dir, "a.ts");
    writeFileSync(existingFile, "const x = 1;\n");
    const deletedFile = join(dir, "deleted.ts");
    const state = createLspManager();
    state.servers.set("tsserver", {
      client: {
        ready: true,
        getAllDiagnostics: () => new Map([
          // Deleted files must be filtered out of the workspace report.
          [`file://${deletedFile}`, [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: 1,
            message: "stale",
          }]],
          [`file://${existingFile}`, [
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
    expect(result.content[0].text).toContain(`${existingFile}:1:2 ERROR [TS1] (ts): bad`);
    expect(result.content[0].text).toContain(`${existingFile}:2:0 WARNING: warn`);
    expect(result.content[0].text).not.toContain("stale");
    expect(result.details).toEqual({ action: "diagnostics", success: true });
    rmSync(dir, { recursive: true, force: true });
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

// ── Writethrough contract + diagnostics freshness ─────────────────────────

/**
 * Minimal LSP server over stdio: answers initialize, publishes one new
 * diagnostic per didSave (message "error-<n>"), and exits on shutdown/exit.
 */
const FAKE_LSP_SERVER = `
let buf = Buffer.alloc(0);
let pubCount = 0;
let saveUri = "";
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
}
function pump() {
  while (true) {
    const headEnd = buf.indexOf("\\r\\n\\r\\n");
    if (headEnd === -1) break;
    const head = buf.slice(0, headEnd).toString("utf8");
    const m = /Content-Length: (\\d+)/.exec(head);
    if (!m) { buf = buf.slice(headEnd + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < headEnd + 4 + len) break;
    const body = JSON.parse(buf.slice(headEnd + 4, headEnd + 4 + len).toString("utf8"));
    buf = buf.slice(headEnd + 4 + len);
    onMessage(body);
  }
}
function onMessage(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {}, serverInfo: { name: "fake-lsp", version: "1.0.0" } } });
  } else if (msg.method === "textDocument/didSave") {
    saveUri = msg.params.textDocument.uri;
    pubCount++;
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: saveUri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "error-" + pubCount }] } });
    }, 30);
  } else if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "exit") {
    process.exit(0);
  }
}
process.stdin.on("data", (chunk) => { buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); pump(); });
`;

describe("LSP writethrough diagnostics freshness", () => {
  test("waitForFreshDiagnostics does not stall on a fast empty publish", async () => {
    // A server that answers quickly with [] has already responded — entering
    // the 5s deferred window would stall every clean write ~5.5s.
    let calls = 0;
    const client = {
      waitForDiagnostics: async (_uri: string, _ms: number) => {
        calls++;
        return [] as unknown[];
      },
    };
    const result = await waitForFreshDiagnostics(client as never, "file:///x");
    expect(result).toEqual([]);
    expect(calls).toBe(1);
  });

  test("waitForFreshDiagnostics falls back to the deferred window only on timeout", async () => {
    const calls: number[] = [];
    const client = {
      serverName: "test-server",
      waitForDiagnostics: async (_uri: string, ms: number, signal?: AbortSignal) => {
        calls.push(ms);
        if (calls.length === 1) return null; // inline window elapsed, no publish
        signal?.addEventListener("abort", () => {});
        return [{ message: "late error" }];
      },
    };
    const result = await waitForFreshDiagnostics(client as never, "file:///x");
    expect(calls).toEqual([500, 5000]);
    expect((result as Array<{ message: string }>)[0]!.message).toBe("late error");
  });

  test("a full deferred timeout marks the server slow; the next file gets a short window", async () => {
    __resetSlowServerTrackingForTests();
    const calls: number[] = [];
    const client = {
      serverName: "slow-server",
      waitForDiagnostics: async (_uri: string, ms: number, signal?: AbortSignal) => {
        calls.push(ms);
        signal?.addEventListener("abort", () => {});
        return null; // never publishes — stalls every window
      },
    };
    // First file: full inline + full deferred (5s), both burn out.
    const first = await waitForFreshDiagnostics(client as never, "file:///a.ts");
    expect(first).toBeNull();
    expect(calls).toEqual([500, 5000]);

    // Second file on the same server: inline 500ms, then the SHORT deferred
    // window instead of another 5s.
    const second = await waitForFreshDiagnostics(client as never, "file:///b.ts");
    expect(second).toBeNull();
    expect(calls).toEqual([500, 5000, 500, 1000]);
  });

  test("slow-server marks are per-server and reset on session start", async () => {
    __resetSlowServerTrackingForTests();
    const calls: Array<Array<string | number>> = [];
    const slowClient = {
      serverName: "slow-server",
      waitForDiagnostics: async (_uri: string, ms: number, signal?: AbortSignal) => {
        calls.push(["slow", ms]);
        signal?.addEventListener("abort", () => {});
        return null;
      },
    };
    const fastClient = {
      serverName: "fast-server",
      waitForDiagnostics: async (_uri: string, ms: number, signal?: AbortSignal) => {
        calls.push(["fast", ms]);
        signal?.addEventListener("abort", () => {});
        return null;
      },
    };
    // Slow server burns a full window once…
    await waitForFreshDiagnostics(slowClient as never, "file:///a.ts");
    expect(calls).toEqual([["slow", 500], ["slow", 5000]]);

    // …a DIFFERENT server is unaffected (full 5s deferred)…
    await waitForFreshDiagnostics(fastClient as never, "file:///b.ts");
    expect(calls).toEqual([["slow", 500], ["slow", 5000], ["fast", 500], ["fast", 5000]]);

    // …and the slow server itself gets the short window on its next file.
    await waitForFreshDiagnostics(slowClient as never, "file:///c.ts");
    expect(calls).toEqual([["slow", 500], ["slow", 5000], ["fast", 500], ["fast", 5000], ["slow", 500], ["slow", 1000]]);

    // session_start resets: the slow server gets a full window again.
    resetSlowServerTracking();
    await waitForFreshDiagnostics(slowClient as never, "file:///d.ts");
    expect(calls.at(-2)).toEqual(["slow", 500]);
    expect(calls.at(-1)).toEqual(["slow", 5000]);
  });

  test("waitForDiagnostics returns post-didSave publishes, never the stale cache", async () => {
    const client = new LspClient(
      { command: process.execPath, args: ["-e", FAKE_LSP_SERVER], fileTypes: [".ts"] } as any,
      "fake-lsp",
    );
    await client.initialize(process.cwd());
    const uri = "file:///repo/a.ts";
    try {
      await client.didSave(uri);
      const first = await client.waitForDiagnostics(uri, 5_000);
      expect(first?.some((d) => d.message === "error-1")).toBe(true);

      // Second save must observe the NEW publish — returning the cached
      // diagnostics here would silently drop error-2.
      await client.didSave(uri);
      const second = await client.waitForDiagnostics(uri, 5_000);
      expect(second?.some((d) => d.message === "error-2")).toBe(true);
    } finally {
      await client.shutdown();
    }
  });

  test("didSave keeps cached diagnostics for silent-server fallback", async () => {
    // This server publishes once per didOpen and ignores didSave entirely —
    // the write-through's fallback path must still see the cached set
    // instead of reporting a false "no diagnostics".
    const publishOnOpen = `
      let buf = Buffer.alloc(0);
      function send(msg) {
        const body = Buffer.from(JSON.stringify(msg));
        process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
      }
      function onMessage(msg) {
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {}, serverInfo: { name: "publish-on-open", version: "1.0.0" } } });
        } else if (msg.method === "textDocument/didOpen") {
          const uri = msg.params.textDocument.uri;
          setTimeout(() => {
            send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "open-error" }] } });
          }, 30);
        } else if (msg.method === "shutdown") {
          send({ jsonrpc: "2.0", id: msg.id, result: null });
        } else if (msg.method === "exit") {
          process.exit(0);
        }
      }
      process.stdin.on("data", (chunk) => { buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); pump(); });
      function pump() {
        while (true) {
          const headEnd = buf.indexOf("\\r\\n\\r\\n");
          if (headEnd === -1) break;
          const head = buf.slice(0, headEnd).toString("utf8");
          const m = /Content-Length: (\\d+)/.exec(head);
          if (!m) { buf = buf.slice(headEnd + 4); continue; }
          const len = Number(m[1]);
          if (buf.length < headEnd + 4 + len) break;
          const body = JSON.parse(buf.slice(headEnd + 4, headEnd + 4 + len).toString("utf8"));
          buf = buf.slice(headEnd + 4 + len);
          onMessage(body);
        }
      }
    `;
    const client = new LspClient(
      { command: process.execPath, args: ["-e", publishOnOpen], fileTypes: [".ts"] } as any,
      "publish-on-open",
    );
    await client.initialize(process.cwd());
    const uri = client.ensureOpen("/repo/a.ts", "const x = 1;\n", "typescript");
    try {
      // The didOpen publish lands in the cache.
      await client.waitForDiagnostics(uri, 5_000);
      expect(client.getDiagnostics(uri)).toHaveLength(1);

      // didSave with a silent server: no fresh publish, but the cached set
      // must survive for the write-through fallback.
      client.didSave(uri);
      const fresh = await client.waitForDiagnostics(uri, 1_000);
      expect(fresh).toBeNull();
      expect(client.getDiagnostics(uri)).toHaveLength(1);
    } finally {
      await client.shutdown();
    }
  });

  test("tool_result handler never mutates the event in place and skips failed writes", async () => {
    const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
    const fakePi: any = {
      on: (event: string, handler: (event: any, ctx: any) => any) => {
        (handlers[event] ??= []).push(handler);
      },
      registerTool: () => {},
    };
    lspExtension(fakePi);
    const handler = handlers["tool_result"]![0]!;
    const ctx = {
      cwd: process.cwd(),
      ui: { notify: () => {}, confirm: async () => false, setStatus: () => {} },
    };

    // Failed writes are skipped entirely (no format-on-write of stale content).
    const failedEvent = {
      toolName: "write",
      isError: true,
      input: { path: "a.ts" },
      content: [{ type: "text", text: "boom" }],
    };
    expect(await handler(failedEvent, ctx)).toBeUndefined();
    expect(failedEvent.content).toEqual([{ type: "text", text: "boom" }]);

    // Successful write without a usable server: nothing appended, and the
    // event object is untouched — upstream only applies the return value.
    const okEvent = {
      toolName: "edit",
      isError: false,
      input: { path: "a.ts" },
      content: [{ type: "text", text: "ok" }],
    };
    const result = await handler(okEvent, ctx);
    expect(result).toBeUndefined();
    expect(okEvent.content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("ensureNamedServer cleans up state when initialization fails", async () => {
    const state = createLspManager();
    state.config = {
      servers: {
        "fake-crash": {
          command: process.execPath,
          args: ["-e", "process.exit(1)"],
          fileTypes: [".ts"],
          rootMarkers: [],
        },
      },
      formatOnWrite: false,
    } as any;

    const result = await ensureNamedServer(state, "fake-crash", process.cwd());
    expect(result).toBeNull();
    expect(state.servers.has("fake-crash")).toBe(false);
  });

  test("concurrent ensureNamedServer calls share one in-flight initialization", async () => {
    const spawnLog = join(tmpdir(), `pico-lsp-spawn-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    const slowServer = `
      const fs = require("node:fs");
      fs.appendFileSync(process.env.PICO_TEST_SPAWN_LOG, "spawned\\n");
      let buf = Buffer.alloc(0);
      function send(msg) {
        const body = Buffer.from(JSON.stringify(msg));
        process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
      }
      function onMessage(msg) {
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {}, serverInfo: { name: "slow-lsp", version: "1.0.0" } } });
        } else if (msg.method === "shutdown") {
          send({ jsonrpc: "2.0", id: msg.id, result: null });
        } else if (msg.method === "exit") {
          process.exit(0);
        }
      }
      process.stdin.on("data", (chunk) => { buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); pump(); });
      function pump() {
        while (true) {
          const headEnd = buf.indexOf("\\r\\n\\r\\n");
          if (headEnd === -1) break;
          const head = buf.slice(0, headEnd).toString("utf8");
          const m = /Content-Length: (\\d+)/.exec(head);
          if (!m) { buf = buf.slice(headEnd + 4); continue; }
          const len = Number(m[1]);
          if (buf.length < headEnd + 4 + len) break;
          const body = JSON.parse(buf.slice(headEnd + 4, headEnd + 4 + len).toString("utf8"));
          buf = buf.slice(headEnd + 4 + len);
          onMessage(body);
        }
      }
    `;
    const state = createLspManager();
    state.config = {
      servers: {
        "fake-slow": {
          command: process.execPath,
          args: ["-e", slowServer],
          fileTypes: [".ts"],
          rootMarkers: [],
        },
      },
      formatOnWrite: false,
    } as any;
    process.env.PICO_TEST_SPAWN_LOG = spawnLog;
    try {
      const [a, b] = await Promise.all([
        ensureNamedServer(state, "fake-slow", process.cwd()),
        ensureNamedServer(state, "fake-slow", process.cwd()),
      ]);
      // Both callers resolved to the SAME client — the second caller awaited
      // the first's in-flight init instead of spawning a duplicate process.
      expect(a).not.toBeNull();
      expect(a).toBe(b);
      expect(state.servers.size).toBe(1);
      const spawns = readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean);
      expect(spawns).toHaveLength(1);
    } finally {
      delete process.env.PICO_TEST_SPAWN_LOG;
      await stopServer(state);
      try { rmSync(spawnLog); } catch { }
    }
  });
});

// ---- missing-server hints (P1) -------------------------------------------

import { formatInstallHint } from "../src/extensions/lsp/install.ts";

test("formatInstallHint suggests a project-local tsc install", () => {
  const hint = formatInstallHint("tsc");
  expect(hint).toContain("bun add -d typescript");
});

test("formatInstallHint fallback points at lsp.json for unknown commands", () => {
  const hint = formatInstallHint("some-unknown-server");
  expect(hint).toContain("settings.json (lsp key)");
});

test("formatInstallHint keeps registry install commands for known servers", () => {
  const hint = formatInstallHint("pyright");
  expect(hint).toContain("npm install -g pyright");
});

// ---- Fourth-round regression tests: URI encoding / applyEdit contract ----

test("pathToUri/uriToPath round-trip spaces and non-ASCII paths", () => {
  const { pathToUri, uriToPath } = require("../src/extensions/lsp/client.ts") as typeof import("../src/extensions/lsp/client.ts");
  const p = "/repo/我的 项目/a file.ts";
  const uri = pathToUri(p);
  expect(uri).toBe(`file://${encodeURI(p)}`);
  expect(uriToPath(uri)).toBe(p);
  // Server-style percent-encoded URIs decode to real paths.
  expect(uriToPath("file:///repo/a%20b.ts")).toBe("/repo/a b.ts");
  // Malformed encodings are returned as-is, not corrupted.
  expect(uriToPath("file:///repo/%zz.ts")).toBe("/repo/%zz.ts");
});

test("pathToUri escapes # and ? which encodeURI leaves as URI delimiters", () => {
  const { pathToUri, uriToPath } = require("../src/extensions/lsp/client.ts") as typeof import("../src/extensions/lsp/client.ts");
  // A filename containing `#` must not arrive as a fragment.
  const uri = pathToUri("/repo/foo#1.ts");
  expect(uri).toBe("file:///repo/foo%231.ts");
  expect(uriToPath(uri)).toBe("/repo/foo#1.ts");
  expect(uriToPath("file:///repo/a?b.ts")).toBe("/repo/a?b.ts");
});

test("workspace/applyEdit server requests are answered with applied:false", () => {
  const { LspClient } = require("../src/extensions/lsp/client.ts") as typeof import("../src/extensions/lsp/client.ts");
  const client = new LspClient({ command: "unused", args: [], fileTypes: [".ts"] } as never, "apply-test");
  const writes: string[] = [];
  // No real process is spawned — drive the request handler directly with a
  // fake stdin so the response contract is asserted deterministically.
  const anyClient = client as unknown as {
    process: { stdin: { write: (s: string) => number } } | null;
    handleRequest: (req: { id: unknown; method: string; params?: unknown }) => void;
  };
  anyClient.process = {
    stdin: {
      write: (s: string) => {
        writes.push(s);
        return s.length;
      },
    },
  };

  anyClient.handleRequest({ id: 7, method: "workspace/applyEdit", params: { edit: { changes: {} } } });
  expect(writes.join("")).toContain('"applied":false');

  anyClient.handleRequest({ id: 8, method: "client/registerCapability" });
  expect(writes.join("")).toContain('"result":null');

  anyClient.handleRequest({ id: 9, method: "bogus/method" });
  expect(writes.join("")).toContain("Method not found");
});

// ---- Fifth-round regressions: version tracking / config pull / cancel ----

import { resolveServerArgs } from "../src/extensions/lsp/client.ts";

test("resolveServerArgs substitutes $PID tokens", () => {
  expect(resolveServerArgs(["-lsp", "$PID"], 1234)).toEqual(["-lsp", "1234"]);
  expect(resolveServerArgs(["-lsp", "--port=$PID", "$PID"], 42)).toEqual(["-lsp", "--port=42", "42"]);
  expect(resolveServerArgs(["a", "b"], 5)).toEqual(["a", "b"]);
});

test("workspace/configuration server requests are answered from configured settings", () => {
  const { LspClient } = require("../src/extensions/lsp/client.ts") as typeof import("../src/extensions/lsp/client.ts");
  const client = new LspClient({
    command: "unused",
    args: [],
    fileTypes: [".ts"],
    settings: { python: { analysis: { typeCheckingMode: "basic" } } },
  } as never, "cfg-test");
  const writes: string[] = [];
  const anyClient = client as unknown as {
    process: { stdin: { write: (s: string) => number } } | null;
    handleRequest: (req: { id: unknown; method: string; params?: unknown }) => void;
  };
  anyClient.process = {
    stdin: {
      write: (s: string) => {
        writes.push(s);
        return s.length;
      },
    },
  };

  anyClient.handleRequest({
    id: 7,
    method: "workspace/configuration",
    params: { items: [{ section: "python" }, { section: "missing" }] },
  });
  const sent = writes.join("");
  expect(sent).toContain('"result":[{"analysis":{"typeCheckingMode":"basic"}},null]');
  expect(sent).toContain("null");
});

test("dynamic capability registration drives supportsDocumentDiagnostics", () => {
  const { LspClient } = require("../src/extensions/lsp/client.ts") as typeof import("../src/extensions/lsp/client.ts");
  const client = new LspClient({ command: "unused", args: [], fileTypes: [".ts"] } as never, "dyn-test");
  const anyClient = client as unknown as {
    process: { stdin: { write: (s: string) => number } } | null;
    handleRequest: (req: { id: unknown; method: string; params?: unknown }) => void;
  };
  anyClient.process = {
    stdin: {
      write: (s: string) => s.length,
    },
  };

  // No static diagnosticProvider, no dynamic registration → not supported.
  expect(client.supportsDocumentDiagnostics).toBe(false);

  anyClient.handleRequest({
    id: 1,
    method: "client/registerCapability",
    params: { registrations: [{ method: "textDocument/diagnostic" }] },
  });
  expect(client.supportsDocumentDiagnostics).toBe(true);

  anyClient.handleRequest({
    id: 2,
    method: "client/unregisterCapability",
    params: { unregistrations: [{ method: "textDocument/diagnostic" }] },
  });
  expect(client.supportsDocumentDiagnostics).toBe(false);
});

test("requestDiagnostic unwraps pull-model results and static diagnosticProvider enables it", async () => {
  const pullServer = `
    let buf = Buffer.alloc(0);
    function send(msg) {
      const body = Buffer.from(JSON.stringify(msg));
      process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
    }
    function onMessage(msg) {
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { diagnosticProvider: true }, serverInfo: { name: "pull-lsp", version: "1.0.0" } } });
      } else if (msg.method === "textDocument/diagnostic") {
        send({ jsonrpc: "2.0", id: msg.id, result: { items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "pulled-error" }] } });
      } else if (msg.method === "shutdown") {
        send({ jsonrpc: "2.0", id: msg.id, result: null });
      } else if (msg.method === "exit") {
        process.exit(0);
      }
    }
    process.stdin.on("data", (chunk) => { buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); pump(); });
    function pump() {
      while (true) {
        const headEnd = buf.indexOf("\\r\\n\\r\\n");
        if (headEnd === -1) break;
        const head = buf.slice(0, headEnd).toString("utf8");
        const m = /Content-Length: (\\d+)/.exec(head);
        if (!m) { buf = buf.slice(headEnd + 4); continue; }
        const len = Number(m[1]);
        if (buf.length < headEnd + 4 + len) break;
        const body = JSON.parse(buf.slice(headEnd + 4, headEnd + 4 + len).toString("utf8"));
        buf = buf.slice(headEnd + 4 + len);
        onMessage(body);
      }
    }
  `;
  const client = new LspClient(
    { command: process.execPath, args: ["-e", pullServer], fileTypes: [".ts"] } as any,
    "pull-lsp",
  );
  await client.initialize(process.cwd());
  try {
    expect(client.supportsDocumentDiagnostics).toBe(true);
    const diags = await client.requestDiagnostic("file:///repo/a.ts");
    expect(diags).toHaveLength(1);
    expect(diags![0]!.message).toBe("pulled-error");
  } finally {
    await client.shutdown();
  }
});

test("waitForDiagnostics drops stale publishes with an older version", async () => {
  const versionedServer = `
    let buf = Buffer.alloc(0);
    let saveUri = "";
    let savedVersion = 0;
    function send(msg) {
      const body = Buffer.from(JSON.stringify(msg));
      process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
    }
    function onMessage(msg) {
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {}, serverInfo: { name: "versioned-lsp", version: "1.0.0" } } });
      } else if (msg.method === "textDocument/didChange") {
        savedVersion = msg.params.textDocument.version;
      } else if (msg.method === "textDocument/didSave") {
        saveUri = msg.params.textDocument.uri;
        // A stale publish for the PREVIOUS version lands first, then the
        // fresh one for the current version — the client must skip the stale.
        setTimeout(() => {
          send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: saveUri, version: savedVersion - 1, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "stale-error" }] } });
        }, 20);
        setTimeout(() => {
          send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: saveUri, version: savedVersion, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "fresh-error" }] } });
        }, 60);
      } else if (msg.method === "shutdown") {
        send({ jsonrpc: "2.0", id: msg.id, result: null });
      } else if (msg.method === "exit") {
        process.exit(0);
      }
    }
    process.stdin.on("data", (chunk) => { buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); pump(); });
    function pump() {
      while (true) {
        const headEnd = buf.indexOf("\\r\\n\\r\\n");
        if (headEnd === -1) break;
        const head = buf.slice(0, headEnd).toString("utf8");
        const m = /Content-Length: (\\d+)/.exec(head);
        if (!m) { buf = buf.slice(headEnd + 4); continue; }
        const len = Number(m[1]);
        if (buf.length < headEnd + 4 + len) break;
        const body = JSON.parse(buf.slice(headEnd + 4, headEnd + 4 + len).toString("utf8"));
        buf = buf.slice(headEnd + 4 + len);
        onMessage(body);
      }
    }
  `;
  const client = new LspClient(
    { command: process.execPath, args: ["-e", versionedServer], fileTypes: [".ts"] } as any,
    "versioned-lsp",
  );
  await client.initialize(process.cwd());
  const uri = client.ensureOpen("/repo/a.ts", "const x = 1;\n", "typescript");
  try {
    client.didChange(uri, 2, "const x = 2;\n");
    client.didSave(uri);
    const diags = await client.waitForDiagnostics(uri, 3_000);
    expect(diags).not.toBeNull();
    const messages = diags!.map((d) => d.message);
    expect(messages).toContain("fresh-error");
    expect(messages).not.toContain("stale-error");
  } finally {
    await client.shutdown();
  }
});

test("abort sends $/cancelRequest and a short request timeout rejects", async () => {
  const logFile = join(tmpdir(), `pico-lsp-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const slowServer = `
    const fs = require("node:fs");
    let buf = Buffer.alloc(0);
    function send(msg) {
      const body = Buffer.from(JSON.stringify(msg));
      process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
    }
    function onMessage(msg) {
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { hoverProvider: true }, serverInfo: { name: "slow-lsp", version: "1.0.0" } } });
      } else if (msg.method === "textDocument/hover") {
        setTimeout(() => send({ jsonrpc: "2.0", id: msg.id, result: null }), 1500);
      } else if (msg.method === "shutdown") {
        send({ jsonrpc: "2.0", id: msg.id, result: null });
      } else if (msg.method === "exit") {
        process.exit(0);
      } else {
        fs.appendFileSync(process.env.PICO_TEST_LOG, msg.method + "\\n");
      }
    }
    process.stdin.on("data", (chunk) => { buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); pump(); });
    function pump() {
      while (true) {
        const headEnd = buf.indexOf("\\r\\n\\r\\n");
        if (headEnd === -1) break;
        const head = buf.slice(0, headEnd).toString("utf8");
        const m = /Content-Length: (\\d+)/.exec(head);
        if (!m) { buf = buf.slice(headEnd + 4); continue; }
        const len = Number(m[1]);
        if (buf.length < headEnd + 4 + len) break;
        const body = JSON.parse(buf.slice(headEnd + 4, headEnd + 4 + len).toString("utf8"));
        buf = buf.slice(headEnd + 4 + len);
        onMessage(body);
      }
    }
  `;
  const client = new LspClient(
    { command: process.execPath, args: ["-e", slowServer], fileTypes: [".ts"] } as any,
    "slow-lsp",
  );
  process.env.PICO_TEST_LOG = logFile;
  await client.initialize(process.cwd());
  const uri = "file:///repo/a.ts";
  try {
    // Per-request timeout: 200ms budget rejects fast instead of waiting 30s.
    const t0 = Date.now();
    await expect(client.textDocumentHover(uri, { line: 0, character: 0 }, undefined, 200)).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(1_500);

    // Abort path: the server must be told via $/cancelRequest.
    const ctrl = new AbortController();
    const pending = client.textDocumentHover(uri, { line: 0, character: 0 }, ctrl.signal);
    setTimeout(() => ctrl.abort(), 100);
    await expect(pending).rejects.toThrow(/aborted/);
    await new Promise((r) => setTimeout(r, 200));
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("$/cancelRequest");
  } finally {
    delete process.env.PICO_TEST_LOG;
    await client.shutdown();
    try { rmSync(logFile); } catch { }
  }
});

test("didChangeWatchedFiles notifies the server of on-disk changes", async () => {
  const logFile = join(tmpdir(), `pico-lsp-watch-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const recordingServer = `
    const fs = require("node:fs");
    let buf = Buffer.alloc(0);
    function send(msg) {
      const body = Buffer.from(JSON.stringify(msg));
      process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
    }
    function onMessage(msg) {
      fs.appendFileSync(process.env.PICO_TEST_LOG, JSON.stringify(msg) + "\\n");
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {}, serverInfo: { name: "record-lsp", version: "1.0.0" } } });
      } else if (msg.method === "shutdown") {
        send({ jsonrpc: "2.0", id: msg.id, result: null });
      } else if (msg.method === "exit") {
        process.exit(0);
      }
    }
    process.stdin.on("data", (chunk) => { buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); pump(); });
    function pump() {
      while (true) {
        const headEnd = buf.indexOf("\\r\\n\\r\\n");
        if (headEnd === -1) break;
        const head = buf.slice(0, headEnd).toString("utf8");
        const m = /Content-Length: (\\d+)/.exec(head);
        if (!m) { buf = buf.slice(headEnd + 4); continue; }
        const len = Number(m[1]);
        if (buf.length < headEnd + 4 + len) break;
        const body = JSON.parse(buf.slice(headEnd + 4, headEnd + 4 + len).toString("utf8"));
        buf = buf.slice(headEnd + 4 + len);
        onMessage(body);
      }
    }
  `;
  const client = new LspClient(
    { command: process.execPath, args: ["-e", recordingServer], fileTypes: [".ts"], settings: { ts: { enabled: true } } } as any,
    "record-lsp",
  );
  process.env.PICO_TEST_LOG = logFile;
  await client.initialize(process.cwd());
  try {
    client.didChangeWatchedFiles("file:///repo/a.ts", 2);
    await new Promise((r) => setTimeout(r, 200));
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("workspace/didChangeWatchedFiles");
    expect(log).toContain('"type":2');
    // The configured settings ride along in didChangeConfiguration.
    expect(log).toContain("workspace/didChangeConfiguration");
    expect(log).toContain('"settings":{"ts":{"enabled":true}}');
  } finally {
    delete process.env.PICO_TEST_LOG;
    await client.shutdown();
    try { rmSync(logFile); } catch { }
  }
});

test("guessLanguageId covers mts/cts/astro/jsonc via document sync", () => {
  const sessionDir = mkdtempSync(join(tmpdir(), "pico-lsp-langid-"));
  writeFileSync(join(sessionDir, "a.mts"), "export const x = 1;\n", "utf8");
  writeFileSync(join(sessionDir, "b.astro"), "---\n---\n", "utf8");
  writeFileSync(join(sessionDir, "c.jsonc"), "{ // comment\n}\n", "utf8");

  const opened: string[] = [];
  const state = createLspManager();
  state.servers.set("tsserver", {
    config: { fileTypes: [".mts", ".astro", ".jsonc"], isLinter: false },
    client: {
      ready: true,
      ensureOpen: (_path: string, _text: string, languageId: string) => {
        opened.push(languageId);
        return "file:///x";
      },
    },
    openDocuments: new Map(),
    lastActivity: Date.now(),
  } as any);

  try {
    syncDocument(state, sessionDir, "a.mts");
    syncDocument(state, sessionDir, "b.astro");
    syncDocument(state, sessionDir, "c.jsonc");
    expect(opened).toEqual(["typescript", "astro", "json"]);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("registered lsp tool schema exposes a timeout parameter", () => {
  let registered: any = null;
  const fakePi: any = {
    on: () => {},
    registerTool: (tool: any) => {
      registered = tool;
    },
  };
  lspExtension(fakePi);
  expect(registered.parameters.properties.timeout).toBeDefined();
  expect(registered.parameters.properties.timeout.description).toMatch(/seconds/);
});

// ---- server fallback on command-not-found (P1) ----------------------------

/** Minimal working LSP server: answers initialize/shutdown/exit. */
const MINI_LSP_SERVER = `
  function send(msg) {
    const body = Buffer.from(JSON.stringify(msg));
    process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
  }
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => { buf = Buffer.concat([buf, chunk]); pump(); });
  function pump() {
    while (true) {
      const headEnd = buf.indexOf("\\r\\n\\r\\n");
      if (headEnd === -1) return;
      const head = buf.slice(0, headEnd).toString("utf8");
      const m = /Content-Length: (\\d+)/.exec(head);
      if (!m) { buf = buf.slice(headEnd + 4); continue; }
      const len = Number(m[1]);
      if (buf.length < headEnd + 4 + len) return;
      const msg = JSON.parse(buf.slice(headEnd + 4, headEnd + 4 + len).toString("utf8"));
      buf = buf.slice(headEnd + 4 + len);
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {}, serverInfo: { name: "mini-lsp", version: "1.0.0" } } });
      } else if (msg.method === "shutdown") {
        send({ jsonrpc: "2.0", id: msg.id, result: null });
      } else if (msg.method === "exit") {
        process.exit(0);
      }
    }
  }
`;

test("ensureServer falls through to the next candidate when a binary is missing", async () => {
  const state = createLspManager();
  state.config = {
    servers: {
      "missing-cmd": {
        command: "pico-no-such-lsp-binary-xyz",
        args: [],
        fileTypes: [".ts"],
        rootMarkers: [],
      },
      "fake-ok": {
        command: process.execPath,
        args: ["-e", MINI_LSP_SERVER],
        fileTypes: [".ts"],
        rootMarkers: [],
      },
    },
    formatOnWrite: false,
  } as any;

  try {
    const client = await ensureServer(state, process.cwd());
    // The missing binary must not abort the search — the installed candidate
    // serves the file instead.
    expect(client).not.toBeNull();
    expect(client!.serverName).toBe("fake-ok");
    expect(state.servers.has("missing-cmd")).toBe(false);
    expect(state.servers.has("fake-ok")).toBe(true);
  } finally {
    await stopServer(state);
  }
});

test("ensureServer surfaces command-not-found when every candidate is missing", async () => {
  const state = createLspManager();
  state.config = {
    servers: {
      "missing-a": { command: "pico-no-such-a", args: [], fileTypes: [".ts"], rootMarkers: [] },
      "missing-b": { command: "pico-no-such-b", args: [], fileTypes: [".ts"], rootMarkers: [] },
    },
    formatOnWrite: false,
  } as any;

  let error: unknown;
  try {
    await ensureServer(state, process.cwd());
  } catch (err) {
    error = err;
  }
  // When NOTHING can start, the caller still needs the install offer — the
  // first missing command is rethrown (matches the old behavior).
  expect(error).toBeInstanceOf(LspError);
  expect((error as LspError).errorCode).toBe(COMMAND_NOT_FOUND);
});

describe("friendlyLspInitError", () => {
  test("collapses the TypeScript-not-installed init failure to an actionable hint", () => {
    const raw =
      'Request initialize failed with message: Could not find a valid TypeScript installation. ' +
      'Please ensure that the "typescript" dependency is installed in the workspace or that a valid `tsserver.path` is specified. Exiting.';
    const out = friendlyLspInitError("typescript-language-server", raw);
    expect(out).toContain("skipped: TypeScript not installed");
    expect(out).toContain("bun add -d typescript");
    expect(out).not.toContain("tsserver.path");
  });

  test("passes other init errors through unchanged", () => {
    const raw = "Request initialize failed with message: connection refused";
    expect(friendlyLspInitError("json-lsp", raw)).toBe(raw);
  });
});

describe("LSP config settings namespace", () => {
  test("loadConfig prefers the settings.json lsp namespace over the legacy file", () => {
    const oldHome = process.env.PICO_HOME;
    const home = mkdtempSync(join(tmpdir(), "pico-lsp-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "pico-lsp-ws-"));
    process.env.PICO_HOME = home;
    try {
      mkdirSync(join(home, "agent"), { recursive: true });
      writeFileSync(join(home, "lsp.json"), JSON.stringify({ formatOnWrite: true, idleTimeoutMs: 111 }));
      writeFileSync(join(home, "agent", "settings.json"), JSON.stringify({
        lsp: { formatOnWrite: false, idleTimeoutMs: 222 },
      }));
      const config = loadConfig(workspace);
      expect(config.formatOnWrite).toBe(false);
      expect(config.idleTimeoutMs).toBe(222);
    } finally {
      if (oldHome === undefined) delete process.env.PICO_HOME;
      else process.env.PICO_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
