/**
 * Smoke tests for subagent extension wiring.
 *
 * Avoid spawning real `pi` subprocesses — just confirm the factory registers
 * the right tool, and that `discoverAgents` finds the four bundled roles.
 */
import { expect, test } from "bun:test";
import { discoverAgents } from "../src/extensions/subagent/agents.ts";
import { buildChainTask } from "../src/extensions/subagent/chain.ts";
import { mapWithConcurrencyLimit } from "../src/extensions/subagent/concurrency.ts";
import { isProviderFailure, runWithFallbackModels } from "../src/extensions/subagent/fallback.ts";
import {
  buildRepairTask,
  markGateFailed,
  runGateAfterSuccess,
  summarizeGateFailure,
  type GateResult,
} from "../src/extensions/subagent/gates.ts";
import subagentExtension from "../src/extensions/subagent/index.ts";
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
import {
  formatUsageStats,
  renderSubagentCall,
  renderSubagentResult,
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
  mergeParallelWorktrees,
  prepareParallelWorktrees,
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
  on(event: "close" | "error", handler: any): void {
    if (event === "close") this.closeHandlers.push(handler);
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
  // they're available without symlinking into ~/.srcode/agent.
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
  expect(unknown.stderr).toBe('Unknown agent: "missing". Available agents: "worker".');
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

  expect(buildAgentProcessArgs(agent, "do work", "/tmp/session.json", "/tmp/prompt.md")).toEqual([
    "--mode",
    "json",
    "-p",
    "--session",
    "/tmp/session.json",
    "--model",
    "model-a",
    "--tools",
    "read,grep",
    "--max-tokens",
    "1024",
    "--thinking",
    "medium",
    "--append-system-prompt",
    "/tmp/prompt.md",
    "Task: do work",
  ]);
  expect(buildAgentProcessArgs({ ...agent, tools: undefined }, "do work", undefined, undefined)).toContain("--no-session");

  const result = createInitialResult(agent, "worker", "run", undefined);
  applyProcessExit(result, 1, true, 2500);
  expect(result.exitCode).toBe(1);
  expect(result.stopReason).toBe("timeout");
  expect(result.errorMessage).toBe("Agent exceeded maxExecutionTimeMs (2500ms)");
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
    command: "srcode",
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
  expect(processResult).toEqual({ exitCode: 0, wasAborted: false, timedOut: false });
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
    command: "srcode",
    args: [],
    cwd: "/repo",
    result: createInitialResult(agent, "worker", "run", undefined),
    spawn: () => errorProc,
  });
  errorProc.error(new Error("spawn failed"));
  expect(await errorRun).toEqual({ exitCode: 1, wasAborted: false, timedOut: false });

  const controller = new AbortController();
  controller.abort();
  const abortProc = new FakeProcess();
  const abortRun = runJsonProcess({
    command: "srcode",
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
  expect(await abortRun).toEqual({ exitCode: 0, wasAborted: true, timedOut: false });
  expect(abortProc.kills).toEqual(["SIGTERM"]);

  let timeoutHandler: (() => void) | undefined;
  const timeoutProc = new FakeProcess();
  const timeoutRun = runJsonProcess({
    command: "srcode",
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
  expect(await timeoutRun).toEqual({ exitCode: 143, wasAborted: false, timedOut: true });
  expect(timeoutProc.kills).toEqual(["SIGTERM"]);
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

  expect(task).toBe('Use prior result, saved plan, and (output "missing" not found).');
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

test("prepareParallelWorktrees cleans up created handles when later setup fails", () => {
  const cleaned: string[] = [];
  const create = (_cwd: string, agentName: string, index: number): WorktreeHandle => {
    if (index === 1) throw new Error("cannot create");
    return {
      worktreeDir: `/tmp/${agentName}`,
      branchName: `branch-${index}`,
      cleanup: () => cleaned.push(agentName),
    };
  };

  const prepared = prepareParallelWorktrees("/repo", [
    { agent: "worker" },
    { agent: "reviewer" },
  ], create);

  expect(prepared.errorText).toBe("Failed to set up git worktrees:\ntask 1 (reviewer): cannot create");
  expect(cleaned).toEqual(["worker"]);
});

test("mergeParallelWorktrees reports skipped, empty, merged, and conflicted worktrees", () => {
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

  const notes = mergeParallelWorktrees(
    "/repo",
    [makeResult("failed", 1), makeResult("empty", 0), makeResult("merged", 0), makeResult("conflict", 0)],
    handles,
    (_cwd, branch) => branch === "b" ? "" : `diff for ${branch}\n`,
    (_cwd, branch) => branch === "d"
      ? { success: false, conflict: "Merge conflict on branch d. Resolve manually." }
      : { success: true },
  );

  expect(notes).toEqual([
    "task 0 (failed): skipped merge (task failed)",
    "task 1 (empty): no changes to merge",
    "task 2 (merged): merged\ndiff for c",
    "task 3 (conflict): Merge conflict on branch d. Resolve manually.",
  ]);
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
