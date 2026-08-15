/**
 * pico hooks unit tests.
 *
 * We exercise the loader (file discovery, merge, dedupe), the runner
 * (success / non-zero / timeout / placeholder substitution), and the
 * extension factory (registers all four event handlers and dispatches the
 * right ones).
 *
 * The runner tests use `bun -e` as a fixture so we don't need a separate
 * shell script; the extension tests use a fake ExtensionAPI that records
 * subscriptions, never spawning an actual subprocess.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  __resetWarnedPaths,
  hookConfigPaths,
  loadHooks,
  type Hook,
} from "../src/extensions/hooks/config.ts";
import { runHook, substitute } from "../src/extensions/hooks/runner.ts";
import { createHooksExtension } from "../src/extensions/hooks/index.ts";

let workdir: string;
let originalHome: string | undefined;
let originalProjectHooks: string | undefined;
let homeRoot: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "pico-hooks-"));
  homeRoot = mkdtempSync(join(tmpdir(), "pico-hooks-home-"));
  originalHome = process.env.PICO_HOME;
  originalProjectHooks = process.env.PICO_ENABLE_PROJECT_HOOKS;
  process.env.PICO_HOME = homeRoot;
  delete process.env.PICO_ENABLE_PROJECT_HOOKS;
  __resetWarnedPaths();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = originalHome;
  if (originalProjectHooks === undefined) delete process.env.PICO_ENABLE_PROJECT_HOOKS;
  else process.env.PICO_ENABLE_PROJECT_HOOKS = originalProjectHooks;
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  try { rmSync(homeRoot, { recursive: true, force: true }); } catch {}
});

function writeHomeConfig(content: unknown): void {
  const dir = join(homeRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hooks.json"), JSON.stringify(content));
}

function writeCwdConfig(content: unknown): void {
  const dir = join(workdir, ".pico");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hooks.json"), JSON.stringify(content));
}

test("hookConfigPaths returns home then cwd", () => {
  const [home, cwd] = hookConfigPaths(workdir);
  expect(home).toBe(join(homeRoot, "hooks.json"));
  expect(cwd).toBe(join(workdir, ".pico", "hooks.json"));
});

test("loadHooks returns [] when no config files exist", () => {
  expect(loadHooks(workdir)).toEqual([]);
});

test("loadHooks skips cwd layer unless project hooks are enabled", () => {
  writeHomeConfig({
    hooks: [
      { event: "PreToolUse", tool: "edit", command: "echo home-edit" },
    ],
  });
  writeCwdConfig({
    hooks: [
      { event: "PreToolUse", tool: "write", command: "echo cwd-write" },
    ],
  });
  const hooks = loadHooks(workdir);
  expect(hooks.length).toBe(1);
  expect(hooks[0]).toMatchObject({ event: "PreToolUse", tool: "edit", command: "echo home-edit" });
});

test("loadHooks merges home and cwd layers when project hooks are enabled", () => {
  process.env.PICO_ENABLE_PROJECT_HOOKS = "1";
  writeHomeConfig({
    hooks: [
      { event: "PreToolUse", tool: "edit", command: "echo home-edit" },
      { event: "PostToolUse", command: "echo shared" },
    ],
  });
  writeCwdConfig({
    hooks: [
      // exact duplicate of home — should drop
      { event: "PostToolUse", command: "echo shared" },
      // cwd-only
      { event: "PreToolUse", tool: "write", command: "echo cwd-write" },
    ],
  });
  const hooks = loadHooks(workdir);
  expect(hooks.length).toBe(3);
  expect(hooks[0]).toMatchObject({ event: "PreToolUse", tool: "edit", command: "echo home-edit" });
  expect(hooks[1]).toMatchObject({ event: "PostToolUse", command: "echo shared" });
  expect(hooks[2]).toMatchObject({ event: "PreToolUse", tool: "write", command: "echo cwd-write" });
  // defaults applied
  expect(hooks[0]!.timeoutMs).toBe(30_000);
  expect(hooks[0]!.blocking).toBe(true);
});

test("loadHooks drops entries with bad event/command and ignores unknown fields", () => {
  process.env.PICO_ENABLE_PROJECT_HOOKS = "1";
  writeCwdConfig({
    hooks: [
      { event: "PreToolUse", command: "echo ok", timeoutMs: 200_000 }, // capped
      { event: "Bogus", command: "echo no" },
      { event: "PreToolUse", command: "" },
      { event: "PreToolUse" }, // no command
    ],
  });
  const hooks = loadHooks(workdir);
  expect(hooks.length).toBe(1);
  expect(hooks[0]!.timeoutMs).toBe(120_000);
});

test("loadHooks tolerates malformed JSON without throwing", () => {
  process.env.PICO_ENABLE_PROJECT_HOOKS = "1";
  const dir = join(workdir, ".pico");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hooks.json"), "{not json");
  expect(loadHooks(workdir)).toEqual([]);
});

test("substitute fills $FILE / $TOOL / $TURN and leaves unknowns for the shell", () => {
  expect(substitute("fmt $FILE for $TOOL turn=$TURN", {
    FILE: "/x/y.ts",
    TOOL: "edit",
    TURN: "3",
  })).toBe("fmt '/x/y.ts' for 'edit' turn='3'");
  expect(substitute("fmt \"$FILE\"", { FILE: "/tmp/has space.ts" })).toBe("fmt \"/tmp/has space.ts\"");
  // Unknown tokens are preserved so the shell expands real environment
  // variables ($HOME, $PATH) instead of silently collapsing them to empty.
  expect(substitute("nada $UNKNOWN", {})).toBe("nada $UNKNOWN");
  expect(substitute("git -C $HOME/proj status", {})).toBe("git -C $HOME/proj status");
});

test("runHook returns exitCode=0 on success", async () => {
  const hook: Hook = {
    event: "PreToolUse",
    command: "exit 0",
    timeoutMs: 5000,
  };
  const res = await runHook(hook, {});
  expect(res.exitCode).toBe(0);
  expect(res.timedOut).toBe(false);
});

test("runHook reports non-zero exit", async () => {
  const hook: Hook = {
    event: "PreToolUse",
    command: "exit 7",
    timeoutMs: 5000,
  };
  const res = await runHook(hook, {});
  expect(res.exitCode).toBe(7);
  expect(res.timedOut).toBe(false);
});

test("runHook substitutes placeholders into the command", async () => {
  const hook: Hook = {
    event: "PreToolUse",
    command: "test \"$TOOL\" = edit && test \"$FILE\" = /tmp/x.ts",
    timeoutMs: 5000,
  };
  const res = await runHook(hook, { TOOL: "edit", FILE: "/tmp/x.ts" });
  expect(res.exitCode).toBe(0);
});

test("runHook shell-quotes unquoted placeholder values", async () => {
  const marker = join(workdir, "should-not-exist");
  const hook: Hook = {
    event: "PreToolUse",
    command: `test -n $FILE && test ! -e ${marker}`,
    timeoutMs: 5000,
  };
  const res = await runHook(hook, { FILE: `x; touch ${marker}` });
  expect(res.exitCode).toBe(0);
});

test("runHook keeps real newlines verbatim inside double quotes", async () => {
  const hook: Hook = {
    event: "PreToolUse",
    // $FILE inside double quotes carries a real newline; the hook must
    // receive it as a newline, not as a literal backslash-n.
    command: "printf '%s' \"$FILE\" | grep -c '^$'",
    timeoutMs: 5000,
  };
  const res = await runHook(hook, { FILE: "a\n\nb" });
  expect(res.exitCode).toBe(0);
  expect(res.stdout.trim()).toBe("1");
});

test("runHook hard-kills on timeout", async () => {
  const hook: Hook = {
    event: "PreToolUse",
    command: "sleep 5",
    timeoutMs: 100,
  };
  const start = Date.now();
  const res = await runHook(hook, {});
  const elapsed = Date.now() - start;
  expect(res.timedOut).toBe(true);
  expect(elapsed).toBeLessThan(2000);
});

test("runHook kills the whole process group on timeout (grandchildren included)", async () => {
  // Real-timer integration test: the point is that sh's grandchild (sleep)
  // dies with its group, so a short timeout + a brief settle wait is the
  // contract under test — fake timers cannot observe process death.
  const pidFile = join(tmpdir(), `pico-hook-grandchild-${process.pid}-${Date.now()}.pid`);
  const hook: Hook = {
    event: "PreToolUse",
    // Record the grandchild's pid, then idle forever.
    command: `sh -c 'sleep 100 & echo $! > ${pidFile}; wait'`,
    timeoutMs: 300,
  };
  const res = await runHook(hook, {});
  expect(res.timedOut).toBe(true);

  await Bun.sleep(150);
  const grandchild = Number(readFileSync(pidFile, "utf8").trim());
  expect(Number.isInteger(grandchild)).toBe(true);
  let alive = true;
  try {
    process.kill(grandchild, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
  try { rmSync(pidFile); } catch {}
});

test("runHook drains output larger than the pipe buffer without deadlocking", async () => {
  // >64KB on stdout fills the OS pipe buffer; a read-after-exit implementation
  // blocks the child on write, never sees it exit, and kills it via timeout.
  const hook: Hook = {
    event: "PreToolUse",
    command: "yes x | head -c 200000",
    timeoutMs: 5000,
  };
  const res = await runHook(hook, {});
  expect(res.timedOut).toBe(false);
  expect(res.exitCode).toBe(0);
  // Output is drained (no deadlock) and truncated at the 4KiB safety cap.
  expect(res.stdout.length).toBeGreaterThan(4000);
  expect(res.stdout.endsWith("[truncated]")).toBe(true);
});

// ---------------------------------------------------------------------------
// Extension factory wiring
// ---------------------------------------------------------------------------

interface FakeApi {
  handlers: Record<string, (event: unknown, ctx?: unknown) => unknown>;
  messages: Array<{ customType?: string; content?: string }>;
  notifications: Array<{ message: string; type?: string }>;
  ctx: {
    hasUI: boolean;
    cwd: string;
    ui: { notify(message: string, type?: string): void };
  };
}

function makeFakeApi(): FakeApi & { api: ExtensionAPI } {
  const handlers: FakeApi["handlers"] = {};
  const messages: FakeApi["messages"] = [];
  const notifications: FakeApi["notifications"] = [];
  const ctx: FakeApi["ctx"] = {
    hasUI: true,
    cwd: workdir,
    ui: {
      notify: (message, type) => {
        notifications.push({ message, type });
      },
    },
  };
  const api = {
    on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
      handlers[event] = handler;
    },
    sendMessage: (msg: { customType?: string; content?: string }) => {
      messages.push(msg);
    },
    registerTool: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
  } as unknown as ExtensionAPI;
  return { handlers, messages, notifications, ctx, api };
}

test("factory registers handlers for all four mapped events", () => {
  const factory = createHooksExtension({
    load: () => [],
    run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
  });
  const fake = makeFakeApi();
  factory(fake.api);
  expect(Object.keys(fake.handlers).sort()).toEqual(
    ["session_shutdown", "session_start", "tool_call", "tool_result", "turn_end"].sort(),
  );
});

test("PreToolUse hook with non-zero exit and blocking=true blocks the tool", async () => {
  const factory = createHooksExtension({
    load: () => [
      { event: "PreToolUse", tool: "edit", command: "fmt $FILE", timeoutMs: 1000, blocking: true },
    ],
    run: async (hook, vars) => {
      // Make sure the runner gets the substituted vars.
      expect(vars.FILE).toBe("/abs/x.ts");
      expect(vars.TOOL).toBe("edit");
      expect(hook.command).toBe("fmt $FILE");
      return { exitCode: 1, stdout: "", stderr: "no formatter found", timedOut: false };
    },
  });
  const fake = makeFakeApi();
  factory(fake.api);
  const handler = fake.handlers.tool_call;
  expect(typeof handler).toBe("function");

  const result = (await handler!({
    type: "tool_call",
    toolCallId: "t1",
    toolName: "edit",
    input: { path: "/abs/x.ts", edits: [] },
  })) as { block?: boolean; reason?: string };

  expect(result.block).toBe(true);
  expect(result.reason).toContain("no formatter found");
});

test("PreToolUse hook with blocking=false only warns on failure", async () => {
  const factory = createHooksExtension({
    load: () => [
      { event: "PreToolUse", command: "noop", timeoutMs: 1000, blocking: false },
    ],
    run: async () => ({ exitCode: 1, stdout: "", stderr: "boom", timedOut: false }),
  });
  const fake = makeFakeApi();
  factory(fake.api);
  const result = (await fake.handlers.tool_call!(
    {
      type: "tool_call",
      toolCallId: "t1",
      toolName: "edit",
      input: {},
    },
    fake.ctx,
  )) as { block?: boolean };
  expect(result.block).toBeUndefined();
  // D13-F2: the failure is a TUI warning, never a session custom message
  // (pi would inject custom messages into the model context).
  expect(
    fake.notifications.some((n) => n.type === "warning" && n.message.includes("blocking=false")),
  ).toBe(true);
  expect(fake.messages.length).toBe(0);
});

test("PostToolUse failure surfaces a warning, never blocks", async () => {
  const factory = createHooksExtension({
    load: () => [{ event: "PostToolUse", command: "x", timeoutMs: 1000 }],
    run: async () => ({ exitCode: 2, stdout: "", stderr: "", timedOut: false }),
  });
  const fake = makeFakeApi();
  factory(fake.api);
  const out = await fake.handlers.tool_result!(
    {
      type: "tool_result",
      toolCallId: "t1",
      toolName: "edit",
      input: {},
      content: [],
      isError: false,
    },
    fake.ctx,
  );
  expect(out).toEqual({});
  expect(
    fake.notifications.some((n) => n.type === "warning" && n.message.includes("PostToolUse hook")),
  ).toBe(true);
  expect(fake.messages.length).toBe(0);
});

test("session_start warns when project hooks config exists but is disabled (D13-F1)", async () => {
  const factory = createHooksExtension({
    load: () => [],
    run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    cwd: () => workdir,
  });
  const fake = makeFakeApi();
  factory(fake.api);
  // Project hooks config exists; PICO_ENABLE_PROJECT_HOOKS is unset (beforeEach).
  writeCwdConfig({ hooks: [{ event: "PostToolUse", command: "echo x" }] });

  await fake.handlers.session_start!({ type: "session_start" }, fake.ctx);

  const warning = fake.notifications.find((n) => n.type === "warning");
  expect(warning).toBeDefined();
  expect(warning!.message).toContain("被安全策略禁用");
  expect(warning!.message).toContain("/doctor");
  expect(warning!.message).toContain("PICO_ENABLE_PROJECT_HOOKS");
  expect(fake.messages.length).toBe(0);
});

test("session_start eager-loads hooks so malformed-config errors are drained (D13-F1)", async () => {
  process.env.PICO_ENABLE_PROJECT_HOOKS = "1";
  const dir = join(workdir, ".pico");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hooks.json"), "{not json");
  const factory = createHooksExtension({
    load: loadHooks,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    cwd: () => workdir,
  });
  const fake = makeFakeApi();
  factory(fake.api);

  await fake.handlers.session_start!({ type: "session_start" }, fake.ctx);

  const warning = fake.notifications.find((n) => n.type === "warning");
  expect(warning).toBeDefined();
  expect(warning!.message).toContain("ignoring");
  expect(warning!.message).toContain("hooks.json");
});

test("long blocking hook progress is a TUI notice, not a model-context message (D13-F2)", async () => {
  const factory = createHooksExtension({
    load: () => [
      { event: "PreToolUse", command: "slow $TOOL", timeoutMs: 30000, blocking: true },
    ],
    run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    cwd: () => workdir,
  });
  const fake = makeFakeApi();
  factory(fake.api);

  const out = (await fake.handlers.tool_call!(
    {
      type: "tool_call",
      toolCallId: "t1",
      toolName: "edit",
      input: {},
    },
    fake.ctx,
  )) as { block?: boolean };

  expect(out.block).toBeUndefined();
  expect(
    fake.notifications.some(
      (n) => n.type === "info" && n.message.includes("Waiting for PreToolUse hook"),
    ),
  ).toBe(true);
  expect(fake.messages.length).toBe(0);
});

test("turn_end fires PostUserMessage hooks with $TURN populated", async () => {
  let captured: Record<string, string | undefined> = {};
  const factory = createHooksExtension({
    load: () => [{ event: "PostUserMessage", command: "echo $TURN", timeoutMs: 1000 }],
    run: async (_hook, vars) => {
      captured = vars;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  const fake = makeFakeApi();
  factory(fake.api);
  await fake.handlers.turn_end!({ type: "turn_end", turnIndex: 4, message: {}, toolResults: [] });
  expect(captured.TURN).toBe("4");
});

test("session_shutdown fires PreSessionEnd hooks", async () => {
  let calls = 0;
  const factory = createHooksExtension({
    load: () => [{ event: "PreSessionEnd", command: "cleanup", timeoutMs: 1000 }],
    run: async () => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  const fake = makeFakeApi();
  factory(fake.api);
  await fake.handlers.session_shutdown!({ type: "session_shutdown", reason: "quit" });
  expect(calls).toBe(1);
});

test("non-matching tool name skips the hook", async () => {
  let runs = 0;
  const factory = createHooksExtension({
    load: () => [
      { event: "PreToolUse", tool: "edit", command: "x", timeoutMs: 1000, blocking: true },
    ],
    run: async () => {
      runs += 1;
      return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
    },
  });
  const fake = makeFakeApi();
  factory(fake.api);
  const out = (await fake.handlers.tool_call!({
    type: "tool_call",
    toolCallId: "t1",
    toolName: "read", // <- doesn't match "edit"
    input: { path: "/x" },
  })) as { block?: boolean };
  expect(runs).toBe(0);
  expect(out.block).toBeUndefined();
});

test("substitute skips escaped placeholders and heredoc bodies", () => {
  const vars = { FILE: "/tmp/secret.txt" };
  // Escaped placeholder stays literal for the shell.
  expect(substitute("echo \\$FILE", vars)).toBe("echo \\$FILE");
  // Heredoc bodies are literal text.
  const heredoc = "cat <<EOF > out.txt\nline with $FILE inside\nEOF";
  expect(substitute(heredoc, vars)).toBe(heredoc);
  // Substitution outside heredocs still works.
  expect(substitute("echo $FILE <<EOF\n$FILE\nEOF", vars)).toContain("'/tmp/secret.txt'");
});

test("runHook spawns in the given cwd", async () => {
  const hook = { event: "PreToolUse" as const, command: "pwd" };
  const tmp = mkdtempSync(join(tmpdir(), "pico-hook-cwd-"));
  try {
    const res = await runHook(hook, {}, tmp);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadHooks prefers the settings.json hooks namespace over the legacy file", () => {
  writeHomeConfig({ hooks: [{ event: "PreToolUse", command: "echo legacy" }] });
  const agentDir = join(homeRoot, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ hooks: { hooks: [{ event: "PreToolUse", command: "echo namespace" }] } }),
  );
  const hooks = loadHooks(workdir);
  expect(hooks).toHaveLength(1);
  expect(hooks[0]!.command).toBe("echo namespace");
});

test("loadHooks falls back to the legacy file when the settings namespace is absent", () => {
  writeHomeConfig({ hooks: [{ event: "PreToolUse", command: "echo legacy" }] });
  const hooks = loadHooks(workdir);
  expect(hooks).toHaveLength(1);
  expect(hooks[0]!.command).toBe("echo legacy");
});
