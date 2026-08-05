/**
 * Plan extension unit tests.
 *
 * Cover the state machine that runs in `src/extensions/plan/index.ts`:
 *   - default state: planActive=false, tool_call doesn't block
 *   - EnterPlanMode flips planActive=true and seeds the plan file
 *   - while active, non-read/plan tools are blocked
 *     with a reason that mentions plan mode
 *   - read-only tools (read/grep/find/ls) are NOT blocked
 *   - ExitPlanMode in non-UI mode stays in plan mode unless explicitly opted in
 *
 * We exercise the extension with a hand-rolled `fakePi` that records the
 * registered tools and event handlers, then drives them directly.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetPlanStateForTests,
  __getPlanStateForTests,
  planExtension,
} from "../src/extensions/plan/index.ts";

interface FakePi {
  tools: Map<string, any>;
  commands: Map<string, any>;
  handlers: Record<string, Array<(event: any, ctx: any) => any>>;
}

function makeFakePi(): FakePi & {
  on: (...a: any[]) => void;
  registerTool: (t: any) => void;
  registerCommand: (n: string, opts: any) => void;
  sendMessage: (...a: any[]) => void;
} {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
  return {
    tools,
    commands,
    handlers,
    on: (event: string, handler: (e: any, c: any) => any) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (n: string, opts: any) => commands.set(n, opts),
    sendMessage: () => {},
  };
}

function makeCtx(opts: {
  sessionId?: string;
  hasUI?: boolean;
  confirm?: (title: string, msg: string) => Promise<boolean>;
} = {}) {
  return {
    sessionManager: {
      getSessionId: () => opts.sessionId ?? "test-session",
    },
    hasUI: opts.hasUI ?? false,
    ui: {
      confirm: opts.confirm ?? (async () => true),
      notify: () => {},
    },
  };
}

let tmpRoot: string;
let prevHome: string | undefined;

beforeEach(() => {
  __resetPlanStateForTests();
  // Redirect plan files to a tmp dir so the tests don't touch the user's
  // real ~/.pico/plans/ directory.
  tmpRoot = mkdtempSync(join(tmpdir(), "pico-plan-test-"));
  prevHome = process.env.PICO_HOME;
  process.env.PICO_HOME = tmpRoot;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = prevHome;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
  __resetPlanStateForTests();
});

test("by default planActive=false and tool_call does not block bash", async () => {
  const pi = makeFakePi();
  planExtension(pi as any);
  expect(__getPlanStateForTests().planActive).toBe(false);

  const handler = pi.handlers["tool_call"]![0]!;
  const result = await handler(
    { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "ls" } },
    makeCtx(),
  );
  expect(result).toBeUndefined();
});

test("EnterPlanMode flips planActive=true, seeds plan file, returns its path", async () => {
  const pi = makeFakePi();
  planExtension(pi as any);
  const enter = pi.tools.get("EnterPlanMode")!;
  const ctx = makeCtx({ sessionId: "abc" });

  const result = await enter.execute("call-1", {}, undefined, undefined, ctx);

  expect(__getPlanStateForTests().planActive).toBe(true);
  const expectedPath = join(tmpRoot, "plans", "abc.md");
  expect(__getPlanStateForTests().planFile).toBe(expectedPath);
  expect(result.details.planFile).toBe(expectedPath);
  // Plan file should now exist with the seed template.
  const content = await Bun.file(expectedPath).text();
  expect(content).toContain("# Plan");
});

test("while plan mode is active, non-read and non-plan tools are blocked", async () => {
  const pi = makeFakePi();
  planExtension(pi as any);
  await pi.tools.get("EnterPlanMode")!.execute("c", {}, undefined, undefined, makeCtx());
  const handler = pi.handlers["tool_call"]![0]!;

  for (const toolName of ["bash", "edit", "write", "NotebookEdit", "memory", "subagent", "webSearch"]) {
    const result = await handler(
      { type: "tool_call", toolCallId: "t", toolName, input: {} },
      makeCtx(),
    );
    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/plan mode/i);
  }
});

test("read/grep/find/ls and plan tools are NOT blocked while plan mode is active", async () => {
  const pi = makeFakePi();
  planExtension(pi as any);
  await pi.tools.get("EnterPlanMode")!.execute("c", {}, undefined, undefined, makeCtx());
  const handler = pi.handlers["tool_call"]![0]!;

  for (const toolName of ["read", "grep", "find", "ls", "SubmitPlan", "ExitPlanMode"]) {
    const result = await handler(
      { type: "tool_call", toolCallId: "t", toolName, input: {} },
      makeCtx(),
    );
    expect(result).toBeUndefined();
  }
});

test("SubmitPlan saves plan content for ExitPlanMode approval", async () => {
  const pi = makeFakePi();
  planExtension(pi as any);
  const ctx = makeCtx({
    sessionId: "submit-test",
    hasUI: true,
    confirm: async (_title, msg) => msg.includes("1. Inspect\n2. Verify"),
  });

  await pi.tools.get("EnterPlanMode")!.execute("c1", {}, undefined, undefined, ctx);
  const submit = await pi.tools.get("SubmitPlan")!.execute(
    "c2",
    { content: "1. Inspect\n2. Verify" },
    undefined,
    undefined,
    ctx,
  );
  const expectedPath = join(tmpRoot, "plans", "submit-test.md");

  expect(submit.details.planFile).toBe(expectedPath);
  expect(await Bun.file(expectedPath).text()).toBe("1. Inspect\n2. Verify\n");

  const exit = await pi.tools.get("ExitPlanMode")!.execute("c3", {}, undefined, undefined, ctx);
  expect(exit.details.approved).toBe(true);
  expect(exit.details.plan).toContain("1. Inspect");
  expect(__getPlanStateForTests().planActive).toBe(false);
});

test("SubmitPlan fails outside plan mode", async () => {
  const pi = makeFakePi();
  planExtension(pi as any);

  const run = pi.tools.get("SubmitPlan")!.execute(
    "c",
    { content: "1. nope" },
    undefined,
    undefined,
    makeCtx(),
  );

  // Tool failures are expressed by throwing: the agent loop derives the
  // isError flag from thrown exceptions, not from returned objects.
  await expect(run).rejects.toThrow("not active");
});

test("ExitPlanMode in non-UI mode requires explicit unattended opt-in", async () => {
  const pi = makeFakePi();
  planExtension(pi as any);
  const ctx = makeCtx({ sessionId: "exit-test", hasUI: false });
  await pi.tools.get("EnterPlanMode")!.execute("c1", {}, undefined, undefined, ctx);
  expect(__getPlanStateForTests().planActive).toBe(true);

  const exit = pi.tools.get("ExitPlanMode")!;
  const result = await exit.execute("c2", {}, undefined, undefined, ctx);

  expect(result.details.approved).toBe(false);
  expect(result.details.plan).toMatch(/# Plan/);
  expect(result.content[0].text).toContain("PICO_ALLOW_UNATTENDED_PLAN_APPROVAL");
  expect(__getPlanStateForTests().planActive).toBe(true);
});

test("ExitPlanMode in non-UI mode can be explicitly approved by env", async () => {
  const prev = process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL;
  process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL = "1";
  try {
    const pi = makeFakePi();
    planExtension(pi as any);
    const ctx = makeCtx({ sessionId: "exit-env-test", hasUI: false });
    await pi.tools.get("EnterPlanMode")!.execute("c1", {}, undefined, undefined, ctx);

    const result = await pi.tools.get("ExitPlanMode")!.execute("c2", {}, undefined, undefined, ctx);

    expect(result.details.approved).toBe(true);
    expect(__getPlanStateForTests().planActive).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL;
    else process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL = prev;
  }
});

test("ExitPlanMode honours ctx.ui.confirm when hasUI=true", async () => {
  const pi = makeFakePi();
  planExtension(pi as any);
  let asked = false;
  const ctx = makeCtx({
    hasUI: true,
    confirm: async () => {
      asked = true;
      return false; // user declines
    },
  });
  await pi.tools.get("EnterPlanMode")!.execute("c1", {}, undefined, undefined, ctx);

  const result = await pi.tools.get("ExitPlanMode")!.execute("c2", {}, undefined, undefined, ctx);

  expect(asked).toBe(true);
  expect(result.details.approved).toBe(false);
  // Rejected → stay in plan mode.
  expect(__getPlanStateForTests().planActive).toBe(true);
});

test("before_agent_start appends the PLAN_MODE_BLOCK while active and not while inactive", async () => {
  const pi = makeFakePi();
  planExtension(pi as any);
  const handler = pi.handlers["before_agent_start"]![0]!;

  // Inactive: handler returns nothing, system prompt unchanged.
  const inactive = await handler({ systemPrompt: "BASE" }, makeCtx());
  expect(inactive).toBeUndefined();

  // Activate then check injection.
  await pi.tools.get("EnterPlanMode")!.execute("c", {}, undefined, undefined, makeCtx({ sessionId: "inj" }));
  const active = await handler({ systemPrompt: "BASE" }, makeCtx());
  expect(active).toBeDefined();
  expect(active.systemPrompt).toContain("BASE");
  expect(active.systemPrompt).toMatch(/计划模式已激活/);
  expect(active.systemPrompt).toContain("SubmitPlan");
  expect(active.systemPrompt).toContain("inj.md");
});

test("/plan command flips planActive=true", async () => {
  const pi = makeFakePi();
  planExtension(pi as any);
  const planCmd = pi.commands.get("plan")!;
  expect(planCmd).toBeDefined();
  await planCmd.handler("", makeCtx({ sessionId: "via-cmd" }));
  expect(__getPlanStateForTests().planActive).toBe(true);
  expect(__getPlanStateForTests().planFile).toBe(
    join(tmpRoot, "plans", "via-cmd.md"),
  );
});

// ---- plan_mode_changed event publishing (P1) ------------------------------

import { __resetExtensionEventsForTests, subscribeExtensionEvent } from "../src/extensions/events.ts";

function collectPlanModeEvents(): Array<{ active: boolean }> {
  const events: Array<{ active: boolean }> = [];
  subscribeExtensionEvent("plan_mode_changed", (event) => events.push(event));
  return events;
}

test("EnterPlanMode publishes plan_mode_changed active=true", async () => {
  __resetExtensionEventsForTests();
  const pi = makeFakePi();
  planExtension(pi as any);
  const events = collectPlanModeEvents();

  const tool = pi.tools.get("EnterPlanMode");
  await tool.execute("id", {}, new AbortController().signal, () => {}, { cwd: "/repo", sessionManager: { getSessionId: () => "s1" } });

  expect(events).toEqual([{ active: true }]);
  __resetExtensionEventsForTests();
});

test("ExitPlanMode approval publishes plan_mode_changed active=false", async () => {
  __resetExtensionEventsForTests();
  const pi = makeFakePi();
  planExtension(pi as any);
  const events = collectPlanModeEvents();

  const enter = pi.tools.get("EnterPlanMode");
  await enter.execute("id", {}, new AbortController().signal, () => {}, { cwd: "/repo", sessionManager: { getSessionId: () => "s1" } });

  const exit = pi.tools.get("ExitPlanMode");
  await exit.execute("id", {}, new AbortController().signal, () => {}, {
    cwd: "/repo",
    sessionManager: { getSessionId: () => "s1" },
    hasUI: true,
    ui: { confirm: async () => true },
  });

  expect(events).toEqual([{ active: true }, { active: false }]);
  __resetExtensionEventsForTests();
});

test("/plan command publishes plan_mode_changed active=true", async () => {
  __resetExtensionEventsForTests();
  const pi = makeFakePi();
  planExtension(pi as any);
  const events = collectPlanModeEvents();

  await pi.commands.get("plan").handler("", { cwd: "/repo", ui: { notify: () => {} } });

  expect(events).toEqual([{ active: true }]);
  __resetExtensionEventsForTests();
});
