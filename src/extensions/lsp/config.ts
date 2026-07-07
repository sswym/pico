/**
 * LSP configuration loading, merging, and server routing.
 *
 * Config sources (highest priority first):
 *   1. Project: `.srcode/lsp.json` in workspace root
 *   2. User:    `~/.srcode/lsp.json`
 *   3. Built-in: defaults.json (bundled)
 *
 * Supports:
 *   - Merging user/project overrides onto defaults
 *   - Per-server fileTypes + rootMarkers matching
 *   - Local binary resolution (node_modules/.bin, .venv/bin, etc.)
 *   - Multi-server routing (one file → multiple servers)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { homedir } from "node:os";
import defaultServers from "./defaults.json" with { type: "json" };

// ── Config types ──────────────────────────────────────────────────────────

interface RawServerConfig {
  command?: string;
  args?: string[];
  fileTypes?: string[];
  extensions?: string[];
  rootMarkers?: string[];
  initOptions?: unknown;
  settings?: unknown;
  disabled?: boolean;
  isLinter?: boolean;
}

export interface LspServerConfig {
  command: string;
  args: string[];
  fileTypes: string[];
  rootMarkers: string[];
  initializationOptions?: unknown;
  settings?: unknown;
  isLinter?: boolean;
  disabled?: boolean;
}

export interface LspConfig {
  servers: Record<string, LspServerConfig>;
  idleTimeoutMs?: number;
}

// ── Config loading ────────────────────────────────────────────────────────

function parseJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(filePath, "utf8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeFileType(ext: string): string {
  return ext.startsWith(".") ? ext : `.${ext}`;
}

function normalizeServerConfig(_name: string, raw: RawServerConfig): LspServerConfig | null {
  if (!raw.command) return null;
  if (raw.disabled) return null;

  const fileTypes = (raw.fileTypes ?? raw.extensions ?? []).map(normalizeFileType);
  if (fileTypes.length === 0) return null;

  return {
    command: raw.command,
    args: raw.args ?? ["--stdio"],
    fileTypes,
    rootMarkers: raw.rootMarkers ?? [],
    initializationOptions: raw.initOptions,
    settings: raw.settings,
    isLinter: raw.isLinter,
    disabled: raw.disabled,
  };
}

function parseServerMap(data: Record<string, unknown>): Record<string, LspServerConfig> {
  const result: Record<string, LspServerConfig> = {};
  for (const [name, value] of Object.entries(data)) {
    if (typeof value !== "object" || value === null) continue;
    const config = normalizeServerConfig(name, value as RawServerConfig);
    if (config) result[name] = config;
  }
  return result;
}

/** Load configuration from all sources and merge. */
export function loadConfig(workspaceRoot: string): LspConfig {
  // Start with built-in defaults
  let merged: Record<string, LspServerConfig> = parseServerMap(
    defaultServers as Record<string, unknown>,
  );
  let idleTimeoutMs: number | undefined;

  // Merge user-level config
  const userConfigPath = join(homedir(), ".srcode", "lsp.json");
  const userConfig = parseJsonFile(userConfigPath);
  if (userConfig) {
    merged = { ...merged, ...parseServerMap(userConfig) };
    if (typeof userConfig["idleTimeoutMs"] === "number") {
      idleTimeoutMs = userConfig["idleTimeoutMs"] as number;
    }
  }

  // Merge project-level config
  const projectConfigPath = join(workspaceRoot, ".srcode", "lsp.json");
  const projectConfig = parseJsonFile(projectConfigPath);
  if (projectConfig) {
    merged = { ...merged, ...parseServerMap(projectConfig) };
    if (typeof projectConfig["idleTimeoutMs"] === "number") {
      idleTimeoutMs = projectConfig["idleTimeoutMs"] as number;
    }
  }

  return { servers: merged, idleTimeoutMs };
}

// ── Local binary resolution ───────────────────────────────────────────────

const LOCAL_BIN_PATHS: Array<{ markers: string[]; binDir: string }> = [
  { markers: ["package.json", "tsconfig.json", "jsconfig.json"], binDir: "node_modules/.bin" },
  { markers: ["pyproject.toml", "setup.py", "requirements.txt"], binDir: ".venv/bin" },
  { markers: ["pyproject.toml", "setup.py", "requirements.txt"], binDir: "venv/bin" },
  { markers: ["Gemfile"], binDir: "vendor/bundle/bin" },
];

