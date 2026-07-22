/**
 * srcode MCP extension.
 *
 * Discovers MCP servers from config files and registers their tools as
 * LLM-callable tools with pi's extension system.
 *
 * Tool naming: mcp__<server>__<toolName>
 *   — compatible with the mcp__ prefix matching.
 *
 * Lifecycle:
 *   1. Extension init (async): read config, spawn servers, initialize, list
 *      tools, register each tool via pi.registerTool().
 *   2. Tool execute: forward arguments to the MCP server via tools/call.
 *   3. Session shutdown: close all MCP server processes.
 *
 * Slash command: /mcp — list connected servers and their tools.
 *
 * Config files (JSON, Claude Code compatible):
 *   ~/.srcode/mcp-servers.json      — home-wide
 *   <cwd>/.srcode/mcp-servers.json  — project-specific (overrides home)
 *
 * Format:
 *   { "mcpServers": { "name": { "command": "npx", "args": [...], "env": {} } } }
 */
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { renderToolCallText, renderToolResultText } from "../tool-render.ts";
import { loadMcpConfig } from "./config.ts";
import {
  spawnMcpServer,
  mcpInitialize,
  mcpListTools,
  mcpCallTool,
  closeMcpServer,
} from "./client.ts";
import type { McpServerConfig, McpServerHandle, McpTool, McpToolCallResult, McpInitializeResult } from "./types.ts";

interface ServerStatus {
  id: string;
  serverName: string;
  serverVersion: string;
  toolCount: number;
  toolNames: string[];
  handle: McpServerHandle;
  error?: undefined;
}

interface ServerFailure {
  id: string;
  error: string;
  handle?: undefined;
}

type ServerEntry = ServerStatus | ServerFailure;
const MCP_STATUS_KEY = "mcp";

export interface McpExtensionDeps {
  load: (cwd: string) => Record<string, McpServerConfig>;
  spawn: (id: string, config: McpServerConfig) => McpServerHandle;
  initialize: (handle: McpServerHandle) => Promise<McpInitializeResult>;
  listTools: (handle: McpServerHandle) => Promise<McpTool[]>;
  callTool: (handle: McpServerHandle, toolName: string, params: Record<string, unknown>) => Promise<McpToolCallResult>;
  close: (handle: McpServerHandle) => void;
}

function connectedEntries(entries: ServerEntry[]): ServerStatus[] {
  return entries.filter((entry): entry is ServerStatus => !entry.error);
}

function failedEntries(entries: ServerEntry[]): ServerFailure[] {
  return entries.filter((entry): entry is ServerFailure => !!entry.error);
}

export function formatMcpStatus(entries: ServerEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const connected = connectedEntries(entries).length;
  const failed = failedEntries(entries).length;
  if (failed > 0) return `MCP: ${connected} ok, ${failed} failed`;
  return `MCP: ${connected} connected`;
}

export function formatMcpReport(entries: ServerEntry[]): { text: string; level: "info" | "warning" } {
  const connected = connectedEntries(entries);
  const failed = failedEntries(entries);

  if (entries.length === 0) {
    return { text: "No MCP servers configured.", level: "info" };
  }

  const lines: string[] = [];
  lines.push(`MCP Servers (${connected.length} connected, ${failed.length} failed):\n`);

  for (const entry of entries) {
    if (!("serverName" in entry)) {
      lines.push(`  ! ${entry.id} - FAILED: ${entry.error}`);
    } else {
      lines.push(`  * ${entry.id} (${entry.serverName} ${entry.serverVersion}) - ${entry.toolCount} tools`);
      for (const name of entry.toolNames) {
        lines.push(`      ${name}`);
      }
      const diagnostics = entry.handle.diagnostics ?? [];
      if (diagnostics.length > 0) {
        lines.push("      diagnostics:");
        for (const line of diagnostics.slice(-5)) {
          lines.push(`        ${line}`);
        }
      }
    }
  }

  return { text: lines.join("\n"), level: failed.length > 0 ? "warning" : "info" };
}

function updateMcpStatus(ctx: unknown, entries: ServerEntry[]): void {
  const ui = (ctx as { ui?: { setStatus?: (key: string, value: string | undefined) => void } }).ui;
  ui?.setStatus?.(MCP_STATUS_KEY, formatMcpStatus(entries));
}

