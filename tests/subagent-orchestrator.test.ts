/**
 * Orchestrator decision-logic tests: drive `runSubagentRequest` through the
 * branches that return BEFORE any child process is spawned — allowlist
 * enforcement, chain reference validation, parallel caps, project-agent
 * approval, unknown-agent rejection, and session-persistence config.
 *
 * The spawned-process layer (JSONL protocol, exit mapping, abort, budgets) is
 * covered by tests/subagent.test.ts via `runJsonProcess` with injected fake
 * processes — this file deliberately stays off the module-level `mock.module`
 * route because it would leak into sibling test files sharing the worker's
 * module registry (bun's module mocks are not per-file isolated).
 *
 * Env isolation: PICO_HOME + PI_CODING_AGENT_DIR are redirected to temp dirs
 * so subagent.json / agent discovery never touch the real data root.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSubagentRequest } from "../src/extensions/subagent/orchestrator.ts";

function makeCtx(cwd: string, overrides: Record<string, unknown> = {}) {
  return {
    cwd,
    hasUI: false,
    ui: { confirm: async () => true },
    sessionManager: undefined,
    ...overrides,
  };
}

function makeText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((p) => p.type === "text")?.text ?? "";
}

let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "pico-orch-"));
  process.env.PICO_HOME = testHome;
  process.env.PI_CODING_AGENT_DIR = join(testHome, "agent");
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  delete process.env.PICO_HOME;
  delete process.env.PI_CODING_AGENT_DIR;
});

function writeSubagentConfig(config: Record<string, unknown>) {
  writeFileSync(join(testHome, "subagent.json"), JSON.stringify(config));
}

function writeUserAgent(name: string, frontmatterLines: string[], body = "body") {
  const dir = join(testHome, "agent", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    ["---", `name: ${name}`, `description: ${name} agent`, ...frontmatterLines, "---", body].join("\n"),
  );
}

// ── single mode: pre-spawn branches ─────────────────────────────────────────

test("single: unknown agent is rejected without any spawn", async () => {
  const result = await runSubagentRequest(
    { agent: "no-such-agent", task: "x" },
    undefined,
    undefined,
    makeCtx(process.cwd()),
  );
  // M9: single-mode failures return a structured result (details preserved
  // for JSONL replay/rendering) instead of throwing — the failure is
  // conveyed via content text plus details.results[0].
  const text = makeText(result);
  expect(text).toContain("Unknown agent");
  expect(text).toContain("no-such-agent");
  expect(result.details.results[0]?.exitCode).toBe(1);
});

test("single: output schema is parsed from frontmatter and failure marks schema_violation", async () => {
  writeUserAgent("structured", ["output:", "  type: object", "  required: [summary]", "  properties:", "    summary:", "      type: string"]);
  const { discoverAgents } = await import("../src/extensions/subagent/agents.ts");
  const agent = discoverAgents(process.cwd(), "user").agents.find((a) => a.name === "structured");
  expect(agent?.outputSchema).toEqual({
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
  });
});

test("single: mode-count guard rejects zero or multiple modes with available agents", async () => {
  const result = await runSubagentRequest({}, undefined, undefined, makeCtx(process.cwd()));
  const text = makeText(result);
  expect(text).toContain("Invalid parameters. Provide exactly one mode.");
  expect(text).toContain("Available agents:");
  expect(text).toContain("worker");

  const multi = await runSubagentRequest(
    { agent: "worker", task: "x", tasks: [{ agent: "worker", task: "y" }] },
    undefined,
    undefined,
    makeCtx(process.cwd()),
  );
  expect(makeText(multi)).toContain("Invalid parameters.");
});

// ── chain mode: pre-spawn branches ──────────────────────────────────────────

test("chain: unresolved output reference throws before any spawn", async () => {
  await expect(
    runSubagentRequest(
      {
        chain: [{ agent: "worker", task: "use {outputs.missing}" }],
      },
      undefined,
      undefined,
      makeCtx(process.cwd()),
    ),
  ).rejects.toThrow(/Chain reference error at step 1/);
});

test("chain: spawn allowlist applies per step", async () => {
  writeSubagentConfig({ spawns: ["scout"] });
  const result = await runSubagentRequest(
    { chain: [{ agent: "worker", task: "x" }] },
    undefined,
    undefined,
    makeCtx(process.cwd()),
  );
  const text = makeText(result);
  expect(text).toContain("not in the spawn allowlist");
  expect(result.details.mode).toBe("chain");
});

test("chain: project agent is refused non-interactively without the env opt-in", async () => {
  const projDir = mkdtempSync(join(tmpdir(), "pico-proj-chain-"));
  try {
    mkdirSync(join(projDir, ".pico", "agents"), { recursive: true });
    writeFileSync(
      join(projDir, ".pico", "agents", "proj.md"),
      ["---", "name: proj", "description: repo agent", "---", "body"].join("\n"),
    );
    const result = await runSubagentRequest(
      { chain: [{ agent: "proj", task: "x" }], agentScope: "both" },
      undefined,
      undefined,
      makeCtx(projDir, { hasUI: false }),
    );
    const text = makeText(result);
    expect(text).toContain("project-local agents need approval");
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test("chain: project agent is approved interactively via ui.confirm", async () => {
  const projDir = mkdtempSync(join(tmpdir(), "pico-proj-chain-ok-"));
  try {
    mkdirSync(join(projDir, ".pico", "agents"), { recursive: true });
    writeFileSync(
      join(projDir, ".pico", "agents", "proj.md"),
      ["---", "name: proj", "description: repo agent", "---", "body"].join("\n"),
    );
    // confirm returns true → the gate passes and the chain proceeds to the
    // (now blocked) step; the missing agent is reported at spawn time.
    const confirmed: Array<[string, string]> = [];
    await expect(
      runSubagentRequest(
        { chain: [{ agent: "proj", task: "x" }], agentScope: "both" },
        undefined,
        undefined,
        makeCtx(projDir, {
          hasUI: true,
          ui: { confirm: async (t: string, m: string) => { confirmed.push([t, m]); return true; } },
        }),
      ),
    ).rejects.toThrow();
    expect(confirmed.length).toBe(1);
    expect(confirmed[0]![0]).toContain("Run project-local agents?");
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

// ── parallel mode: pre-spawn branches ───────────────────────────────────────

test("parallel: too many tasks is refused before spawning", async () => {
  const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: "worker", task: `t${i}` }));
  const result = await runSubagentRequest({ tasks }, undefined, undefined, makeCtx(process.cwd()));
  const text = makeText(result);
  expect(text).toContain("Too many parallel tasks (9). Max is 8.");
});

test("parallel: configurable maxTasks via subagent.json", async () => {
  writeSubagentConfig({ parallel: { maxTasks: 2 } });
  const tasks = Array.from({ length: 3 }, (_, i) => ({ agent: "worker", task: `t${i}` }));
  const result = await runSubagentRequest({ tasks }, undefined, undefined, makeCtx(process.cwd()));
  const text = makeText(result);
  expect(text).toContain("Max is 2.");
});

test("parallel: spawn allowlist applies to the tasks mode", async () => {
  writeSubagentConfig({ spawns: ["scout"] });
  const result = await runSubagentRequest(
    { tasks: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }] },
    undefined,
    undefined,
    makeCtx(process.cwd()),
  );
  const text = makeText(result);
  expect(text).toContain("not in the spawn allowlist");
  expect(result.details.mode).toBe("parallel");
});

test("parallel: project agent in tasks mode is refused non-interactively", async () => {
  const projDir = mkdtempSync(join(tmpdir(), "pico-proj-par-"));
  try {
    mkdirSync(join(projDir, ".pico", "agents"), { recursive: true });
    writeFileSync(
      join(projDir, ".pico", "agents", "proj.md"),
      ["---", "name: proj", "description: repo agent", "---", "body"].join("\n"),
    );
    const result = await runSubagentRequest(
      { tasks: [{ agent: "proj", task: "x" }], agentScope: "both" },
      undefined,
      undefined,
      makeCtx(projDir, { hasUI: false }),
    );
    const text = makeText(result);
    expect(text).toContain("project-local agents need approval");
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

// ── session persistence config ──────────────────────────────────────────────

test("sessions disabled in subagent.json skips the session-dir creation", async () => {
  writeSubagentConfig({ sessions: { enabled: false } });
  const { picoSubagentSessionDir } = await import("../src/extensions/paths.ts");
  expect(picoSubagentSessionDir()).toBe(join(testHome, "subagent-sessions"));
  expect(join(testHome, "subagent-sessions")).not.toSatisfy(() => {
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      readdirSync(join(testHome, "subagent-sessions"));
      return true;
    } catch {
      return false;
    }
  });
});

test("sessions enabled (default) creates the session-dir root", async () => {
  const { picoSubagentSessionDir } = await import("../src/extensions/paths.ts");
  const dir = picoSubagentSessionDir();
  expect(join(testHome, "subagent-sessions")).not.toSatisfy(() => {
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      readdirSync(join(testHome, "subagent-sessions"));
      return true;
    } catch {
      return false;
    }
  });
  void dir;
});

// ── agent discovery & config wiring ─────────────────────────────────────────

test("user agent frontmatter: fallbackModels and maxRequests are parsed", async () => {
  writeUserAgent("cfgagent", ["model: primary", "fallbackModels: f1, f2", "maxRequests: 12"]);
  const { discoverAgents } = await import("../src/extensions/subagent/agents.ts");
  const agent = discoverAgents(process.cwd(), "user").agents.find((a) => a.name === "cfgagent");
  expect(agent?.model).toBe("primary");
  expect(agent?.fallbackModels).toEqual(["f1", "f2"]);
  expect(agent?.maxRequests).toBe(12);
});

test("user agent overrides a same-named bundled agent", async () => {
  writeUserAgent("worker", ["model: custom-model"]);
  const { discoverAgents } = await import("../src/extensions/subagent/agents.ts");
  const worker = discoverAgents(process.cwd(), "user").agents.find((a) => a.name === "worker");
  expect(worker?.model).toBe("custom-model");
});

// ── renderer formatting (pure functions) ────────────────────────────────────

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const baseResult = (overrides: Record<string, unknown> = {}) => ({
  agent: "worker",
  agentSource: "user" as const,
  task: "t",
  exitCode: 0,
  messages: [{ role: "assistant", content: [{ type: "text", text: "out" }] }],
  stderr: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  ...overrides,
});

function renderText(rendered: unknown): string {
  const r = rendered as { text?: string; content?: unknown; render?: (w: number) => string[] };
  if (typeof r?.render === "function") {
    return (r.render(120) ?? []).join("\n");
  }
  return String((r as any).text ?? (r as any).content ?? "");
}

test("renderer: formatUsageStats handles M-scale and empty stats", async () => {
  const { formatUsageStats } = await import("../src/extensions/subagent/renderer.ts");
  expect(formatUsageStats({ input: 2_000_000, output: 0 })).toBe("↑2.0M");
  expect(formatUsageStats({ turns: 5, cost: 1 })).toBe("5 turns $1.0000");
  expect(formatUsageStats({})).toBe("");
});

test("renderer: renderSubagentCall renders chain and single modes", async () => {
  const { renderSubagentCall } = await import("../src/extensions/subagent/renderer.ts");
  const chain = renderText(renderSubagentCall({
    chain: [
      { agent: "worker", task: "step one {previous}" },
      { agent: "reviewer", task: "review" },
      { agent: "scout", task: "third" },
      { agent: "oracle", task: "fourth" },
    ],
    agentScope: "both",
  }, plainTheme));
  expect(chain).toContain("chain (4 steps)");
  expect(chain).toContain("+1 more");
  expect(chain).toContain("step one");

  const single = renderText(renderSubagentCall({ agent: "scout", task: "research", agentScope: "user" }, plainTheme));
  expect(single).toContain("scout");
  expect(single).toContain("research");

  const noTask = renderText(renderSubagentCall({ agent: "oracle" }, plainTheme));
  expect(noTask).toContain("oracle");
});

test("renderer: formatToolCall renders every tool family", async () => {
  const { renderSubagentResult } = await import("../src/extensions/subagent/renderer.ts");
  const toolCall = (name: string, args: Record<string, unknown>) => ({
    type: "toolCall" as const,
    name,
    arguments: args,
  });
  const r = baseResult({
    messages: [{ role: "assistant", content: [toolCall("bash", { command: "echo hi" }), toolCall("read", { file_path: "/x/a.ts", offset: 5, limit: 10 }), toolCall("write", { path: "/x/new.ts", content: "a\nb\nc" }), toolCall("edit", { file_path: "/x/e.ts" }), toolCall("ls", { path: "/x" }), toolCall("find", { pattern: "*.ts", path: "/x" }), toolCall("grep", { pattern: "foo", path: "/x" }), toolCall("custom_tool", { a: 1 })] }],
  });
  const rendered = renderText(renderSubagentResult(
    {
      content: [{ type: "text", text: "final" }],
      details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] },
    },
    true,
    plainTheme,
  ));
  expect(rendered).toContain("$ echo hi");
  expect(rendered).toContain("read /x/a.ts:5-14");
  expect(rendered).toContain("write /x/new.ts (3 lines)");
  expect(rendered).toContain("edit /x/e.ts");
  expect(rendered).toContain("ls /x");
  expect(rendered).toContain("find *.ts in /x");
  expect(rendered).toContain("grep /foo/ in /x");
  expect(rendered).toContain("custom_tool");
});

test("renderer: expanded single result shows task, output, and usage", async () => {
  const { renderSubagentResult } = await import("../src/extensions/subagent/renderer.ts");
  const r = baseResult({
    messages: [{ role: "assistant", content: [{ type: "text", text: "the final answer" }] }],
    usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 4000, turns: 1 },
    model: "m1",
  });
  const rendered = renderText(renderSubagentResult(
    {
      content: [{ type: "text", text: "the final answer" }],
      details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] },
    },
    true,
    plainTheme,
  ));
  expect(rendered).toContain("─── Task ───");
  expect(rendered).toContain("the final answer");
  expect(rendered).toContain("↑1.0k ↓50 $0.0100 ctx:4.0k m1");
});

test("renderer: chain result renders per-step status and total usage", async () => {
  const { renderSubagentResult } = await import("../src/extensions/subagent/renderer.ts");
  const ok = baseResult({ step: 1, label: "plan" });
  const fail = baseResult({ step: 2, exitCode: 1, stopReason: "error", errorMessage: "boom", messages: [] });
  const rendered = renderText(renderSubagentResult(
    {
      content: [{ type: "text", text: "chain" }],
      details: { mode: "chain", agentScope: "user", projectAgentsDir: null, results: [ok, fail] },
    },
    true,
    plainTheme,
  ));
  expect(rendered).toContain("1/2 steps");
  expect(rendered).toContain("─── plan: ");
  expect(rendered).toContain("─── Step 2: worker ✗");
});

test("renderer: parallel result renders running placeholders", async () => {
  const { renderSubagentResult } = await import("../src/extensions/subagent/renderer.ts");
  const running = baseResult({ exitCode: -1, messages: [] });
  const done = baseResult({ agent: "scout", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
  const rendered = renderText(renderSubagentResult(
    {
      content: [{ type: "text", text: "par" }],
      details: { mode: "parallel", agentScope: "user", projectAgentsDir: null, results: [running, done] },
    },
    false,
    plainTheme,
  ));
  expect(rendered).toContain("1/2 done, 1 running");
  expect(rendered).toContain("(running…)");
});

// ── P0/P1/P2: pre-spawn branch enforcement ──────────────────────────────────

test("single: async and resumeFrom are rejected in parallel/chain modes", async () => {
  const par = await runSubagentRequest(
    { tasks: [{ agent: "worker", task: "a" }], async: true },
    undefined,
    undefined,
    makeCtx(process.cwd()),
  );
  expect(makeText(par)).toContain("async and resumeFrom are only supported in single mode");

  const chain = await runSubagentRequest(
    { chain: [{ agent: "worker", task: "a" }], resumeFrom: "/x" },
    undefined,
    undefined,
    makeCtx(process.cwd()),
  );
  expect(makeText(chain)).toContain("async and resumeFrom are only supported in single mode");
});

test("single: resumeFrom with a nonexistent path is refused before spawn", async () => {
  const result = await runSubagentRequest(
    { agent: "worker", task: "x", resumeFrom: "/no/such/session.jsonl" },
    undefined,
    undefined,
    makeCtx(process.cwd()),
  );
  expect(makeText(result)).toContain("Invalid resumeFrom path");
});

test("single: permissions.denyAgents refuses denied agents before spawn", async () => {
  writeSubagentConfig({ permissions: { denyAgents: ["worker"] } });
  const result = await runSubagentRequest(
    { agent: "worker", task: "x" },
    undefined,
    undefined,
    makeCtx(process.cwd()),
  );
  const text = makeText(result);
  expect(text).toContain("denied by settings \"subagent\".permissions.denyAgents");
  expect(text).toContain("worker");
});

test("renderer: renderSubagentWaitCall lists jobs", async () => {
  const { renderSubagentWaitCall } = await import("../src/extensions/subagent/renderer.ts");
  const two = renderText(renderSubagentWaitCall({ jobs: ["subagent-job-1", "subagent-job-2"] }, plainTheme));
  expect(two).toContain("2 jobs");
  expect(two).toContain("subagent-job-1");
  const one = renderText(renderSubagentWaitCall({ jobs: ["subagent-job-1"] }, plainTheme));
  expect(one).toContain("1 job");
});

test("renderer: renderSubagentCall marks async launches", async () => {
  const { renderSubagentCall } = await import("../src/extensions/subagent/renderer.ts");
  const rendered = renderText(renderSubagentCall({ agent: "worker", task: "t", async: true }, plainTheme));
  expect(rendered).toContain("async");
});