/**
 * Resolve a command to an executable path.
 * Checks local bin directories first, then falls back to $PATH.
 */
export function resolveCommand(command: string, cwd: string): string | null {
  // Check local bin paths first
  for (const { markers, binDir } of LOCAL_BIN_PATHS) {
    const hasMarker = markers.some((m) => existsSync(join(cwd, m)));
    if (!hasMarker) continue;
    const localPath = join(cwd, binDir, command);
    if (existsSync(localPath)) return localPath;
  }

  // Check if command exists on PATH by testing if it's accessible
  // We do a simple existence check since we can't easily parse $PATH in Bun
  // The spawn will fail gracefully if not found
  return command;
}

// ── Root marker detection ─────────────────────────────────────────────────

/** Check if any root marker exists in the directory or its ancestors (up to 3 levels). */
export function hasRootMarkers(cwd: string, markers: string[]): boolean {
  if (markers.length === 0) return true; // No markers = always match
  let dir = cwd;
  for (let depth = 0; depth < 3; depth++) {
    if (markers.some((m) => existsSync(join(dir, m)))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

// ── Server routing ────────────────────────────────────────────────────────

/** Normalize a file extension (ensure leading dot). */
function extOf(filePath: string): string {
  const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")) : "";
  return ext.toLowerCase();
}

/** Get all servers that can handle a file, based on fileTypes. */
export function getServersForFile(config: LspConfig, filePath: string): Array<[string, LspServerConfig]> {
  const ext = extOf(filePath);
  const result: Array<[string, LspServerConfig]> = [];
  for (const [name, serverConfig] of Object.entries(config.servers)) {
    if (serverConfig.disabled) continue;
    if (serverConfig.fileTypes.includes(ext)) {
      result.push([name, serverConfig]);
    }
  }
  // Primary (non-linter) servers first
  result.sort((a, b) => {
    const aLinter = a[1].isLinter ? 1 : 0;
    const bLinter = b[1].isLinter ? 1 : 0;
    return aLinter - bLinter;
  });
  return result;
}

/** Get the primary (first non-linter) server for a file. */
export function getPrimaryServerForFile(config: LspConfig, filePath: string): [string, LspServerConfig] | null {
  const servers = getServersForFile(config, filePath);
  for (const [name, serverConfig] of servers) {
    if (!serverConfig.isLinter) return [name, serverConfig];
  }
  // Fall back to first available (linter)
  return servers[0] ?? null;
}

/** Get all server names that handle the given file type, for diagnostics. */
export function getAllServersForFile(config: LspConfig, filePath: string): Array<[string, LspServerConfig]> {
  return getServersForFile(config, filePath);
}

/**
 * Detect which servers to start based on workspace root markers.
 * Returns all servers whose rootMarkers match the workspace.
 */
export function detectServers(config: LspConfig, workspaceRoot: string): Array<[string, LspServerConfig]> {
  const result: Array<[string, LspServerConfig]> = [];
  for (const [name, serverConfig] of Object.entries(config.servers)) {
    if (serverConfig.disabled) continue;
    if (hasRootMarkers(workspaceRoot, serverConfig.rootMarkers)) {
      result.push([name, serverConfig]);
    }
  }
  // Sort by how many matching source files exist in the project.
  // Ensures language-specific servers (basedpyright for .py) rank higher than
  // generic ones (vscode-html-language-server) when the project has actual source files.
  const SKIP = new Set(["node_modules", ".git", "build", "dist", "target", ".next", "__pycache__", ".venv"]);
  function countFiles(dir: string, exts: Set<string>, depth: number): number {
    if (depth > 2) return 0;
    let count = 0;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && exts.has(extname(entry.name))) count++;
        else if (entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith(".")) {
          count += countFiles(join(dir, entry.name), exts, depth + 1);
        }
      }
    } catch {}
    return count;
  }
  result.sort(([, a], [, b]) => {
    const extsA = new Set(a.fileTypes.map(e => e.startsWith(".") ? e : `.${e}`));
    const extsB = new Set(b.fileTypes.map(e => e.startsWith(".") ? e : `.${e}`));
    return countFiles(workspaceRoot, extsB, 0) - countFiles(workspaceRoot, extsA, 0);
  });
  return result;
}