export function createMcpExtension(deps: McpExtensionDeps): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const entries: ServerEntry[] = [];
    const activeTools = new Map<string, { handle: McpServerHandle; toolName: string }>();
    let connectedCwd: string | null = null;

  // ── Register /mcp command BEFORE async server connections ──────────────

    pi.registerCommand("mcp", {
      description: "List connected MCP servers and their tools",
      handler: async (_args, ctx) => {
        const report = formatMcpReport(entries);
        ctx.ui.notify(report.text, report.level);
      },
    });

  // ── Connect to MCP servers once the session cwd is known ────────────────

    async function connect(cwd: string): Promise<void> {
      if (connectedCwd === cwd) return;
      for (const entry of entries) {
        if (entry.handle) deps.close(entry.handle);
      }
      entries.length = 0;
      activeTools.clear();
      connectedCwd = cwd;

      const servers = deps.load(cwd);

      for (const [id, config] of Object.entries(servers)) {
        let handle: McpServerHandle | undefined;
        try {
          handle = deps.spawn(id, config);
          const initResult = await deps.initialize(handle);
          const tools = await deps.listTools(handle);

          const { name: serverName, version: serverVersion } = initResult.serverInfo;

          const toolNames: string[] = [];
          for (const tool of tools) {
            const piToolName = `mcp__${id}__${tool.name}`;
            toolNames.push(piToolName);
            const schema = tool.inputSchema ?? { type: "object" as const, properties: {} };
            const toolHandle = handle;
            activeTools.set(piToolName, { handle: toolHandle, toolName: tool.name });

            pi.registerTool(
              defineTool({
                name: piToolName,
                label: `MCP: ${id} › ${tool.name}`,
                description: tool.description ?? `MCP tool "${tool.name}" from server "${id}"`,
                promptSnippet:
                  `${piToolName} — call "${tool.name}" on MCP server "${id}"`,
                parameters: Type.Unsafe(schema),
                renderCall(args, theme, context) {
                  return renderToolCallText(piToolName, args, theme, context);
                },
                renderResult(result, options, theme, context) {
                  return renderToolResultText(result, options, theme, context);
                },
                async execute(_tcId, params, _signal) {
                  try {
                    const active = activeTools.get(piToolName);
                    if (!active || active.handle !== toolHandle) {
                      throw new Error(`MCP tool "${piToolName}" is no longer active for this session`);
                    }
                    const result = await deps.callTool(active.handle, active.toolName, params as Record<string, unknown>);
                    return {
                      content: result.content.map((c) => {
                        if (c.type === "text") return { type: "text" as const, text: c.text };
                        if (c.type === "image") {
                          return {
                            type: "text" as const,
                            text: `[Image: ${c.mimeType} (${c.data.length} bytes base64)]`,
                          };
                        }
                        return {
                          type: "text" as const,
                          text: c.type === "resource"
                            ? (c.resource.text ?? "[binary resource]")
                            : JSON.stringify(c),
                        };
                      }),
                      details: { server: id, tool: tool.name },
                      isError: result.isError ?? false,
                    };
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    return {
                      content: [{ type: "text" as const, text: `MCP tool "${tool.name}" failed: ${msg}` }],
                      details: { server: id, tool: tool.name },
                      isError: true,
                    };
                  }
                },
              }),
            );
          }

          entries.push({ id, serverName, serverVersion, toolCount: tools.length, toolNames, handle });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (handle) deps.close(handle);
          entries.push({ id, error: msg });
        }
      }
      updateMcpStatus(lastCtx, entries);
    }

    let lastCtx: unknown;
    pi.on("session_start", async (_event, ctx) => {
      lastCtx = ctx;
      await connect(ctx.cwd);
    });

  // Cleanup on shutdown
    pi.on("session_shutdown", () => {
      for (const entry of entries) {
        if (entry.handle) deps.close(entry.handle);
      }
      entries.length = 0;
      activeTools.clear();
      connectedCwd = null;
      updateMcpStatus(lastCtx, entries);
      lastCtx = undefined;
    });
  };
}

export const mcpExtension: ExtensionFactory = createMcpExtension({
  load: loadMcpConfig,
  spawn: spawnMcpServer,
  initialize: mcpInitialize,
  listTools: mcpListTools,
  callTool: mcpCallTool,
  close: closeMcpServer,
});

export default mcpExtension;
