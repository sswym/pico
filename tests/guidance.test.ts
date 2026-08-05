import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCrashResumeHint,
  buildHelpText,
  buildNoModelGuidance,
  buildReasoningErrorGuidance,
  guidanceExtension,
  isReasoningContractError,
} from "../src/extensions/guidance/index.ts";

const savedHome = process.env.PICO_HOME;
let home: string | null = null;

function withHome(): string {
  home = mkdtempSync(join(tmpdir(), "pico-guidance-"));
  process.env.PICO_HOME = home;
  return home;
}

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
  if (savedHome === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = savedHome;
});

function makeFakePi() {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
  const handlers: Record<string, Array<(event: any, ctx: any) => unknown>> = {};
  const sent: Array<{ customType: string; content: string }> = [];
  const pi = {
    registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => {
      commands.set(name, opts);
    },
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      (handlers[event] ??= []).push(handler);
    },
    sendMessage: (message: { customType: string; content: string }) => {
      sent.push(message);
    },
  };
  return { pi: pi as any, commands, handlers, sent };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: true,
    cwd: "/repo",
    model: { id: "m", provider: "p" },
    sessionManager: { getSessionId: () => "session-1" },
    ...overrides,
  };
}

function guidanceMessages(sent: Array<{ customType: string; content: string }>) {
  return sent.filter((m) => m.customType === "pico.guidance");
}

test("/help command is registered and renders offline command list", async () => {
  const { pi, commands, sent } = makeFakePi();
  guidanceExtension(pi);

  const help = commands.get("help");
  expect(help).toBeDefined();
  await help!.handler("", makeCtx());

  expect(sent.length).toBe(1);
  expect(sent[0]!.customType).toBe("pico.help");
  expect(sent[0]!.content).toContain("/doctor");
  expect(sent[0]!.content).toContain("/memory");
  expect(sent[0]!.content).toContain("F7");
  expect(buildHelpText()).toContain("/help");
});

test("no-model guidance is sent once in TUI sessions without a model", () => {
  withHome();
  const { pi, handlers, sent } = makeFakePi();
  guidanceExtension(pi);

  const sessionStart = handlers.session_start!;
  sessionStart[0]!({}, makeCtx({ model: undefined }));
  sessionStart[0]!({}, makeCtx({ model: undefined }));

  const guidance = guidanceMessages(sent);
  expect(guidance.length).toBe(1);
  expect(guidance[0]!.content).toContain("pico setup");
});

test("no-model guidance is skipped when a model is configured or UI is absent", () => {
  withHome();
  const { pi, handlers, sent } = makeFakePi();
  guidanceExtension(pi);
  const sessionStart = handlers.session_start!;

  sessionStart[0]!({}, makeCtx({ model: { id: "m", provider: "p" } }));
  sessionStart[0]!({}, makeCtx({ model: undefined, hasUI: false }));

  expect(guidanceMessages(sent).length).toBe(0);
});

test("crash marker: stale marker triggers resume hint once, clean quit clears it", () => {
  const home = withHome();
  const { pi, handlers, sent } = makeFakePi();
  guidanceExtension(pi);
  const sessionStart = handlers.session_start!;
  const sessionShutdown = handlers.session_shutdown!;
  const markerPath = join(home, "last-session.json");

  sessionStart[0]!({ reason: "startup" }, makeCtx());
  expect(guidanceMessages(sent).length).toBe(0);
  expect(existsSync(markerPath)).toBe(true);
  expect(JSON.parse(readFileSync(markerPath, "utf-8")).sessionId).toBe("session-1");

  sessionShutdown[0]!({ reason: "quit" }, makeCtx());
  expect(existsSync(markerPath)).toBe(false);
});

test("crash marker: abnormal exit leaves marker and next startup shows resume hint", () => {
  const home = withHome();
  const markerPath = join(home, "last-session.json");
  // Simulate run 1 dying: another process left its marker behind.
  writeFileSync(markerPath, JSON.stringify({ sessionId: "dead-session", cwd: "/repo", pid: 424242 }), "utf-8");

  const { pi, handlers, sent } = makeFakePi();
  guidanceExtension(pi);
  handlers.session_start![0]!({ reason: "startup" }, makeCtx({ sessionManager: { getSessionId: () => "session-2" } }));

  const hints = guidanceMessages(sent);
  expect(hints.length).toBe(1);
  expect(hints[0]!.content).toContain("pico -c");
  expect(hints[0]!.content).toContain("/repo");
  // Marker is refreshed for the live session.
  expect(JSON.parse(readFileSync(markerPath, "utf-8")).sessionId).toBe("session-2");
});

test("crash marker: session switch inside one process does not trigger the hint", () => {
  withHome();
  const { pi, handlers, sent } = makeFakePi();
  guidanceExtension(pi);
  const sessionStart = handlers.session_start!;

  // First session of this process, then a /new-style second session start:
  // the marker now on disk was written by this same process → no crash hint.
  sessionStart[0]!({ reason: "startup" }, makeCtx({ model: undefined }));
  expect(guidanceMessages(sent).length).toBe(1); // only the no-model hint

  sessionStart[0]!({ reason: "new" }, makeCtx({ model: undefined }));
  expect(guidanceMessages(sent).length).toBe(1); // still no crash hint
});

test("reasoning contract 400 in agent_end messages triggers guidance once", () => {
  withHome();
  const { pi, handlers, sent } = makeFakePi();
  guidanceExtension(pi);
  const agentEnd = handlers.agent_end!;

  const errorText =
    'Error: 400: {"message":"Error from provider (Console): Upstream request failed: ' +
    "[invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API.\"}";

  agentEnd[0]!({ messages: [{ role: "assistant", content: [{ type: "text", text: errorText }] }] }, makeCtx());
  agentEnd[0]!({ messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }, makeCtx());

  const guidance = guidanceMessages(sent);
  expect(guidance.length).toBe(1);
  expect(guidance[0]!.content).toContain("requiresReasoningContentOnAssistantMessages");
});

test("reasoning contract detection handles plain-text content and unrelated errors", () => {
  expect(isReasoningContractError('The `reasoning_content` in the thinking mode must be passed back to the API.')).toBe(true);
  expect(isReasoningContractError("rate limit exceeded")).toBe(false);
  expect(buildReasoningErrorGuidance()).toContain("Shift+Tab");
  expect(buildNoModelGuidance()).toContain("pico setup");
  expect(buildCrashResumeHint({ sessionId: "s1", cwd: "/w" })).toContain("pico -c");
});

test("guidance points at models.json (not the legacy models.yml)", () => {
  expect(buildReasoningErrorGuidance()).toContain("models.json");
  expect(buildReasoningErrorGuidance()).not.toContain("models.yml");
  expect(buildNoModelGuidance()).toContain("models.json");
  expect(buildNoModelGuidance()).not.toContain("models.yml");
});

test("guidance extension registers help and commands aliases", () => {
  const { pi, commands } = makeFakePi();
  guidanceExtension(pi);
  expect(commands.has("help")).toBe(true);
  expect(commands.has("commands")).toBe(true);
});
