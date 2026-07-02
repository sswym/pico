/**
 * LspManager — multi-server lifecycle + document sync.
 *
 * Uses config.ts to discover and route servers. Each server is spawned lazily
 * when first needed. Supports multiple concurrent servers per file type.
 */
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import type { LspServerConfig } from "./config.ts";
import { loadConfig, getServersForFile, detectServers, resolveCommand } from "./config.ts";
import { LspClient, locationToDisplay, lspPositionToDisplay, LspError } from "./client.ts";

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
  openDocuments: Map<string, { uri: string; languageId: string }>;
}

export interface LspManagerState {
  config: ReturnType<typeof loadConfig> | null;
  servers: Map<string, ManagedServer>;
  configured: boolean;
}

export function createLspManager(): LspManagerState {
  return {
    config: null,
    servers: new Map(),
    configured: false,
  };
}

/** Get or start the primary (non-linter) server for a file. */
export async function ensureServer(
  state: LspManagerState,
  workspaceRoot: string,
): Promise<LspClient | null> {
  // Ensure config is loaded
  if (!state.config) {
    state.config = loadConfig(workspaceRoot);
    state.configured = true;
  }

  // Find the first ready or startable server for any file in this project
  // We pick the first server whose rootMarkers match
  for (const [name, serverConfig] of Object.entries(state.config.servers)) {
    if (serverConfig.disabled) continue;
    if (serverConfig.isLinter) continue; // Skip linters for primary
    const managed = state.servers.get(name);
    if (managed?.client.ready) return managed.client;
  }

  // No server ready — start the first matching one (filtered by rootMarkers)
  const matching = detectServers(state.config, workspaceRoot);
  for (const [name, serverConfig] of matching) {
    if (serverConfig.isLinter) continue;

    const client = new LspClient(
      { language: name, extensions: serverConfig.fileTypes, command: serverConfig.command, args: serverConfig.args, initializationOptions: serverConfig.initializationOptions },
      name,
    );

    const managed: ManagedServer = {
      name,
      config: serverConfig,
      client,
      initializing: null,
      openDocuments: new Map(),
    };

    state.servers.set(name, managed);

    managed.initializing = (async () => {
      try {
        const resolvedCommand = resolveCommand(serverConfig.command, workspaceRoot) ?? serverConfig.command;
        managed.client = new LspClient(
          { language: name, extensions: serverConfig.fileTypes, command: resolvedCommand, args: serverConfig.args, initializationOptions: serverConfig.initializationOptions },
          name,
        );
        await managed.client.initialize(workspaceRoot);
      } catch (err) {
        const msg = err instanceof LspError ? err.message : String(err);
        console.error(`[lsp] Failed to start ${name}:`, msg);
        state.servers.delete(name);
      } finally {
        managed.initializing = null;
      }
    })();

    await managed.initializing;
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
  if (!state.config) {
    state.config = loadConfig(workspaceRoot);
    state.configured = true;
  }

  const serverConfig = state.config.servers[name];
  if (!serverConfig || serverConfig.disabled) return null;

  const managed = state.servers.get(name);
  if (managed?.client.ready) return managed.client;
  if (managed?.initializing) {
    await managed.initializing;
    return managed.client.ready ? managed.client : null;
  }

  // Start this server
  const client = new LspClient(
    { language: name, extensions: serverConfig.fileTypes, command: serverConfig.command, args: serverConfig.args, initializationOptions: serverConfig.initializationOptions },
    name,
  );

  const newManaged: ManagedServer = {
    name,
    config: serverConfig,
    client,
    initializing: null,
    openDocuments: new Map(),
  };

  state.servers.set(name, newManaged);

  newManaged.initializing = (async () => {
    try {
      await newManaged.client.initialize(workspaceRoot);
    } catch (err) {
      const msg = err instanceof LspError ? err.message : String(err);
      console.error(`[lsp] Failed to start ${name}:`, msg);
      state.servers.delete(name);
    } finally {
      newManaged.initializing = null;
    }
  })();

  await newManaged.initializing;
  return newManaged.client.ready ? newManaged.client : null;
}

/** Shut down all managed servers. */
export async function stopServer(state: LspManagerState): Promise<void> {
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

/** Get all ready clients. */
export function getActiveClients(state: LspManagerState): Array<[string, LspClient]> {
  const result: Array<[string, LspClient]> = [];
  for (const [name, managed] of state.servers) {
    if (managed.client.ready) result.push([name, managed.client]);
  }
  return result;
}

/** Get servers that handle a specific file. */
export function getServersForFilePath(
  state: LspManagerState,
  filePath: string,
): Array<[string, ManagedServer]> {
  if (!state.config) return [];
  const matchingNames = getServersForFile(state.config, filePath).map(([n]) => n);
  const result: Array<[string, ManagedServer]> = [];
  for (const name of matchingNames) {
    const managed = state.servers.get(name);
    if (managed) result.push([name, managed]);
  }
  return result;
}

/**
 * Ensure a server knows about a file and return its URI.
 * Picks the primary (non-linter) server for the file.
 */
export function syncDocument(
  state: LspManagerState,
  filePath: string,
): string | null {
  const absPath = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);

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

function syncDocumentToServer(managed: ManagedServer, absPath: string): string | null {
  const existing = managed.openDocuments.get(absPath);
  if (existing) return existing.uri;

  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }

  const langId = guessLanguageId(absPath);
  const uri = managed.client.ensureOpen(absPath, text, langId);
  managed.openDocuments.set(absPath, { uri, languageId: langId });
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

// Backwards-compatible re-export for index.ts
export { loadConfig } from "./config.ts";
