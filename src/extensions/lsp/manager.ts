/**
 * LspManager — multi-server lifecycle + document sync.
 *
 * Uses config.ts to discover and route servers. Each server is spawned lazily
 * when first needed. Supports multiple concurrent servers per file type.
 */
import { readFileSync, promises as fsPromises } from "node:fs";
import { spawn } from "node:child_process";
import { join, extname } from "node:path";
import type { LspServerConfig, LspConfig } from "./config.ts";
import { loadConfig, getPrimaryServerForFile, detectServers, resolveCommand, hasRootMarkers } from "./config.ts";
import { LspClient, locationToDisplay, lspPositionToDisplay, LspError, COMMAND_NOT_FOUND } from "./client.ts";

// ── Runtime state ───────────────────────────────────────────────────────────

const IDLE_CHECK_INTERVAL_MS = 60_000;
// 2.5.1: 3 minutes locked the user out of every LSP call after one cold-start
// failure (rust-analyzer first index etc.). 60s still prevents hot-looping a
// broken server while letting a transient cold start retry quickly.
const INIT_FAILURE_BACKOFF_MS = 60 * 1000;

interface LspManagerRuntime {
  idleTimeoutMs: number | null;
  idleCheckInterval: ReturnType<typeof setInterval> | null;
  initFailures: Map<string, { at: number; message: string }>;
  /** In-flight shutdowns (idle reaper) keyed by server name — a new ensure
   *  must wait for the old process to die before spawning a replacement,
   *  otherwise two servers race on the same name/ports. */
  shuttingDown: Map<string, Promise<void>>;
}

export function setIdleTimeout(state: LspManagerState, ms: number | null | undefined): void {
  state.runtime.idleTimeoutMs = ms ?? null;
  if (state.runtime.idleTimeoutMs && state.runtime.idleTimeoutMs > 0) {
    startIdleChecker(state);
  } else {
    stopIdleChecker(state);
  }
}

function startIdleChecker(state: LspManagerState): void {
  if (state.runtime.idleCheckInterval) return;
  state.runtime.idleCheckInterval = setInterval(() => {
    const idleTimeoutMs = state.runtime.idleTimeoutMs;
    if (!idleTimeoutMs) return;
    const now = Date.now();
    for (const [name, managed] of state.servers) {
      if (managed.client.ready && now - managed.lastActivity > idleTimeoutMs) {
        state.servers.delete(name);
        const shuttingDown = managed.client.shutdown()
          .catch(() => {})
          .finally(() => {
            state.runtime.shuttingDown.delete(name);
          });
        state.runtime.shuttingDown.set(name, shuttingDown);
      }
    }
  }, IDLE_CHECK_INTERVAL_MS);
}

function stopIdleChecker(state: LspManagerState): void {
  if (state.runtime.idleCheckInterval) {
    clearInterval(state.runtime.idleCheckInterval);
    state.runtime.idleCheckInterval = null;
  }
}

// ── Init failure backoff ────────────────────────────────────────────────────

function checkInitBackoff(state: LspManagerState, serverName: string): void {
  const failure = state.runtime.initFailures.get(serverName);
  if (!failure) return;
  if (Date.now() - failure.at < INIT_FAILURE_BACKOFF_MS) {
    const remaining = Math.ceil((INIT_FAILURE_BACKOFF_MS - (Date.now() - failure.at)) / 1000);
    throw new LspError(
      `Server "${serverName}" failed to start recently (${failure.message}). Retry in ${remaining}s.`,
      -1,
    );
  }
  state.runtime.initFailures.delete(serverName);
}

function recordInitFailure(state: LspManagerState, serverName: string, message: string): void {
  state.runtime.initFailures.set(serverName, { at: Date.now(), message });
}

/** Probe results cached per (command, cwd): warmup runs it on every session. */
const unsupportedProbeCache = new Map<string, string | null>();

/**
 * Async probe (2.5.11): the old spawnSync blocked the whole event loop for
 * up to 2s on the session-start path, freezing the UI on every launch.
 */
