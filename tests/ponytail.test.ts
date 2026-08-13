import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  parsePonytailCommand,
  ponytailExtension,
  readDefaultMode,
  resolveSessionMode,
} from "../src/extensions/ponytail/index.ts";
import {
  __resetPonytailSkillCacheForTests,
  getPonytailInstructions,
} from "../src/extensions/ponytail/instructions.ts";

type Handler = (event: any, ctx: any) => any;

function makeFakePi() {
  const handlers: Record<string, Handler[]> = {};
  const commands = new Map<string, { description: string; handler: Handler }>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const sentUserMessages: Array<{ text: string; options?: unknown }> = [];
  return {
    handlers,
    commands,
    appendedEntries,
    sentUserMessages,
    on: (event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand: (name: string, options: { description: string; handler: Handler }) => {
      commands.set(name, options);
    },
    appendEntry: (customType: string, data: unknown) => {
      appendedEntries.push({ customType, data });
    },
    sendUserMessage: (text: string, options?: unknown) => {
      sentUserMessages.push({ text, options });
    },
  };
}

function makeCommandContext(overrides: Record<string, unknown> = {}) {
  return {
    isIdle: () => true,
    sessionManager: { getEntries: () => [] },
    ui: { notify() {} },
    ...overrides,
  } as any;
}

const savedEnv = { ...process.env };

beforeEach(() => {
  for (const key of [
    "PONYTAIL_DEFAULT_MODE",
    "PONYTAIL_QUIET_STARTUP",
    "PONYTAIL_HIDE_STATUS",
    "PICO_HOME",
  ]) {
    delete process.env[key];
  }
  __resetPonytailSkillCacheForTests();
  const tmp = mkdtempSync(join(tmpdir(), "pico-ponytail-test-"));
  process.env.PICO_HOME = tmp;
});

afterEach(() => {
  __resetPonytailSkillCacheForTests();
  const home = process.env.PICO_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

test("extension registers Ponytail commands", () => {
  const pi = makeFakePi();
  ponytailExtension(pi as any);

  expect([...pi.commands.keys()].sort()).toEqual([
    "ponytail",
    "ponytail-audit",
    "ponytail-debt",
    "ponytail-gain",
    "ponytail-help",
    "ponytail-review",
  ]);
});

test("/ponytail updates session mode and injects instructions", async () => {
  const pi = makeFakePi();
  ponytailExtension(pi as any);
  const ctx = makeCommandContext();

  await pi.handlers.session_start![0]!({ reason: "startup" }, ctx);
  await pi.commands.get("ponytail")!.handler("ultra", ctx);

  expect(pi.appendedEntries.at(-1)).toEqual({ customType: "ponytail-mode", data: { mode: "ultra" } });

  const result = await pi.handlers.before_agent_start![0]!({ systemPrompt: "BASE" }, ctx);
  expect(result.systemPrompt).toContain("PONYTAIL MODE ACTIVE");
  expect(result.systemPrompt).toContain("ultra");
});

test("before_agent_start guards missing event and missing systemPrompt", async () => {
  const pi = makeFakePi();
  ponytailExtension(pi as any);
  const ctx = makeCommandContext();
  await pi.handlers.session_start![0]!({ reason: "startup" }, ctx); // currentMode -> default (full)

  // #439: a null/undefined event must not crash, and still injects the ruleset.
  for (const bad of [undefined, null]) {
    const r = await pi.handlers.before_agent_start![0]!(bad, ctx);
    expect(r.systemPrompt).toContain("PONYTAIL MODE ACTIVE");
    expect(r.systemPrompt).not.toContain("undefined");
  }

  // #440: an event without a systemPrompt must not prepend the literal "undefined".
  const empty = await pi.handlers.before_agent_start![0]!({}, ctx);
  expect(empty.systemPrompt).toContain("PONYTAIL MODE ACTIVE");
  expect(empty.systemPrompt.startsWith("undefined")).toBe(false);

  // A real base prompt is still preserved and prepended.
  const withBase = await pi.handlers.before_agent_start![0]!({ systemPrompt: "BASE" }, ctx);
  expect(withBase.systemPrompt.startsWith("BASE\n\n")).toBe(true);
  expect(withBase.systemPrompt).toContain("PONYTAIL MODE ACTIVE");
});

test("session_start restores latest persisted mode", async () => {
  const pi = makeFakePi();
  ponytailExtension(pi as any);
  const ctx = makeCommandContext({
    sessionManager: {
      getEntries: () => [
        { type: "custom", customType: "ponytail-mode", data: { mode: "lite" } },
      ],
    },
  });

  await pi.handlers.session_start![0]!({ reason: "resume" }, ctx);
  const result = await pi.handlers.before_agent_start![0]!({ systemPrompt: "BASE" }, ctx);

  expect(result.systemPrompt).toContain("lite");
});

test("skill alias commands delegate to Pi skill commands", async () => {
  const pi = makeFakePi();
  ponytailExtension(pi as any);
  const ctx = makeCommandContext();

  for (const name of ["ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"]) {
    await pi.commands.get(name)!.handler("", ctx);
  }

  expect(pi.sentUserMessages.map((entry) => entry.text)).toEqual([
    "/skill:ponytail-review",
    "/skill:ponytail-audit",
    "/skill:ponytail-debt",
    "/skill:ponytail-gain",
    "/skill:ponytail-help",
  ]);
});

test("normal mode disables persistent instructions", async () => {
  const pi = makeFakePi();
  ponytailExtension(pi as any);
  const ctx = makeCommandContext();

  await pi.handlers.session_start![0]!({ reason: "startup" }, ctx);
  await pi.commands.get("ponytail")!.handler("ultra", ctx);
  await pi.handlers.input![0]!({ text: "normal mode", source: "interactive" }, ctx);

  const disabled = await pi.handlers.before_agent_start![0]!({ systemPrompt: "BASE" }, ctx);
  expect(disabled).toBeUndefined();
});

test("a request mentioning normal mode stays active", async () => {
  const pi = makeFakePi();
  ponytailExtension(pi as any);
  const ctx = makeCommandContext();

  await pi.handlers.session_start![0]!({ reason: "startup" }, ctx);
  await pi.commands.get("ponytail")!.handler("ultra", ctx);
  await pi.handlers.input![0]!({ text: "add a normal mode toggle next to dark mode", source: "interactive" }, ctx);

  const result = await pi.handlers.before_agent_start![0]!({ systemPrompt: "BASE" }, ctx);
  expect(result.systemPrompt).toMatch(/PONYTAIL MODE ACTIVE/);
});

test("status bar renders the mode and flips active on agent_start", async () => {
  const pi = makeFakePi();
  ponytailExtension(pi as any);
  const statusWrites: Array<{ key: string; text: string }> = [];
  const ctx = makeCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }] },
    ui: { notify() {}, setStatus: (key: string, text: string) => statusWrites.push({ key, text }), theme: { fg: (_c: string, t: string) => t } },
  });

  await pi.handlers.session_start![0]!({ reason: "resume" }, ctx);
  await pi.handlers.agent_start![0]!({}, ctx);

  expect(statusWrites.at(-2)!.key).toBe("ponytail");
  expect(statusWrites.at(-2)!.text).toMatch(/○.*ULTRA/);
  expect(statusWrites.at(-1)!.text).toMatch(/●.*ULTRA/);
});

