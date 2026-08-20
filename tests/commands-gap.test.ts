/**
 * Command-handler gap tests.
 *
 * The primary suite covers 7 of 16 slash commands; these tests drive the
 * remaining 9 command handlers (vision, todo, language)
 * plus the session_before_switch / session_before_fork / session_tree event
 * handlers that no existing test reaches.
 *
 * Env isolation: PICO_HOME is redirected to a temp dir so settings.json
 * writes never touch the real data root.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { languageExtension, __resetLanguageCacheForTests } from "../src/extensions/language.ts";
import { createVisionExtension } from "../src/extensions/vision/index.ts";
import { todoExtension } from "../src/extensions/todo/index.ts";

const ORIG_PICO_HOME = process.env.PICO_HOME;
let testHome: string;
let projDir: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "pico-cmd-home-"));
  projDir = mkdtempSync(join(tmpdir(), "pico-cmd-proj-"));
  process.env.PICO_HOME = testHome;
  __resetLanguageCacheForTests();
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  if (ORIG_PICO_HOME === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = ORIG_PICO_HOME;
  __resetLanguageCacheForTests();
});

function makeFakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers: Record<string, Array<(event: any, ctx?: any) => any>> = {};
  const entries: Array<[string, unknown]> = [];
  return {
    tools,
    commands,
    handlers,
    entries,
    on: (event: string, handler: (event: any, ctx?: any) => unknown) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    registerShortcut: () => {},
    appendEntry: (key: string, value: unknown) => entries.push([key, value]),
    sendMessage: (_m: any) => {},
    sendUserMessage: () => {},
    getCommands: () => [],
    events: { emit: () => {}, subscribe: () => {}, unsubscribe: () => {} },
  };
}

function makeNotifyCtx(overrides: Record<string, unknown> = {}) {
  const notices: Array<{ msg: string; level: string }> = [];
  return {
    cwd: projDir,
    hasUI: true,
    notices,
    sessionManager: { getSessionId: () => "s1" },
    ui: {
      notify: (msg: string, level = "info") => notices.push({ msg, level }),
      setStatus: () => {},
      setWidget: () => {},
      setEditorComponent: () => {},
      setWorkingMessage: () => {},
      theme: { fg: () => (text: string) => text },
    },
    ...overrides,
  };
}

// ── /language ────────────────────────────────────────────────────────────

describe("/language command", () => {
  test("registers the language command", () => {
    const pi = makeFakePi();
    languageExtension(pi as any);
    expect(pi.commands.has("language")).toBe(true);
  });

  test("no argument reports the current language", async () => {
    const pi = makeFakePi();
    languageExtension(pi as any);
    const ctx = makeNotifyCtx();
    await pi.commands.get("language").handler("", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("Language: 简体中文");
  });

  test("set language persists to settings.json and updates the cache", async () => {
    mkdirSync(join(testHome, "agent"), { recursive: true });
    writeFileSync(join(testHome, "agent", "settings.json"), "{}");
    const pi = makeFakePi();
    languageExtension(pi as any);
    const ctx = makeNotifyCtx();

    await pi.commands.get("language").handler("English", ctx);
    expect(ctx.notices.at(-1)?.msg).toBe("Language set to: English");

    const settings = JSON.parse(readFileSync(join(testHome, "agent", "settings.json"), "utf8"));
    expect(settings.language).toBe("English");

    // The cache is updated immediately — the next turn sees the new language.
    const beforeAgentStart = pi.handlers["before_agent_start"]![0]!;
    const result = beforeAgentStart({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("English");
  });

  test("rejects languages longer than 64 chars or containing newlines", async () => {
    const pi = makeFakePi();
    languageExtension(pi as any);
    const ctx = makeNotifyCtx();

    await pi.commands.get("language").handler("x".repeat(65), ctx);
    expect(ctx.notices.at(-1)?.level).toBe("error");

    await pi.commands.get("language").handler("a\nb", ctx);
    expect(ctx.notices.at(-1)?.level).toBe("error");
  });

  test("refuses to write when settings.json is damaged", async () => {
    mkdirSync(join(testHome, "agent"), { recursive: true });
    writeFileSync(join(testHome, "agent", "settings.json"), "{broken json");
    const pi = makeFakePi();
    languageExtension(pi as any);
    const ctx = makeNotifyCtx();

    await pi.commands.get("language").handler("English", ctx);
    expect(ctx.notices.at(-1)?.level).toBe("error");
    expect(ctx.notices.at(-1)?.msg).toContain("损坏");
  });
});

// ── /vision ──────────────────────────────────────────────────────────────

describe("/vision command", () => {
  test("reports current model and auxiliary vision config", async () => {
    mkdirSync(join(testHome, "agent"), { recursive: true });
    writeFileSync(join(testHome, "agent", "settings.json"), JSON.stringify({
      auxiliary: { vision: { provider: "openai", model: "gpt-vision" } },
    }));
    const pi = makeFakePi();
    createVisionExtension({
      fetchImpl: fetch,
      complete: (async () => ({
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: "openai-completions",
        provider: "openai",
        model: "gpt-vision",
        usage: {},
        stopReason: "stop",
        timestamp: Date.now(),
      })) as any,
    })(pi as any);

    const ctx = makeNotifyCtx({
      model: { provider: "local", id: "text-only" },
    });
    await pi.commands.get("vision").handler("", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("pico vision");
    expect(ctx.notices.at(-1)?.msg).toContain("current model: local/text-only");
    expect(ctx.notices.at(-1)?.msg).toContain("auxiliary vision model: openai/gpt-vision");
  });

  test("flags warning level when no auxiliary vision is configured", async () => {
    const pi = makeFakePi();
    createVisionExtension({
      fetchImpl: fetch,
      complete: (async () => ({
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: "openai-completions",
        provider: "openai",
        model: "m",
        usage: {},
        stopReason: "stop",
        timestamp: Date.now(),
      })) as any,
    })(pi as any);

    const ctx = makeNotifyCtx({ model: { provider: "p", id: "m" } });
    await pi.commands.get("vision").handler("", ctx);
    expect(ctx.notices.at(-1)?.level).toBe("warning");
    expect(ctx.notices.at(-1)?.msg).toContain("(not configured)");
  });
});

// ── /todo ────────────────────────────────────────────────────────────────

describe("/todo command", () => {
  test("empty argument lists the session todos", async () => {
    const pi = makeFakePi();
    todoExtension(pi as any);
    const messages: any[] = [];
    pi.sendMessage = (m: any) => { messages.push(m); };
    const ctx = makeNotifyCtx();

    await pi.commands.get("todo").handler("", ctx);
    expect(messages).toHaveLength(1);
    expect(messages[0].customType).toBe("pico.todo");
    expect(messages[0].content).toContain("Session todos (0):");
  });

  test("clear drops the list", async () => {
    const pi = makeFakePi();
    todoExtension(pi as any);
    const messages: any[] = [];
    pi.sendMessage = (m: any) => { messages.push(m); };
    const ctx = makeNotifyCtx();

    await pi.commands.get("todo").handler("clear", ctx);
    expect(messages.at(-1)?.content).toContain("Todo list cleared.");
  });

  test("unknown subcommand shows usage", async () => {
    const pi = makeFakePi();
    todoExtension(pi as any);
    const messages: any[] = [];
    pi.sendMessage = (m: any) => { messages.push(m); };

    await pi.commands.get("todo").handler("bogus", makeNotifyCtx());
    expect(messages.at(-1)?.content).toContain("Usage:");
  });
});

// ── session_before_switch / session_before_fork / session_tree ────────────

describe("session lifecycle event handlers", () => {
  test("todo session_before_switch resets the list and unregisters the widget", async () => {
    const pi = makeFakePi();
    todoExtension(pi as any);
    const ctx = makeNotifyCtx();

    await pi.handlers["session_before_switch"]![0]!({}, ctx);
    const messages: any[] = [];
    pi.sendMessage = (m: any) => { messages.push(m); };
    await pi.commands.get("todo").handler("", ctx);
    expect(messages.at(-1)?.content).toContain("Session todos (0):");
  });

  test("todo session_before_fork resets the list and unregisters the widget", async () => {
    const pi = makeFakePi();
    todoExtension(pi as any);
    const ctx = makeNotifyCtx();

    await pi.handlers["session_before_fork"]![0]!({}, ctx);
    const messages: any[] = [];
    pi.sendMessage = (m: any) => { messages.push(m); };
    await pi.commands.get("todo").handler("", ctx);
    expect(messages.at(-1)?.content).toContain("Session todos (0):");
  });
});

// ── retro-theme event wiring: message_update / tool_execution_start/end ──

describe("retro-theme activity event wiring", () => {
  test("message_update, tool_execution_start and tool_execution_end are wired to the activity tracker", async () => {
    const { retroThemeExtension } = await import("../src/extensions/retro-theme/index.ts");
    const pi = makeFakePi();
    retroThemeExtension(pi as any);

    expect(pi.handlers["message_update"]).toBeDefined();
    expect(pi.handlers["tool_execution_start"]).toBeDefined();
    expect(pi.handlers["tool_execution_end"]).toBeDefined();
    expect(pi.handlers["turn_start"]).toBeDefined();
    expect(pi.handlers["agent_end"]).toBeDefined();

    // Driving the events must not throw with a real-ish ctx.
    const ctx = makeNotifyCtx();
    await pi.handlers["turn_start"]![0]!({}, ctx);
    await pi.handlers["message_update"]![0]!({}, ctx);
    await pi.handlers["tool_execution_start"]![0]!({ toolName: "bash" }, ctx);
    await pi.handlers["tool_execution_end"]![0]!({}, ctx);
    await pi.handlers["agent_end"]![0]!({}, ctx);
    await pi.handlers["session_shutdown"]![0]!({ type: "session_shutdown", reason: "quit" }, ctx);
  });

  test("failed-turn notification fires on agent_settled and clears on the next turn", async () => {
    const { retroThemeExtension } = await import("../src/extensions/retro-theme/index.ts");
    const pi = makeFakePi();
    retroThemeExtension(pi as any);

    const notices: Array<{ msg: string; level: string }> = [];
    const statuses: Array<[string, string | undefined]> = [];
    const ctx = {
      cwd: projDir,
      hasUI: true,
      ui: {
        notify: (msg: string, level = "info") => notices.push({ msg, level }),
        setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
      },
    };

    // turn_end with an error stopReason arms the failure
    await pi.handlers["turn_end"]![0]!(
      { message: { stopReason: "error", errorMessage: "provider 500" } },
      ctx,
    );
    await pi.handlers["agent_settled"]![0]!({}, ctx);
    expect(notices.at(-1)?.msg).toContain("任务失败");
    expect(statuses.at(-1)).toEqual(["pico.lastError", "!failed"]);

    // Next turn_start clears the marker (the second turn_start handler owns
    // the status row; the first drives the activity tracker).
    await pi.handlers["turn_start"]![1]!({}, ctx);
    expect(statuses.at(-1)).toEqual(["pico.lastError", undefined]);
  });

  test("aborted turns are not surfaced as failures", async () => {
    const { retroThemeExtension } = await import("../src/extensions/retro-theme/index.ts");
    const pi = makeFakePi();
    retroThemeExtension(pi as any);

    const notices: Array<{ msg: string; level: string }> = [];
    const ctx = {
      cwd: projDir,
      hasUI: true,
      ui: {
        notify: (msg: string, level = "info") => notices.push({ msg, level }),
        setStatus: () => {},
      },
    };

    await pi.handlers["turn_end"]![0]!(
      { message: { stopReason: "aborted", errorMessage: "Operation aborted" } },
      ctx,
    );
    await pi.handlers["agent_settled"]![0]!({}, ctx);
    expect(notices).toHaveLength(0);
  });
});

// ── memory session_before_compact event wiring ───────────────────────────

describe("memory session_before_compact event", () => {
  test("event handler returns a compaction contribution from archived user messages", async () => {
    const oldDb = process.env.PICO_MEMORY_DB;
    const tempDb = join(tmpdir(), `pico-mem-compact-${Date.now()}.db`);
    process.env.PICO_MEMORY_DB = tempDb;
    try {
      const { memoryExtension } = await import("../src/extensions/memory/index.ts");
      const { handlers, ...fakePi } = makeMemoryFakePi();
      memoryExtension(fakePi as any);

      await handlers["session_start"]![0]!({}, {
        cwd: projDir,
        sessionManager: { getSessionId: () => "compact-session" },
      });

      const result = await handlers["session_before_compact"]![0]!({
        branchEntries: [
          // Real upstream payload: SESSION entries ({type:'message',
          // message:{role,content}}) — not bare messages.
          { type: "message", message: { role: "user", content: "remember: we prefer bun over node" } },
          { type: "message", message: { role: "assistant", content: "noted" } },
        ],
        preparation: { firstKeptEntryId: "e1", tokensBefore: 1000 },
      });

      expect(result).toBeDefined();
      expect(result.compaction).toBeDefined();
      expect(result.compaction.firstKeptEntryId).toBe("e1");
      expect(result.compaction.tokensBefore).toBe(1000);
      expect(result.compaction.summary.length).toBeGreaterThan(0);

      await handlers["session_shutdown"]![0]!({ reason: "quit" }, { cwd: projDir });
    } finally {
      if (oldDb === undefined) delete process.env.PICO_MEMORY_DB;
      else process.env.PICO_MEMORY_DB = oldDb;
      try { rmSync(tempDb); } catch {}
      try { rmSync(`${tempDb}-wal`); } catch {}
      try { rmSync(`${tempDb}-shm`); } catch {}
    }
  });

  test("event handler is a no-op without preparation data", async () => {
    const oldDb = process.env.PICO_MEMORY_DB;
    const tempDb = join(tmpdir(), `pico-mem-compact-${Date.now()}.db`);
    process.env.PICO_MEMORY_DB = tempDb;
    try {
      const { memoryExtension } = await import("../src/extensions/memory/index.ts");
      const { handlers, ...fakePi } = makeMemoryFakePi();
      memoryExtension(fakePi as any);

      await handlers["session_start"]![0]!({}, {
        cwd: projDir,
        sessionManager: { getSessionId: () => "compact-session" },
      });

      const result = await handlers["session_before_compact"]![0]!({
        branchEntries: [{ role: "user", content: "remember this" }],
      });
      expect(result).toEqual({});

      await handlers["session_shutdown"]![0]!({ reason: "quit" }, { cwd: projDir });
    } finally {
      if (oldDb === undefined) delete process.env.PICO_MEMORY_DB;
      else process.env.PICO_MEMORY_DB = oldDb;
      try { rmSync(tempDb); } catch {}
      try { rmSync(`${tempDb}-wal`); } catch {}
      try { rmSync(`${tempDb}-shm`); } catch {}
    }
  });
});

// ── local helpers ─────────────────────────────────────────────────────────

function makeMemoryFakePi() {
  const handlers: Record<string, Array<(event: any, ctx?: any) => any>> = {};
  return {
    handlers,
    on: (event: string, handler: (event: any, ctx?: any) => any) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: () => {},
    registerCommand: () => {},
    sendMessage: () => {},
    subscribeExtensionEvent: () => {},
    publishExtensionEvent: () => {},
  };
}
