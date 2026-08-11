/**
 * Supervisor channel (intercom) tests — 子侧 contact_supervisor 工具 +
 * 父侧 subagent_supervisor 工具与轮询器。
 *
 * 全部走真实文件系统（os.tmpdir()/pico-supervisor-channels），不 spawn
 * 真实子进程：子侧身份用环境变量模拟，父侧唤醒用 fakePi 捕获 sendMessage。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subagentChildEnv } from "../src/extensions/subagent/process.ts";
import {
  SUBAGENT_CHANNEL_DIR_ENV,
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
  SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
  SUBAGENT_RUN_ID_ENV,
  clearChannelRoot,
  createChannelDir,
  createRunId,
  createSupervisorChannel,
  readChildMetadata,
  registerChildSupervisorTool,
} from "../src/extensions/subagent/supervisor-channel.ts";

function makeFakePi(): any {
  const tools: Array<{ name: string; execute?: (...args: any[]) => any }> = [];
  const sent: Array<{ message: any; options?: any }> = [];
  return {
    tools,
    sent,
    registerTool: (t: { name: string; execute?: (...args: any[]) => any }) => tools.push(t),
    sendMessage: (message: any, options?: any) => sent.push({ message, options }),
  };
}

let testRoot = "";

beforeEach(() => {
  testRoot = join(tmpdir(), `pico-sup-test-${Math.random().toString(36).slice(2)}`);
  process.env.PICO_SUPERVISOR_CHANNEL_ROOT = testRoot;
});

afterEach(() => {
  clearChildEnv();
  delete process.env.PICO_SUPERVISOR_CHANNEL_ROOT;
  clearChannelRoot();
  rmSync(testRoot, { recursive: true, force: true });
});

function setChildEnv(overrides: Record<string, string> = {}) {
  process.env[SUBAGENT_CHANNEL_DIR_ENV] = overrides[SUBAGENT_CHANNEL_DIR_ENV] ?? join(testRoot, "run-test-worker-0");
  process.env[SUBAGENT_RUN_ID_ENV] = overrides[SUBAGENT_RUN_ID_ENV] ?? "run-test";
  process.env[SUBAGENT_CHILD_AGENT_ENV] = overrides[SUBAGENT_CHILD_AGENT_ENV] ?? "worker";
  process.env[SUBAGENT_CHILD_INDEX_ENV] = overrides[SUBAGENT_CHILD_INDEX_ENV] ?? "0";
  process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = overrides[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] ?? "session-1";
}

function clearChildEnv() {
  for (const key of [
    SUBAGENT_CHANNEL_DIR_ENV,
    SUBAGENT_RUN_ID_ENV,
    SUBAGENT_CHILD_AGENT_ENV,
    SUBAGENT_CHILD_INDEX_ENV,
    SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
    "PICO_SUPERVISOR_ASK_TIMEOUT_MS",
  ]) {
    delete process.env[key];
  }
}

function writeSupervisorRequest(
  channelDir: string,
  sessionId: string,
  runId: string,
  overrides: Record<string, unknown> = {},
): string {
  const id = (overrides.id as string) ?? `req-${Math.random().toString(36).slice(2)}`;
  const request = {
    type: "pico.supervisor.request",
    id,
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    reason: "need_decision",
    message: "Need a decision.",
    expectsReply: true,
    runId,
    agent: "worker",
    childIndex: 0,
    orchestratorSessionId: sessionId,
    ...overrides,
  };
  mkdirSync(join(channelDir, "requests"), { recursive: true });
  writeFileSync(join(channelDir, "requests", `${id}.json`), JSON.stringify(request));
  return id;
}

async function tickUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("tickUntil timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function registerTool(pi: any, name: string) {
  const tool = pi.tools.find((t: { name: string }) => t.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

afterEach(() => {
  clearChildEnv();
  clearChannelRoot();
});

// ── 子侧：环境变量门控 + contact_supervisor ────────────────────────────────

test("registerChildSupervisorTool registers only with child env identity", () => {
  const plain = makeFakePi();
  expect(registerChildSupervisorTool(plain)).toBe(false);
  expect(plain.tools).toHaveLength(0);

  setChildEnv();
  const child = makeFakePi();
  expect(registerChildSupervisorTool(child)).toBe(true);
  expect(child.tools.map((t: { name: string }) => t.name)).toContain("contact_supervisor");
});

test("readChildMetadata parses env identity and rejects incomplete env", () => {
  expect(readChildMetadata()).toBeUndefined();
  setChildEnv();
  expect(readChildMetadata()).toEqual({
    channelDir: join(testRoot, "run-test-worker-0"),
    runId: "run-test",
    agent: "worker",
    childIndex: 0,
    orchestratorSessionId: "session-1",
  });
  clearChildEnv();
  process.env[SUBAGENT_CHANNEL_DIR_ENV] = "x";
  process.env[SUBAGENT_RUN_ID_ENV] = "y";
  expect(readChildMetadata()).toBeUndefined();
});

test("contact_supervisor need_decision writes a request and blocks until the reply", async () => {
  setChildEnv();
  const channelDir = process.env[SUBAGENT_CHANNEL_DIR_ENV]!;
  createChannelDir("run-test", "worker", 0);
  const pi = makeFakePi();
  registerChildSupervisorTool(pi);
  const tool = registerTool(pi, "contact_supervisor");

  const pending = tool.execute!("tool-1", { reason: "need_decision", message: "Can I proceed?" }, undefined);
  const requestFiles = readdirSync(join(channelDir, "requests"));
  expect(requestFiles).toHaveLength(1);
  const request = JSON.parse(readFileSync(join(channelDir, "requests", requestFiles[0]!), "utf-8"));
  expect(request.type).toBe("pico.supervisor.request");
  expect(request.reason).toBe("need_decision");
  expect(request.expectsReply).toBe(true);
  expect(request.message).toContain("Can I proceed?");
  expect(request.orchestratorSessionId).toBe("session-1");

  writeFileSync(
    join(channelDir, "replies", `${request.id}.json`),
    JSON.stringify({ type: "pico.supervisor.reply", requestId: request.id, createdAt: Date.now(), message: "Go ahead" }),
  );
  const result = await pending;
  expect(result.content[0].text).toContain("Go ahead");
});

test("contact_supervisor progress_update is fire-and-forget", async () => {
  setChildEnv();
  createChannelDir("run-test", "worker", 0);
  const pi = makeFakePi();
  registerChildSupervisorTool(pi);
  const tool = registerTool(pi, "contact_supervisor");

  const result = await tool.execute!("t", { reason: "progress_update", message: "UPDATE: 50%" }, undefined);
  expect(result.content[0].text).toContain("queued");
  const channelDir = process.env[SUBAGENT_CHANNEL_DIR_ENV]!;
  expect(readdirSync(join(channelDir, "requests"))).toHaveLength(1);
});

test("contact_supervisor times out when no reply arrives and cleans the request", async () => {
  setChildEnv();
  process.env.PICO_SUPERVISOR_ASK_TIMEOUT_MS = "50";
  createChannelDir("run-test", "worker", 0);
  const pi = makeFakePi();
  registerChildSupervisorTool(pi);
  const tool = registerTool(pi, "contact_supervisor");

  await expect(tool.execute!("t", { reason: "need_decision", message: "?" }, undefined)).rejects.toThrow(/Timed out/);
  const channelDir = process.env[SUBAGENT_CHANNEL_DIR_ENV]!;
  expect(readdirSync(join(channelDir, "requests"))).toHaveLength(0);
});

test("contact_supervisor aborts when the signal fires", async () => {
  setChildEnv();
  process.env.PICO_SUPERVISOR_ASK_TIMEOUT_MS = "5000";
  createChannelDir("run-test", "worker", 0);
  const pi = makeFakePi();
  registerChildSupervisorTool(pi);
  const tool = registerTool(pi, "contact_supervisor");

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await expect(tool.execute!("t", { reason: "need_decision", message: "?" }, controller.signal)).rejects.toThrow(/cancelled/);
});

test("contact_supervisor interview_request parses structured replies", async () => {
  setChildEnv();
  createChannelDir("run-test", "worker", 0);
  const pi = makeFakePi();
  registerChildSupervisorTool(pi);
  const tool = registerTool(pi, "contact_supervisor");

  const pending = tool.execute!(
    "t",
    { reason: "interview_request", message: "need shape", interview: { title: "T", questions: [{ q: "a" }] } },
    undefined,
  );
  const channelDir = process.env[SUBAGENT_CHANNEL_DIR_ENV]!;
  const requestFiles = readdirSync(join(channelDir, "requests"));
  const request = JSON.parse(readFileSync(join(channelDir, "requests", requestFiles[0]!), "utf-8"));
  expect(request.message).toContain('"questions"');

  writeFileSync(
    join(channelDir, "replies", `${request.id}.json`),
    JSON.stringify({ type: "pico.supervisor.reply", requestId: request.id, createdAt: Date.now(), message: '```json\n{"ok":true}\n```' }),
  );
  const result = await pending;
  expect(result.details.structuredReply).toEqual({ ok: true });
});

// ── 父侧：轮询器唤醒 + subagent_supervisor 工具 ────────────────────────────

test("parent poller wakes the session via sendMessage with triggerTurn", async () => {
  const pi = makeFakePi();
  const channel = createSupervisorChannel(pi);
  const runId = createRunId();
  const channelDir = createChannelDir(runId, "worker", 0);
  channel.start("session-1");
  writeSupervisorRequest(channelDir, "session-1", runId);

  await tickUntil(() => pi.sent.length === 1);
  const sent = pi.sent[0]!;
  expect(sent.message.customType).toBe("subagent_supervisor_request");
  expect(sent.options?.triggerTurn).toBe(true);
  expect(sent.message.details.agent).toBe("worker");
  expect(sent.message.display).toBe(true);
  channel.dispose();
});

test("parent poller ignores requests from other sessions", async () => {
  const pi = makeFakePi();
  const channel = createSupervisorChannel(pi);
  const runId = createRunId();
  const channelDir = createChannelDir(runId, "worker", 0);
  channel.start("session-A");
  writeSupervisorRequest(channelDir, "session-B", runId);
  await new Promise((r) => setTimeout(r, 30));
  expect(pi.sent).toHaveLength(0);
  channel.dispose();
});

test("parent poller cleans up expired requests without waking", async () => {
  const pi = makeFakePi();
  const channel = createSupervisorChannel(pi);
  const tool = registerTool(pi, "subagent_supervisor");
  const runId = createRunId();
  const channelDir = createChannelDir(runId, "worker", 0);
  channel.start("session-1");
  writeSupervisorRequest(channelDir, "session-1", runId, { expiresAt: Date.now() - 1000 });
  // 触发一次 poll（工具执行内会先 poll）；过期请求被删除且不唤醒。
  await tool.execute!("t", { action: "status" });
  expect(pi.sent).toHaveLength(0);
  expect(readdirSync(join(channelDir, "requests"))).toHaveLength(0);
  channel.dispose();
});

test("subagent_supervisor lists and replies to pending requests", async () => {
  const pi = makeFakePi();
  const channel = createSupervisorChannel(pi);
  const tool = registerTool(pi, "subagent_supervisor");
  const runId = createRunId();
  const channelDir = createChannelDir(runId, "worker", 0);
  channel.start("session-1");
  const requestId = writeSupervisorRequest(channelDir, "session-1", runId);
  await tickUntil(() => pi.sent.length === 1);

  const pendingResult = await tool.execute!("t", { action: "pending" });
  expect(pendingResult.content[0].text).toContain(requestId);

  const replyResult = await tool.execute!("t", { action: "reply", replyTo: requestId, message: "Approved" });
  expect(replyResult.content[0].text).toContain(requestId);
  const replies = readdirSync(join(channelDir, "replies"));
  expect(replies).toHaveLength(1);
  const reply = JSON.parse(readFileSync(join(channelDir, "replies", replies[0]!), "utf-8"));
  expect(reply.message).toBe("Approved");
  expect(readdirSync(join(channelDir, "requests"))).toHaveLength(0);
  channel.dispose();
});

test("subagent_supervisor status reports the pending count", async () => {
  const pi = makeFakePi();
  const channel = createSupervisorChannel(pi);
  const tool = registerTool(pi, "subagent_supervisor");
  const runId = createRunId();
  const channelDir = createChannelDir(runId, "worker", 0);
  channel.start("session-1");
  writeSupervisorRequest(channelDir, "session-1", runId);
  await tickUntil(() => pi.sent.length === 1);

  const result = await tool.execute!("t", { action: "status" });
  expect(result.content[0].text).toContain("1");
  channel.dispose();
});

test("dispose clears the channel root", async () => {
  const pi = makeFakePi();
  const channel = createSupervisorChannel(pi);
  createChannelDir(createRunId(), "worker", 0);
  channel.start("session-1");
  expect(existsSync(testRoot)).toBe(true);
  channel.dispose();
  expect(existsSync(testRoot)).toBe(false);
});

test("subagentChildEnv merges supervisor channel overrides and bumps depth", () => {
  const env = subagentChildEnv({ [SUBAGENT_CHANNEL_DIR_ENV]: "/tmp/ch" });
  expect(env[SUBAGENT_CHANNEL_DIR_ENV]).toBe("/tmp/ch");
  expect(env.PICO_SUBAGENT_DEPTH).toBe("1");
});