test("status bar stays silent when ui lacks a theme", async () => {
  const pi = makeFakePi();
  ponytailExtension(pi as any);
  const calls: string[] = [];
  const ctx = makeCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }] },
    ui: { notify() {}, setStatus: (_key: string, text: string) => calls.push(text) }, // setStatus present, theme absent
  });

  await pi.handlers.session_start![0]!({ reason: "resume" }, ctx);
  await pi.handlers.agent_start![0]!({}, ctx);

  expect(calls).toEqual([]);
});

test("PONYTAIL_HIDE_STATUS hides the indicator but keeps ponytail active", async () => {
  process.env.PONYTAIL_HIDE_STATUS = "1";
  const pi = makeFakePi();
  ponytailExtension(pi as any);
  const statusWrites: Array<{ key: string; text: string }> = [];
  const ctx = makeCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }] },
    ui: { notify() {}, setStatus: (key: string, text: string) => statusWrites.push({ key, text }), theme: { fg: (_c: string, t: string) => t } },
  });

  await pi.handlers.session_start![0]!({ reason: "resume" }, ctx);
  await pi.handlers.agent_start![0]!({}, ctx);
  const injected = await pi.handlers.before_agent_start![0]!({ systemPrompt: "BASE" }, ctx);

  expect(statusWrites).toEqual([]);
  expect(injected.systemPrompt).toMatch(/PONYTAIL MODE ACTIVE/);
});

test("settings hideStatus hides the indicator but keeps ponytail active", async () => {
  const settingsPath = join(process.env.PICO_HOME!, "agent", "settings.json");
  writeSettingsFile(settingsPath, { ponytail: { hideStatus: true } });
  const pi = makeFakePi();
  ponytailExtension(pi as any);
  const statusWrites: Array<{ key: string; text: string }> = [];
  const ctx = makeCommandContext({
    ui: { notify() {}, setStatus: (key: string, text: string) => statusWrites.push({ key, text }), theme: { fg: (_c: string, t: string) => t } },
  });

  await pi.handlers.session_start![0]!({ reason: "startup" }, ctx);
  await pi.handlers.agent_start![0]!({}, ctx);
  const injected = await pi.handlers.before_agent_start![0]!({ systemPrompt: "BASE" }, ctx);

  expect(statusWrites).toEqual([]);
  expect(injected.systemPrompt).toMatch(/PONYTAIL MODE ACTIVE/);
});

