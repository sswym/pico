/**
 * Smoke tests for subagent extension wiring.
 *
 * Avoid spawning real `pi` subprocesses — just confirm the factory registers
 * the right tool, and that `discoverAgents` finds the four bundled roles.
 */
import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describeSiblingResults, runSubagentRequest, waitForSubagentJobs, __resetSessionSpawnCountsForTests } from "../src/extensions/subagent/orchestrator.ts";
import { applyDenyTools, discoverAgents, KNOWN_CHILD_TOOLS } from "../src/extensions/subagent/agents.ts";
import { buildChainTask, findUnresolvedChainReferences } from "../src/extensions/subagent/chain.ts";
import { mapWithConcurrencyLimit, acquireChildSlot, __resetChildSlotsForTests } from "../src/extensions/subagent/concurrency.ts";
import { applyOverrides, resolveDenyAgents, resolveDenyTools } from "../src/extensions/subagent/config.ts";
import { isProviderFailure, runWithFallbackModels } from "../src/extensions/subagent/fallback.ts";
import {
  buildRepairTask,
  checkAcceptanceGate,
  markGateFailed,
  runGateAfterSuccess,
  summarizeGateFailure,
  type GateResult,
} from "../src/extensions/subagent/gates.ts";
import subagentExtension from "../src/extensions/subagent/index.ts";
import { __resetJobsForTests, cancelRunningJobs, createJobId, failJob, getJob, registerJob, settleJob, waitForJobs } from "../src/extensions/subagent/jobs.ts";
import { spillLargeFileOnlyOutput } from "../src/extensions/subagent/output.ts";
import {
  createParallelPlaceholders,
  formatParallelProgress,
  summarizeParallelResults,
} from "../src/extensions/subagent/parallel.ts";
import {
  applyProcessExit,
  buildAgentProcessArgs,
  createInitialResult,
  createUnknownAgentResult,
  runJsonProcess,
  type SpawnedProcessLike,
} from "../src/extensions/subagent/process.ts";
import { missingPrintPrompt } from "../src/runtime/print-guard.ts";
import {
  formatUsageStats,
  renderSubagentCall,
  renderSubagentResult,
  renderSubagentWaitCall,
} from "../src/extensions/subagent/renderer.ts";
import { applyJsonModeLine } from "../src/extensions/subagent/runner.ts";
import {
  getDisplayItems,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  truncateOutput,
  type SingleResult,
} from "../src/extensions/subagent/results.ts";
import { tryForkSession } from "../src/extensions/subagent/session.ts";
import {
  cleanupWorktrees,
  createWorktree,
  mergeParallelWorktrees,
  mergeWorktree,
  prepareParallelWorktrees,
  sanitizeAgentNameForWorktree,
  type WorktreeHandle,
} from "../src/extensions/subagent/worktree.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

class FakeProcess implements SpawnedProcessLike {
  killed = false;
  kills: string[] = [];
  stdoutHandlers: Array<(data: unknown) => void> = [];
  stderrHandlers: Array<(data: unknown) => void> = [];
  closeHandlers: Array<(code: number | null) => void> = [];
  exitHandlers: Array<(code: number | null) => void> = [];
  errorHandlers: Array<(error: unknown) => void> = [];
  stdout = {
    on: (_event: "data", handler: (data: unknown) => void) => {
      this.stdoutHandlers.push(handler);
    },
  };
  stderr = {
    on: (_event: "data", handler: (data: unknown) => void) => {
      this.stderrHandlers.push(handler);
    },
  };
  on(event: "close" | "error" | "exit", handler: any): void {
    if (event === "close") this.closeHandlers.push(handler);
    else if (event === "exit") this.exitHandlers.push(handler);
    else this.errorHandlers.push(handler);
  }
  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.killed = true;
    this.kills.push(signal);
  }
  stdoutData(data: string): void {
    for (const handler of this.stdoutHandlers) handler(data);
  }
  stderrData(data: string): void {
    for (const handler of this.stderrHandlers) handler(data);
  }
  close(code: number | null): void {
    for (const handler of this.closeHandlers) handler(code);
  }
  exit(code: number | null): void {
    for (const handler of this.exitHandlers) handler(code);
  }
  error(error: unknown): void {
    for (const handler of this.errorHandlers) handler(error);
  }
}

test("subagent extension registers the 'subagent' tool and delegates invalid requests", async () => {
  const tools: Array<{ name: string; execute?: (...args: any[]) => Promise<any> }> = [];
  const fakePi: any = {
    on: () => {},
    registerTool: (t: { name: string; execute?: (...args: any[]) => Promise<any> }) => tools.push(t),
    registerCommand: () => {},
    sendMessage: () => {},
  };
  await subagentExtension(fakePi);
  expect(tools.map((t) => t.name)).toContain("subagent");

  const tool = tools.find((t) => t.name === "subagent")!;
  const result = await tool.execute!("tool-1", {}, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: false,
    ui: { confirm: async () => true },
  });
  expect(result.content[0].text).toContain("Invalid parameters. Provide exactly one mode.");
  expect(result.content[0].text).toContain("Available agents:");
});

test("discoverAgents finds the six bundled roles under user scope", () => {
  const result = discoverAgents(process.cwd(), "user");
  const names = new Set(result.agents.map((a) => a.name));
  expect(names.has("scout")).toBe(true);
  expect(names.has("planner")).toBe(true);
  expect(names.has("worker")).toBe(true);
  expect(names.has("reviewer")).toBe(true);
  expect(names.has("oracle")).toBe(true);
  expect(names.has("researcher")).toBe(true);

  // Source must be "user" — bundled agents are loaded under user scope so
  // they're available without symlinking into ~/.pico/agent.
  for (const a of result.agents) expect(a.source).toBe("user");
});

test("worker bundled agent advertises memory in its tools allowlist", () => {
  const result = discoverAgents(process.cwd(), "user");
  const worker = result.agents.find((a) => a.name === "worker");
  expect(worker).toBeDefined();
  // worker.md has no `tools:` frontmatter, so tools is undefined ⇒ defaults
  // unrestricted. memory tool is reachable. We assert the system prompt does
  // mention memory so the LLM knows to use it.
  expect(worker!.systemPrompt).toMatch(/memory/i);
});

test("mapWithConcurrencyLimit preserves result order while respecting concurrency", async () => {
  let running = 0;
  let maxRunning = 0;
  const results = await mapWithConcurrencyLimit([30, 10, 20, 5], 2, async (delay, index) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, delay));
    running--;
    return `item-${index}`;
  });

  expect(results).toEqual(["item-0", "item-1", "item-2", "item-3"]);
  expect(maxRunning).toBeLessThanOrEqual(2);
});

test("mapWithConcurrencyLimit waits for sibling workers and calls onFailure on error", async () => {
  let siblingFinished = false;
  let onFailureCalled = 0;
  const run = mapWithConcurrencyLimit(
    [0, 1, 2],
    3,
    async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay * 20));
      if (delay === 1) throw new Error("boom");
      siblingFinished = true;
      return "ok";
    },
    () => onFailureCalled++,
  );

  await expect(run).rejects.toThrow("boom");
  // The error must not be propagated until every worker has settled.
  expect(siblingFinished).toBe(true);
  expect(onFailureCalled).toBe(1);
});

test("tryForkSession returns branched session path when manager supports it", () => {
  const calls: string[] = [];
  const result = tryForkSession({
    getLeafId: () => "leaf-123",
    createBranchedSession: (leafId: string) => {
      calls.push(leafId);
      return "/tmp/session.json";
    },
  });

  expect(result).toBe("/tmp/session.json");
  expect(calls).toEqual(["leaf-123"]);
});

test("tryForkSession returns undefined when forking is unavailable or invalid", () => {
  expect(tryForkSession(null)).toBeUndefined();
  expect(tryForkSession({ getLeafId: () => undefined })).toBeUndefined();
  expect(tryForkSession({ getLeafId: () => "leaf" })).toBeUndefined();
  expect(tryForkSession({
    getLeafId: () => "leaf",
    createBranchedSession: () => "",
  })).toBeUndefined();
  expect(tryForkSession({
    getLeafId: () => "leaf",
    createBranchedSession: () => {
      throw new Error("nope");
    },
  })).toBeUndefined();
});

test("subagent result helpers extract final output and display items", () => {
  const messages: any[] = [
    { role: "assistant", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] },
    { role: "assistant", content: [{ type: "text", text: "final" }] },
  ];

  expect(getFinalOutput(messages)).toBe("final");
  expect(getDisplayItems(messages)).toEqual([
    { type: "text", text: "first" },
    { type: "toolCall", name: "read", args: { path: "a.ts" } },
    { type: "text", text: "final" },
  ]);
});

test("subagent result helpers classify failures and choose failure output", () => {
  const result: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "do it",
    exitCode: 1,
    messages: [{ role: "assistant", content: [{ type: "text", text: "assistant output" }] } as any],
    stderr: "stderr output",
    errorMessage: "explicit error",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  expect(isFailedResult(result)).toBe(true);
  expect(getResultOutput(result)).toBe("explicit error");
});

test("truncateOutput respects byte cap and keeps unicode boundaries valid", () => {
  const output = "a".repeat(10) + "界".repeat(10);
  const truncated = truncateOutput(output, 16);

  expect(Buffer.byteLength(truncated.split("\n\n[Output truncated:")[0]!, "utf8")).toBeLessThanOrEqual(16);
  expect(truncated).toContain("Output truncated");
});

