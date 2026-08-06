/**
 * observability extension tests.
 *
 * Drive the factory with a hand-rolled fakePi, fire lifecycle handlers with
 * constructed fake ctx (sessionManager.getSessionId returns a fake id), and
 * assert on the JSONL file: 5-event flow, metadata-only payloads (args/output
 * never appear in the file), error flag, trim, tolerance, and silent failures.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __resetObservabilityForTests,
  __setObservabilityLimitsForTests,
  getObservabilityFilePath,
  logEvent,
  observabilityExtension,
  readObservabilityEvents,
} from "../src/extensions/observability.ts";
import { __resetExtensionEventsForTests, publishExtensionEvent } from "../src/extensions/events.ts";

const FAKE_SESSION_ID = "ses_test123";
const SECRET_TOOL_INPUT = "rm -rf /sensitive-secrets";
const SECRET_TOOL_OUTPUT = "TOP SECRET OUTPUT";

interface FakeApi {
  handlers: Record<string, (event: unknown, ctx?: Record<string, unknown>) => unknown>;
}

function makeFakeApi(): { handlers: FakeApi["handlers"]; api: Parameters<typeof observabilityExtension>[0] } {
  const handlers: FakeApi["handlers"] = {};
  const api = {
    on: (event: string, handler: (event: unknown, ctx?: Record<string, unknown>) => unknown) => {
      handlers[event] = handler;
    },
    registerTool: () => {},
    registerCommand: () => {},
    sendMessage: () => {},
  } as unknown as Parameters<typeof observabilityExtension>[0];
  return { handlers, api };
}

function makeFakeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionManager: { getSessionId: () => FAKE_SESSION_ID },
    model: { provider: "anthropic", id: "claude-test" },
    ...overrides,
  };
}

let homeDir: string;
let oldPicoHome: string | undefined;

beforeEach(() => {
  oldPicoHome = process.env.PICO_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "pico-obs-"));
  process.env.PICO_HOME = homeDir;
  __resetObservabilityForTests();
  __resetExtensionEventsForTests();
});

afterEach(() => {
  if (oldPicoHome === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = oldPicoHome;
  __resetObservabilityForTests();
  __resetExtensionEventsForTests();
  rmSync(homeDir, { recursive: true, force: true });
});

test("factory registers all seven lifecycle handlers", () => {
  const fake = makeFakeApi();
  observabilityExtension(fake.api);
  expect(Object.keys(fake.handlers).sort()).toEqual(
    ["before_provider_request", "session_shutdown", "session_start", "tool_call", "tool_result", "turn_end", "turn_start"].sort(),
  );
});

test("session → turn → tool → shutdown writes five JSONL events, metadata only", () => {
  const fake = makeFakeApi();
  observabilityExtension(fake.api);

  fake.handlers.session_start!({ type: "session_start", reason: "startup" }, makeFakeCtx());
  fake.handlers.turn_start!({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }, makeFakeCtx());
  fake.handlers.tool_call!(
    { type: "tool_call", toolCallId: "call_1", toolName: "bash", input: { command: SECRET_TOOL_INPUT } },
    makeFakeCtx(),
  );
  fake.handlers.tool_result!(
    {
      type: "tool_result",
      toolCallId: "call_1",
      toolName: "bash",
      input: { command: SECRET_TOOL_INPUT },
      content: [{ type: "text", text: SECRET_TOOL_OUTPUT }],
      isError: false,
    },
    makeFakeCtx(),
  );
  fake.handlers.session_shutdown!({ type: "session_shutdown", reason: "quit" }, makeFakeCtx());

  const events = readObservabilityEvents();
  expect(events).toHaveLength(5);
  expect(events.map((e) => e.event)).toEqual([
    "session_start",
    "turn_start",
    "tool_call",
    "tool_result",
    "session_shutdown",
  ]);
  for (const event of events) {
    expect(event.ts).toBeGreaterThan(0);
    expect(event.sessionId).toBe(FAKE_SESSION_ID);
  }
  // turnId 贯穿回合内所有事件（trace-id 思想）。
  expect(events[1]?.turnId).toBe(`${FAKE_SESSION_ID}:1`);
  expect(events[2]?.turnId).toBe(`${FAKE_SESSION_ID}:1`);
  expect(events[3]?.turnId).toBe(`${FAKE_SESSION_ID}:1`);
  // tool_call 的 payload 只有工具名。
  expect(events[2]?.payload).toEqual({ tool: "bash" });
  expect(events[3]?.payload).toEqual({ tool: "bash" });
  expect(events[3]?.durationMs).toBeGreaterThanOrEqual(0);
  expect(events[4]?.durationMs).toBeGreaterThanOrEqual(0);
  // shutdown 事件在清空状态前记录，仍携带活动 turnId（血缘贯穿到最后一刻）。
  expect(events[4]?.turnId).toBe(`${FAKE_SESSION_ID}:1`);

  // 文件为 JSONL：一行一条。
  const raw = readFileSync(getObservabilityFilePath(), "utf-8");
  expect(raw.trim().split("\n")).toHaveLength(5);
  // 隐私红线：工具输入参数与工具输出绝不落盘。
  expect(raw).not.toContain(SECRET_TOOL_INPUT);
  expect(raw).not.toContain(SECRET_TOOL_OUTPUT);
  // 文件权限 0o600（API key 类数据风险防护）。
  expect(statSync(getObservabilityFilePath()).mode & 0o777).toBe(0o600);
});

test("tool_result records error: true when isError is set, still no output content", () => {
  const fake = makeFakeApi();
  observabilityExtension(fake.api);

  fake.handlers.session_start!({ type: "session_start", reason: "startup" }, makeFakeCtx());
  fake.handlers.tool_call!({ type: "tool_call", toolCallId: "c1", toolName: "read", input: {} }, makeFakeCtx());
  fake.handlers.tool_result!(
    {
      type: "tool_result",
      toolCallId: "c1",
      toolName: "read",
      input: {},
      content: [{ type: "text", text: SECRET_TOOL_OUTPUT }],
      isError: true,
    },
    makeFakeCtx(),
  );

  const events = readObservabilityEvents();
  expect(events[2]?.payload).toEqual({ tool: "read", error: true });
  const raw = readFileSync(getObservabilityFilePath(), "utf-8");
  expect(raw).not.toContain(SECRET_TOOL_OUTPUT);
});

test("turn_end logs turn duration and clears the active turnId", () => {
  const fake = makeFakeApi();
  observabilityExtension(fake.api);

  fake.handlers.session_start!({ type: "session_start", reason: "startup" }, makeFakeCtx());
  fake.handlers.turn_start!({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }, makeFakeCtx());
  fake.handlers.turn_end!({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, makeFakeCtx());
  fake.handlers.tool_call!({ type: "tool_call", toolCallId: "c2", toolName: "read", input: {} }, makeFakeCtx());

  const events = readObservabilityEvents();
  expect(events.map((e) => e.event)).toEqual(["session_start", "turn_start", "turn_end", "tool_call"]);
  expect(events[2]?.durationMs).toBeGreaterThanOrEqual(0);
  expect(events[2]?.turnId).toBe(`${FAKE_SESSION_ID}:1`);
  // turn 结束后的事件不再携带 turnId。
  expect(events[3]?.turnId).toBeUndefined();
});

test("before_provider_request logs provider/model metadata, never the payload", () => {
  const fake = makeFakeApi();
  observabilityExtension(fake.api);

  fake.handlers.session_start!({ type: "session_start", reason: "startup" }, makeFakeCtx());
  fake.handlers.before_provider_request!(
    { type: "before_provider_request", payload: { messages: [{ role: "user", content: "my secret prompt" }] } },
    makeFakeCtx(),
  );

  const events = readObservabilityEvents();
  expect(events.map((e) => e.event)).toEqual(["session_start", "provider_request"]);
  expect(events[1]?.payload).toEqual({ provider: "anthropic", model: "claude-test" });
  const raw = readFileSync(getObservabilityFilePath(), "utf-8");
  expect(raw).not.toContain("my secret prompt");
});

test("subagent_completed logs childSessionId metadata only, never task/result content", () => {
  const fake = makeFakeApi();
  observabilityExtension(fake.api);

  fake.handlers.session_start!({ type: "session_start", reason: "startup" }, makeFakeCtx());
  publishExtensionEvent("subagent_completed", {
    task: "secret task text",
    result: "secret result text",
    childSessionId: "ses_child_1",
  });

  const events = readObservabilityEvents();
  expect(events.map((e) => e.event)).toEqual(["session_start", "subagent_completed"]);
  expect(events[1]?.payload).toEqual({ childSessionId: "ses_child_1" });
  const raw = readFileSync(getObservabilityFilePath(), "utf-8");
  expect(raw).not.toContain("secret task text");
  expect(raw).not.toContain("secret result text");
});

test("log file is trimmed to the last maxLines once the byte cap is exceeded", () => {
  const fake = makeFakeApi();
  observabilityExtension(fake.api);
  __setObservabilityLimitsForTests(2048, 5);

  fake.handlers.session_start!({ type: "session_start", reason: "startup" }, makeFakeCtx());
  for (let i = 0; i < 40; i++) {
    fake.handlers.tool_call!(
      { type: "tool_call", toolCallId: `c${i}`, toolName: "bash", input: { command: `cmd ${i}` } },
      makeFakeCtx(),
    );
  }

  const events = readObservabilityEvents();
  expect(events).toHaveLength(5);
  // 保留的是最后 5 条，最旧的事件（session_start）已被截掉。
  expect(events.map((e) => e.event)).toEqual(["tool_call", "tool_call", "tool_call", "tool_call", "tool_call"]);
  // 文件本身也未超限。
  expect(statSync(getObservabilityFilePath()).size).toBeLessThanOrEqual(2048);
});

test("readObservabilityEvents tolerates a missing file and corrupt lines", () => {
  // 文件不存在 → []。
  expect(readObservabilityEvents()).toEqual([]);

  const fake = makeFakeApi();
  observabilityExtension(fake.api);
  // 手动写入损坏行 + 合法行。
  mkdirSync(join(homeDir, "agent"), { recursive: true });
  writeFileSync(getObservabilityFilePath(), "{corrupt}\n{\"ts\":1,\"event\":\"x\"}\n", { mode: 0o600 });

  const events = readObservabilityEvents();
  expect(events).toHaveLength(1);
  expect(events[0]?.event).toBe("x");
});

test("__resetObservabilityForTests clears session/turn state", () => {
  const fake = makeFakeApi();
  observabilityExtension(fake.api);

  fake.handlers.session_start!({ type: "session_start", reason: "startup" }, makeFakeCtx());
  fake.handlers.turn_start!({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }, makeFakeCtx());
  __resetObservabilityForTests();
  fake.handlers.session_shutdown!({ type: "session_shutdown", reason: "quit" }, makeFakeCtx());

  const events = readObservabilityEvents();
  expect(events).toHaveLength(3);
  expect(events[0]?.sessionId).toBe(FAKE_SESSION_ID);
  expect(events[1]?.turnId).toBe(`${FAKE_SESSION_ID}:1`);
  // 重置后 sessionId/turnId 均已清空。
  expect(events[2]?.sessionId).toBeUndefined();
  expect(events[2]?.turnId).toBeUndefined();
});

test("logEvent swallows fs failures when PICO_HOME is not writable", () => {
  // PICO_HOME 指向一个普通文件：mkdir -p 会失败，但 logEvent 必须静默不抛。
  const blocker = join(homeDir, "blocker");
  writeFileSync(blocker, "not a directory");
  process.env.PICO_HOME = blocker;

  expect(() => logEvent("test_event")).not.toThrow();
  expect(readObservabilityEvents()).toEqual([]);
});

test("logEvent without an active session omits sessionId/turnId", () => {
  expect(() => logEvent("standalone", { tool: "bash" })).not.toThrow();

  const events = readObservabilityEvents();
  expect(events).toHaveLength(1);
  expect(events[0]?.event).toBe("standalone");
  expect(events[0]?.sessionId).toBeUndefined();
  expect(events[0]?.turnId).toBeUndefined();
  expect(events[0]?.payload).toEqual({ tool: "bash" });
});
