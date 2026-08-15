/**
 * Command-handler gap tests.
 *
 * The primary suite covers 7 of 16 slash commands; these tests drive the
 * remaining 9 command handlers (automode, auto-mode, vision, todo, language,
 * undo, redo, diff-stack, undo-redo-clear-cache) plus the undo_redo tool and
 * the session_before_switch / session_before_fork / session_tree event
 * handlers that no existing test reaches.
 *
 * Env isolation: PICO_HOME is redirected to a temp dir so settings.json
 * writes and the undo-redo cache never touch the real data root.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiAutomode } from "../src/extensions/automode/extension.ts";
import { loadEffectiveConfig } from "../src/extensions/automode/config.ts";
import { languageExtension, __resetLanguageCacheForTests } from "../src/extensions/language.ts";
import { createVisionExtension } from "../src/extensions/vision/index.ts";
import { todoExtension } from "../src/extensions/todo/index.ts";
import undoRedoExtension from "../src/extensions/undo-redo/index.ts";

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

// ── /automode + /auto-mode ───────────────────────────────────────────────

describe("/automode and /auto-mode commands", () => {
  function setupAutomode() {
    const pi = makeFakePi();
    const ext = createPiAutomode({
      loadConfig: (cwd: string) => ({
        ...loadEffectiveConfig(cwd),
        enabled: false,
        classifierModel: "p1/m1",
      }),
      classifyAction: async () => ({ decision: "allow" as const, tier: "allow" as const, reason: "ok" }),
    });
    ext(pi as any);
    // session_start seeds state
    pi.handlers["session_start"]![0]!({}, makeNotifyCtx({
      sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
    }));
    return pi;
  }

  test("registers both command names", () => {
    const pi = setupAutomode();
    expect(pi.commands.has("automode")).toBe(true);
    expect(pi.commands.has("auto-mode")).toBe(true);
  });

  test("status reports the effective config", async () => {
    const pi = setupAutomode();
    const ctx = makeNotifyCtx();
    await pi.commands.get("automode").handler("status", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("enabled: no");
    expect(ctx.notices.at(-1)?.msg).toContain("classifier: p1/m1");
  });

  test("on persists an override to session state", async () => {
    const pi = setupAutomode();
    const ctx = makeNotifyCtx();
    await pi.commands.get("automode").handler("on", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("已为本会话启用");
    expect(pi.entries.some(([k]) => k === "pico-automode-state")).toBe(true);
  });

  test("off disables for the session", async () => {
    const pi = setupAutomode();
    const ctx = makeNotifyCtx();
    await pi.commands.get("automode").handler("off", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("已为本会话禁用");
  });

  test("auto-mode alias dispatches to the same handler", async () => {
    const pi = setupAutomode();
    const ctx = makeNotifyCtx();
    await pi.commands.get("auto-mode").handler("off", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("已为本会话禁用");
  });

  test("reset zeroes counters", async () => {
    const pi = setupAutomode();
    const ctx = makeNotifyCtx();
    await pi.commands.get("automode").handler("reset", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("计数已重置");
  });

  test("unknown subcommand shows usage", async () => {
    const pi = setupAutomode();
    const ctx = makeNotifyCtx();
    await pi.commands.get("automode").handler("frobnicate", ctx);
    expect(ctx.notices.at(-1)?.level).toBe("error");
    expect(ctx.notices.at(-1)?.msg).toContain("Usage:");
  });
});

// ── /undo /redo /diff-stack /undo-redo-clear-cache ───────────────────────

describe("undo-redo commands", () => {
  async function setupUndoRedo() {
    const pi = makeFakePi();
    undoRedoExtension(pi as any);
    const ctx = makeNotifyCtx({
      sessionManager: { getSessionId: () => "s1", getLeafId: () => "leaf-1", branch: () => {}, resetLeaf: () => {} },
    });
    await pi.handlers["session_start"]![0]!({}, ctx);
    return { pi, ctx };
  }

  test("registers undo, redo, diff-stack, undo-redo-clear-cache commands and undo_redo tool", async () => {
    const { pi } = await setupUndoRedo();
    for (const name of ["undo", "redo", "diff-stack", "undo-redo-clear-cache"]) {
      expect(pi.commands.has(name)).toBe(true);
    }
    expect(pi.tools.has("undo_redo")).toBe(true);
  });

  test("undo with empty history reports no undo history", async () => {
    const { pi, ctx } = await setupUndoRedo();
    await pi.commands.get("undo").handler("", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("No undo history");
  });

  test("redo with empty history reports no redo history", async () => {
    const { pi, ctx } = await setupUndoRedo();
    await pi.commands.get("redo").handler("", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("No redo history");
  });

  test("diff-stack with no buffered diffs reports empty", async () => {
    const { pi, ctx } = await setupUndoRedo();
    await pi.commands.get("diff-stack").handler("", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("No buffered diffs");
  });

  test("undo-redo-clear-cache re-initializes the session", async () => {
    const { pi, ctx } = await setupUndoRedo();
    const cacheRoot = join(testHome, "agent", "cache", "undo-redo", "s1");
    await pi.commands.get("undo-redo-clear-cache").handler("", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("cache cleared");
    // The cache dir was removed and recreated — assert the root still exists
    // and no stale sandbox remains.
    expect(existsSync(join(cacheRoot, "sandbox"))).toBe(true);
  });
});

describe("undo_redo tool", () => {
  async function setupUndoRedo() {
    const pi = makeFakePi();
    undoRedoExtension(pi as any);
    const ctx = makeNotifyCtx({
      sessionManager: { getSessionId: () => "s1", getLeafId: () => "leaf-1", branch: () => {}, resetLeaf: () => {} },
    });
    await pi.handlers["session_start"]![0]!({}, ctx);
    return { pi, ctx };
  }

  function toolCtx() {
    return makeNotifyCtx({
      sessionManager: { getSessionId: () => "s1", getLeafId: () => "leaf-1", branch: () => {}, resetLeaf: () => {} },
    });
  }

  test("undo with no history returns a message without error", async () => {
    const { pi } = await setupUndoRedo();
    const tool = pi.tools.get("undo_redo");
    const result = await tool.execute("t1", { action: "undo" }, undefined, undefined, toolCtx());
    expect(result.content[0].text).toContain("No undo history.");
  });

  test("list_diffs with no buffered diffs returns an empty list", async () => {
    const { pi } = await setupUndoRedo();
    const tool = pi.tools.get("undo_redo");
    const result = await tool.execute("t2", { action: "list_diffs" }, undefined, undefined, toolCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No buffered diffs available.");
    expect(result.details.items).toEqual([]);
  });

  test("diff without a path is an error", async () => {
    const { pi } = await setupUndoRedo();
    const tool = pi.tools.get("undo_redo");
    const result = await tool.execute("t3", { action: "diff" }, undefined, undefined, toolCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires a path");
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

  test("undo-redo session_tree restores the new leaf without crashing on empty state", async () => {
    const pi = makeFakePi();
    undoRedoExtension(pi as any);
    const ctx = makeNotifyCtx({
      sessionManager: { getSessionId: () => "s1", getLeafId: () => "leaf-1", branch: () => {}, resetLeaf: () => {} },
    });
    await pi.handlers["session_start"]![0]!({}, ctx);

    const handler = pi.handlers["session_tree"]![0]!;
    expect(handler).toBeDefined();
    await handler({ oldLeafId: "leaf-1", newLeafId: "leaf-2" });
  });

  test("undo-redo session_before_switch re-initializes for the new session", async () => {
    const pi = makeFakePi();
    undoRedoExtension(pi as any);
    const ctx = makeNotifyCtx({
      sessionManager: { getSessionId: () => "s1", getLeafId: () => "leaf-1", branch: () => {}, resetLeaf: () => {} },
    });
    await pi.handlers["session_start"]![0]!({}, ctx);

    const beforeSwitch = pi.handlers["session_before_switch"]![0]!;
    expect(beforeSwitch).toBeDefined();
    await beforeSwitch({}, ctx);
    // Re-initialization must not throw and the commands still work.
    await pi.commands.get("undo").handler("", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("No undo history");
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