test("parsePonytailCommand: bare, level, status, default, invalid", () => {
  expect(parsePonytailCommand("")).toEqual({ type: "set-mode", mode: "full" });
  expect(parsePonytailCommand("", "off")).toEqual({ type: "set-mode", mode: "full" });
  expect(parsePonytailCommand("lite")).toEqual({ type: "set-mode", mode: "lite" });
  expect(parsePonytailCommand("ULTRA")).toEqual({ type: "set-mode", mode: "ultra" });
  expect(parsePonytailCommand("status")).toEqual({ type: "status" });
  expect(parsePonytailCommand("default full")).toEqual({ type: "set-default", mode: "full" });
  expect(parsePonytailCommand("default review")).toEqual({ type: "invalid", reason: "invalid-default-mode" });
  expect(parsePonytailCommand("bogus")).toEqual({ type: "invalid", reason: "invalid-mode", mode: "bogus" });
});

test("resolveSessionMode scans session entries newest-first", () => {
  expect(resolveSessionMode(undefined)).toBe("full");
  expect(resolveSessionMode([], "lite")).toBe("lite");
  expect(resolveSessionMode([
    { type: "custom", customType: "ponytail-mode", data: { mode: "lite" } },
    { type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } },
  ])).toBe("ultra");
  expect(resolveSessionMode([
    { type: "custom", customType: "other", data: { mode: "off" } },
  ], "lite")).toBe("lite");
});

test("writeDefaultMode persists to settings.json and review is rejected", async () => {
  const { writeDefaultMode } = await import("../src/extensions/ponytail/config.ts");

  expect(writeDefaultMode("ultra")).toBe("ultra");
  expect(readDefaultMode()).toBe("ultra");

  const settingsPath = join(process.env.PICO_HOME!, "agent", "settings.json");
  const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(saved.ponytail.defaultMode).toBe("ultra");

  // review 是会话级模式，不能作默认（上游 #377）。
  expect(writeDefaultMode("review")).toBeNull();
  expect(readDefaultMode()).toBe("ultra");
});

test("PONYTAIL_DEFAULT_MODE env overrides settings default", async () => {
  process.env.PONYTAIL_DEFAULT_MODE = "lite";
  const settingsPath = join(process.env.PICO_HOME!, "agent", "settings.json");
  writeSettingsFile(settingsPath, { ponytail: { defaultMode: "ultra" } });

  expect(readDefaultMode()).toBe("lite");
});

test("injected instructions: stable block identical across modes, mode text outside", () => {
  const stableOf = (mode: string) => {
    const text = getPonytailInstructions(mode);
    const start = text.indexOf("<!-- PICO_CACHE_STABLE:START -->");
    const end = text.indexOf("<!-- PICO_CACHE_STABLE:END -->");
    expect(start).toBeGreaterThan(0); // 模式行在标记外
    expect(end).toBeGreaterThan(start);
    return {
      head: text.slice(0, start),
      stable: text.slice(start, end),
      tail: text.slice(end),
    };
  };

  const full = stableOf("full");
  expect(full.head).toMatch(/^PONYTAIL MODE ACTIVE — level: full/);

  const lite = stableOf("lite");
  const ultra = stableOf("ultra");
  // 稳定段跨模式字节一致（进缓存前缀的前提）
  expect(lite.stable).toBe(full.stable);
  expect(ultra.stable).toBe(full.stable);
  // 模式相关文本留在标记外且随模式变化
  expect(full.tail).toContain("full");
  expect(ultra.tail).toContain("ultra");
  expect(lite.tail).not.toBe(ultra.tail);
});

test("fallback instructions still assemble when skill body is missing", () => {
  // 把内置 SKILL.md 临时改名，验证 fallback 路径（含标记拆分）。
  const skillPath = join(process.cwd(), "src", "skills", "ponytail", "SKILL.md");
  const moved = `${skillPath}.bak`;
  try {
    renameSync(skillPath, moved);
    __resetPonytailSkillCacheForTests();
    const text = getPonytailInstructions("full");
    expect(text).toContain("PONYTAIL MODE ACTIVE — level: full");
    expect(text).toContain("<!-- PICO_CACHE_STABLE:START -->");
    expect(text).toContain("The ladder");
  } finally {
    if (existsSync(moved)) {
      renameSync(moved, skillPath);
    }
    __resetPonytailSkillCacheForTests();
  }
});

function writeSettingsFile(path: string, settings: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}
