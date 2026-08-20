/**
 * Coverage-gap tests: dynamically exercise codegraph-indexed symbols that the
 * primary suite missed (see COVERAGE-CHECK.md for the gap list). Pure logic,
 * hand-rolled fakes only — matches repo conventions (no mock libraries).
 */
import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── web ──────────────────────────────────────────────────────────────────
import { formatFetchResult } from "../src/extensions/web/fetch.ts";
import { formatSearchResults } from "../src/extensions/web/search.ts";
import { renderWebSearchResult } from "../src/extensions/web/render.ts";

// ── subagent ─────────────────────────────────────────────────────────────
import { subagentChildEnv } from "../src/extensions/subagent/process.ts";
import { getWorktreeDiff } from "../src/extensions/subagent/worktree.ts";

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