test("subagent renderer formats usage and call previews", () => {
  expect(formatUsageStats({
    input: 1200,
    output: 42,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.01234,
    contextTokens: 5000,
    turns: 2,
  }, "test-model")).toBe("2 turns ↑1.2k ↓42 $0.0123 ctx:5.0k test-model");

  const rendered: any = renderSubagentCall({
    tasks: [
      { agent: "scout", task: "inspect files" },
      { agent: "reviewer", task: "review output" },
    ],
    agentScope: "both",
  }, plainTheme);
  expect(String(rendered.text ?? rendered.content ?? rendered)).toContain("parallel (2 tasks)");
});

test("subagent renderer handles empty result details", () => {
  const rendered: any = renderSubagentResult({
    content: [{ type: "text", text: "plain output" }],
    details: undefined,
  }, false, plainTheme);
  expect(String(rendered.text ?? rendered.content ?? rendered)).toContain("plain output");
});

test("subagent renderer counts gate-failed chain steps as failed", () => {
  const base = {
    agent: "worker",
    agentSource: "user" as const,
    task: "t",
    exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: "out" }] }],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
  const gateFailed = { ...base, step: 1, stopReason: "gate_failed", errorMessage: "gate failed" };
  const ok = { ...base, step: 2 };

  const rendered: any = renderSubagentResult(
    {
      content: [{ type: "text", text: "chain" }],
      details: { mode: "chain", agentScope: "user", projectAgentsDir: null, results: [gateFailed, ok] },
    },
    true,
    plainTheme,
  );
  const text = String(rendered.text ?? rendered.content ?? rendered);
  // gate_failed keeps exitCode 0, so an exitCode-based count would report 2/2;
  // isFailedResult must drive the status.
  expect(text).toContain("1/2 steps");
  expect(text).toContain("Step 1: worker ✗");
  expect(text).toContain("Step 2: worker ✓");
});

test("subagent renderer marks live single-run updates as running, not success", () => {
  const base = {
    agent: "scout",
    agentSource: "user" as const,
    task: "research",
    exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: "interim" }] }],
    stderr: "",
    usage: { input: 512, output: 128, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3000, turns: 1 },
  };
  const details = { mode: "single" as const, agentScope: "user" as const, projectAgentsDir: null, results: [base] };

  // Live partial: must show running markers, never ✓ (exitCode still 0).
  const live: any = renderSubagentResult(
    { content: [{ type: "text", text: "(running...)" }], details },
    false,
    plainTheme,
    { isPartial: true },
  );
  const liveText = String(live.text ?? live.content ?? live);
  expect(liveText).toContain("运行中");
  expect(liveText).toContain("进行中 1 turn ↑512 ↓128 ctx:3.0k");
  expect(liveText).not.toContain("✓");

  // Final: plain success, no running markers.
  const done: any = renderSubagentResult(
    { content: [{ type: "text", text: "done" }], details },
    false,
    plainTheme,
  );
  const doneText = String(done.text ?? done.content ?? done);
  expect(doneText).not.toContain("运行中");
  expect(doneText).not.toContain("进行中");
  expect(doneText).toContain("✓");
});

test("subagent runner applies json mode message and tool-result events", () => {
  const result: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  const assistantEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      model: "m",
      stopReason: "end",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 99,
        cost: { total: 0.001 },
      },
      content: [{ type: "text", text: "done" }],
    },
  });
  const toolEvent = JSON.stringify({
    type: "tool_result_end",
    message: { role: "tool", content: [{ type: "text", text: "tool output" }] },
  });

  expect(applyJsonModeLine(result, assistantEvent)).toBe(true);
  expect(applyJsonModeLine(result, toolEvent)).toBe(true);
  expect(applyJsonModeLine(result, "not-json")).toBe(false);

  expect(result.messages).toHaveLength(2);
  expect(result.model).toBe("m");
  expect(result.stopReason).toBe("end");
  expect(result.usage).toEqual({
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
    cost: 0.001,
    contextTokens: 99,
    turns: 1,
  });
});

test("process helpers build initial and unknown-agent results", () => {
  const agent = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
    model: "model-a",
  };

  const initial = createInitialResult(agent, "worker", "run", 2);
  expect(initial).toMatchObject({
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 0,
    model: "model-a",
    step: 2,
  });
  expect(initial.usage.turns).toBe(0);

  const unknown = createUnknownAgentResult("missing", "run", [agent], 3);
  expect(unknown.exitCode).toBe(1);
  expect(unknown.agentSource).toBe("unknown");
  expect(unknown.stderr).toBe('Unknown agent: "missing". Call subagent with list: true to enumerate available agents.');
  expect(unknown.step).toBe(3);
});

test("process helpers build process args and apply timeout exits", () => {
  const agent = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
    model: "model-a",
    tools: ["read", "grep"],
    maxTokens: 1024,
    thinking: "medium",
  };

  expect(buildAgentProcessArgs(agent, "do work", "/tmp/session.json", "/tmp/prompt.md", undefined)).toEqual([
    "--mode",
    "json",
    "-p",
    "--session",
    "/tmp/session.json",
    "--model",
    "model-a",
    "--tools",
    "read,grep,contact_supervisor",
    "--max-tokens",
    "1024",
    "--thinking",
    "medium",
    "--append-system-prompt",
    "/tmp/prompt.md",
    "Task: do work",
  ]);
  expect(
    buildAgentProcessArgs({ ...agent, tools: undefined }, "do work", undefined, undefined, undefined),
  ).toContain("--no-session");
  // A plain session file (no fork) also switches to --session.
  expect(
    buildAgentProcessArgs(agent, "do work", undefined, undefined, "/tmp/plain-session.jsonl"),
  ).toEqual(
    expect.arrayContaining(["--session", "/tmp/plain-session.jsonl"]),
  );
  expect(
    buildAgentProcessArgs(agent, "do work", "/tmp/fork.jsonl", undefined, "/tmp/plain-session.jsonl"),
  ).toEqual(
    expect.arrayContaining(["--session", "/tmp/fork.jsonl"]),
  );

  const result = createInitialResult(agent, "worker", "run", undefined);
  applyProcessExit(result, 1, true, 2500, undefined);
  expect(result.exitCode).toBe(1);
  expect(result.stopReason).toBe("timeout");
  expect(result.errorMessage).toBe("Agent exceeded maxExecutionTimeMs (2500ms)");

  const budgetResult = createInitialResult(agent, "worker", "run", undefined);
  budgetResult.stopReason = "budget";
  applyProcessExit(budgetResult, 1, false, 2500, 7);
  expect(budgetResult.stopReason).toBe("budget");
  expect(budgetResult.errorMessage).toBe("Agent exceeded request budget (7 requests)");
});

test("process helpers honor systemPromptMode / inheritProjectContext / inheritSkills", () => {
  const agent = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
    model: "model-a",
  };

  const replace = buildAgentProcessArgs(
    { ...agent, systemPromptMode: "replace" },
    "t",
    undefined,
    "/tmp/prompt.md",
    undefined,
  );
  expect(replace).toContain("--system-prompt");
  expect(replace).toContain("/tmp/prompt.md");
  expect(replace).not.toContain("--append-system-prompt");

  const stripped = buildAgentProcessArgs(
    {
      ...agent,
      systemPromptMode: "replace",
      inheritProjectContext: false,
      inheritSkills: false,
    },
    "t",
    undefined,
    "/tmp/prompt.md",
    undefined,
  );
  expect(stripped).toContain("--no-context-files");
  expect(stripped).toContain("--no-skills");

  const defaults = buildAgentProcessArgs(agent, "t", undefined, "/tmp/prompt.md", undefined);
  expect(defaults).toContain("--append-system-prompt");
  expect(defaults).not.toContain("--system-prompt");
  expect(defaults).not.toContain("--no-context-files");
  expect(defaults).not.toContain("--no-skills");
});

test("runJsonProcess parses streamed json lines and captures stderr", async () => {
  const agent = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
  };
  const result = createInitialResult(agent, "worker", "run", undefined);
  const proc = new FakeProcess();
  let updates = 0;
  const run = runJsonProcess({
    command: "pico",
    args: ["--mode", "json"],
    cwd: "/repo",
    result,
    spawn: () => proc,
    onMessage: () => {
      updates++;
    },
  });

  proc.stdoutData('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hel');
  proc.stdoutData('lo"}],"usage":{"input":1,"output":2}}}\nnot-json\n');
  proc.stderrData("warn\n");
  proc.close(0);

  const processResult = await run;
  expect(processResult).toEqual({ exitCode: 0, wasAborted: false, timedOut: false, budgetExceeded: false });
  expect(updates).toBe(1);
  expect(getFinalOutput(result.messages)).toBe("hello");
  expect(result.stderr).toBe("warn\n");
  expect(result.usage.input).toBe(1);
  expect(result.usage.output).toBe(2);
});

test("runJsonProcess handles process errors, aborts, and timeouts", async () => {
  const agent = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
  };

  const errorProc = new FakeProcess();
  const errorRun = runJsonProcess({
    command: "pico",
    args: [],
    cwd: "/repo",
    result: createInitialResult(agent, "worker", "run", undefined),
    spawn: () => errorProc,
  });
  errorProc.error(new Error("spawn failed"));
  expect(await errorRun).toEqual({ exitCode: 1, wasAborted: false, timedOut: false, budgetExceeded: false });

  const controller = new AbortController();
  controller.abort();
  const abortProc = new FakeProcess();
  const abortRun = runJsonProcess({
    command: "pico",
    args: [],
    cwd: "/repo",
    result: createInitialResult(agent, "worker", "run", undefined),
    signal: controller.signal,
    spawn: () => abortProc,
    setTimeoutFn: ((handler: () => void) => {
      handler();
      return 1 as any;
    }) as any,
    clearTimeoutFn: (() => {}) as any,
  });
  abortProc.close(null);
  expect(await abortRun).toEqual({ exitCode: 1, wasAborted: true, timedOut: false, budgetExceeded: false });
  // The mocked setTimeoutFn fires the escalation immediately (simulating a
  // process still alive 5s after SIGTERM), so the unconditional SIGKILL
  // escalation must have run.
  expect(abortProc.kills).toEqual(["SIGTERM", "SIGKILL"]);

  let timeoutHandler: (() => void) | undefined;
  const timeoutProc = new FakeProcess();
  const timeoutRun = runJsonProcess({
    command: "pico",
    args: [],
    cwd: "/repo",
    result: createInitialResult(agent, "worker", "run", undefined),
    timeoutMs: 10,
    spawn: () => timeoutProc,
    setTimeoutFn: ((handler: () => void) => {
      timeoutHandler = handler;
      return 1 as any;
    }) as any,
    clearTimeoutFn: (() => {}) as any,
  });
  timeoutHandler!();
  timeoutProc.close(143);
  expect(await timeoutRun).toEqual({ exitCode: 143, wasAborted: false, timedOut: true, budgetExceeded: false });
  expect(timeoutProc.kills).toEqual(["SIGTERM"]);
});

