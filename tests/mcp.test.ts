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
    home: process.env.SRCODE_HOME,
    projectMcp: process.env.SRCODE_ENABLE_PROJECT_MCP,
  });
}

afterEach(() => {
  const prev = envStack.pop();
  if (!prev) return;
  if (prev.home === undefined) delete process.env.SRCODE_HOME;
  else process.env.SRCODE_HOME = prev.home;
  if (prev.projectMcp === undefined) delete process.env.SRCODE_ENABLE_PROJECT_MCP;
  else process.env.SRCODE_ENABLE_PROJECT_MCP = prev.projectMcp;
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
  const home = mkdtempSync(join(tmpdir(), "srcode-mcp-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "srcode-mcp-cwd-"));
  process.env.SRCODE_HOME = home;
  delete process.env.SRCODE_ENABLE_PROJECT_MCP;
  try {
    writeFileSync(join(home, "mcp-servers.json"), JSON.stringify({
      mcpServers: { docs: { command: "home-docs" } },
    }));
    mkdirSync(join(cwd, ".srcode"), { recursive: true });
    writeFileSync(join(cwd, ".srcode", "mcp-servers.json"), JSON.stringify({
      mcpServers: { docs: { command: "project-docs" }, local: { command: "local" } },
    }));

    expect(loadMcpConfig(cwd)).toEqual({ docs: { command: "home-docs" } });

    process.env.SRCODE_ENABLE_PROJECT_MCP = "1";
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

  const oldResult = await oldTool.execute("tc-old", {});
  expect(oldResult.isError).toBe(true);
  expect(oldResult.content[0].text).toMatch(/no longer active/i);
  expect(calls).toEqual([]);

  const newResult = await pi.tools.get("mcp__two__new").execute("tc-new", {});
  expect(newResult.isError).toBe(false);
  expect(calls).toEqual([{ handle: "two", toolName: "new" }]);
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
