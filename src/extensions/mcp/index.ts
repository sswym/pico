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
import { loadMcpConfig } from "./config.ts";
import {
  spawnMcpServer,
  mcpInitialize,
  mcpListTools,
  mcpCallTool,
  closeMcpServer,
} from "./client.ts";
import type { McpServerHandle } from "./types.ts";

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

export const mcpExtension: ExtensionFactory = async (pi: ExtensionAPI) => {
  const entries: ServerEntry[] = [];

  // ── Register /mcp command BEFORE async server connections ──────────────

  pi.registerCommand("mcp", {
    description: "List connected MCP servers and their tools",
    handler: async (_args, ctx) => {
      const connected = entries.filter((e): e is ServerStatus => !e.error);
      const failed = entries.filter((e): e is ServerFailure => !!e.error);

      if (entries.length === 0) {
        ctx.ui.notify("No MCP servers configured.", "info");
        return;
      }

      const lines: string[] = [];
      lines.push(`MCP Servers (${connected.length} connected, ${failed.length} failed):\n`);

      for (const entry of entries) {
        if (!("serverName" in entry)) {
          lines.push(`  ✗ ${entry.id} — FAILED: ${entry.error}`);
        } else {
          lines.push(`  ✓ ${entry.id} (${entry.serverName} ${entry.serverVersion}) — ${entry.toolCount} tools`);
          for (const name of entry.toolNames) {
            lines.push(`      ${name}`);
          }
        }
      }

      ctx.ui.notify(lines.join("\n"), failed.length > 0 ? "warning" : "info");
    },
  });

  // ── Connect to MCP servers (async, after command registration) ─────────

  const cwd = process.cwd();
  const servers = loadMcpConfig(cwd);

  for (const [id, config] of Object.entries(servers)) {
    let handle: McpServerHandle | undefined;
    try {
      handle = spawnMcpServer(id, config);
      const initResult = await mcpInitialize(handle);
      const tools = await mcpListTools(handle);

      const { name: serverName, version: serverVersion } = initResult.serverInfo;
      console.error(`[mcp] Connected "${id}" (${serverName} ${serverVersion}) — ${tools.length} tools`);

      const toolNames: string[] = [];
      for (const tool of tools) {
        const piToolName = `mcp__${id}__${tool.name}`;
        toolNames.push(piToolName);
        const schema = tool.inputSchema ?? { type: "object" as const, properties: {} };

        pi.registerTool(
          defineTool({
            name: piToolName,
            label: `MCP: ${id} › ${tool.name}`,
            description: tool.description ?? `MCP tool "${tool.name}" from server "${id}"`,
            promptSnippet:
              `${piToolName} — call "${tool.name}" on MCP server "${id}"`,
            parameters: Type.Unsafe(schema),
            async execute(_tcId, params, _signal) {
              try {
                const result = await mcpCallTool(handle!, tool.name, params as Record<string, unknown>);
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
      console.error(`[mcp] Failed to connect "${id}": ${msg}`);
      if (handle) closeMcpServer(handle);
      entries.push({ id, error: msg });
    }
  }

  // Cleanup on shutdown
  pi.on("session_shutdown", () => {
    for (const entry of entries) {
      if (entry.handle) closeMcpServer(entry.handle);
    }
    entries.length = 0;
  });
};

export default mcpExtension;