test("runJsonProcess maps signal-death (close with null code) to a non-zero exit", async () => {
  // A child killed by a signal (crash, OOM killer, external kill) reports
  // close(code = null). It must NOT be dressed up as exitCode 0 — that would
  // present a half-finished run as success.
  const agent = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
  };

  const proc = new FakeProcess();
  const run = runJsonProcess({
    command: "pico",
    args: [],
    cwd: "/repo",
    result: createInitialResult(agent, "worker", "run", undefined),
    spawn: () => proc,
  });
  proc.close(null);
  expect(await run).toEqual({ exitCode: 1, wasAborted: false, timedOut: false, budgetExceeded: false });
});

test("runJsonProcess caps the partial-line stdout buffer without dropping later events", async () => {
  const agent = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
  };
  const result = createInitialResult(agent, "worker", "run", undefined);
  let updates = 0;
  const proc = new FakeProcess();
  const run = runJsonProcess({
    command: "pico",
    args: ["--mode", "json"],
    cwd: "/repo",
    result,
    spawn: () => proc,
    onMessage: () => {
      updates++;
    },
  });

  // A giant unterminated line (over the 1 MiB cap) must not wedge parsing —
  // it is dropped, and a subsequent well-formed event still arrives.
  proc.stdoutData(`${"x".repeat(2 * 1024 * 1024)}`);
  proc.stdoutData('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"after"}],"usage":{"input":1,"output":2}}}\n');
  proc.close(0);

  expect(await run).toEqual({ exitCode: 0, wasAborted: false, timedOut: false, budgetExceeded: false });
  expect(updates).toBe(1);
  expect(getFinalOutput(result.messages)).toBe("after");
});

test("runJsonProcess detaches the abort listener when the hang path resolves", async () => {
  // Escaped-grandchild scenario: `exit` fires but `close` never does, so the
  // 10s hang timer resolves the run. The abort listener must be detached on
  // that path too — otherwise a later abort would kill the stale (possibly
  // recycled) pid's process group.
  const agent = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
  };
  const listeners = new Set<() => void>();
  const signal = {
    aborted: false,
    addEventListener: (_ev: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_ev: string, fn: () => void) => { listeners.delete(fn); },
  };
  let hangHandler: (() => void) | undefined;
  const proc = new FakeProcess();
  const run = runJsonProcess({
    command: "pico",
    args: [],
    cwd: "/repo",
    result: createInitialResult(agent, "worker", "run", undefined),
    signal: signal as any,
    spawn: () => proc,
    setTimeoutFn: ((handler: () => void) => {
      hangHandler = handler;
      return 1 as any;
    }) as any,
    clearTimeoutFn: (() => {}) as any,
  });

  expect(listeners.size).toBe(1);
  proc.exit(0); // child gone; close never arrives
  hangHandler!(); // 10s grace elapses — the hang path resolves
  expect(await run).toEqual({ exitCode: 0, wasAborted: false, timedOut: false, budgetExceeded: false });
  expect(listeners.size).toBe(0);
});

test("parallel failure surfaces preserved sibling results in the error", () => {
  const agent = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
  };
  const finished: SingleResult[] = [
    { ...createInitialResult(agent, "worker", "task-a", 1), exitCode: 0, messages: [] },
    { ...createInitialResult(agent, "reviewer", "task-b", 2), exitCode: 1, stopReason: "aborted", errorMessage: "Subagent aborted (user interrupt)" },
  ];
  const err = describeSiblingResults(finished, new Error("boom"));
  expect(err.message).toContain("boom");
  expect(err.message).toContain("Sibling results from before the abort (2)");
  expect(err.message).toContain("[worker]");
  expect(err.message).toContain("[reviewer]");

  // No finished siblings: the original error propagates untouched.
  const bare = describeSiblingResults([], new Error("only-failure"));
  expect(bare.message).toBe("only-failure");
});

test("buildChainTask substitutes previous and named outputs", () => {
  const task = buildChainTask(
    { task: "Use {previous}, {outputs.plan}, and {outputs.missing}." },
    "prior result",
    { plan: "saved plan" },
    () => {
      throw new Error("should not read");
    },
  );

  expect(task).toBe('Use prior result, saved plan, and [CHAIN ERROR: output "missing" not found — the step that defines it must run first, or the name is misspelled].');
});

test("findUnresolvedChainReferences reports names that no step defined", () => {
  const resolved = buildChainTask({ task: "Use {previous} and {outputs.plan}." }, "prior", { plan: "p" }, () => "");
  expect(findUnresolvedChainReferences(resolved)).toEqual([]);

  const broken = buildChainTask(
    { task: "Use {outputs.plan} and {outputs.0}, then {previous}" },
    "prior",
    {},
    () => "",
  );
  expect(findUnresolvedChainReferences(broken).sort()).toEqual(["0", "plan"]);
});

test("buildChainTask caps {previous} to keep downstream context bounded", () => {
  const huge = "x".repeat(100_000);
  const task = buildChainTask({ task: "Refine {previous}" }, huge, {}, () => "");
  expect(task).toContain("[... truncated");
  expect(task.length).toBeLessThan(40_000);
});

test("buildChainTask prepends readable file context and reports read failures", () => {
  const task = buildChainTask(
    { task: "Review files", reads: ["a.ts", "missing.ts"] },
    "",
    {},
    (filePath) => {
      if (filePath === "a.ts") return "const a = 1;";
      throw new Error("not found");
    },
  );

  expect(task).toContain("## Context (read into prompt)");
  expect(task).toContain("--- File: a.ts ---\nconst a = 1;");
  expect(task).toContain("--- File: missing.ts (could not read: not found) ---");
  expect(task).toContain("## Task\n\nReview files");
});

test("parallel helpers create placeholders and format progress", () => {
  const results = createParallelPlaceholders([
    { agent: "worker", task: "one" },
    { agent: "reviewer", task: "two" },
  ]);

  expect(results).toHaveLength(2);
  expect(results[0]!.exitCode).toBe(-1);
  expect(results[0]!.usage.turns).toBe(0);
  expect(formatParallelProgress(results)).toBe("Parallel: 0/2 done, 2 running...");

  results[0]!.exitCode = 0;
  expect(formatParallelProgress(results)).toBe("Parallel: 1/2 done, 1 running...");
});

test("parallel helper summarizes successes, failures, fallback notes, and merge notes", () => {
  const results: SingleResult[] = [
    {
      agent: "worker",
      agentSource: "user",
      task: "implement",
      exitCode: 0,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] } as any],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      contextFallback: "fork unavailable",
    },
    {
      agent: "reviewer",
      agentSource: "user",
      task: "review",
      exitCode: 1,
      messages: [],
      stderr: "bad",
      stopReason: "error",
      errorMessage: "provider failed",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    },
  ];

  const text = summarizeParallelResults(results, 1024, ["task 0 (worker): merged"]);
  expect(text).toContain("Parallel: 1/2 succeeded");
  expect(text).toContain("### [worker] completed");
  expect(text).toContain("_note: fork unavailable_");
  expect(text).toContain("### [reviewer] failed (error)");
  expect(text).toContain("provider failed");
  expect(text).toContain("## Worktree merges");
});

test("isProviderFailure recognizes retryable provider errors only", () => {
  const base: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 1,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  expect(isProviderFailure({ ...base, stopReason: "error", errorMessage: "HTTP 429 rate limit" })).toBe(true);
  expect(isProviderFailure({ ...base, stopReason: "error", errorMessage: "model overloaded" })).toBe(true);
  expect(isProviderFailure({ ...base, stopReason: "timeout", errorMessage: "HTTP 429" })).toBe(false);
  expect(isProviderFailure({ ...base, stopReason: "error", errorMessage: "tool failed" })).toBe(false);
});

test("runWithFallbackModels calls success handler when primary succeeds or has no fallback", async () => {
  const success: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
  let successHandlerCalls = 0;

  const result = await runWithFallbackModels({
    agents: [{
      name: "worker",
      description: "",
      source: "user",
      filePath: "worker.md",
      systemPrompt: "",
      fallbackModels: ["fallback-a"],
    }],
    agentName: "worker",
    context: "ctx",
    run: async () => success,
    onSuccessOrNoFallback: async (_agent, runResult) => {
      successHandlerCalls++;
      return { ...runResult, stopReason: "gate_checked" };
    },
  });

  expect(successHandlerCalls).toBe(1);
  expect(result.stopReason).toBe("gate_checked");
});

