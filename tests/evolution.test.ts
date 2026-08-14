/**
 * evolution extension integration tests — fakePi + fake complete 驱动完整
 * 链路：agent_end 触发审查 → 技能落盘、频率限制、禁用、失败推进、shutdown
 * 等待、resume 去重。
 *
 * Env isolation follows tests/skill.test.ts: PICO_HOME redirected to a
 * mkdtemp directory in beforeEach, restored in afterEach.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEvolutionExtension } from "../src/extensions/evolution/index.ts";
import { __resetEvolutionStateForTests, getState, setShutdownWaitMsForTests } from "../src/extensions/evolution/state.ts";
import { userSkillsDir } from "../src/extensions/evolution/apply.ts";

let homeDir: string;
let oldPicoHome: string | undefined;

interface FakeComplete {
  counter: { value: number };
  prompts: string[]; // 每次调用收到的审查输入文本（用于断言输入内容）
  complete: (m: unknown, c: unknown, o: unknown) => Promise<unknown>;
}

/** 返回一个 fake complete：按队列依次返回；队列耗尽后返回空结果。 */
function makeFakeComplete(responses: string[]): FakeComplete {
  const counter = { value: 0 };
  const prompts: string[] = [];
  const complete = async (_m: unknown, context: unknown): Promise<unknown> => {
    counter.value++;
    const text = responses[Math.min(counter.value - 1, responses.length - 1)] ?? '{"create":[],"update":[]}';
    const messages = (context as { messages?: Array<{ content?: Array<{ type?: string; text?: string }> }> })?.messages;
    const prompt = messages?.[0]?.content?.find((b) => b.type === "text")?.text ?? "";
    prompts.push(prompt);
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    };
  };
  return { counter, prompts, complete };
}

function makeExtensionWith(fake: FakeComplete): { pi: ExtensionAPI; handlers: Record<string, Array<(event: never, ctx: ExtensionContext) => unknown>> } {
  const { pi, handlers } = makePi();
  createEvolutionExtension({ reviewDeps: { complete: fake.complete as never } })(pi);
  return { pi, handlers };
}

function makePi(): { pi: ExtensionAPI; handlers: Record<string, Array<(event: never, ctx: ExtensionContext) => unknown>> } {
  const handlers: Record<string, Array<(event: never, ctx: ExtensionContext) => unknown>> = {};
  return {
    handlers,
    pi: {
      on: (event: string, handler: never) => {
        (handlers[event] ??= []).push(handler as never);
      },
    } as unknown as ExtensionAPI,
  };
}

function makeCtx(): ExtensionContext {
  const fakeModel = { provider: "test", id: "fake-model" };
  return {
    cwd: homeDir,
    model: fakeModel,
    signal: undefined,
    modelRegistry: {
      find: () => fakeModel,
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
  } as unknown as ExtensionContext;
}

function writeSettings(config: Record<string, unknown>): void {
  const dir = join(homeDir, "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ evolution: config }));
}

/** 等待 fire-and-forget 审查完成（inFlight 结束 + 事件循环排空）。 */
async function drain(): Promise<void> {
  const pending = getState().inFlight;
  if (pending) await pending;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function agentEndMessages(round: number): Array<{ role: string; content: string }> {
  return [
    { role: "user", content: `round ${round} user request` },
    { role: "assistant", content: `round ${round} assistant doing work` },
  ];
}

beforeEach(() => {
  oldPicoHome = process.env.PICO_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "pico-evolve-int-"));
  process.env.PICO_HOME = homeDir;
  __resetEvolutionStateForTests();
  setShutdownWaitMsForTests(50);
});

afterEach(() => {
  if (oldPicoHome === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = oldPicoHome;
  rmSync(homeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 触发与落盘
// ---------------------------------------------------------------------------

test("agent_end at turn threshold triggers review and writes skill + manifest", async () => {
  writeSettings({ enabled: true, reviewEveryTurns: 2, maxReviewsPerSession: 2 });
  const fake = makeFakeComplete([
    JSON.stringify({
      create: [{ name: "auth-debug", description: "Debug auth flows", content: "1. Check token\n2. Verify" }],
      update: [],
    }),
  ]);
  const { pi, handlers } = makePi();
  createEvolutionExtension({ reviewDeps: { complete: fake.complete as never } })(pi);

  handlers["session_start"]!.forEach((h) => h({ type: "session_start", reason: "startup" } as never, makeCtx()));
  const ctx = makeCtx();
  handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: agentEndMessages(1) } as never, ctx));
  expect(fake.counter.value).toBe(0); // 未达阈值
  handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: agentEndMessages(2) } as never, ctx));
  await drain();

  expect(fake.counter.value).toBe(1);
  expect(existsSync(join(userSkillsDir(), "auth-debug", "SKILL.md"))).toBe(true);
  const content = readFileSync(join(userSkillsDir(), "auth-debug", "SKILL.md"), "utf-8");
  expect(content).toContain("x-pico-evolved: true");
  expect(content).toContain("Debug auth flows");
  expect(existsSync(join(userSkillsDir(), ".pico-evolved.json"))).toBe(true);
  expect(getState().reviewsDone).toBe(1);
  expect(getState().buffer.length).toBe(0); // 已消费
});