async function getUnsupportedServerCommandReason(serverName: string, command: string, cwd: string): Promise<string | null> {
  if (serverName !== "typescript-native") return null;

  const key = `${command}\0${cwd}`;
  const cached = unsupportedProbeCache.get(key);
  if (cached !== undefined) return cached;

  const reason = await new Promise<string | null>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (reason: string | null) => {
      if (settled) return;
      settled = true;
      resolve(reason);
    };
    let child;
    try {
      child = spawn(command, ["--help", "--all"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(null);
    }, 2_000);
    timer.unref?.();
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => {
      clearTimeout(timer);
      const errno = err as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        // Command missing — not a probe verdict; the caller reports
        // COMMAND_NOT_FOUND and may install it, so don't cache this outcome.
        finish(null);
        return;
      }
      finish(`Command "${command}" probe failed: ${err.message}`);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const output = `${stdout}\n${stderr}`;
      finish(output.includes("--lsp")
        ? null
        : `Command "${command}" does not advertise TypeScript native LSP support (--lsp).`);
    });
  });

  if (reason !== null) unsupportedProbeCache.set(key, reason);
  return reason;
}

// ── Type guards for Hover contents ────────────────────────────────────────

interface MarkedStringLanguage {
  language: string;
  value: string;
}

interface MarkupContent {
  kind: string;
  value: string;
}

function isMarkedStringLanguage(obj: unknown): obj is MarkedStringLanguage {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "language" in obj &&
    "value" in obj &&
    typeof (obj as Record<string, unknown>).language === "string" &&
    typeof (obj as Record<string, unknown>).value === "string"
  );
}

function isMarkupContent(obj: unknown): obj is MarkupContent {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "kind" in obj &&
    "value" in obj &&
    typeof (obj as Record<string, unknown>).kind === "string" &&
    typeof (obj as Record<string, unknown>).value === "string"
  );
}

// ── Formatting helpers ───────────────────────────────────────────────────

export function formatHoverResult(
  hover: { contents: unknown; range?: unknown } | null,
): string {
  if (!hover) return "No hover information available.";
  const { contents } = hover;

  if (typeof contents === "string") return contents;

  if (Array.isArray(contents)) {
    return contents
      .map((c) => {
        if (typeof c === "string") return c;
        if (isMarkedStringLanguage(c)) {
          return `\`\`\`${c.language}\n${c.value}\n\`\`\``;
        }
        return JSON.stringify(c);
      })
      .join("\n\n");
  }

  if (typeof contents === "object" && contents !== null) {
    if (isMarkupContent(contents)) return contents.value;
    if (isMarkedStringLanguage(contents)) {
      return `\`\`\`${contents.language}\n${contents.value}\n\`\`\``;
    }
  }

  return JSON.stringify(contents);
}

export function formatLocations(
  locations: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> | null,
  label: string,
): string {
  if (!locations || locations.length === 0) return `No ${label} found.`;
  const lines: string[] = [];
  for (const loc of locations) {
    const d = locationToDisplay(loc);
    lines.push(`  ${d.filePath}:${d.line}:${d.character}`);
  }
  return `Found ${locations.length} ${label}:\n${lines.join("\n")}`;
}

const SEVERITY_LABELS: Record<number, string> = {
  1: "ERROR", 2: "WARNING", 3: "INFO", 4: "HINT",
};

export function formatDiagnosticsForFile(
  filePath: string,
  diagnostics: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number; code?: string | number; source?: string; message: string }>,
): string {
  if (diagnostics.length === 0) return `No diagnostics for ${filePath}.`;
  const lines: string[] = [];
  for (const d of diagnostics) {
    const sev = SEVERITY_LABELS[d.severity ?? 1] ?? "UNKNOWN";
    const pos = lspPositionToDisplay(d.range.start);
    const code = d.code ? ` [${d.code}]` : "";
    const src = d.source ? ` (${d.source})` : "";
    lines.push(`  ${filePath}:${pos.line}:${pos.character} ${sev}${code}${src}: ${d.message}`);
  }
  return `Diagnostics for ${filePath} (${diagnostics.length}):\n${lines.join("\n")}`;
}

