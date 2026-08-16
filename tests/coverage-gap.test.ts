/**
 * Coverage-gap tests: dynamically exercise codegraph-indexed symbols that the
 * primary suite missed (see COVERAGE-CHECK.md for the gap list). Pure logic,
 * hand-rolled fakes only — matches repo conventions (no mock libraries).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── automode/model.ts: parseModelSpec / formatModelSpec ──────────────────
import { parseModelSpec, formatModelSpec } from "../src/extensions/automode/model.ts";

// ── automode/transcript.ts ───────────────────────────────────────────────
import {
  approximateTokenCount,
  buildClassifierTranscript,
  loadedContextFromSystemPromptOptions,
} from "../src/extensions/automode/transcript.ts";

// ── automode/config.ts / hard-deny.ts ────────────────────────────────────
import { writeGlobalClassifierModel } from "../src/extensions/automode/config.ts";
import { isRootHomeOrSystemPath } from "../src/extensions/automode/hard-deny.ts";

// ── automode/classifier.ts ───────────────────────────────────────────────
import {
  classifyInStages,
  classifyWithRetry,
  createClassifierCompletionPlan,
  parseClassifierDecision,
} from "../src/extensions/automode/classifier.ts";
import { createLogger, resolveLogPath } from "../src/extensions/automode/log.ts";

// ── web ──────────────────────────────────────────────────────────────────
import { formatFetchResult } from "../src/extensions/web/fetch.ts";
import { formatSearchResults } from "../src/extensions/web/search.ts";
import { renderWebSearchResult } from "../src/extensions/web/render.ts";

// ── subagent ─────────────────────────────────────────────────────────────
import { subagentChildEnv } from "../src/extensions/subagent/process.ts";
import { getWorktreeDiff } from "../src/extensions/subagent/worktree.ts";

// ── automode config validation ───────────────────────────────────────────
import { loadEffectiveConfigWithDiagnostics } from "../src/extensions/automode/config.ts";

// ── lsp ──────────────────────────────────────────────────────────────────
import { resolveFormattingOptions } from "../src/extensions/lsp/format-options.ts";
import {
  formatDiagnosticsForFile,
  formatDocumentSymbols,
  flattenDocumentSymbols,
  formatHoverResult,
  formatLocations,
} from "../src/extensions/lsp/manager.ts";
import { installServer } from "../src/extensions/lsp/install.ts";

// ── setup ────────────────────────────────────────────────────────────────
import { setupUsage, runSetupCommand } from "../src/setup/index.ts";
import { PassThrough } from "node:stream";

// ════ automode/model.ts ══════════════════════════════════════════════════

describe("automode model spec", () => {
  test("parseModelSpec splits provider/id", () => {
    expect(parseModelSpec("anthropic/claude-3")).toEqual({
      provider: "anthropic",
      id: "claude-3",
    });
  });

  test("parseModelSpec rejects malformed specs", () => {
    expect(parseModelSpec("no-slash")).toBeUndefined();
    expect(parseModelSpec("/leading")).toBeUndefined();
    expect(parseModelSpec("trailing/")).toBeUndefined();
    expect(parseModelSpec("")).toBeUndefined();
  });

  test("formatModelSpec renders provider/id", () => {
    expect(formatModelSpec({ provider: "openai", id: "gpt-4o" } as never)).toBe(
      "openai/gpt-4o",
    );
  });
});

// ════ automode/transcript.ts ═════════════════════════════════════════════

describe("automode transcript", () => {
  test("approximateTokenCount estimates tokens at 4 chars each", () => {
    expect(approximateTokenCount("")).toBe(0);
    expect(approximateTokenCount("abcd")).toBe(1);
    expect(approximateTokenCount("abcdefg")).toBe(2);
  });

  test("loadedContextFromSystemPromptOptions formats context files", () => {
    const out = loadedContextFromSystemPromptOptions({
      contextFiles: [
        { path: "a.md", content: "AAA" },
        { path: "b.md", content: "BBB" },
      ],
    });
    expect(out).toContain("# a.md");
    expect(out).toContain("AAA");
    expect(out).toContain("# b.md");
    expect(out).toContain("BBB");
  });

  test("loadedContextFromSystemPromptOptions tolerates junk input", () => {
    expect(loadedContextFromSystemPromptOptions(undefined)).toBe("");
    expect(loadedContextFromSystemPromptOptions(null)).toBe("");
    expect(loadedContextFromSystemPromptOptions({ contextFiles: "nope" })).toBe("");
  });

  test("buildClassifierTranscript flattens user + tool entries", () => {
    const ctx = {
      sessionManager: {
        buildContextEntries: () => [
          {
            type: "message",
            message: { role: "user", content: "hello there" },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", name: "bash", arguments: { cmd: "ls" } },
              ],
            },
          },
          { type: "other", message: {} },
        ],
      },
    } as never;
    const out = buildClassifierTranscript(ctx as never, {
      maxUserTokens: 1000,
      maxToolTokens: 1000,
    });
    expect(out).toContain("hello there");
    expect(out).toContain("bash");
  });
});

// ════ automode/config.ts / hard-deny.ts ══════════════════════════════════

describe("automode config write & hard-deny path guard", () => {
  test("writeGlobalClassifierModel persists while preserving other settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-gap-cfg-"));
    try {
      const path = join(dir, "automode.json");
      writeFileSync(path, JSON.stringify({ autoMode: { enabled: true } }));
      writeGlobalClassifierModel("openai/gpt-4o", path);
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        autoMode: { enabled: boolean; classifierModel: string };
      };
      expect(parsed.autoMode.enabled).toBe(true);
      expect(parsed.autoMode.classifierModel).toBe("openai/gpt-4o");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("isRootHomeOrSystemPath treats /usr,/etc as system; ~/ as safe", () => {
    const home = "/home/u";
    expect(isRootHomeOrSystemPath("/etc/passwd", home)).toBe(true);
    expect(isRootHomeOrSystemPath("/usr/bin", home)).toBe(true);
    expect(isRootHomeOrSystemPath("/home/u/proj", home)).toBe(false);
    expect(isRootHomeOrSystemPath("/home/u", home)).toBe(true);
  });
});

// ════ automode/classifier.ts ═════════════════════════════════════════════

describe("automode classifier", () => {
  test("createClassifierCompletionPlan defaults to raw complete", () => {
    const plan = createClassifierCompletionPlan({} as never, undefined);
    expect(plan.reasoning.mode).toBe("server-default");
    expect(plan.completeFn).toBeDefined();
  });

  test("createClassifierCompletionPlan maps explicit level to simple complete", () => {
    const plan = createClassifierCompletionPlan({} as never, "low");
    expect(plan.reasoning.mode).toBe("explicit");
    expect(
      (plan.reasoning as { requestedLevel?: unknown }).requestedLevel,
    ).toBe("low");
  });

  test("parseClassifierDecision accepts a valid decision", () => {
    const message = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            decision: "allow",
            tier: "explicit_intent",
            reason: "user asked for it",
          }),
        },
      ],
    } as never;
    expect(parseClassifierDecision(message)).toEqual({
      decision: "allow",
      tier: "explicit_intent",
      reason: "user asked for it",
    });
  });

  test("parseClassifierDecision rejects malformed payloads", () => {
    const base = (text: string) => ({ content: [{ type: "text", text }] });
    // missing keys
    expect(parseClassifierDecision(base('{"decision":"allow"}') as never)).toBeUndefined();
    // invalid tier/decision pairing
    expect(
      parseClassifierDecision(
        base(
          JSON.stringify({ decision: "block", tier: "allow", reason: "x" }),
        ) as never,
      ),
    ).toBeUndefined();
    // invalid JSON
    expect(parseClassifierDecision(base("{oops") as never)).toBeUndefined();
    // empty reason
    expect(
      parseClassifierDecision(
        base(
          JSON.stringify({ decision: "block", tier: "soft_deny", reason: "  " }),
        ) as never,
      ),
    ).toBeUndefined();
  });

  test("classifyWithRetry returns decision and records attempts", async () => {
    const attempts: Array<{ attempt: number }> = [];
    const decision = await classifyWithRetry(
      async () => ({
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              decision: "allow",
              tier: "allow",
              reason: "safe",
            }),
          },
        ],
      }) as never,
      { model: {} } as never,
      { systemPrompt: "s", messages: [] } as never,
      undefined,
      { onAttempt: (a: { attempt: number }) => attempts.push(a) } as never,
    );
    expect(decision.decision).toBe("allow");
    expect(attempts.length).toBeGreaterThan(0);
  });

  test("classifyWithRetry fails closed on invalid responses", async () => {
    const decision = await classifyWithRetry(
      async () => ({ stopReason: "stop", content: [{ type: "text", text: "garbage" }] }) as never,
      { model: {} } as never,
      { systemPrompt: "s", messages: [] } as never,
      undefined,
      { maxAttempts: 1 },
    );
    expect(decision.decision).toBe("block");
  });

  test("classifyInStages fast+detailed path returns final decision", async () => {
    const decision = await classifyInStages(
      async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "0" }],
      }) as never,
      { model: {} } as never,
      { systemPrompt: "s", contextMessage: { role: "user", content: "c" } } as never,
      undefined,
      { sessionId: "s1" } as never,
    );
    expect(decision.decision).toBe("allow");
  });

  test("classifyInStages fast '1' escalates to detailed retry", async () => {
    const calls: string[] = [];
    const decision = await classifyInStages(
      async () => {
        calls.push("call");
        // fast: "1" (risk) → detailed parse of this JSON must succeed
        return {
          stopReason: "stop",
          content: [
            {
              type: "text",
              text:
                calls.length === 1
                  ? "1"
                  : JSON.stringify({
                      decision: "block",
                      tier: "soft_deny",
                      reason: "needs review",
                    }),
            },
          ],
        } as never;
      },
      { model: {} } as never,
      { systemPrompt: "s", contextMessage: { role: "user", content: "c" } } as never,
      undefined,
      { sessionId: "s1" } as never,
    );
    expect(calls.length).toBeGreaterThan(1);
    expect(decision.decision).toBe("block");
    expect(decision.tier).toBe("soft_deny");
  });

  test("createLogger append writes JSONL only when enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-gap-log-"));
    try {
      const resolved = resolveLogPath(undefined, dir, "s1");
      const logger = createLogger({
        enabled: true,
        classifierIo: true,
        sessionDir: dir,
        sessionId: "s1",
      });
      logger.append({ type: "decision", decisionId: "d1" } as never);
      const content = readFileSync(resolved, "utf8");
      expect(content).toContain("d1");
      // disabled logger writes nothing
      const off = createLogger({
        enabled: false,
        classifierIo: false,
        sessionDir: dir,
        sessionId: "s1",
      });
      off.append({ type: "decision", decisionId: "d2" } as never);
      expect(readFileSync(resolved, "utf8")).not.toContain("d2");
      // classifierIo=false drops classifier entries
      const noIo = createLogger({
        enabled: true,
        classifierIo: false,
        sessionDir: dir,
        sessionId: "s1",
      });
      noIo.append({ type: "classifier", decisionId: "d3" } as never);
      expect(readFileSync(resolved, "utf8")).not.toContain("d3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ════ web ════════════════════════════════════════════════════════════════

describe("web formatting", () => {
  test("formatFetchResult renders url/status/content", () => {
    const out = formatFetchResult(
      {
        url: "https://example.com",
        status: 200,
        statusText: "OK",
        contentType: "text/html",
        markdown: "# Hi",
        truncated: false,
      } as never,
      "what is this",
    );
    expect(out).toContain("URL: https://example.com");
    expect(out).toContain("Status: 200 OK");
    expect(out).toContain("Prompt: what is this");
    expect(out).toContain("# Hi");
  });

  test("formatFetchResult marks truncation", () => {
    const out = formatFetchResult(
      {
        url: "https://e.com",
        status: 200,
        statusText: "OK",
        markdown: "x",
        truncated: true,
      } as never,
      undefined,
    );
    expect(out).toContain("Truncated to");
  });

  test("formatSearchResults formats and empty case", () => {
    expect(formatSearchResults("pico", [])).toBe('No results for "pico".');
    const out = formatSearchResults("pico", [
      { title: "T1", url: "https://a", snippet: "S1" },
    ]);
    expect(out).toContain("Search: pico");
    expect(out).toContain("1. T1");
    expect(out).toContain("https://a");
    expect(out).toContain("S1");
  });

  test("renderWebSearchResult sets text via theme", () => {
    let lastText = "";
    const text = {
      setText: (t: string) => {
        lastText = t;
      },
    };
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
      dim: (t: string) => t,
    };
    renderWebSearchResult(
      {
        content: [{ type: "text", text: "Search: pico\nResults: 0" }],
      } as never,
      { expanded: false, isPartial: false } as never,
      theme as never,
      { lastComponent: text, isError: false },
    );
    expect(lastText).toContain("Search: pico");
  });
});

// ════ subagent ═══════════════════════════════════════════════════════════

describe("subagent process/worktree", () => {
  test("subagentChildEnv bumps depth and inherits env", () => {
    const prev = process.env.PICO_SUBAGENT_DEPTH;
    process.env.PICO_SUBAGENT_DEPTH = "2";
    try {
      const env = subagentChildEnv();
      expect(env.PICO_SUBAGENT_DEPTH).toBe("3");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      if (prev === undefined) delete process.env.PICO_SUBAGENT_DEPTH;
      else process.env.PICO_SUBAGENT_DEPTH = prev;
    }
  });

  test("subagentChildEnv clamps invalid depth", () => {
    const prev = process.env.PICO_SUBAGENT_DEPTH;
    process.env.PICO_SUBAGENT_DEPTH = "abc";
    try {
      expect(subagentChildEnv().PICO_SUBAGENT_DEPTH).toBe("1");
    } finally {
      if (prev === undefined) delete process.env.PICO_SUBAGENT_DEPTH;
      else process.env.PICO_SUBAGENT_DEPTH = prev;
    }
  });

  test("getWorktreeDiff returns diff stat or fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-gap-git-"));
    try {
      const { execSync } = await import("node:child_process");
      execSync("git init -q", { cwd: dir });
      execSync('git config user.email t@t.t && git config user.name t', { cwd: dir });
      writeFileSync(join(dir, "f.txt"), "one");
      execSync("git add f.txt && git commit -qm init", { cwd: dir });
      writeFileSync(join(dir, "f.txt"), "two");
      execSync("git add f.txt && git commit -qm second", { cwd: dir });
      const out = await getWorktreeDiff(dir, "main");
      expect(typeof out).toBe("string");
      // missing branch → fallback message
      const missing = await getWorktreeDiff(dir, "no-such-branch");
      expect(missing).toBe("(unable to get diff)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ════ automode config validation ═════════════════════════════════════════

describe("automode config validation", () => {
  function loadWith(settings: unknown): string[] {
    const prev = process.env.PICO_AUTOMODE_SETTINGS_JSON;
    process.env.PICO_AUTOMODE_SETTINGS_JSON = JSON.stringify(settings);
    try {
      return loadEffectiveConfigWithDiagnostics("/tmp/gap-cwd").diagnostics;
    } finally {
      if (prev === undefined) delete process.env.PICO_AUTOMODE_SETTINGS_JSON;
      else process.env.PICO_AUTOMODE_SETTINGS_JSON = prev;
    }
  }

  test("validateLogSetting rejects non-object log", () => {
    const diagnostics = loadWith({ autoMode: { log: "yes" } });
    expect(diagnostics.some((d) => d.includes("log must be an object"))).toBe(true);
  });

  test("validateLogSetting rejects non-boolean enabled", () => {
    const diagnostics = loadWith({ autoMode: { log: { enabled: "yes" } } });
    expect(diagnostics.some((d) => d.includes("log.enabled must be a boolean"))).toBe(true);
  });

  test("validateLogSetting rejects non-boolean classifierIo", () => {
    const diagnostics = loadWith({
      autoMode: { log: { enabled: true, classifierIo: "yes" } },
    });
    expect(diagnostics.some((d) => d.includes("log.classifierIo must be a boolean"))).toBe(true);
  });

  test("validateLogSetting accepts valid log config", () => {
    const diagnostics = loadWith({
      autoMode: { log: { enabled: true, classifierIo: false } },
    });
    expect(diagnostics.some((d) => d.includes("log"))).toBe(false);
  });
});

// ════ lsp ════════════════════════════════════════════════════════════════

describe("lsp formatting & config resolution", () => {
  test("resolveFormattingOptions honors .editorconfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-gap-ec-"));
    try {
      writeFileSync(
        join(dir, ".editorconfig"),
        "[*.ts]\nindent_size = 4\nindent_style = space\ninsert_final_newline = true\n",
      );
      const opts = resolveFormattingOptions(join(dir, "a.ts"));
      expect(opts.tabSize).toBe(4);
      expect(opts.insertSpaces).toBe(true);
      expect(opts.insertFinalNewline).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolveFormattingOptions sniffs content when no editorconfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-gap-ec2-"));
    try {
      writeFileSync(join(dir, "a.ts"), "  x\n  y\n");
      const opts = resolveFormattingOptions(join(dir, "a.ts"));
      expect(opts.insertSpaces).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("formatHoverResult covers all shapes", () => {
    expect(formatHoverResult(null)).toBe("No hover information available.");
    expect(formatHoverResult({ contents: "plain" } as never)).toBe("plain");
    expect(
      formatHoverResult({ contents: ["a", { language: "ts", value: "code" }] } as never),
    ).toContain("```ts");
    expect(
      formatHoverResult({ contents: { kind: "markdown", value: "**md**" } } as never),
    ).toBe("**md**");
  });

  test("formatLocations renders locations", () => {
    expect(formatLocations(null, "refs")).toBe("No refs found.");
    expect(formatLocations([], "refs")).toBe("No refs found.");
    const out = formatLocations(
      [
        {
          uri: "file:///a.ts",
          range: {
            start: { line: 1, character: 2 },
            end: { line: 1, character: 5 },
          },
        },
      ],
      "refs",
    );
    expect(out).toContain("Found 1 refs");
    expect(out).toContain("a.ts");
  });

  test("formatDiagnosticsForFile renders messages", () => {
    const out = formatDiagnosticsForFile(
      "a.ts",
      [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          severity: 1,
          message: "boom",
        },
      ],
    );
    expect(out).toContain("a.ts");
    expect(out).toContain("boom");
  });

  test("flattenDocumentSymbols + formatDocumentSymbols roundtrip", () => {
    const flat = flattenDocumentSymbols([
      {
        name: "Foo",
        kind: 6,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 2, character: 0 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 3 },
        },
        children: [],
      } as never,
    ]);
    expect(flat).toHaveLength(1);
    const text = formatDocumentSymbols(flat);
    expect(text).toContain("Foo");
  });

  test("installServer returns hint error for unknown command", async () => {
    const out = await installServer("no-such-lsp-xyz");
    expect(out.ok).toBe(false);
    expect(out.output).toContain("No known install command");
  });
});

// ════ lsp client RPC 方法 ════════════════════════════════════════════════

describe("lsp client request methods", () => {
  async function clientWithFakeProcess() {
    const { LspClient } = await import("../src/extensions/lsp/client.ts");
    const client = new LspClient(
      { command: "unused", args: [], fileTypes: [".ts"] } as never,
      "gap-lsp-client",
    );
    const frames: string[] = [];
    const anyClient = client as unknown as {
      process: { stdin: { write: (s: string) => number } } | null;
      handleResponse: (resp: {
        id: number;
        result?: unknown;
        error?: { code: number; message: string };
      }) => void;
    };
    anyClient.process = {
      stdin: {
        write: (s: string) => {
          frames.push(s);
          return s.length;
        },
      },
    };
    return { client, anyClient, frames };
  }

  function extractMethod(frame: string): string {
    const body = frame.slice(frame.indexOf("\r\n\r\n") + 4);
    return (JSON.parse(body) as { method: string }).method;
  }

  test("textDocumentDefinition sends textDocument/definition", async () => {
    const { client, anyClient, frames } = await clientWithFakeProcess();
    const p = client.textDocumentDefinition("file:///a.ts", {
      line: 1,
      character: 2,
    });
    expect(extractMethod(frames[0]!)).toBe("textDocument/definition");
    const id = (JSON.parse(frames[0]!.slice(frames[0]!.indexOf("\r\n\r\n") + 4)) as { id: number }).id;
    anyClient.handleResponse({ id, result: null });
    expect(await p).toBeNull();
  });

  test("textDocumentTypeDefinition sends typeDefinition", async () => {
    const { client, anyClient, frames } = await clientWithFakeProcess();
    const p = client.textDocumentTypeDefinition("file:///a.ts", {
      line: 0,
      character: 0,
    });
    expect(extractMethod(frames[0]!)).toBe("textDocument/typeDefinition");
    const id = (JSON.parse(frames[0]!.slice(frames[0]!.indexOf("\r\n\r\n") + 4)) as { id: number }).id;
    anyClient.handleResponse({ id, result: null });
    expect(await p).toBeNull();
  });

  test("textDocumentImplementation sends implementation", async () => {
    const { client, anyClient, frames } = await clientWithFakeProcess();
    const p = client.textDocumentImplementation("file:///a.ts", {
      line: 0,
      character: 0,
    });
    expect(extractMethod(frames[0]!)).toBe("textDocument/implementation");
    const id = (JSON.parse(frames[0]!.slice(frames[0]!.indexOf("\r\n\r\n") + 4)) as { id: number }).id;
    anyClient.handleResponse({ id, result: null });
    expect(await p).toBeNull();
  });

  test("textDocumentReferences sends references", async () => {
    const { client, anyClient, frames } = await clientWithFakeProcess();
    const p = client.textDocumentReferences("file:///a.ts", {
      line: 0,
      character: 0,
    });
    expect(extractMethod(frames[0]!)).toBe("textDocument/references");
    const id = (JSON.parse(frames[0]!.slice(frames[0]!.indexOf("\r\n\r\n") + 4)) as { id: number }).id;
    anyClient.handleResponse({ id, result: [] });
    expect(await p).toEqual([]);
  });

  test("textDocumentDocumentSymbol sends documentSymbol", async () => {
    const { client, anyClient, frames } = await clientWithFakeProcess();
    const p = client.textDocumentDocumentSymbol("file:///a.ts");
    expect(extractMethod(frames[0]!)).toBe("textDocument/documentSymbol");
    const id = (JSON.parse(frames[0]!.slice(frames[0]!.indexOf("\r\n\r\n") + 4)) as { id: number }).id;
    anyClient.handleResponse({ id, result: [] });
    expect(await p).toEqual([]);
  });

  test("workspaceSymbol sends workspace/symbol", async () => {
    const { client, anyClient, frames } = await clientWithFakeProcess();
    const p = client.workspaceSymbol("Foo");
    expect(extractMethod(frames[0]!)).toBe("workspace/symbol");
    const id = (JSON.parse(frames[0]!.slice(frames[0]!.indexOf("\r\n\r\n") + 4)) as { id: number }).id;
    anyClient.handleResponse({ id, result: [] });
    expect(await p).toEqual([]);
  });

  test("textDocumentCodeAction sends codeAction", async () => {
    const { client, anyClient, frames } = await clientWithFakeProcess();
    const p = client.textDocumentCodeAction("file:///a.ts", {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    }, { diagnostics: [] });
    expect(extractMethod(frames[0]!)).toBe("textDocument/codeAction");
    const id = (JSON.parse(frames[0]!.slice(frames[0]!.indexOf("\r\n\r\n") + 4)) as { id: number }).id;
    anyClient.handleResponse({ id, result: [] });
    expect(await p).toEqual([]);
  });

  test("codeActionResolve sends codeAction/resolve", async () => {
    const { client, anyClient, frames } = await clientWithFakeProcess();
    const p = client.codeActionResolve({ title: "fix" } as never);
    expect(extractMethod(frames[0]!)).toBe("codeAction/resolve");
    const id = (JSON.parse(frames[0]!.slice(frames[0]!.indexOf("\r\n\r\n") + 4)) as { id: number }).id;
    anyClient.handleResponse({ id, result: { title: "fix" } });
    expect(await p).toEqual({ title: "fix" });
  });

  test("textDocumentRename sends rename", async () => {
    const { client, anyClient, frames } = await clientWithFakeProcess();
    const p = client.textDocumentRename("file:///a.ts", {
      line: 0,
      character: 0,
    }, "NewName");
    expect(extractMethod(frames[0]!)).toBe("textDocument/rename");
    const id = (JSON.parse(frames[0]!.slice(frames[0]!.indexOf("\r\n\r\n") + 4)) as { id: number }).id;
    anyClient.handleResponse({ id, result: null });
    expect(await p).toBeNull();
  });

  test("workspaceWillRenameFiles sends workspace/willRenameFiles", async () => {
    const { client, anyClient, frames } = await clientWithFakeProcess();
    const p = client.workspaceWillRenameFiles([{ oldUri: "a", newUri: "b" }]);
    expect(extractMethod(frames[0]!)).toBe("workspace/willRenameFiles");
    const id = (JSON.parse(frames[0]!.slice(frames[0]!.indexOf("\r\n\r\n") + 4)) as { id: number }).id;
    anyClient.handleResponse({ id, result: null });
    expect(await p).toBeNull();
  });

  test("workspaceDidRenameFiles sends workspace/didRenameFiles", async () => {
    const { client, frames } = await clientWithFakeProcess();
    client.workspaceDidRenameFiles([{ oldUri: "a", newUri: "b" }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(extractMethod(frames[0]!)).toBe("workspace/didRenameFiles");
  });
});

// ── cache-optimizer ──────────────────────────────────────────────────────
import { cacheOptimizerExtension } from "../src/extensions/cache-optimizer/index.ts";

// ════ cache-optimizer env paths ══════════════════════════════════════════

describe("cache-optimizer env switches", () => {
  function makePi() {
    const handlers: Record<string, Array<(e: unknown, ctx: unknown) => unknown>> = {};
    return {
      handlers,
      on: (ev: string, h: (e: unknown, ctx: unknown) => unknown) => {
        (handlers[ev] ??= []).push(h);
      },
      registerTool: () => {},
      registerCommand: () => {},
    };
  }

  test("NO_PROMPT_REWRITE env bypasses before_agent_start rewrite", () => {
    const prev = process.env.PICO_CACHE_OPTIMIZER_NO_PROMPT_REWRITE;
    process.env.PICO_CACHE_OPTIMIZER_NO_PROMPT_REWRITE = "1";
    try {
      const pi = makePi();
      cacheOptimizerExtension(pi as never);
      const result = pi.handlers.before_agent_start?.[0]!(
        { systemPrompt: "original prompt", systemPromptOptions: {} },
        { model: { api: "openai-responses" } },
      );
      expect(result).toEqual({});
    } finally {
      if (prev === undefined) delete process.env.PICO_CACHE_OPTIMIZER_NO_PROMPT_REWRITE;
      else process.env.PICO_CACHE_OPTIMIZER_NO_PROMPT_REWRITE = prev;
    }
  });

  test("openai-responses model bypasses rewrite (shouldBypassPromptRewrite)", () => {
    const prev = process.env.PICO_CACHE_OPTIMIZER_NO_PROMPT_REWRITE;
    delete process.env.PICO_CACHE_OPTIMIZER_NO_PROMPT_REWRITE;
    try {
      const pi = makePi();
      cacheOptimizerExtension(pi as never);
      const result = pi.handlers.before_agent_start?.[0]!(
        { systemPrompt: "x", systemPromptOptions: {} },
        { model: { api: "openai-responses" } },
      );
      expect(result).toEqual({});
    } finally {
      if (prev === undefined) delete process.env.PICO_CACHE_OPTIMIZER_NO_PROMPT_REWRITE;
      else process.env.PICO_CACHE_OPTIMIZER_NO_PROMPT_REWRITE = prev;
    }
  });
});

// ════ setup ══════════════════════════════════════════════════════════════

describe("setup helpers", () => {
  test("setupUsage lists sections", () => {
    const usage = setupUsage();
    expect(usage).toContain("pico setup");
    expect(usage).toContain("model");
    expect(usage).toContain("--non-interactive");
  });

  test("runSetupCommand interactive path drives ReadlinePrompter", async () => {
    const prevHome = process.env.PICO_HOME;
    const home = mkdtempSync(join(tmpdir(), "pico-gap-setup-"));
    process.env.PICO_HOME = home;
    try {
      const input = new PassThrough() as PassThrough & { isTTY: boolean };
      input.isTTY = true;
      const output = new PassThrough() as PassThrough & { isTTY: boolean };
      output.isTTY = true;
      let outText = "";
      output.on("data", (c: Buffer) => {
        outText += c.toString("utf-8");
      });
      // 3 Enter keys: language choice, provider choice, default-model text,
      // then API-key secret skipped by empty input.
      const run = runSetupCommand(
        { section: "model", nonInteractive: false } as never,
        { input, output },
      );
      for (let i = 1; i <= 4; i++) {
        setTimeout(() => input.write("\r"), i * 100);
      }
      const code = await run;
      expect(code).toBe(0);
      expect(outText).toContain("pico 设置完成");
    } finally {
      if (prevHome === undefined) delete process.env.PICO_HOME;
      else process.env.PICO_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
