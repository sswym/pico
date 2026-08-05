/**
 * MCP extension tests.
 *
 * Covers the extension seam without spawning real MCP servers:
 * - config is loaded from session ctx.cwd, not process.cwd()
 * - tools are registered after session_start
 * - registered tool calls forward to the MCP client adapter
 * - shutdown closes connected handles
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMcpConfig } from "../src/extensions/mcp/config.ts";
import { createMcpExtension, formatMcpReport } from "../src/extensions/mcp/index.ts";
import type { McpServerConfig, McpServerHandle, McpToolCallResult } from "../src/extensions/mcp/types.ts";

const envStack: Array<{ home: string | undefined; projectMcp: string | undefined }> = [];

function pushEnv(): void {
  envStack.push({
    home: process.env.PICO_HOME,
    projectMcp: process.env.PICO_ENABLE_PROJECT_MCP,
  });
}

afterEach(() => {
  const prev = envStack.pop();
  if (!prev) return;
  if (prev.home === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = prev.home;
  if (prev.projectMcp === undefined) delete process.env.PICO_ENABLE_PROJECT_MCP;
  else process.env.PICO_ENABLE_PROJECT_MCP = prev.projectMcp;
});

function makeHandle(id: string): McpServerHandle {
  return {
    id,
    proc: {
      stdin: {
        write: () => 0,
        end: () => 0,
      },
      kill: () => {},
      exited: Promise.resolve(0),
    },
    nextId: 1,
    pending: new Map(),
    buffer: "",
  };
}

function makeFakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
  return {
    tools,
    commands,
    handlers,
    on: (event: string, handler: (event: any, ctx: any) => any) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, opts: any) => {
      commands.set(name, opts);
    },
  };
}

test("loadMcpConfig skips project config unless explicitly enabled", () => {
  pushEnv();
  const home = mkdtempSync(join(tmpdir(), "pico-mcp-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pico-mcp-cwd-"));
  process.env.PICO_HOME = home;
  delete process.env.PICO_ENABLE_PROJECT_MCP;
  try {
    writeFileSync(join(home, "mcp-servers.json"), JSON.stringify({
      mcpServers: { docs: { command: "home-docs" } },
    }));
    mkdirSync(join(cwd, ".pico"), { recursive: true });
    writeFileSync(join(cwd, ".pico", "mcp-servers.json"), JSON.stringify({
      mcpServers: { docs: { command: "project-docs" }, local: { command: "local" } },
    }));

    expect(loadMcpConfig(cwd)).toEqual({ docs: { command: "home-docs" } });

    process.env.PICO_ENABLE_PROJECT_MCP = "1";
    expect(loadMcpConfig(cwd)).toEqual({
      docs: { command: "project-docs" },
      local: { command: "local" },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("MCP extension loads config from session cwd and registers discovered tools", async () => {
  const pi = makeFakePi();
  const loadedCwds: string[] = [];
  const calls: Array<{ handle: string; toolName: string; params: Record<string, unknown> }> = [];
  const closed: string[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const extension = createMcpExtension({
    load: (cwd) => {
      loadedCwds.push(cwd);
      return {
        docs: { command: "fake-mcp" } satisfies McpServerConfig,
      };
    },
    spawn: (id) => makeHandle(id),
    initialize: async () => ({
      protocolVersion: "test",
      capabilities: {},
      serverInfo: { name: "Fake MCP", version: "1.0.0" },
    }),
    listTools: async () => [
      {
        name: "lookup",
        description: "Lookup docs",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
    callTool: async (handle, toolName, params): Promise<McpToolCallResult> => {
      calls.push({ handle: handle.id, toolName, params });
      return { content: [{ type: "text", text: "found docs" }] };
    },
    close: (handle) => {
      closed.push(handle.id);
    },
  });

  extension(pi as any);
  expect(pi.commands.has("mcp")).toBe(true);
  expect(pi.tools.size).toBe(0);

  await pi.handlers["session_start"]![0]!({}, {
    cwd: "/repo/project",
    ui: {
      setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
    },
  });

  expect(loadedCwds).toEqual(["/repo/project"]);
  expect(statuses.at(-1)).toEqual(["mcp", "MCP: 1 connected"]);
  expect(pi.tools.has("mcp__docs__lookup")).toBe(true);
  expect(pi.tools.get("mcp__docs__lookup").renderResult).toBeFunction();

  const result = await pi.tools.get("mcp__docs__lookup").execute("tc1", { query: "memory" });
  expect(result.content[0].text).toBe("found docs");
  expect(result.details).toEqual({ server: "docs", tool: "lookup" });
  expect(calls).toEqual([{ handle: "docs", toolName: "lookup", params: { query: "memory" } }]);

  await pi.handlers["session_shutdown"]![0]!({}, {});
  expect(closed).toEqual(["docs"]);
  expect(statuses.at(-1)).toEqual(["mcp", undefined]);
});

test("MCP extension records failed server connections without blocking other servers", async () => {
  const pi = makeFakePi();
  const closed: string[] = [];
  const extension = createMcpExtension({
    load: () => ({
      bad: { command: "bad" },
      good: { command: "good" },
    }),
    spawn: (id) => makeHandle(id),
    initialize: async (handle) => {
      if (handle.id === "bad") throw new Error("cannot start");
      return {
        protocolVersion: "test",
        capabilities: {},
        serverInfo: { name: "Good MCP", version: "2.0.0" },
      };
    },
    listTools: async () => [{ name: "ok", inputSchema: { type: "object", properties: {} } }],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: (handle) => {
      closed.push(handle.id);
    },
  });

  extension(pi as any);
  await pi.handlers["session_start"]![0]!({}, { cwd: "/repo/project" });

  expect(pi.tools.has("mcp__good__ok")).toBe(true);
  expect(closed).toContain("bad");

  const notices: Array<{ text: string; level: string }> = [];
  await pi.commands.get("mcp").handler("", {
    ui: {
      notify: (text: string, level: string) => notices.push({ text, level }),
    },
  });
  expect(notices[0]!.level).toBe("warning");
  expect(notices[0]!.text).toContain("bad");
  expect(notices[0]!.text).toContain("FAILED");

  await pi.handlers["session_shutdown"]![0]!({}, {});
  expect(closed).toContain("good");
});

test("/mcp report includes connected tools and recent diagnostics without terminal logging", () => {
  const handle = makeHandle("docs");
  handle.diagnostics = ["warn one", "warn two"];

  const report = formatMcpReport([
    {
      id: "docs",
      serverName: "Docs MCP",
      serverVersion: "1.2.3",
      toolCount: 1,
      toolNames: ["mcp__docs__lookup"],
      handle,
    },
  ]);

  expect(report.level).toBe("info");
  expect(report.text).toContain("Docs MCP 1.2.3");
  expect(report.text).toContain("mcp__docs__lookup");
  expect(report.text).toContain("diagnostics:");
  expect(report.text).toContain("warn two");
});

test("MCP tools from a previous cwd stop using closed handles after reconnect", async () => {
  const pi = makeFakePi();
  const calls: Array<{ handle: string; toolName: string }> = [];
  const closed: string[] = [];
  const extension = createMcpExtension({
    load: (cwd): Record<string, McpServerConfig> => {
      if (cwd.endsWith("one")) return { one: { command: "one" } };
      return { two: { command: "two" } };
    },
    spawn: (id) => makeHandle(id),
    initialize: async (handle) => ({
      protocolVersion: "test",
      capabilities: {},
      serverInfo: { name: handle.id, version: "1.0.0" },
    }),
    listTools: async (handle) => [{ name: handle.id === "one" ? "old" : "new", inputSchema: { type: "object", properties: {} } }],
    callTool: async (handle, toolName): Promise<McpToolCallResult> => {
      calls.push({ handle: handle.id, toolName });
      return { content: [{ type: "text", text: "ok" }] };
    },
    close: (handle) => {
      closed.push(handle.id);
    },
  });

  extension(pi as any);
  await pi.handlers["session_start"]![0]!({}, { cwd: "/repo/one" });
  const oldTool = pi.tools.get("mcp__one__old");
  expect(oldTool).toBeDefined();

  await pi.handlers["session_start"]![0]!({}, { cwd: "/repo/two" });
  expect(closed).toContain("one");
  expect(pi.tools.has("mcp__two__new")).toBe(true);

  // Tool failures are expressed by throwing (the agent loop derives isError
  // from thrown exceptions), and the stale tool must NOT reach the closed
  // handle.
  await expect(oldTool.execute("tc-old", {})).rejects.toThrow(/not active/i);
  expect(calls).toEqual([]);

  const newResult = await pi.tools.get("mcp__two__new").execute("tc-new", {});
  // Success results carry no isError field — the agent loop derives it from
  // thrown errors only, and this is a success path.
  expect(newResult.isError).toBeUndefined();
  expect(calls).toEqual([{ handle: "two", toolName: "new" }]);
});

test("connect closes a superseded handle when a newer connect starts mid-initialization", async () => {
  const pi = makeFakePi();
  const closed: string[] = [];
  let releaseInit: (() => void) | undefined;
  const initGate = new Promise<void>((resolve) => { releaseInit = resolve; });
  const extension = createMcpExtension({
    load: (cwd): Record<string, McpServerConfig> => {
      if (cwd.endsWith("one")) return { one: { command: "one" } };
      return { two: { command: "two" } };
    },
    spawn: (id) => makeHandle(id),
    initialize: async (handle) => {
      if (handle.id === "one") await initGate;
      return { protocolVersion: "test", capabilities: {}, serverInfo: { name: handle.id, version: "1.0.0" } };
    },
    listTools: async (handle) => [{ name: "t", inputSchema: { type: "object", properties: {} } }],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: (handle) => {
      closed.push(handle.id);
    },
  });

  extension(pi as any);
  // First connect stalls inside initialize(); the second connect starts
  // before it settles.
  const first = pi.handlers["session_start"]![0]!({}, { cwd: "/repo/one" });
  await pi.handlers["session_start"]![0]!({}, { cwd: "/repo/two" });
  releaseInit!();
  await first;

  // The superseded generation must close its own handle instead of leaking it.
  expect(closed).toContain("one");
  expect(closed).not.toContain("two");
  expect(pi.tools.has("mcp__two__t")).toBe(true);
});

// ─── Real-subprocess integration: requests must actually reach the server ──

import { spawnMcpServer, mcpInitialize, mcpListTools, closeMcpServer } from "../src/extensions/mcp/client.ts";

/** Minimal stdio JSON-RPC echo server: replies to initialize/tools/list. */
const ECHO_SERVER = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { process.stderr.write("bad json: " + line + "\\n"); continue; }
    if (req.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "echo", version: "1.0.0" } } }) + "\\n");
    } else if (req.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "ping", description: "pong" }] } }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\\n");
    }
  }
});
`;

test("MCP client requests reach a real subprocess (stdin flush regression)", async () => {
  const handle = spawnMcpServer("echo", {
    command: process.execPath,
    args: ["-e", ECHO_SERVER],
  });
  try {
    const init = await mcpInitialize(handle);
    expect(init.serverInfo.name).toBe("echo");
    const tools = await mcpListTools(handle);
    expect(tools.map((t) => t.name)).toEqual(["ping"]);
  } finally {
    closeMcpServer(handle);
  }
});

// ---- Fourth-round regression tests: isError throw / parallel+retry / shutdown holders ----

test("MCP execute throws when the server reports isError (dead return field)", async () => {
  const pi = makeFakePi();
  const extension = createMcpExtension({
    load: () => ({ srv: { command: "fake" } }),
    spawn: (id) => makeHandle(id),
    initialize: async () => ({
      protocolVersion: "test",
      capabilities: {},
      serverInfo: { name: "S", version: "1" },
    }),
    listTools: async () => [{ name: "boom", inputSchema: { type: "object", properties: {} } }],
    callTool: async (): Promise<McpToolCallResult> => ({
      content: [{ type: "text", text: "server-side failure detail" }],
      isError: true,
    }),
    close: () => {},
  });
  extension(pi as never);
  await pi.handlers["session_start"]![0]!({}, { cwd: "/repo" });
  await expect(
    pi.tools.get("mcp__srv__boom").execute("tc1", {}),
  ).rejects.toThrow(/server-side failure detail/);
});

test("MCP connect retries failed servers on the next session_start with the same cwd", async () => {
  const pi = makeFakePi();
  let failing = true;
  const extension = createMcpExtension({
    load: () => ({ flaky: { command: "fake" } }),
    spawn: (id) => makeHandle(id),
    initialize: async () => {
      if (failing) throw new Error("not ready yet");
      return { protocolVersion: "test", capabilities: {}, serverInfo: { name: "F", version: "1" } };
    },
    listTools: async () => [{ name: "ok", inputSchema: { type: "object", properties: {} } }],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: () => {},
  });
  extension(pi as never);

  await pi.handlers["session_start"]![0]!({}, { cwd: "/repo" });
  expect(pi.tools.has("mcp__flaky__ok")).toBe(false);

  // Server recovers; the next session_start for the same cwd must retry it.
  failing = false;
  await pi.handlers["session_start"]![0]!({}, { cwd: "/repo" });
  expect(pi.tools.has("mcp__flaky__ok")).toBe(true);
});

test("MCP session_shutdown nulls holder refs so stale tools fail fast", async () => {
  const pi = makeFakePi();
  const extension = createMcpExtension({
    load: () => ({ srv: { command: "fake" } }),
    spawn: (id) => makeHandle(id),
    initialize: async () => ({
      protocolVersion: "test",
      capabilities: {},
      serverInfo: { name: "S", version: "1" },
    }),
    listTools: async () => [{ name: "ok", inputSchema: { type: "object", properties: {} } }],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: () => {},
  });
  extension(pi as never);
  await pi.handlers["session_start"]![0]!({}, { cwd: "/repo" });
  const tool = pi.tools.get("mcp__srv__ok");
  await tool.execute("tc1", {});
  await pi.handlers["session_shutdown"]![0]!({}, {});
  // Between shutdown and the next connect the tool must throw "not active",
  // not write to the closed handle and hang for the request timeout.
  await expect(tool.execute("tc2", {})).rejects.toThrow(/not active/);
});

test("MCP registration rollback leaves no dangling active tools when registration fails mid-server", async () => {
  const tools = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
  const pi = {
    tools,
    commands,
    handlers,
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: (tool: { name: string }) => {
      // Simulate the upstream unique-name validation: duplicate tool names throw.
      if (tools.has(tool.name)) throw new Error("duplicate tool name");
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, opts: unknown) => {
      commands.set(name, opts);
    },
  };

  const extension = createMcpExtension({
    load: () => ({ dup: { command: "fake" } }),
    spawn: (id) => makeHandle(id),
    initialize: async () => ({
      protocolVersion: "test",
      capabilities: {},
      serverInfo: { name: "D", version: "1" },
    }),
    listTools: async () => [
      { name: "a", inputSchema: { type: "object", properties: {} } },
      { name: "b", inputSchema: { type: "object", properties: {} } },
    ],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: () => {},
  });
  // Simulate the upstream unique-name validation throwing mid-server (after
  // "a" was already registered): "a" must not stay active.
  const throwingPi = {
    ...pi,
    registerTool: (tool: { name: string }) => {
      if (tool.name === "mcp__dup__b") throw new Error("duplicate tool name");
      tools.set(tool.name, tool);
    },
  };
  extension(throwingPi as never);
  await pi.handlers["session_start"]![0]!({}, { cwd: "/repo" });

  // The failed server leaves no half-registered state: tool "a" is not active.
  await expect(
    (tools.get("mcp__dup__a") as { execute: (id: string, p: unknown) => Promise<unknown> }).execute("tc1", {}),
  ).rejects.toThrow(/not active/);
});

test("loadMcpConfig validates server entries and keeps valid ones from a broken file", () => {
  pushEnv();
  const home = mkdtempSync(join(tmpdir(), "pico-mcp-home-"));
  process.env.PICO_HOME = home;
  const { __resetMcpConfigWarningsForTests } = require("../src/extensions/mcp/config.ts") as typeof import("../src/extensions/mcp/config.ts");
  try {
    writeFileSync(join(home, "mcp-servers.json"), JSON.stringify({
      mcpServers: {
        good: { command: "npx", args: ["-y", "server"], env: { TOKEN: "abc" } },
        badCommand: { command: 123 },
        badEnv: { command: "x", env: "nope" },
        badArgs: { command: "x", args: "nope" },
      },
    }));
    const loaded = loadMcpConfig(process.cwd());
    expect(Object.keys(loaded)).toEqual(["good"]);
    expect(loaded.good).toEqual({ command: "npx", args: ["-y", "server"], env: { TOKEN: "abc" } });
  } finally {
    __resetMcpConfigWarningsForTests();
    rmSync(home, { recursive: true, force: true });
  }
});