export interface DocumentSymbolFlat {
  name: string;
  kind: number;
  line: number;
  character: number;
  endLine: number;
  detail?: string;
}

interface HierarchicalSymbol {
  name: string;
  kind: number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  detail?: string;
  children?: HierarchicalSymbol[];
}

export function flattenDocumentSymbols(symbols: HierarchicalSymbol[]): DocumentSymbolFlat[] {
  const result: DocumentSymbolFlat[] = [];
  for (const sym of symbols) {
    result.push({
      name: sym.name,
      kind: sym.kind,
      line: sym.range.start.line + 1,
      character: sym.range.start.character,
      endLine: sym.range.end.line + 1,
      detail: sym.detail,
    });
    if (sym.children && sym.children.length > 0) {
      result.push(...flattenDocumentSymbols(sym.children));
    }
  }
  return result;
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package",
  5: "Class", 6: "Method", 7: "Property", 8: "Field",
  9: "Constructor", 10: "Enum", 11: "Interface", 12: "Function",
  13: "Variable", 14: "Constant", 15: "String", 16: "Number",
  17: "Boolean", 18: "Array", 19: "Object", 20: "Key",
  21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
};

export function formatDocumentSymbols(symbols: DocumentSymbolFlat[]): string {
  if (symbols.length === 0) return "No symbols found in file.";
  const lines: string[] = [];
  for (const sym of symbols) {
    const kind = SYMBOL_KIND_NAMES[sym.kind] ?? `Kind${sym.kind}`;
    const detail = sym.detail ? ` — ${sym.detail}` : "";
    lines.push(`  ${kind} ${sym.name} (line ${sym.line})${detail}`);
  }
  return `Symbols (${symbols.length}):\n${lines.join("\n")}`;
}

// ── Multi-server manager ──────────────────────────────────────────────────

interface ManagedServer {
  name: string;
  config: LspServerConfig;
  client: LspClient;
  initializing: Promise<void> | null;
  openDocuments: Map<string, { uri: string; languageId: string; version: number; text: string }>;
  lastActivity: number;
}

export interface SyncedDocument {
  uri: string;
  client: LspClient;
  serverName: string;
}

export interface LspManagerState {
  config: LspConfig | null;
  servers: Map<string, ManagedServer>;
  configured: boolean;
  runtime: LspManagerRuntime;
}

export function createLspManager(): LspManagerState {
  return {
    config: null,
    servers: new Map(),
    configured: false,
    runtime: {
      idleTimeoutMs: null,
      idleCheckInterval: null,
      initFailures: new Map(),
      shuttingDown: new Map(),
    },
  };
}

/**
 * Get or start the primary (non-linter) server for a file.
 *
 * Throws LspError with errorCode "command-not-found" when the binary doesn't
 * exist (ENOENT), so callers can offer to install it.
 * Returns null when no server can be started for other reasons.
 */
