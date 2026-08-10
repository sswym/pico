import { afterEach, beforeEach, expect, test } from "bun:test";
import { autoThinkingExtension, THINKING_LEVELS } from "../src/extensions/auto-thinking/index.ts";
import { buildUltrathinkNotice, containsUltrathink } from "../src/extensions/auto-thinking/ultrathink.ts";

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
