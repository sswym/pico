/**
 * Load MCP server configuration from JSON files.
 *
 * Merges two layers (home config is base, project config overrides only
 * when PICO_ENABLE_PROJECT_MCP=1):
 *   ~/.pico/mcp-servers.json   — user-wide server definitions
 *   <cwd>/.pico/mcp-servers.json — project-specific overrides (opt-in)
 *
 * Format (compatible with Claude Code's mcpServers):
 *   { "mcpServers": { "server-name": { "command": "npx", "args": [...], "env": {...} } } }
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpConfig, McpServerConfig } from "./types.ts";
import { picoMcpConfigPath } from "../paths.ts";
import { allowProjectMcp } from "../policy.ts";

const warnedInvalidServers = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedInvalidServers.has(key)) return;
  warnedInvalidServers.add(key);
  console.warn(`[pico mcp] ${message}`);
}

export function __resetMcpConfigWarningsForTests(): void {
  warnedInvalidServers.clear();
}

/**
 * Validate a single server entry; a malformed entry must not silently vanish
 * (it would look like "no servers configured" and poison the whole file).
 */
function validateServer(key: string, server: unknown): McpServerConfig | null {
  if (!server || typeof server !== "object") {
    warnOnce(key, `server "${key}" is not an object; skipped`);
    return null;
  }
  const s = server as Record<string, unknown>;
  if (typeof s.command !== "string" || s.command.trim() === "") {
    warnOnce(key, `server "${key}" has no valid "command" (must be a non-empty string); skipped`);
    return null;
  }
  if (s.args !== undefined && !Array.isArray(s.args)) {
    warnOnce(key, `server "${key}" has invalid "args" (must be an array); skipped`);
    return null;
  }
  if (s.env !== undefined && (typeof s.env !== "object" || s.env === null || Array.isArray(s.env))) {
    warnOnce(key, `server "${key}" has invalid "env" (must be an object); skipped`);
    return null;
  }
  const out: McpServerConfig = { command: s.command };
  if (Array.isArray(s.args)) {
    const nonStrings = (s.args as unknown[]).filter((a) => typeof a !== "string");
    if (nonStrings.length > 0) {
      warnOnce(`${key}:args`, `server "${key}" has ${nonStrings.length} non-string args entry(ies); dropped (e.g. a port number written as 8080 instead of "8080")`);
    }
    out.args = (s.args as unknown[]).filter((a): a is string => typeof a === "string");
  }
  if (s.env && typeof s.env === "object" && !Array.isArray(s.env)) {
    const nonStrings = Object.entries(s.env as Record<string, unknown>).filter(([, v]) => typeof v !== "string");
    if (nonStrings.length > 0) {
      warnOnce(`${key}:env`, `server "${key}" has ${nonStrings.length} non-string env value(s); dropped (e.g. {"PORT": 8080} instead of "8080")`);
    }
    out.env = Object.fromEntries(
      Object.entries(s.env as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  return out;
}

/**
 * Load the MCP server configuration by merging home and project configs.
 * Project config values override home config values for the same server key
 * only when PICO_ENABLE_PROJECT_MCP=1 is set.
 * Returns an empty record when no config is found.
 */
export function loadMcpConfig(cwd: string): Record<string, McpServerConfig> {
  const merger = (path: string, sourceName: string): Record<string, McpServerConfig> => {
    try {
      if (!existsSync(path)) return {};
      const raw = readFileSync(path, "utf-8");
      const parsed: McpConfig = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.mcpServers) {
        warnOnce(sourceName, `${sourceName} is missing "mcpServers"; ignored`);
        return {};
      }
      const out: Record<string, McpServerConfig> = {};
      for (const [key, server] of Object.entries(parsed.mcpServers)) {
        const validated = validateServer(key, server);
        if (validated) out[key] = validated;
      }
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnOnce(sourceName, `${sourceName} could not be parsed (${msg}); ignored`);
      return {};
    }
  };

  const homeServers = merger(picoMcpConfigPath(), picoMcpConfigPath());
  const projectPath = join(cwd, ".pico", "mcp-servers.json");
  const projectServers = allowProjectMcp() ? merger(projectPath, projectPath) : {};

  const merged: Record<string, McpServerConfig> = { ...homeServers };
  for (const [key, server] of Object.entries(projectServers)) {
    merged[key] = server;
  }
  return merged;
}