export async function ensureServer(
  state: LspManagerState,
  workspaceRoot: string,
): Promise<LspClient | null> {
  // Wait for any idle-reaped server still shutting down before starting a
  // replacement — two processes for one server name would race on ports and
  // both publish diagnostics.
  const pendingShutdowns = [...state.runtime.shuttingDown.values()];
  if (pendingShutdowns.length > 0) {
    await Promise.allSettled(pendingShutdowns);
  }
  // Ensure config is loaded
  if (!state.config) {
    state.config = loadConfig(workspaceRoot);
    state.configured = true;
    setIdleTimeout(state, state.config.idleTimeoutMs);
  }

  // Find the first ready or startable server for any file in this project
  // We pick the first server whose rootMarkers match
  for (const [name, serverConfig] of Object.entries(state.config.servers)) {
    if (serverConfig.disabled) continue;
    if (serverConfig.isLinter) continue; // Skip linters for primary
    // A ready server from another project shape must not be reused: in a Go
    // project that synced a .py file earlier, returning pyright here would
    // route every workspace query to the wrong language.
    if (!hasRootMarkers(workspaceRoot, serverConfig.rootMarkers)) continue;
    const managed = state.servers.get(name);
    if (managed?.client.ready) {
      managed.lastActivity = Date.now();
      return managed.client;
    }
    // Another caller is mid-initialization — await it instead of spawning a
    // second process for the same server (which would orphan the first).
    if (managed?.initializing) {
      await managed.initializing;
      if (managed.client.ready) {
        managed.lastActivity = Date.now();
        return managed.client;
      }
    }
  }

  // No server ready — start the first matching one (filtered by rootMarkers)
  const matching = detectServers(state.config, workspaceRoot);
  for (const [name, serverConfig] of matching) {
    if (serverConfig.isLinter) continue;

    try {
      checkInitBackoff(state, name);
    } catch (err) {
      // Backoff still active; skip this server and try the next one
      continue;
    }

    const resolvedCommand = resolveCommand(serverConfig.command, workspaceRoot) ?? serverConfig.command;
    const unsupportedReason = await getUnsupportedServerCommandReason(name, resolvedCommand, workspaceRoot);
    if (unsupportedReason) {
      recordInitFailure(state, name, unsupportedReason);
      continue;
    }

    const client = new LspClient(
      { language: name, extensions: serverConfig.fileTypes, command: resolvedCommand, args: serverConfig.args, initializationOptions: serverConfig.initializationOptions },
      name,
    );

    const managed: ManagedServer = {
      name,
      config: serverConfig,
      client,
      initializing: null,
      openDocuments: new Map(),
      lastActivity: Date.now(),
    };

    state.servers.set(name, managed);

    managed.initializing = (async () => {
      try {
        await managed.client.initialize(workspaceRoot);
        managed.lastActivity = Date.now();
        await prewarmProject(managed, workspaceRoot);
      } catch (err) {
        // Propagate command-not-found so callers can offer to install.
        if (err instanceof LspError && err.errorCode === COMMAND_NOT_FOUND) {
          state.servers.delete(name);
          managed.client.shutdown();
          throw err;
        }
        const msg = err instanceof LspError ? err.message : String(err);
        console.error(`[lsp] Failed to start ${name}:`, msg);
        recordInitFailure(state, name, msg);
        state.servers.delete(name);
        // Reap the spawned process — otherwise a server that started its
        // binary but failed initialization leaks for the process lifetime.
        managed.client.shutdown().catch(() => {});
      } finally {
        managed.initializing = null;
      }
    })();

    try {
      await managed.initializing;
    } catch (err) {
      // Re-throw command-not-found for the caller to handle.
      if (err instanceof LspError && err.errorCode === COMMAND_NOT_FOUND) throw err;
    }
    if (managed.client.ready) return managed.client;
  }

  return null;
}

/** Get a specific server by name. */
export async function ensureNamedServer(
  state: LspManagerState,
  name: string,
  workspaceRoot: string,
): Promise<LspClient | null> {
  // Mirrors ensureServer: an idle-reaped server may still be shutting down —
  // spawning its replacement now would run two processes for one server name
  // (port bind races, duplicate diagnostics).
  const pendingShutdowns = [...state.runtime.shuttingDown.values()];
  if (pendingShutdowns.length > 0) {
    await Promise.allSettled(pendingShutdowns);
  }
  if (!state.config) {
    state.config = loadConfig(workspaceRoot);
    state.configured = true;
    setIdleTimeout(state, state.config.idleTimeoutMs);
  }

  const serverConfig = state.config.servers[name];
  if (!serverConfig || serverConfig.disabled) return null;

  const managed = state.servers.get(name);
  if (managed?.client.ready) {
    managed.lastActivity = Date.now();
    return managed.client;
  }
  if (managed?.initializing) {
    await managed.initializing;
    return managed.client.ready ? managed.client : null;
  }

  // Start this server
  checkInitBackoff(state, name);
  const resolvedCommand = resolveCommand(serverConfig.command, workspaceRoot) ?? serverConfig.command;
  const unsupportedReason = await getUnsupportedServerCommandReason(name, resolvedCommand, workspaceRoot);
  if (unsupportedReason) {
    recordInitFailure(state, name, unsupportedReason);
    return null;
  }

  const client = new LspClient(
    { language: name, extensions: serverConfig.fileTypes, command: resolvedCommand, args: serverConfig.args, initializationOptions: serverConfig.initializationOptions },
    name,
  );

  const newManaged: ManagedServer = {
    name,
    config: serverConfig,
    client,
    initializing: null,
    openDocuments: new Map(),
    lastActivity: Date.now(),
  };

  state.servers.set(name, newManaged);

  newManaged.initializing = (async () => {
    try {
      await newManaged.client.initialize(workspaceRoot);
      newManaged.lastActivity = Date.now();
      await prewarmProject(newManaged, workspaceRoot);
    } catch (err) {
      if (err instanceof LspError && err.errorCode === COMMAND_NOT_FOUND) {
        state.servers.delete(name);
        throw err;
      }
      const msg = err instanceof LspError ? err.message : String(err);
      console.error(`[lsp] Failed to start ${name}:`, msg);
      recordInitFailure(state, name, msg);
      state.servers.delete(name);
      // Reap the spawned process — mirrors ensureServer, otherwise a server
      // that started its binary but failed initialization leaks.
      newManaged.client.shutdown().catch(() => {});
    } finally {
      newManaged.initializing = null;
    }
  })();

  try {
    await newManaged.initializing;
  } catch (err) {
    if (err instanceof LspError && err.errorCode === COMMAND_NOT_FOUND) throw err;
  }
  return newManaged.client.ready ? newManaged.client : null;
}

