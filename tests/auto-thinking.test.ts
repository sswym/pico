import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { autoThinkingExtension, THINKING_LEVELS } from "../src/extensions/auto-thinking/index.ts";
import { buildUltrathinkNotice, containsUltrathink } from "../src/extensions/auto-thinking/ultrathink.ts";
import { isSettingsDamaged, readSettings, writeSettings } from "../src/extensions/settings.ts";

type FakeHandler = (event: any, ctx: any) => any;

function makeFakePi() {
  const handlers: Record<string, FakeHandler[]> = {};
  const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
  let thinkingLevel: string | undefined = "medium";
  const notices: string[] = [];
  return {
    handlers,
    commands,
    notices,
    on: (event: string, handler: FakeHandler) => {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand: (name: string, opts: { description: string; handler: (args: string, ctx: any) => Promise<void> }) => {
      commands.set(name, opts);
    },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level: string) => {
      thinkingLevel = level;
    },
    ui: {
      notify: (text: string) => notices.push(text),
    },
  };
}

const savedEnv = { ...process.env };

beforeEach(() => {
  delete process.env.PICO_AUTO_THINKING_DISABLE;
  delete process.env.PICO_ULTRATHINK_NOTICE_ONLY;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

function runBeforeAgentStart(pi: ReturnType<typeof makeFakePi>, prompt: string, systemPrompt = "base prompt") {
  const handler = pi.handlers["before_agent_start"]?.[0];
  if (!handler) throw new Error("before_agent_start handler not registered");
  return handler({ prompt, systemPrompt }, {});
}

// --- containsUltrathink: prose-boundary detection --------------------------

test("detects standalone lowercase ultrathink in prose", () => {
  expect(containsUltrathink("ultrathink 帮我设计并发方案")).toBe(true);
  expect(containsUltrathink("please ultrathink this problem through")).toBe(true);
  expect(containsUltrathink("leading text\nultrathink\ntrailing")).toBe(true);
});

test("rejects uppercase, embedded, and partial matches", () => {
  expect(containsUltrathink("UltraThink")).toBe(false);
  expect(containsUltrathink("ultrathinkable design")).toBe(false);
  expect(containsUltrathink("super-ultrathink")).toBe(false);
  expect(containsUltrathink("just a normal request")).toBe(false);
});

test("skips fenced code blocks, inline code, and XML tag sections", () => {
  expect(containsUltrathink("```ts\nconst x = \"ultrathink\";\n```\nwhat does it do?")).toBe(false);
  expect(containsUltrathink("run `ultrathink --help` please")).toBe(false);
  expect(containsUltrathink("<system-notice>\nultrathink inside tags\n</system-notice>\nreal question?")).toBe(false);
});

test("detects keyword after a code block closes", () => {
  const text = "```ts\nconst x = 1;\n```\nnow ultrathink the design";
  expect(containsUltrathink(text)).toBe(true);
});

// --- buildUltrathinkNotice -------------------------------------------------

test("notice wraps reasoning reminder in system-notice tags", () => {
  const notice = buildUltrathinkNotice();
  expect(notice).toContain("<system-notice>");
  expect(notice).toContain("multi-step reasoning");
  expect(notice).toContain("</system-notice>");
});

// --- extension wiring ------------------------------------------------------

test("ultrathink keyword raises thinking to max and injects notice", () => {
  const pi = makeFakePi();
  autoThinkingExtension(pi as any);

  const result = runBeforeAgentStart(pi, "ultrathink design this module");

  expect(pi.getThinkingLevel()).toBe("max");
  expect(result.systemPrompt).toContain("<system-notice>");
  expect(result.systemPrompt).toContain("multi-step reasoning");
  expect(result.systemPrompt.startsWith("base prompt")).toBe(true);
});

test("no keyword leaves thinking level and prompt untouched", () => {
  const pi = makeFakePi();
  autoThinkingExtension(pi as any);

  const result = runBeforeAgentStart(pi, "plain request");

  expect(pi.getThinkingLevel()).toBe("medium");
  expect(result).toEqual({});
});

test("previous thinking level is restored on agent_end", () => {
  const pi = makeFakePi();
  autoThinkingExtension(pi as any);

  runBeforeAgentStart(pi, "ultrathink go");
  expect(pi.getThinkingLevel()).toBe("max");

  const endHandler = pi.handlers["agent_end"]?.[0];
  if (!endHandler) throw new Error("agent_end handler not registered");
  endHandler({}, {});
  expect(pi.getThinkingLevel()).toBe("medium");
});

test("no restore when keyword fires while already at max", () => {
  const pi = makeFakePi();
  pi.setThinkingLevel("max");
  autoThinkingExtension(pi as any);

  runBeforeAgentStart(pi, "ultrathink go");
  expect(pi.getThinkingLevel()).toBe("max");

  const endHandler = pi.handlers["agent_end"]?.[0];
  if (!endHandler) throw new Error("agent_end handler not registered");
  endHandler({}, {});
  expect(pi.getThinkingLevel()).toBe("max");
});

test("notice-only mode injects notice without touching thinking level", () => {
  process.env.PICO_ULTRATHINK_NOTICE_ONLY = "1";
  const pi = makeFakePi();
  autoThinkingExtension(pi as any);

  const result = runBeforeAgentStart(pi, "ultrathink go");

  expect(pi.getThinkingLevel()).toBe("medium");
  expect(result.systemPrompt).toContain("<system-notice>");
});

test("disabled env bypasses everything", () => {
  process.env.PICO_AUTO_THINKING_DISABLE = "1";
  const pi = makeFakePi();
  autoThinkingExtension(pi as any);

  const result = runBeforeAgentStart(pi, "ultrathink go");

  expect(pi.getThinkingLevel()).toBe("medium");
  expect(result).toEqual({});
});

test("registers thinking command with level validation", async () => {
  const pi = makeFakePi();
  autoThinkingExtension(pi as any);

  const cmd = pi.commands.get("thinking");
  expect(cmd).toBeDefined();
  expect(cmd!.description).toContain("thinking level");

  await cmd!.handler("high", { ui: pi.ui });
  expect(pi.getThinkingLevel()).toBe("high");

  await cmd!.handler("bogus", { ui: pi.ui });
  expect(pi.getThinkingLevel()).toBe("high");
  expect(pi.notices.some((n) => n.includes("Unknown thinking level"))).toBe(true);

  await cmd!.handler("", { ui: pi.ui });
  expect(pi.notices.some((n) => n.includes("Thinking level: high"))).toBe(true);
});

test("THINKING_LEVELS covers all seven upstream levels", () => {
  expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

// --- /thinking status (F3) & clamped notify (F4) -------------------------

test("/thinking status shows the current level like /ponytail status", async () => {
  const pi = makeFakePi();
  autoThinkingExtension(pi as unknown as Parameters<typeof autoThinkingExtension>[0]);

  const cmd = pi.commands.get("thinking")!;
  await cmd.handler("status", { ui: pi.ui });

  expect(pi.getThinkingLevel()).toBe("medium"); // status is not a level change
  expect(pi.notices.some((n) => n.includes("Thinking level: medium"))).toBe(true);
  expect(pi.notices.some((n) => n.includes("Unknown thinking level"))).toBe(false);
});

test("/thinking minimal notifies the clamped effective level, not the request", async () => {
  const pi = makeFakePi();
  // Upstream clamps unsupported levels: only off/high/max are available here,
  // so "minimal" lands on "high".
  const supported = ["off", "high", "max"];
  const originalSet = pi.setThinkingLevel;
  pi.setThinkingLevel = (level: string) => {
    originalSet(supported.includes(level) ? level : "high");
  };
  autoThinkingExtension(pi as unknown as Parameters<typeof autoThinkingExtension>[0]);

  const cmd = pi.commands.get("thinking")!;
  await cmd.handler("minimal", { ui: pi.ui });

  expect(pi.getThinkingLevel()).toBe("high");
  expect(pi.notices.some((n) => n.includes("Thinking level set to high"))).toBe(true);
  expect(pi.notices.some((n) => n.includes("minimal not supported"))).toBe(true);
});

// --- ultrathink must not persist defaultThinkingLevel (F2/M12) ------------

test("ultrathink restore puts the persisted defaultThinkingLevel back", () => {
  const oldHome = process.env.PICO_HOME;
  const home = mkdtempSync(join(tmpdir(), "pico-thinking-home-"));
  process.env.PICO_HOME = home;
  try {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(join(home, "agent", "settings.json"), JSON.stringify({
      defaultThinkingLevel: "medium",
    }));

    // Simulate upstream AgentSession.setThinkingLevel: clamp to the model's
    // supported levels (off/high/max) and persist every effective change to
    // settings.json — exactly the behavior that used to rewrite the user's
    // default from medium to high after one ultrathink turn.
    const pi = makeFakePi();
    const supported = ["off", "high", "max"];
    let level = "high"; // "medium" in settings clamps to "high" at session start
    pi.getThinkingLevel = () => level;
    pi.setThinkingLevel = (next: string) => {
      const effective = supported.includes(next) ? next : "high";
      level = effective;
      if (!isSettingsDamaged()) {
        const settings = readSettings();
        settings.defaultThinkingLevel = effective;
        writeSettings(settings);
      }
    };
    autoThinkingExtension(pi as unknown as Parameters<typeof autoThinkingExtension>[0]);

    runBeforeAgentStart(pi, "ultrathink design the queue module");
    expect(pi.getThinkingLevel()).toBe("max");
    expect(readSettings().defaultThinkingLevel).toBe("max"); // upstream persisted the raise

    const endHandler = pi.handlers["agent_end"]?.[0];
    if (!endHandler) throw new Error("agent_end handler not registered");
    endHandler({}, {});

    expect(pi.getThinkingLevel()).toBe("high"); // session restored to clamped level
    expect(readSettings().defaultThinkingLevel).toBe("medium"); // config unchanged
  } finally {
    if (oldHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