test("runWithFallbackModels retries provider failures with fallback models in order", async () => {
  const models: Array<string | undefined> = [];
  const makeFailure = (): SingleResult => ({
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 1,
    messages: [],
    stderr: "",
    stopReason: "error",
    errorMessage: "HTTP 429 rate limit",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  });
  const success: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  const result = await runWithFallbackModels({
    agents: [{
      name: "worker",
      description: "",
      source: "user",
      filePath: "worker.md",
      systemPrompt: "",
      model: "primary",
      fallbackModels: ["fallback-a", "fallback-b"],
    }],
    agentName: "worker",
    context: undefined,
    run: async (agents) => {
      models.push(agents[0]!.model);
      return models.length < 3 ? makeFailure() : success;
    },
    onSuccessOrNoFallback: async (_agent, runResult) => runResult,
  });

  expect(result.exitCode).toBe(0);
  expect(models).toEqual(["primary", "fallback-a", "fallback-b"]);
});

test("runWithFallbackModels runs the success handler (acceptance gate) on fallback success", async () => {
  const makeFailure = (): SingleResult => ({
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 1,
    messages: [],
    stderr: "",
    stopReason: "error",
    errorMessage: "HTTP 429 rate limit",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  });
  const success: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
  let handlerCalls = 0;
  let gateAgentModel: string | undefined;

  const result = await runWithFallbackModels({
    agents: [{
      name: "worker",
      description: "",
      source: "user",
      filePath: "worker.md",
      systemPrompt: "",
      model: "primary",
      fallbackModels: ["fallback-a"],
    }],
    agentName: "worker",
    context: undefined,
    run: async (agents) => (agents[0]!.model === "primary" ? makeFailure() : success),
    onSuccessOrNoFallback: async (agent, runResult) => {
      handlerCalls++;
      gateAgentModel = agent?.model;
      return { ...runResult, stopReason: "gate_checked" };
    },
  });

  expect(handlerCalls).toBe(1);
  expect(gateAgentModel).toBe("fallback-a");
  expect(result.stopReason).toBe("gate_checked");
});

test("runWithFallbackModels does not retry non-provider errors or aborted signals", async () => {
  const toolFailure: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 1,
    messages: [],
    stderr: "",
    stopReason: "error",
    errorMessage: "tool failed",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
  let calls = 0;
  const result = await runWithFallbackModels({
    agents: [{
      name: "worker",
      description: "",
      source: "user",
      filePath: "worker.md",
      systemPrompt: "",
      fallbackModels: ["fallback-a"],
    }],
    agentName: "worker",
    context: undefined,
    run: async () => {
      calls++;
      return toolFailure;
    },
    onSuccessOrNoFallback: async (_agent, runResult) => runResult,
  });

  expect(result).toBe(toolFailure);
  expect(calls).toBe(1);

  const controller = new AbortController();
  controller.abort();
  calls = 0;
  const providerFailure = { ...toolFailure, errorMessage: "HTTP 503 overloaded" };
  const abortedResult = await runWithFallbackModels({
    agents: [{
      name: "worker",
      description: "",
      source: "user",
      filePath: "worker.md",
      systemPrompt: "",
      fallbackModels: ["fallback-a"],
    }],
    agentName: "worker",
    context: undefined,
    signal: controller.signal,
    run: async () => {
      calls++;
      return providerFailure;
    },
    onSuccessOrNoFallback: async (_agent, runResult) => runResult,
  });

  expect(abortedResult).toBe(providerFailure);
  expect(calls).toBe(1);
});

test("spillLargeFileOnlyOutput writes large successful output and replaces final assistant text", async () => {
  const writes: Array<{ filePath: string; content: string }> = [];
  const result: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 0,
    messages: [
      { role: "assistant", content: [{ type: "text", text: "small" }] } as any,
      { role: "assistant", content: [{ type: "text", text: "large output" }] } as any,
    ],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  await spillLargeFileOnlyOutput(result, "bad/name", "file-only", 4, {
    tmpPrefix: "/tmp/out-",
    mkdtemp: async (prefix) => `${prefix}dir`,
    writeFile: async (filePath, content) => {
      writes.push({ filePath, content });
    },
    now: () => 123,
  });

  expect(writes).toEqual([{ filePath: "/tmp/out-dir/output-bad_name-123.md", content: "large output" }]);
  expect(result.outputFile).toBe("/tmp/out-dir/output-bad_name-123.md");
  expect(getFinalOutput(result.messages)).toContain("Output written to file (12 bytes): /tmp/out-dir/output-bad_name-123.md");
  expect(getFinalOutput(result.messages)).toContain("--- Preview (first 2KB) ---\nlarge output");
});

test("spillLargeFileOnlyOutput skips inline mode, small output, and failed results", async () => {
  let writes = 0;
  const makeResult = (exitCode: number, text: string): SingleResult => ({
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode,
    messages: [{ role: "assistant", content: [{ type: "text", text }] } as any],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  });
  const writer = {
    tmpPrefix: "/tmp/out-",
    mkdtemp: async (prefix: string) => `${prefix}dir`,
    writeFile: async () => {
      writes++;
    },
    now: () => 123,
  };

  await spillLargeFileOnlyOutput(makeResult(0, "large output"), "worker", "inline", 4, writer);
  await spillLargeFileOnlyOutput(makeResult(0, "ok"), "worker", "file-only", 4, writer);
  await spillLargeFileOnlyOutput(makeResult(1, "large output"), "worker", "file-only", 4, writer);

  expect(writes).toBe(0);
});

test("sanitizeAgentNameForWorktree strips shell metacharacters", () => {
  expect(sanitizeAgentNameForWorktree("worker")).toBe("worker");
  // Every illegal-character run collapses to a single underscore, so no
  // shell metacharacter survives into the branch/dir names.
  expect(sanitizeAgentNameForWorktree("x; touch /tmp/pwn")).toBe("x_touch_tmp_pwn");
  expect(sanitizeAgentNameForWorktree("$(rm -rf /)")).toBe("_rm_-rf_");
  expect(sanitizeAgentNameForWorktree("foo\"bar")).toBe("foo_bar");
});

test("prepareParallelWorktrees cleans up created handles when later setup fails", async () => {
  const cleaned: string[] = [];
  const create = (_cwd: string, agentName: string, index: number): WorktreeHandle => {
    if (index === 1) throw new Error("cannot create");
    return {
      worktreeDir: `/tmp/${agentName}`,
      branchName: `branch-${index}`,
      cleanup: () => {
        cleaned.push(agentName);
      },
    };
  };

  const prepared = await prepareParallelWorktrees("/repo", [
    { agent: "worker" },
    { agent: "reviewer" },
  ], create);

  expect(prepared.errorText).toBe("Failed to set up git worktrees:\ntask 1 (reviewer): cannot create");
  expect(cleaned).toEqual(["worker"]);
});

test("mergeParallelWorktrees reports skipped, empty, merged, and conflicted worktrees", async () => {
  const makeResult = (agent: string, exitCode: number): SingleResult => ({
    agent,
    agentSource: "user",
    task: "run",
    exitCode,
    messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] } as any],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  });
  const handles: WorktreeHandle[] = [
    { worktreeDir: "/tmp/a", branchName: "a", cleanup: () => {} },
    { worktreeDir: "/tmp/b", branchName: "b", cleanup: () => {} },
    { worktreeDir: "/tmp/c", branchName: "c", cleanup: () => {} },
    { worktreeDir: "/tmp/d", branchName: "d", cleanup: () => {} },
  ];

  const notes = await mergeParallelWorktrees(
    "/repo",
    [makeResult("failed", 1), makeResult("empty", 0), makeResult("merged", 0), makeResult("conflict", 0)],
    handles,
    async (_cwd, branch) => branch === "b" ? "" : `diff for ${branch}\n`,
    async (_cwd, branch) => branch === "d"
      ? { success: false, conflict: "Merge conflict on branch d. Resolve manually." }
      : { success: true },
    async () => true,
  );

  expect(notes).toEqual([
    "task 0 (failed): skipped merge (task failed)",
    "task 1 (empty): no changes to merge",
    "task 2 (merged): merged\ndiff for c",
    "task 3 (conflict): Merge conflict on branch d. Resolve manually.",
  ]);
  // The conflicted branch must survive cleanup for manual resolution; the
  // merged one is safe to delete.
  expect(handles[3]!.keepBranch).toBe(true);
  expect(handles[2]!.keepBranch).toBeUndefined();
});

test("mergeParallelWorktrees warns when worktree changes cannot be committed", async () => {
  const makeResult = (agent: string): SingleResult => ({
    agent,
    agentSource: "user",
    task: "run",
    exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] } as any],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  });

  const notes = await mergeParallelWorktrees(
    "/repo",
    [makeResult("no-commit")],
    [{ worktreeDir: "/tmp/x", branchName: "x", cleanup: () => {} }],
    async () => "diff for x\n",
    async () => ({ success: true }),
    async () => false,
  );

  expect(notes[0]).toContain("could not commit worktree changes");
  expect(notes[0]).toContain("may be lost");
});