test("disabled extension never triggers review", async () => {
  writeSettings({ enabled: false, reviewEveryTurns: 1 });
  const fake = makeFakeComplete(['{"create":[],"update":[]}']);
  const { pi, handlers } = makePi();
  createEvolutionExtension({ reviewDeps: { complete: fake.complete as never } })(pi);

  handlers["session_start"]!.forEach((h) => h({ type: "session_start", reason: "startup" } as never, makeCtx()));
  const ctx = makeCtx();
  for (let i = 0; i < 6; i++) {
    handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: agentEndMessages(i) } as never, ctx));
  }
  await drain();
  expect(fake.counter.value).toBe(0);
  expect(getState().reviewsDone).toBe(0);
});

// ---------------------------------------------------------------------------
// 频率限制
// ---------------------------------------------------------------------------

test("reviews capped at maxReviewsPerSession even with many turns", async () => {
  writeSettings({ enabled: true, reviewEveryTurns: 2, maxReviewsPerSession: 2 });
  const fake = makeFakeComplete(['{"create":[],"update":[]}']);
  const { pi, handlers } = makePi();
  createEvolutionExtension({ reviewDeps: { complete: fake.complete as never } })(pi);

  handlers["session_start"]!.forEach((h) => h({ type: "session_start", reason: "startup" } as never, makeCtx()));
  const ctx = makeCtx();
  for (let i = 0; i < 12; i++) {
    handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: agentEndMessages(i) } as never, ctx));
    // 每回合让 in-flight 有机会完成（真实回合间有异步间隙）
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await drain();
  expect(fake.counter.value).toBe(2);
  expect(getState().reviewsDone).toBe(2);
});

// ---------------------------------------------------------------------------
// 回合阈值（消息条数不加速）
// ---------------------------------------------------------------------------

test("threshold counts turns, not messages", async () => {
  writeSettings({ enabled: true, reviewEveryTurns: 2 });
  const fake = makeFakeComplete(['{"create":[],"update":[]}']);
  const { pi, handlers } = makePi();
  createEvolutionExtension({ reviewDeps: { complete: fake.complete as never } })(pi);

  handlers["session_start"]!.forEach((h) => h({ type: "session_start", reason: "startup" } as never, makeCtx()));
  const ctx = makeCtx();
  // 回合 1：单回合塞入 10 条消息——仍不应触发
  const many = Array.from({ length: 10 }, (_, i) => ({ role: "tool", content: `msg ${i}` }));
  handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: many } as never, ctx));
  expect(fake.counter.value).toBe(0);
  // 回合 2：达到阈值
  handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: agentEndMessages(2) } as never, ctx));
  await drain();
  expect(fake.counter.value).toBe(1);
});

// ---------------------------------------------------------------------------
// 审查失败：推进水位、不重试、不阻塞
// ---------------------------------------------------------------------------

test("failed review advances watermark and does not retry same batch", async () => {
  writeSettings({ enabled: true, reviewEveryTurns: 2, maxReviewsPerSession: 5 });
  let attempts = 0;
  const complete = async () => {
    attempts++;
    throw new Error("provider down");
  };
  const { pi, handlers } = makePi();
  createEvolutionExtension({ reviewDeps: { complete } as never })(pi);

  handlers["session_start"]!.forEach((h) => h({ type: "session_start", reason: "startup" } as never, makeCtx()));
  const ctx = makeCtx();
  handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: agentEndMessages(1) } as never, ctx));
  handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: agentEndMessages(2) } as never, ctx));
  await drain();
  expect(attempts).toBe(1); // 触发并失败
  expect(getState().reviewsDone).toBe(1); // 失败也计数
  // 回合 3、4 再触发一次（水位已推进，不会对同一批重复触发）
  handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: agentEndMessages(3) } as never, ctx));
  handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: agentEndMessages(4) } as never, ctx));
  await drain();
  expect(attempts).toBe(2);
});