/** Shut down all managed servers. */
export async function stopServer(state: LspManagerState): Promise<void> {
  stopIdleChecker(state);
  for (const [, managed] of state.servers) {
    for (const [, doc] of managed.openDocuments) {
      managed.client.didClose(doc.uri);
    }
    managed.openDocuments.clear();
    await managed.client.shutdown();
  }
  state.servers.clear();
  state.config = null;
  state.configured = false;
}

export function __recordInitFailureForTests(state: LspManagerState, serverName: string, message: string): void {
  recordInitFailure(state, serverName, message);
}

export function __checkInitBackoffForTests(state: LspManagerState, serverName: string): void {
  checkInitBackoff(state, serverName);
}

export function __getUnsupportedServerCommandReasonForTests(serverName: string, command: string, cwd: string): Promise<string | null> {
  return getUnsupportedServerCommandReason(serverName, command, cwd);
}

/** Get all ready clients. */
export function getActiveClients(state: LspManagerState): Array<[string, LspClient]> {
  const result: Array<[string, LspClient]> = [];
  for (const [name, managed] of state.servers) {
    if (managed.client.ready) {
      managed.lastActivity = Date.now();
      result.push([name, managed.client]);
    }
  }
  return result;
}

/**
 * Ensure a server knows about a file and return its URI.
 * Picks the primary (non-linter) server for the file.
 */
export function syncDocument(
  state: LspManagerState,
  workspaceRoot: string,
  filePath: string,
): string | null {
  const absPath = filePath.startsWith("/") ? filePath : join(workspaceRoot, filePath);

  // Find the best server for this file
  for (const [, managed] of state.servers) {
    if (!managed.client.ready) continue;
    if (managed.config.isLinter) continue; // Prefer primary servers
    const ext = extname(absPath).replace(".", "").toLowerCase();
    const dotExt = `.${ext}`;
    if (!managed.config.fileTypes.includes(dotExt)) continue;
    return syncDocumentToServer(managed, absPath);
  }

  // Fallback: any ready server that handles this file type
  for (const [, managed] of state.servers) {
    if (!managed.client.ready) continue;
    const ext = extname(absPath).replace(".", "").toLowerCase();
    const dotExt = `.${ext}`;
    if (!managed.config.fileTypes.includes(dotExt)) continue;
    return syncDocumentToServer(managed, absPath);
  }

  return null;
}

/**
 * Ensure the primary server for a file is running, synchronize current disk
 * contents to that exact server, and return the matching client with the URI.
 */
