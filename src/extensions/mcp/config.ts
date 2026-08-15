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
import { readSettings } from "../settings.ts";
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

type ServerValidation =
  | { ok: true; config: McpServerConfig }
  | { ok: false; error: string };

/**
 * Validate a single server entry. A malformed entry must not silently vanish
 * (it would look like "no servers configured" and poison the whole file) —
 * the returned reason is surfaced in /mcp as a FAILED entry (P5).
 */
function validateServer(key: string, server: unknown): ServerValidation {
  if (!server || typeof server !== "object") {
    return { ok: false, error: `server "${key}" is not an object` };
  }
  const s = server as Record<string, unknown>;
  if (typeof s.command !== "string" || s.command.trim() === "") {
    return { ok: false, error: `server "${key}" has no valid "command" (must be a non-empty string)` };
  }
  if (s.args !== undefined && !Array.isArray(s.args)) {
    return { ok: false, error: `server "${key}" has invalid "args" (must be an array)` };
  }
  if (s.env !== undefined && (typeof s.env !== "object" || s.env === null || Array.isArray(s.env))) {
    return { ok: false, error: `server "${key}" has invalid "env" (must be an object)` };
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
  return { ok: true, config: out };
}

interface McpConfigLoadResult {
  servers: Record<string, McpServerConfig>;
  /** Entries rejected by validation, with the reason (P5). */
  invalid: Array<{ id: string; error: string }>;
}

function parseFile(path: string, sourceName: string): McpConfigLoadResult {
  try {
    if (!existsSync(path)) return { servers: {}, invalid: [] };
    const raw = readFileSync(path, "utf-8");
    return parseMcpConfigObject(JSON.parse(raw), sourceName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnOnce(sourceName, `${sourceName} could not be parsed (${msg}); ignored`);
    return { servers: {}, invalid: [] };
  }
}

/**
 * 从已解析的 mcp 配置对象（含 mcpServers 键）提取服务器表与校验失败条目。
 * 兼容旧文件顶层与 settings.json `mcpServers` 命名空间（逐字一致）。
 */
function parseMcpConfigObject(raw: unknown, sourceName: string): McpConfigLoadResult {
  if (!raw || typeof raw !== "object" || !(raw as McpConfig).mcpServers) {
    warnOnce(sourceName, `${sourceName} is missing "mcpServers"; ignored`);
    return { servers: {}, invalid: [] };
  }
  const servers: Record<string, McpServerConfig> = {};
  const invalid: Array<{ id: string; error: string }> = [];
  for (const [key, server] of Object.entries((raw as McpConfig).mcpServers)) {
    const validated = validateServer(key, server);
    if (validated.ok) {
      servers[key] = validated.config;
    } else {
      invalid.push({ id: key, error: validated.error });
      warnOnce(key, `${validated.error}; skipped`);
    }
  }
  return { servers, invalid };
}

/**
 * Load the merged (home + project) config together with its validation
 * failures, so callers can surface rejected entries instead of losing them.
 */
function loadMcpConfigResult(cwd: string): McpConfigLoadResult {
  // 用户级：settings.json `mcpServers` 命名空间优先，否则回退旧 ~/.pico/mcp-servers.json。
  const settings = readSettings();
  const homeResult = settings.mcpServers !== undefined
    ? parseMcpConfigObject(settings.mcpServers, "settings.json:mcpServers")
    : parseFile(picoMcpConfigPath(), picoMcpConfigPath());
  const projectPath = join(cwd, ".pico", "mcp-servers.json");
  const projectResult = allowProjectMcp() ? parseFile(projectPath, projectPath) : { servers: {}, invalid: [] };

  const servers: Record<string, McpServerConfig> = { ...homeResult.servers };
  for (const [key, server] of Object.entries(projectResult.servers)) {
    servers[key] = server;
  }

  // A project key (valid or invalid) overrides the home entry of the same
  // name, so a home-side failure is dropped when the project replaces it.
  const projectKeys = new Set([
    ...Object.keys(projectResult.servers),
    ...projectResult.invalid.map((entry) => entry.id),
  ]);
  const invalid = [
    ...homeResult.invalid.filter((entry) => !projectKeys.has(entry.id)),
    ...projectResult.invalid,
  ];

  return { servers, invalid };
}

/**
 * Load the MCP server configuration by merging home and project configs.
 * Project config values override home config values for the same server key
 * only when PICO_ENABLE_PROJECT_MCP=1 is set.
 * Returns an empty record when no config is found.
 */
export function loadMcpConfig(cwd: string): Record<string, McpServerConfig> {
  return loadMcpConfigResult(cwd).servers;
}

/**
 * Validation failures from the merged config (same sources and merge rules as
 * `loadMcpConfig`): the entries `loadMcpConfig` silently skips, with reasons.
 * The MCP extension surfaces these as FAILED entries in /mcp (P5).
 */
export function loadInvalidMcpServers(cwd: string): Array<{ id: string; error: string }> {
  return loadMcpConfigResult(cwd).invalid;
}
