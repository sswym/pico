/**
 * Load MCP server configuration from JSON files.
 *
 * Merges two layers (home config is base, project config overrides):
 *   ~/.srcode/mcp-servers.json   — user-wide server definitions
 *   <cwd>/.srcode/mcp-servers.json — project-specific overrides
 *
 * Format (compatible with Claude Code's mcpServers):
 *   { "mcpServers": { "server-name": { "command": "npx", "args": [...], "env": {...} } } }
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpConfig, McpServerConfig } from "./types.ts";
import { srcodeMcpConfigPath } from "../paths.ts";

/**
 * Load the MCP server configuration by merging home and project configs.
 * Project config values override home config values for the same server key.
 * Returns an empty record when no config is found.
 */
export function loadMcpConfig(cwd: string): Record<string, McpServerConfig> {
  const merger = (path: string): Record<string, McpServerConfig> => {
    try {
      if (!existsSync(path)) return {};
      const raw = readFileSync(path, "utf-8");
      const parsed: McpConfig = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.mcpServers) {
        return parsed.mcpServers;
      }
      console.error(`[mcp] Warning: ${path} has no "mcpServers" key, skipping.`);
      return {};
    } catch (e) {
      const msg = e instanceof SyntaxError ? "invalid JSON" : String(e);
      console.error(`[mcp] Warning: could not load ${path} (${msg})`);
      return {};
    }
  };

  const homeServers = merger(srcodeMcpConfigPath());
  const projectServers = merger(join(cwd, ".srcode", "mcp-servers.json"));

  const merged: Record<string, McpServerConfig> = { ...homeServers };
  for (const [key, server] of Object.entries(projectServers)) {
    merged[key] = server;
  }
  return merged;
}
