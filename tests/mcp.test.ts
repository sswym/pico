/**
 * MCP extension tests.
 *
 * Covers the extension seam without spawning real MCP servers:
 * - config is loaded from session ctx.cwd, not process.cwd()
 * - tools are registered after session_start
 * - registered tool calls forward to the MCP client adapter
 * - shutdown closes connected handles
 */
import { expect, test } from "bun:test";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import type { McpServerConfig, McpServerHandle, McpToolCallResult } from "../src/extensions/mcp/types.ts";

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

test("MCP extension loads config from session cwd and registers discovered tools", async () => {
  const pi = makeFakePi();
  const loadedCwds: string[] = [];
  const calls: Array<{ handle: string; toolName: string; params: Record<string, unknown> }> = [];
  const closed: string[] = [];
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

  await pi.handlers["session_start"]![0]!({}, { cwd: "/repo/project" });

  expect(loadedCwds).toEqual(["/repo/project"]);
  expect(pi.tools.has("mcp__docs__lookup")).toBe(true);

  const result = await pi.tools.get("mcp__docs__lookup").execute("tc1", { query: "memory" });
  expect(result.content[0].text).toBe("found docs");
  expect(result.details).toEqual({ server: "docs", tool: "lookup" });
  expect(calls).toEqual([{ handle: "docs", toolName: "lookup", params: { query: "memory" } }]);

  await pi.handlers["session_shutdown"]![0]!({}, {});
  expect(closed).toEqual(["docs"]);
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