// ---------------------------------------------------------------------------
// session_shutdown 等待 in-flight
// ---------------------------------------------------------------------------

test("session_shutdown waits for in-flight review up to waitMs", async () => {
  writeSettings({ enabled: true, reviewEveryTurns: 1 });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const complete = async () => {
    await gate;
    return { role: "assistant", content: [{ type: "text", text: '{"create":[],"update":[]}' }], stopReason: "stop" };
  };
  const { pi, handlers } = makePi();
  createEvolutionExtension({ reviewDeps: { complete } as never })(pi);

  handlers["session_start"]!.forEach((h) => h({ type: "session_start", reason: "startup" } as never, makeCtx()));
  const ctx = makeCtx();
  handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: agentEndMessages(1) } as never, ctx));
  expect(getState().inFlight).not.toBeNull();

  const started = Date.now();
  const shutdownHandler = handlers["session_shutdown"]![0]! as (e: never, c: ExtensionContext) => Promise<void>;
  await shutdownHandler({ type: "session_shutdown", reason: "quit" } as never, ctx);
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(40); // 等待了（waitMs=50，宽容计时）
  expect(elapsed).toBeLessThan(1_000); // 没有无限等待

  release!();
  await drain();
  expect(getState().inFlight).toBeNull(); // 完成后清理
});

test("session_shutdown does not wait on reload", async () => {
  writeSettings({ enabled: true, reviewEveryTurns: 1 });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const complete = async () => {
    await gate;
    return { role: "assistant", content: [{ type: "text", text: '{"create":[],"update":[]}' }], stopReason: "stop" };
  };
  const { pi, handlers } = makePi();
  createEvolutionExtension({ reviewDeps: { complete } as never })(pi);

  handlers["session_start"]!.forEach((h) => h({ type: "session_start", reason: "startup" } as never, makeCtx()));
  const ctx = makeCtx();
  handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: agentEndMessages(1) } as never, ctx));
  const started = Date.now();
  const shutdownHandler = handlers["session_shutdown"]![0]! as (e: never, c: ExtensionContext) => Promise<void>;
  await shutdownHandler({ type: "session_shutdown", reason: "reload" } as never, ctx);
  expect(Date.now() - started).toBeLessThan(40); // 立即返回
  release!();
});

// ---------------------------------------------------------------------------
// resume：模块级 seen 集合防重扫
// ---------------------------------------------------------------------------

test("resume session does not re-scan already-seen messages", async () => {
  writeSettings({ enabled: true, reviewEveryTurns: 1 });
  const fake = makeFakeComplete(['{"create":[],"update":[]}']);
  const { pi, handlers } = makePi();
  createEvolutionExtension({ reviewDeps: { complete: fake.complete as never } })(pi);

  handlers["session_start"]!.forEach((h) => h({ type: "session_start", reason: "startup" } as never, makeCtx()));
  const ctx = makeCtx();
  // 回合 1：A、B 两条消息
  const first = [
    { role: "user", content: "message A" },
    { role: "assistant", content: "message B" },
  ];
  handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: first } as never, ctx));
  await drain();

  // resume：新会话 start（重置缓冲），但 agent_end 消息包含旧历史 A、B + 新消息 C
  handlers["session_start"]!.forEach((h) => h({ type: "session_start", reason: "resume" } as never, ctx));
  const resumed = [
    { role: "user", content: "message A" },
    { role: "assistant", content: "message B" },
    { role: "assistant", content: "message C" },
  ];
  handlers["agent_end"]!.forEach((h) => h({ type: "agent_end", messages: resumed } as never, ctx));
  await drain();

  expect(fake.counter.value).toBe(2); // 两次会话各触发一次（resume 会话已重置计数）
  // resume 会话的审查输入只含 C：A/B 被模块级 seen 集合挡住，不会重扫
  const secondPrompt = fake.prompts[1] ?? "";
  expect(secondPrompt).toContain("message C");
  expect(secondPrompt).not.toContain("message A");
  expect(secondPrompt).not.toContain("message B");
});
