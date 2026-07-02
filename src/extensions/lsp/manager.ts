/**
 * LspManager — language server lifecycle + auto-detection.
 *
 * Detects the project language from workspace files, spawns the matching
 * language server on demand, and manages document sync via tool_call events.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import type { ServerConfig } from "./types.ts";
import { LspClient, locationToDisplay, lspPositionToDisplay, LspError } from "./client.ts";

// ── Server detection ─────────────────────────────────────────────────────

const SERVER_CONFIGS: ServerConfig[] = [
  {
    language: "typescript",
    extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
    command: "typescript-language-server",
    args: ["--stdio"],
    initializationOptions: {
      preferences: {
        includeInlayParameterNameHints: "all",
        includeInlayVariableTypeHints: true,
        includeInlayFunctionLikeReturnTypeHints: true,
      },
    },
  },
  {
    language: "python",
    extensions: ["py", "pyi"],
    command: "pyright-langserver",
    args: ["--stdio"],
  },
  {
    language: "rust",
    extensions: ["rs"],
    command: "rust-analyzer",
  },
];

interface DetectionResult {
  config: ServerConfig;
  root: string;
}

/** Detect which server to use based on workspace files. */
export function detectServer(workspaceRoot: string): DetectionResult | null {
  if (
    existsSync(join(workspaceRoot, "tsconfig.json")) ||
    existsSync(join(workspaceRoot, "package.json"))
  ) {
    const tsConfig = SERVER_CONFIGS.find((c) => c.language === "typescript")!;
    return { config: tsConfig, root: workspaceRoot };
  }
  if (existsSync(join(workspaceRoot, "Cargo.toml"))) {
    const rustConfig = SERVER_CONFIGS.find((c) => c.language === "rust")!;
    return { config: rustConfig, root: workspaceRoot };
  }
  if (
    existsSync(join(workspaceRoot, "pyproject.toml")) ||
    existsSync(join(workspaceRoot, "pyrightconfig.json")) ||
    existsSync(join(workspaceRoot, "setup.py"))
  ) {
    const pyConfig = SERVER_CONFIGS.find((c) => c.language === "python")!;
    return { config: pyConfig, root: workspaceRoot };
  }
  return null;
}

/** Guess language ID from file extension. */
export function languageIdFromExtension(filePath: string): string {
  const ext = extname(filePath).replace(".", "").toLowerCase();
  for (const config of SERVER_CONFIGS) {
    if (config.extensions.includes(ext)) return config.language;
  }
  return "unknown";
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

// ── LspManager ───────────────────────────────────────────────────────────

export interface LspManagerState {
  client: LspClient | null;
  detection: DetectionResult | null;
  openDocuments: Map<string, { uri: string; languageId: string }>;
  initializing: Promise<void> | null;
}

export function createLspManager(): LspManagerState {
  return {
    client: null,
    detection: null,
    openDocuments: new Map(),
    initializing: null,
  };
}

/** Lazily start the server for the workspace. */
export async function ensureServer(
  state: LspManagerState,
  workspaceRoot: string,
): Promise<LspClient | null> {
  if (state.client?.ready) return state.client;
  if (state.initializing) {
    await state.initializing;
    return state.client;
  }

  const detection = detectServer(workspaceRoot);
  if (!detection) return null;

  state.detection = detection;
  state.client = new LspClient(detection.config);

  state.initializing = (async () => {
    try {
      await state.client!.initialize(detection.root);
    } catch (err) {
      const msg = err instanceof LspError ? err.message : String(err);
      console.error(`[lsp] Failed to start ${detection.config.language} server:`, msg);
      state.client = null;
    } finally {
      state.initializing = null;
    }
  })();

  await state.initializing;
  return state.client;
}

/** Shut down the managed server. */
export async function stopServer(state: LspManagerState): Promise<void> {
  if (!state.client) return;
  for (const [, doc] of state.openDocuments) {
    state.client.didClose(doc.uri);
  }
  state.openDocuments.clear();
  await state.client.shutdown();
  state.client = null;
  state.detection = null;
}

/**
 * Ensure the server knows about a file and return its URI.
 * Reads the file from disk.
 */
export function syncDocument(
  state: LspManagerState,
  filePath: string,
): string | null {
  const client = state.client;
  if (!client?.ready) return null;

  const absPath = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);
  const langId = languageIdFromExtension(absPath);

  if (!client.config.extensions.includes(extname(absPath).replace(".", "").toLowerCase())) {
    return null;
  }

  const existing = state.openDocuments.get(absPath);
  if (existing) return existing.uri;

  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }

  const uri = client.ensureOpen(absPath, text, langId);
  state.openDocuments.set(absPath, { uri, languageId: langId });
  return uri;
}