function runGit(cwd: string, args: string[]): string {
  return execSync(`git ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("mergeWorktree detects conflicts from stdout and aborts the merge (real git)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pico-wt-conflict-"));
  try {
    runGit(repo, ["init", "-q", "-b", "main"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    runGit(repo, ["config", "user.name", "pico test"]);
    writeFileSync(join(repo, "f.txt"), "base\n");
    runGit(repo, ["add", "f.txt"]);
    runGit(repo, ["commit", "-qm", "base"]);

    runGit(repo, ["checkout", "-qb", "feature"]);
    writeFileSync(join(repo, "f.txt"), "feature change\n");
    runGit(repo, ["commit", "-qam", "feature"]);
    runGit(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "f.txt"), "main change\n");
    runGit(repo, ["commit", "-qam", "main"]);

    // git prints "CONFLICT (content): ..." on stdout — a stderr-only probe
    // never fires, leaving the merge half-applied. The abort must run and
    // the working tree must be clean afterwards.
    const result = await mergeWorktree(repo, "feature");
    expect(result.success).toBe(false);
    expect(result.conflict).toContain("Resolve manually");
    expect(() => runGit(repo, ["rev-parse", "--verify", "MERGE_HEAD"])).toThrow();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanupWorktrees keeps branches marked for manual resolution (real git)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pico-wt-keep-"));
  try {
    runGit(repo, ["init", "-q", "-b", "main"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    runGit(repo, ["config", "user.name", "pico test"]);
    writeFileSync(join(repo, "f.txt"), "base\n");
    runGit(repo, ["add", "f.txt"]);
    runGit(repo, ["commit", "-qm", "base"]);

    const kept = await createWorktree(repo, "reviewer", 0);
    kept.keepBranch = true;
    const merged = await createWorktree(repo, "worker", 1);
    await cleanupWorktrees([kept, merged]);

    // The merged branch is gone; the kept one survives for manual resolution.
    expect(() => runGit(repo, ["rev-parse", "--verify", merged.branchName])).toThrow();
    expect(runGit(repo, ["rev-parse", "--verify", kept.branchName]).trim()).toBeTruthy();
    // Worktree dirs are removed either way — only the branch survives.
    expect(runGit(repo, ["worktree", "list"]).includes(kept.worktreeDir)).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("gate helpers summarize failures and build repair task", () => {
  const gateResult: GateResult = {
    passed: false,
    failedCriteria: ["tests pass", "lint clean"],
    evidenceResults: [
      { command: "bun test", output: "ok", passed: true },
      { command: "bun lint", output: "l1\nl2\nl3\nl4\nl5\nl6", passed: false },
    ],
  };

  const summary = summarizeGateFailure(gateResult);
  expect(summary).toBe("Failed criteria: tests pass; lint clean\nFailed evidence:\n- $ bun lint\n  l1\n  l2\n  l3\n  l4\n  l5");

  const repairTask = buildRepairTask("Fix feature", 2, 3, summary);
  expect(repairTask).toContain("Fix feature");
  expect(repairTask).toContain("## Acceptance gate failed (self-repair attempt 2 of 3)");
  expect(repairTask).toContain(summary);
  expect(repairTask).toContain("The same checks will run again.");
});

test("markGateFailed annotates result with gate failure stop reason", () => {
  const result: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  expect(markGateFailed(result, "gate failed")).toBe(result);
  expect(result.stopReason).toBe("gate_failed");
  expect(result.errorMessage).toBe("gate failed");
});

test("runGateAfterSuccess marks failure when self-repair is disabled", async () => {
  const result: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  const final = await runGateAfterSuccess({
    agent: { name: "worker", acceptance: { criteria: ["tests"] } },
    result,
    task: "run",
    runCwd: "/repo",
    context: undefined,
    checkGate: async () => ({
      passed: false,
      failedCriteria: ["tests"],
      evidenceResults: [{ command: "bun test", output: "fail", passed: false }],
    }),
    runRepair: async () => {
      throw new Error("should not repair");
    },
  });

  expect(final).toBe(result);
  expect(final.stopReason).toBe("gate_failed");
  expect(final.errorMessage).toContain("Acceptance gate failed.");
});

test("checkAcceptanceGate fails criteria without matching evidence", async () => {
  const result = await checkAcceptanceGate(
    {
      criteria: ["tests pass", "types pass"],
      evidence: [{ command: "true" }],
    },
    process.cwd(),
  );

  expect(result.passed).toBe(false);
  expect(result.failedCriteria).toEqual(["types pass"]);
  expect(result.evidenceResults).toHaveLength(1);
});

test("runGateAfterSuccess repairs until gate passes", async () => {
  const primary: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
  const repaired: SingleResult = { ...primary, task: "repair" };
  let gateCalls = 0;
  const repairTasks: string[] = [];

  const final = await runGateAfterSuccess({
    agent: { name: "worker", acceptance: { selfRepair: true, maxRepairAttempts: 2 } },
    result: primary,
    task: "run",
    runCwd: "/repo",
    context: "ctx",
    checkGate: async () => {
      gateCalls++;
      return gateCalls < 2
        ? { passed: false, failedCriteria: [], evidenceResults: [{ command: "check", output: "bad", passed: false }] }
        : { passed: true, failedCriteria: [], evidenceResults: [] };
    },
    runRepair: async (_agentName, repairTask, context) => {
      expect(context).toBe("ctx");
      repairTasks.push(repairTask);
      return repaired;
    },
  });

  expect(final).toBe(repaired);
  expect(repairTasks).toHaveLength(1);
  expect(repairTasks[0]).toContain("self-repair attempt 1 of 2");
});

test("runGateAfterSuccess returns last repair result when repair attempts are exhausted", async () => {
  const primary: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
  const repair: SingleResult = { ...primary, task: "repair" };

  const final = await runGateAfterSuccess({
    agent: { name: "worker", acceptance: { selfRepair: true, maxRepairAttempts: 1 } },
    result: primary,
    task: "run",
    runCwd: "/repo",
    context: undefined,
    checkGate: async () => ({
      passed: false,
      failedCriteria: ["tests"],
      evidenceResults: [{ command: "bun test", output: "fail", passed: false }],
    }),
    runRepair: async () => repair,
  });

  expect(final).toBe(repair);
  expect(final.stopReason).toBe("gate_failed");
  expect(final.errorMessage).toContain("after 1 self-repair attempt");
});

test("runSubagentRequest list:true enumerates agents without running anything", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pico-list-agents-"));
  try {
    const result = await runSubagentRequest(
      { list: true },
      undefined,
      undefined,
      {
        cwd,
        hasUI: false,
        ui: { confirm: async () => true },
        sessionManager: undefined,
      },
    );
    expect(result.content[0]?.type).toBe("text");
    const first = result.content[0];
    if (!first || first.type !== "text") throw new Error("expected text content");
    const text = first.text;
    expect(text).toContain("Available subagents");
    // Built-in agents are discoverable without any config files.
    expect(text).toContain("worker");
    expect(text).toContain("scout");
    expect(text).toContain("(user)");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("non-interactive runs refuse project-local agents without the opt-in env flag", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pico-proj-agents-"));
  const agentsDir = join(cwd, ".pico", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "proj.md"),
    [
      "---",
      "name: proj",
      "description: repo-controlled test agent",
      "---",
      "Do the thing.",
    ].join("\n"),
    "utf-8",
  );
  const oldFlag = process.env.PICO_ALLOW_UNATTENDED_PROJECT_AGENTS;
  delete process.env.PICO_ALLOW_UNATTENDED_PROJECT_AGENTS;
  try {
    const result = await runSubagentRequest(
      { agent: "proj", task: "do it", agentScope: "both" },
      undefined,
      undefined,
      {
        cwd,
        hasUI: false,
        ui: { confirm: async () => true },
        sessionManager: undefined,
      },
    );
    expect(result.content[0]?.type).toBe("text");
    expect((result.content[0] as { text: string }).text).toContain("Canceled");
    expect((result.content[0] as { text: string }).text).toContain("PICO_ALLOW_UNATTENDED_PROJECT_AGENTS");
  } finally {
    if (oldFlag === undefined) delete process.env.PICO_ALLOW_UNATTENDED_PROJECT_AGENTS;
    else process.env.PICO_ALLOW_UNATTENDED_PROJECT_AGENTS = oldFlag;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkAcceptanceGate runs evidence asynchronously and matches exit codes exactly", async () => {
  // exit-0 default: success only on exit 0.
  const ok = await checkAcceptanceGate(
    { criteria: ["c"], evidence: [{ command: "exit 0" }] },
    process.cwd(),
  );
  expect(ok.passed).toBe(true);

  // exit-1 expectation: 127 (command missing) is NOT a pass.
  const missing = await checkAcceptanceGate(
    { criteria: ["c"], evidence: [{ command: "definitely-not-a-command-xyz", expect: "exit 1" }] },
    process.cwd(),
  );
  expect(missing.evidenceResults[0]!.passed).toBe(false);

  // Unknown expect values fail loudly with the reason.
  const unknownExpect = await checkAcceptanceGate(
    { criteria: ["c"], evidence: [{ command: "exit 0", expect: "exit1" }] },
    process.cwd(),
  );
  expect(unknownExpect.evidenceResults[0]!.passed).toBe(false);
  expect(unknownExpect.evidenceResults[0]!.output).toContain("unknown expect value");
});

test("checkAcceptanceGate aborts the in-flight command when the signal fires", async () => {
  const controller = new AbortController();
  const gate = checkAcceptanceGate(
    { criteria: ["c"], evidence: [{ command: "sleep 30" }] },
    process.cwd(),
    controller.signal,
  );
  // Give the spawn a moment, then cancel — the command must not run 30s.
  await new Promise((r) => setTimeout(r, 100));
  controller.abort();
  const result = await gate;
  expect(result.evidenceResults[0]!.passed).toBe(false);
  expect(result.evidenceResults[0]!.output.length).toBeLessThanOrEqual(500);
});

test("applyOverrides ignores invalid numbers instead of forwarding them to argv", async () => {
  const base = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
    maxTokens: 4000,
    maxExecutionTimeMs: 120_000,
  };
  const overridden = applyOverrides([base], {
    defaults: { maxTokens: "abc", maxExecutionTimeMs: -5 } as never,
  });
  expect(overridden[0]!.maxTokens).toBe(4000);
  expect(overridden[0]!.maxExecutionTimeMs).toBe(120_000);

  const valid = applyOverrides([base], {
    defaults: { maxTokens: 8000, maxExecutionTimeMs: 60_000 },
  });
  expect(valid[0]!.maxTokens).toBe(8000);
  expect(valid[0]!.maxExecutionTimeMs).toBe(60_000);
});

test("discoverAgents skips malformed frontmatter files without breaking the registry", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-agents-bad-"));
  const agentsDir = join(home, "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const savedHome = process.env.PICO_HOME;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PICO_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  try {
    // Duplicate YAML keys throw in the parser (uniqueKeys).
    writeFileSync(join(agentsDir, "broken.md"), "---\nname: broken\nname: dup\n---\nbody");
    writeFileSync(join(agentsDir, "good.md"), "---\nname: goodone\ndescription: fine\n---\nbody");
    const names = discoverAgents(process.cwd(), "user").agents.map((a) => a.name);
    expect(names).toContain("goodone");
    expect(names).not.toContain("broken");
  } finally {
    if (savedHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = savedHome;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(home, { recursive: true, force: true });
  }
});

test("spillLargeFileOnlyOutput registers the temp dir until cleanupSpillDirs runs", async () => {
  const { cleanupSpillDirs, __resetSpillDirsForTests } = await import("../src/extensions/subagent/output.ts");
  __resetSpillDirsForTests();
  const result: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: "large output" }] }] as never[],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
  const dir = mkdtempSync(join(tmpdir(), "pico-spill-"));
  await spillLargeFileOnlyOutput(result, "worker", "file-only", 4, {
    tmpPrefix: `${dir}/out-`,
    mkdtemp: (prefix) => {
      mkdirSync(`${prefix}dir`);
      return Promise.resolve(`${prefix}dir`);
    },
    writeFile: async (filePath, content) => writeFileSync(filePath, content),
    now: () => 123,
  });
  // The spilled dir survives (chain steps may still read the path)...
  expect(await import("node:fs").then((fs) => fs.existsSync(`${dir}/out-dir`))).toBe(true);
  // ...until the session-end cleanup.
  cleanupSpillDirs();
  expect(await import("node:fs").then((fs) => fs.existsSync(`${dir}/out-dir`))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

// ---- 2.4.x regression tests (fifth review round) --------------------------

test("2.4.3: spawn failures surface the reason on the result", async () => {
  const agent = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
  };
  const result = createInitialResult(agent, "worker", "run", undefined);
  const proc = new FakeProcess();
  const run = runJsonProcess({
    command: "pico",
    args: [],
    cwd: "/repo",
    result,
    spawn: () => proc,
  });
  proc.error(new Error("spawn pico ENOENT"));
  await run;
  expect(result.errorMessage).toContain("Failed to spawn pico");
  expect(result.errorMessage).toContain("ENOENT");
  expect(result.stopReason).toBe("error");
});

test("2.4.2: agents without maxExecutionTimeMs get the 30-minute default", () => {
  const { DEFAULT_AGENT_TIMEOUT_MS } = { DEFAULT_AGENT_TIMEOUT_MS: 30 * 60 * 1000 };
  expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(1800000);
});

test("2.4.5: gate interruption is attributed as abort, not gate failure", async () => {
  const { runGateAfterSuccess } = await import("../src/extensions/subagent/gates.ts");
  const controller = new AbortController();
  controller.abort();
  const result: SingleResult = {
    agent: "worker",
    agentSource: "user",
    task: "t",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
  const out = await runGateAfterSuccess({
    agent: { name: "worker", acceptance: { evidence: [{ command: "true" }], criteria: ["c"] } },
    result,
    task: "t",
    runCwd: "/repo",
    context: undefined,
    signal: controller.signal,
    checkGate: async (_acc, _cwd, sig) => {
      sig?.dispatchEvent(new Event("abort"));
      return { passed: false, failedCriteria: ["c"], evidenceResults: [{ command: "true", output: "", passed: false }] };
    },
    runRepair: async () => result,
  });
  expect(out.stopReason).toBe("aborted");
  expect(out.errorMessage).toContain("interrupted");
});

test("2.4.8: checkAcceptanceGate reports per-evidence progress", async () => {
  const { checkAcceptanceGate } = await import("../src/extensions/subagent/gates.ts");
  const seen: Array<{ index: number; total: number; command: string }> = [];
  await checkAcceptanceGate(
    { evidence: [{ command: "true" }, { command: "false" }], criteria: ["a", "b"] },
    "/repo",
    undefined,
    (index, total, command) => seen.push({ index, total, command }),
  );
  expect(seen).toEqual([
    { index: 0, total: 2, command: "true" },
    { index: 1, total: 2, command: "false" },
  ]);
});

test("2.6.3: stderr is capped with a tail-preserving marker", async () => {
  const { runJsonProcess } = await import("../src/extensions/subagent/process.ts");
  const agent = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
  };
  const result = createInitialResult(agent, "worker", "run", undefined);
  const proc = new FakeProcess();
  const run = runJsonProcess({
    command: "pico",
    args: [],
    cwd: "/repo",
    result,
    spawn: () => proc,
  });
  for (let i = 0; i < 4000; i++) proc.stderrData("x".repeat(100));
  proc.close(1);
  await run;
  expect(result.stderr).toContain("[stderr truncated");
  expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThan(512 * 1024);
});

// ── 2.7.x: structured output schema (G5) ────────────────────────────────────

test("validateOutputSchema enforces types, required fields, and array items", async () => {
  const { validateOutputSchema } = await import("../src/extensions/subagent/schema.ts");
  const schema = {
    type: "object",
    required: ["summary", "files"],
    properties: {
      summary: { type: "string" },
      files: { type: "array", items: { type: "string" } },
      score: { type: "number" },
    },
  };
  expect(validateOutputSchema(schema, { summary: "ok", files: ["a.ts"] }).success).toBe(true);
  expect(validateOutputSchema(schema, { summary: 3, files: ["a.ts"] })).toEqual({
    success: false,
    errors: ["$.summary: expected string, got number"],
  });
  const missing = validateOutputSchema(schema, { summary: "ok" });
  expect(missing.success).toBe(false);
  expect(missing.success ? [] : missing.errors).toContain('$: missing required field "files"');
  const badItem = validateOutputSchema(schema, { summary: "ok", files: [1] });
  expect(badItem.success).toBe(false);
  expect(badItem.success ? [] : badItem.errors).toEqual(["$.files[0]: expected string, got number"]);
  expect(validateOutputSchema("not-an-object", {})).toEqual({
    success: false,
    errors: ["$: invalid output schema (must be an object)"],
  });
  expect(validateOutputSchema({ type: "integer" }, 3.5)).toEqual({
    success: false,
    errors: ["$: expected integer, got number"],
  });
});

test("applyOutputSchemaCheck marks non-JSON and schema-invalid output as schema_violation", async () => {
  const { applyOutputSchemaCheck } = await import("../src/extensions/subagent/orchestrator.ts");
  const schema = { type: "object", required: ["result"], properties: { result: { type: "string" } } };
  const makeResult = (text: string): SingleResult => ({
    agent: "worker",
    agentSource: "user",
    task: "run",
    exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text }] }] as never[],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  });
  const valid = makeResult('{"result":"ok"}');
  applyOutputSchemaCheck(schema, valid);
  expect(valid.stopReason).toBeUndefined();

  const notJson = makeResult("plain prose");
  applyOutputSchemaCheck(schema, notJson);
  expect(notJson.stopReason).toBe("schema_violation");
  expect(notJson.errorMessage).toContain("not valid JSON");
  expect(isFailedResult(notJson)).toBe(true);

  const wrongShape = makeResult('{"other": 1}');
  applyOutputSchemaCheck(schema, wrongShape);
  expect(wrongShape.stopReason).toBe("schema_violation");
  expect(wrongShape.errorMessage).toContain('missing required field "result"');
});

// ── 2.7.x: config additions (G7 / G8 / G4) ───────────────────────────────────

test("positiveInt coerces valid positive integers only", async () => {
  const { positiveInt } = await import("../src/extensions/subagent/config.ts");
  expect(positiveInt(4)).toBe(4);
  expect(positiveInt("6")).toBe(6);
  expect(positiveInt(0)).toBeUndefined();
  expect(positiveInt(-2)).toBeUndefined();
  expect(positiveInt(2.5)).toBe(2);
  expect(positiveInt("abc")).toBeUndefined();
  expect(positiveInt(undefined)).toBeUndefined();
});

test("resolveSpawnWhitelist returns undefined unless a non-empty list is configured", async () => {
  const { resolveSpawnWhitelist } = await import("../src/extensions/subagent/config.ts");
  expect(resolveSpawnWhitelist({})).toBeUndefined();
  expect(resolveSpawnWhitelist({ spawns: [] })).toBeUndefined();
  expect(resolveSpawnWhitelist({ spawns: ["  ", ""] })).toBeUndefined();
  expect(resolveSpawnWhitelist({ spawns: ["scout", " planner "] })).toEqual(["scout", "planner"]);
});

test("applyOverrides applies maxRequests overrides", () => {
  const base = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
  };
  const specific = applyOverrides([base], { agents: { worker: { maxRequests: 50 } } });
  expect(specific[0]!.maxRequests).toBe(50);
  const defaults = applyOverrides([base], { defaults: { maxRequests: 120 } });
  expect(defaults[0]!.maxRequests).toBe(120);
  const invalid = applyOverrides([base], { agents: { worker: { maxRequests: -1 } } });
  expect(invalid[0]!.maxRequests).toBeUndefined();
});

// ── 2.7.x: soft request budget (G4) ─────────────────────────────────────────

test("runJsonProcess kills the child when budgetCheck fires", async () => {
  const agent = {
    name: "worker",
    description: "",
    source: "user" as const,
    filePath: "worker.md",
    systemPrompt: "",
  };
  const result = createInitialResult(agent, "worker", "run", undefined);
  const proc = new FakeProcess();
  let turns = 0;
  const run = runJsonProcess({
    command: "pico",
    args: [],
    cwd: "/repo",
    result,
    spawn: () => proc,
    budgetCheck: () => {
      turns++;
      return turns >= 2;
    },
  });
  proc.stdoutData('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"one"}]}}\n');
  proc.stdoutData('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"two"}]}}\n');
  proc.close(143);
  const processResult = await run;
  expect(processResult.budgetExceeded).toBe(true);
  expect(processResult.timedOut).toBe(false);
  expect(processResult.wasAborted).toBe(false);
  expect(proc.kills).toEqual(["SIGTERM"]);
  expect(result.stopReason).toBe("budget");
  expect(isFailedResult(result)).toBe(true);
});

// ── 2.7.x: spawn allowlist (G7) ──────────────────────────────────────────────

test("runSubagentRequest refuses agents outside the spawn allowlist", async () => {
  const home = mkdtempSync(join(tmpdir(), "pico-subagent-spawns-"));
  const savedHome = process.env.PICO_HOME;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PICO_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  try {
    writeFileSync(
      join(home, "subagent.json"),
      JSON.stringify({ spawns: ["scout"] }),
    );
    const result = await runSubagentRequest(
      { agent: "worker", task: "do it" },
      undefined,
      undefined,
      { cwd: process.cwd(), hasUI: false, ui: { confirm: async () => true } },
    );
    const text = result.content.find((p) => p.type === "text")?.text ?? "";
    expect(text).toContain("not in the spawn allowlist");
    expect(text).toContain("worker");
    expect(text).toContain("scout");
  } finally {
    if (savedHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = savedHome;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverAgents parses output schema and maxRequests from frontmatter", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-agents-output-"));
  const agentsDir = join(home, "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const savedHome = process.env.PICO_HOME;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PICO_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  try {
    writeFileSync(
      join(agentsDir, "structured.md"),
      [
        "---",
        "name: structured",
        "description: structured output agent",
        "maxRequests: 25",
        "output:",
        "  type: object",
        "  required: [summary]",
        "  properties:",
        "    summary:",
        "      type: string",
        "---",
        "body",
      ].join("\n"),
    );
    const agent = discoverAgents(process.cwd(), "user").agents.find((a) => a.name === "structured");
    expect(agent).toBeDefined();
    expect(agent!.maxRequests).toBe(25);
    expect(agent!.outputSchema).toEqual({
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    });
  } finally {
    if (savedHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = savedHome;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildAgentProcessArgs output passes the -p prompt guard (subagent spawn regression)", () => {
  const agent = {
    name: "worker",
    description: "d",
    systemPrompt: "",
    model: "model-a",
    source: "user" as const,
    filePath: "/tmp/agents/worker.md",
  };
  const args = buildAgentProcessArgs(agent, "Task: do work", "/tmp/session.json", "/tmp/prompt.md", undefined);
  // The child is spawned as `pico ...args`; the -p guard must accept it.
  expect(missingPrintPrompt(args)).toBe(false);
});

// ── P0: async jobs (jobs.ts + async launch + subagent_wait) ─────────────────

function makeSingleResult(overrides: Record<string, unknown> = {}): SingleResult {
  return {
    agent: "worker",
    agentSource: "user",
    task: "t",
    exitCode: 0,
    messages: [fauxAssistantMessage([fauxText("out")], { stopReason: "stop" })],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    ...overrides,
  };
}

async function tickUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("tickUntil timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function withSubagentHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pico-subagent-tests-"));
  const savedHome = process.env.PICO_HOME;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PICO_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  return fn(home).finally(() => {
    if (savedHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = savedHome;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(home, { recursive: true, force: true });
  });
}

const plainCtx = (spawnProcess: (command: string, args: string[]) => FakeProcess) => ({
  cwd: process.cwd(),
  hasUI: false,
  ui: { confirm: async () => true },
  sessionManager: undefined,
  spawnProcess,
});

test("jobs: waitForJobs resolves immediately when jobs are already settled", async () => {
  try {
    registerJob("default", "subagent-job-1", "worker", "t", () => {});
    settleJob("default", "subagent-job-1", makeSingleResult());
    const outcome = await waitForJobs("default", ["subagent-job-1"]);
    expect(outcome.settled.map((j) => j.id)).toEqual(["subagent-job-1"]);
    expect(outcome.pending).toEqual([]);
    expect(outcome.timedOut).toBe(false);
  } finally {
    __resetJobsForTests();
  }
});

test("jobs: waitForJobs waits for a later settle and reports unknown ids", async () => {
  try {
    registerJob("default", "subagent-job-1", "worker", "t", () => {});
    const waiter = waitForJobs("default", ["subagent-job-1", "nope-1"]);
    setTimeout(() => settleJob("default", "subagent-job-1", makeSingleResult()), 10);
    const outcome = await waiter;
    expect(outcome.pending).toEqual([]);
    expect(outcome.settled[0]?.id).toBe("subagent-job-1");
    expect(outcome.unknown).toEqual(["nope-1"]);
  } finally {
    __resetJobsForTests();
  }
});

test("jobs: waitForJobs times out with pending ids when no settle arrives", async () => {
  try {
    registerJob("default", "subagent-job-1", "worker", "t", () => {});
    const outcome = await waitForJobs("default", ["subagent-job-1"], { timeoutMs: 10 });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.pending).toEqual(["subagent-job-1"]);
    expect(outcome.settled).toEqual([]);
  } finally {
    __resetJobsForTests();
  }
});

test("jobs: waitForJobs aborts on the signal and reports pending ids", async () => {
  try {
    registerJob("default", "subagent-job-1", "worker", "t", () => {});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const outcome = await waitForJobs("default", ["subagent-job-1"], { signal: controller.signal });
    expect(outcome.aborted).toBe(true);
    expect(outcome.pending).toEqual(["subagent-job-1"]);
  } finally {
    __resetJobsForTests();
  }
});

test("jobs: cancelRunningJobs aborts running jobs and settles them with an error", async () => {
  try {
    let canceled = 0;
    registerJob("default", "subagent-job-1", "worker", "t", () => { canceled++; });
    const ids = cancelRunningJobs("default");
    expect(ids).toEqual(["subagent-job-1"]);
    expect(canceled).toBe(1);
    const job = getJob("default", "subagent-job-1");
    expect(job?.status).toBe("settled");
    expect(job?.errorMessage).toContain("session shutdown");
  } finally {
    __resetJobsForTests();
  }
});

test("P0: async launch returns a job id immediately and the job settles in the background", async () => {
  await withSubagentHome(async () => {
    const procs: FakeProcess[] = [];
    const ctx = plainCtx(() => {
      const p = new FakeProcess();
      procs.push(p);
      return p;
    });
    try {
      const res = await runSubagentRequest({ agent: "worker", task: "background work", async: true }, undefined, undefined, ctx);
      const text = res.content.find((p) => p.type === "text")?.text ?? "";
      const match = /subagent-job-(\d+)/.exec(text);
      expect(match).not.toBeNull();
      const jobId = `subagent-job-${match![1]}`;
      expect(text).toContain("subagent_wait");

      const job = getJob("default", jobId);
      expect(job?.status).toBe("running");

      await tickUntil(() => procs.length === 1);
      procs[0]!.stdoutData('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"async done"}],"usage":{"input":1,"output":2}}}\n');
      procs[0]!.close(0);

      const outcome = await waitForJobs("default", [jobId]);
      expect(outcome.pending).toEqual([]);
      const settled = getJob("default", jobId);
      expect(settled?.status).toBe("settled");
      expect(settled?.result?.usage.turns).toBe(1);
    } finally {
      for (const p of procs) if (!p.killed) p.close(0);
      __resetJobsForTests();
      __resetChildSlotsForTests();
      __resetSessionSpawnCountsForTests();
    }
  });
});

test("P0: subagent_wait reports settled and unknown jobs", async () => {
  try {
    registerJob("default", "subagent-job-1", "worker", "t1", () => {});
    settleJob("default", "subagent-job-1", makeSingleResult({ task: "t1" }));
    const res = await waitForSubagentJobs(
      { jobs: ["subagent-job-1", "subagent-job-99"] },
      undefined,
      { cwd: process.cwd(), hasUI: false, ui: { confirm: async () => true } },
    );
    const text = res.content.find((p) => p.type === "text")?.text ?? "";
    expect(text).toContain("subagent-job-1 [worker] completed");
    expect(text).toContain("subagent-job-99 — unknown");
  } finally {
    __resetJobsForTests();
  }
});

test("P0: subagent_wait times out and aborts with pending jobs still running", async () => {
  try {
    registerJob("default", "subagent-job-1", "worker", "t", () => {});
    const timedOut = await waitForSubagentJobs(
      { jobs: ["subagent-job-1"], timeoutMs: 10 },
      undefined,
      { cwd: process.cwd(), hasUI: false, ui: { confirm: async () => true } },
    );
    const timeoutText = timedOut.content.find((p) => p.type === "text")?.text ?? "";
    expect(timeoutText).toContain("still running");
    expect(timeoutText).toContain("timed out");

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const aborted = await waitForSubagentJobs(
      { jobs: ["subagent-job-1"] },
      controller.signal,
      { cwd: process.cwd(), hasUI: false, ui: { confirm: async () => true } },
    );
    const abortText = aborted.content.find((p) => p.type === "text")?.text ?? "";
    expect(abortText).toContain("Wait aborted");
  } finally {
    __resetJobsForTests();
  }
});

test("P0: subagent_wait renders a single settled job as a single-mode result", async () => {
  try {
    registerJob("default", "subagent-job-1", "worker", "t", () => {});
    settleJob("default", "subagent-job-1", makeSingleResult());
    const res = await waitForSubagentJobs(
      { jobs: ["subagent-job-1"] },
      undefined,
      { cwd: process.cwd(), hasUI: false, ui: { confirm: async () => true } },
    );
    expect(res.details.mode).toBe("single");
    expect(res.details.results.length).toBe(1);
  } finally {
    __resetJobsForTests();
  }
});

// ── P1: resumeFrom (resume a saved session) ─────────────────────────────────

test("P1: resumeFrom passes the saved session file to the child", async () => {
  await withSubagentHome(async (home) => {
    const sessionFile = join(home, "saved-session.jsonl");
    writeFileSync(sessionFile, "{}");
    const procs: FakeProcess[] = [];
    const captured: string[][] = [];
    const ctx = plainCtx((_command: string, args: string[]) => {
      captured.push(args);
      const p = new FakeProcess();
      procs.push(p);
      return p;
    });
    try {
      const run = runSubagentRequest({ agent: "worker", task: "continue", resumeFrom: sessionFile }, undefined, undefined, ctx);
      await tickUntil(() => procs.length === 1);
      const args = captured[0]!;
      expect(args).toContain("--session");
      const idx = args.indexOf("--session");
      expect(args[idx + 1]).toBe(sessionFile);
      procs[0]!.close(0);
      await run;
    } finally {
      for (const p of procs) if (!p.killed) p.close(0);
      __resetJobsForTests();
      __resetChildSlotsForTests();
      __resetSessionSpawnCountsForTests();
    }
  });
});

// ── P2: permissions + session caps ──────────────────────────────────────────

test("P2: applyDenyTools filters explicit lists and restricts unrestricted agents", () => {
  const base = { description: "d", systemPrompt: "", source: "user" as const, filePath: "/x" };
  const explicit = applyDenyTools({ name: "a", tools: ["bash", "read"], ...base }, ["bash"]);
  expect(explicit.tools).toEqual(["read"]);
  const unrestricted = applyDenyTools({ name: "a", ...base }, ["bash"]);
  expect(unrestricted.tools).toEqual(KNOWN_CHILD_TOOLS.filter((t) => t !== "bash"));
  const noop = applyDenyTools({ name: "a", ...base }, []);
  expect(noop.tools).toBeUndefined();
});

test("P2: resolveDenyTools / resolveDenyAgents parse config permissions", () => {
  expect(resolveDenyTools({ permissions: { denyTools: ["bash", " write "] } })).toEqual(["bash", "write"]);
  expect(resolveDenyTools({ permissions: {} })).toBeUndefined();
  expect(resolveDenyAgents({ permissions: { denyAgents: ["worker"] } })).toEqual(new Set(["worker"]));
  expect(resolveDenyAgents({})).toBeUndefined();
});

test("P2: acquireChildSlot enforces the global cap and hands slots to waiters", async () => {
  try {
    const noop = await acquireChildSlot(undefined);
    expect(typeof noop).toBe("function");
    noop();

    const release1 = await acquireChildSlot(1);
    let secondAcquired = false;
    const second = acquireChildSlot(1).then((release) => {
      secondAcquired = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(secondAcquired).toBe(false);
    release1();
    const release2 = await second;
    expect(secondAcquired).toBe(true);
    release2();
  } finally {
    __resetChildSlotsForTests();
  }
});

test("P2: denyTools strips denied tools from the child spawn args", async () => {
  await withSubagentHome(async (home) => {
    writeFileSync(join(home, "subagent.json"), JSON.stringify({ permissions: { denyTools: ["bash"] } }));
    const procs: FakeProcess[] = [];
    const captured: string[][] = [];
    const ctx = plainCtx((_command: string, args: string[]) => {
      captured.push(args);
      const p = new FakeProcess();
      procs.push(p);
      return p;
    });
    try {
      const run = runSubagentRequest({ agent: "worker", task: "x" }, undefined, undefined, ctx);
      await tickUntil(() => procs.length === 1);
      const args = captured[0]!;
      const toolsIdx = args.indexOf("--tools");
      expect(toolsIdx).not.toBe(-1);
      const tools = args[toolsIdx + 1]!.split(",");
      expect(tools).not.toContain("bash");
      expect(tools).toContain("read");
      procs[0]!.close(0);
      await run;
    } finally {
      for (const p of procs) if (!p.killed) p.close(0);
      __resetChildSlotsForTests();
      __resetSessionSpawnCountsForTests();
    }
  });
});

test("P2: maxSubagentSpawnsPerSession refuses extra spawns in a session", async () => {
  await withSubagentHome(async (home) => {
    writeFileSync(join(home, "subagent.json"), JSON.stringify({ maxSubagentSpawnsPerSession: 1 }));
    const procs: FakeProcess[] = [];
    const ctx = plainCtx(() => {
      const p = new FakeProcess();
      procs.push(p);
      return p;
    });
    try {
      const first = runSubagentRequest({ agent: "worker", task: "one" }, undefined, undefined, ctx);
      await tickUntil(() => procs.length === 1);
      procs[0]!.close(0);
      await first;
      expect(procs.length).toBe(1);

      await expect(
        runSubagentRequest({ agent: "worker", task: "two" }, undefined, undefined, ctx),
      ).rejects.toThrow(/Max subagent spawns per session \(1\) exceeded/);
      expect(procs.length).toBe(1);
    } finally {
      for (const p of procs) if (!p.killed) p.close(0);
      __resetChildSlotsForTests();
      __resetSessionSpawnCountsForTests();
    }
  });
});

test("P2: globalConcurrencyLimit bounds in-flight children across async jobs", async () => {
  await withSubagentHome(async (home) => {
    writeFileSync(join(home, "subagent.json"), JSON.stringify({ globalConcurrencyLimit: 1 }));
    const procs: FakeProcess[] = [];
    const ctx = plainCtx(() => {
      const p = new FakeProcess();
      procs.push(p);
      return p;
    });
    const launch = async (task: string) => {
      const res = await runSubagentRequest({ agent: "worker", task, async: true }, undefined, undefined, ctx);
      const text = res.content.find((p) => p.type === "text")?.text ?? "";
      const match = /subagent-job-(\d+)/.exec(text);
      expect(match).not.toBeNull();
      return `subagent-job-${match![1]}`;
    };
    try {
      const job1 = await launch("one");
      await tickUntil(() => procs.length === 1);
      const job2 = await launch("two");
      // second job's child must NOT spawn while job1 holds the only slot
      await new Promise((r) => setTimeout(r, 10));
      expect(procs.length).toBe(1);

      procs[0]!.close(0);
      await waitForJobs("default", [job1]);
      await new Promise((r) => setTimeout(r, 20));
      expect(procs.length).toBe(2);

      procs[1]!.close(0);
      await waitForJobs("default", [job2]);
    } finally {
      for (const p of procs) if (!p.killed) p.close(0);
      __resetJobsForTests();
      __resetChildSlotsForTests();
      __resetSessionSpawnCountsForTests();
    }
  });
});

// ── intercom: supervisor channel wiring ─────────────────────────────────────

test("intercom: async launch records the channel dir on the job for steering", async () => {
  const { __resetJobsForTests, getJob } = await import("../src/extensions/subagent/jobs.ts");
  const { existsSync } = await import("node:fs");
  await withSubagentHome(async () => {
    const procs: FakeProcess[] = [];
    const ctx = plainCtx(() => {
      const p = new FakeProcess();
      procs.push(p);
      return p;
    });
    try {
      const res = await runSubagentRequest({ agent: "worker", task: "bg", async: true }, undefined, undefined, ctx);
      const match = /subagent-job-(\d+)/.exec(res.content.find((p) => p.type === "text")?.text ?? "");
      expect(match).not.toBeNull();
      const jobId = `subagent-job-${match![1]}`;
      await tickUntil(() => procs.length === 1);
      const job = getJob("default", jobId);
      expect(job?.channelDir).toBeDefined();
      expect(job?.runId).toBeDefined();
      // steer/ 目录按需创建（writeSteer 时），此时不应存在。
      expect(existsSync(join(job!.channelDir!, "steer"))).toBe(false);
      procs[0]!.close(0);
      await waitForJobs("default", [jobId]);
    } finally {
      for (const p of procs) if (!p.killed) p.close(0);
      __resetJobsForTests();
      __resetChildSlotsForTests();
      __resetSessionSpawnCountsForTests();
    }
  });
});

test("intercom: spawning a subagent creates its supervisor channel dir", async () => {
  const { clearChannelRoot } = await import("../src/extensions/subagent/supervisor-channel.ts");
  const os = await import("node:os");
  const { existsSync, readdirSync } = await import("node:fs");
  await withSubagentHome(async () => {
    const procs: FakeProcess[] = [];
    const ctx = plainCtx(() => {
      const p = new FakeProcess();
      procs.push(p);
      return p;
    });
    try {
      // 本文件其他 spawn 测试也会创建通道目录；清空后本次 run 恰好新增 1 个。
      clearChannelRoot();
      const run = runSubagentRequest({ agent: "worker", task: "x" }, undefined, undefined, ctx);
      await tickUntil(() => procs.length === 1);
      const root = join(os.tmpdir(), "pico-supervisor-channels");
      const dirs = readdirSync(root);
      expect(dirs.length).toBe(1);
      const channelDir = join(root, dirs[0]!);
      expect(existsSync(join(channelDir, "requests"))).toBe(true);
      expect(existsSync(join(channelDir, "replies"))).toBe(true);
      procs[0]!.close(0);
      await run;
    } finally {
      for (const p of procs) if (!p.killed) p.close(0);
      clearChannelRoot();
      __resetChildSlotsForTests();
      __resetSessionSpawnCountsForTests();
    }
  });
});