export async function syncDocumentForFile(
  state: LspManagerState,
  workspaceRoot: string,
  filePath: string,
): Promise<SyncedDocument | null> {
  if (!state.config) {
    state.config = loadConfig(workspaceRoot);
    state.configured = true;
    setIdleTimeout(state, state.config.idleTimeoutMs);
  }

  const absPath = filePath.startsWith("/") ? filePath : join(workspaceRoot, filePath);
  const primary = getPrimaryServerForFile(state.config, absPath);
  if (!primary) return null;

  await ensureNamedServer(state, primary[0], workspaceRoot);
  const managed = state.servers.get(primary[0]);
  if (!managed?.client.ready) return null;

  const uri = syncDocumentToServer(managed, absPath);
  if (!uri) return null;
  managed.lastActivity = Date.now();
  return { uri, client: managed.client, serverName: managed.name };
}

function syncDocumentToServer(managed: ManagedServer, absPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    // File deleted mid-session — close it on the server so stale diagnostics
    // and the openDocuments map don't linger (previously they grew forever).
    const existing = managed.openDocuments.get(absPath);
    if (existing) {
      managed.client.didClose(existing.uri);
      managed.openDocuments.delete(absPath);
    }
    return null;
  }

  const existing = managed.openDocuments.get(absPath);
  if (existing) {
    if (existing.text !== text) {
      existing.version++;
      existing.text = text;
      managed.client.didChange(existing.uri, existing.version, text);
    }
    managed.lastActivity = Date.now();
    return existing.uri;
  }

  const langId = guessLanguageId(absPath);
  const uri = managed.client.ensureOpen(absPath, text, langId);
  managed.openDocuments.set(absPath, { uri, languageId: langId, version: 1, text });
  managed.lastActivity = Date.now();
  return uri;
}

function guessLanguageId(filePath: string): string {
  const ext = extname(filePath).replace(".", "").toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
    mjs: "javascript", cjs: "javascript", py: "python", rs: "rust", go: "go",
    java: "java", kt: "kotlin", scala: "scala", hs: "haskell", ml: "ocaml",
    ex: "elixir", exs: "elixir", rb: "ruby", php: "php", cs: "csharp",
    lua: "lua", nix: "nix", zig: "zig", sh: "shellscript", bash: "shellscript",
    yaml: "yaml", yml: "yaml", json: "json", toml: "toml", sql: "sql",
    swift: "swift", dart: "dart", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    vue: "vue", svelte: "svelte", css: "css", scss: "scss", html: "html",
    graphql: "graphql", prisma: "prisma", tf: "terraform",
  };
  return map[ext] ?? ext;
}

/**
 * Pre-warm a language server by opening the first matching source file.
 * Both tsserver and rust-analyzer need at least one didOpen before
 * workspace/symbol and other project-wide features work.
 *
 * Async (2.5.11): the previous readdirSync/readFileSync scan ran on the
 * startup path and blocked the whole event loop for seconds in large repos.
 */
async function prewarmProject(managed: ManagedServer, workspaceRoot: string): Promise<void> {
  const exts = new Set((managed.client.config.extensions ?? []).map(e => e.startsWith(".") ? e : `.${e}`));
  const SKIP = new Set(["node_modules", ".git", "build", "dist", "target", ".next", "__pycache__"]);
  const MAX_DEPTH = 3;

  async function scan(dir: string, depth: number): Promise<boolean> {
    if (depth > MAX_DEPTH) return false;
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    // Process files first, then directories
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = extname(entry.name);
        if (!exts.has(ext)) continue;
        const absPath = join(dir, entry.name);
        try {
          const text = await fsPromises.readFile(absPath, "utf8");
          // Use the canonical languageId mapping ("ts" -> "typescript",
          // "py" -> "python"); some servers reject or mis-handle raw ext.
          const langId = guessLanguageId(absPath);
          const uri = managed.client.ensureOpen(absPath, text, langId);
          managed.openDocuments.set(absPath, { uri, languageId: langId, version: 1, text });
          return true;
        } catch {}
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith(".")) {
        if (await scan(join(dir, entry.name), depth + 1)) return true;
      }
    }
    return false;
  }

  await scan(workspaceRoot, 0);
}

// Backwards-compatible re-export for index.ts
export { loadConfig } from "./config.ts";
