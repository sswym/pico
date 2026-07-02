/**
 * srcode LSP extension.
 *
 * Registers five LLM-callable tools backed by a language server:
 *   - lsp_hover        — type info / docs at a position
 *   - lsp_definition   — jump-to-definition
 *   - lsp_references   — find all references
 *   - lsp_diagnostics  — errors / warnings for a file
 *   - lsp_symbols      — document outline (functions, classes, …)
 *
 * The server is spawned lazily on the first tool call and shut down on
 * session_shutdown.  Auto-detection picks the right server from workspace
 * files (tsconfig.json → tsserver, Cargo.toml → rust-analyzer, etc.).
 */
import { Type } from "@earendil-works/pi-ai";

import {
  defineTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { positionToLsp } from "./client.ts";
import {
  createLspManager,
  ensureServer,
  stopServer,
  syncDocument,
  formatHoverResult,
  formatLocations,
  formatDiagnosticsForFile,
  flattenDocumentSymbols,
  formatDocumentSymbols,
} from "./manager.ts";
import type { DocumentSymbolFlat, LspManagerState } from "./manager.ts";

// ── Result helpers ────────────────────────────────────────────────────────

const TEXT: "text" = "text";

function ok(text: string) {
  return { content: [{ type: TEXT, text }], details: undefined };
}

function fail(text: string) {
  return { content: [{ type: TEXT, text }], details: undefined, isError: true };
}

/**
 * Safely extract `uri` and `range.start.line` from a Location-like object.
 * Uses `in` narrowing at every depth — no unchecked `as` casts.
 */
function extractLocationFields(obj: unknown): { uri: string; line: number } | null {
  if (typeof obj !== "object" || obj === null) return null;
  if (!("uri" in obj) || !("range" in obj)) return null;

  const uriVal = obj.uri;
  if (typeof uriVal !== "string") return null;

  const rangeVal = obj.range;
  if (typeof rangeVal !== "object" || rangeVal === null || !("start" in rangeVal)) return null;

  const startVal = rangeVal.start;
  if (typeof startVal !== "object" || startVal === null || !("line" in startVal)) return null;

  const lineVal = startVal.line;
  if (typeof lineVal !== "number") return null;

  return { uri: uriVal, line: lineVal };
}

// ── Type guard for DocumentSymbol vs SymbolInformation ─────────────────────

interface HierarchicalSymbol {
  name: string;
  kind: number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
  detail?: string;
  children?: HierarchicalSymbol[];
}

interface FlatSymbolInfo {
  name: string;
  kind: number;
  location: { uri: string; range: { start: { line: number } } };
  containerName?: string;
}

function isHierarchicalSymbolArray(symbols: unknown[]): symbols is HierarchicalSymbol[] {
  return (
    symbols.length > 0 &&
    symbols[0] !== null &&
    typeof symbols[0] === "object" &&
    "selectionRange" in symbols[0]
  );
}

function isFlatSymbolInfoArray(symbols: unknown[]): symbols is FlatSymbolInfo[] {
  return (
    symbols.length > 0 &&
    symbols[0] !== null &&
    typeof symbols[0] === "object" &&
    "location" in symbols[0]
  );
}

interface WorkspaceSymbolItem {
  name: string;
  kind: number;
  location: unknown;
  containerName?: string;
}

function isWorkspaceSymbolArray(symbols: unknown[]): symbols is WorkspaceSymbolItem[] {
  return (
    symbols.length > 0 &&
    symbols[0] !== null &&
    typeof symbols[0] === "object" &&
    "location" in symbols[0]
  );
}

// ── Tool parameter schemas ────────────────────────────────────────────────

const PositionParams = Type.Object({
  file: Type.String({ description: "File path (relative to cwd or absolute)." }),
  line: Type.Integer({ description: "1-based line number." }),
  character: Type.Integer({ description: "0-based character offset within the line." }),
});

const FileParams = Type.Object({
  file: Type.String({ description: "File path (relative to cwd or absolute)." }),
});

const SymbolsQueryParams = Type.Object({
  query: Type.Optional(
    Type.String({ description: "Filter symbols by name substring. Empty = list all in file." }),
  ),
  file: Type.Optional(
    Type.String({ description: "Restrict to one file (document symbols). Omit for workspace-wide search." }),
  ),
});

// ── Extension factory ─────────────────────────────────────────────────────

export const lspExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const state: LspManagerState = createLspManager();

  // ── lsp_hover ──────────────────────────────────────────────────────────

  pi.registerTool(
    defineTool({
      name: "lsp_hover",
      label: "LSP Hover",
      description:
        "Get type information and documentation at a code position using a language server. " +
        "Returns the hover tooltip content (type signature, docstring, etc.) for the symbol " +
        "at the given file, line, and character position.",
      parameters: PositionParams,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const client = await ensureServer(state, ctx.cwd);
        if (!client) return fail("No language server available for this project.");
        const uri = syncDocument(state, params.file);
        if (!uri) return fail(`Cannot open file: ${params.file}`);
        try {
          const pos = positionToLsp(params.line, params.character);
          const hover = await client.textDocumentHover(uri, pos);
          return ok(formatHoverResult(hover));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return fail(`LSP hover failed: ${msg}`);
        }
      },
    }),
  );

  // ── lsp_definition ─────────────────────────────────────────────────────

  pi.registerTool(
    defineTool({
      name: "lsp_definition",
      label: "LSP Definition",
      description:
        "Find the definition(s) of the symbol at a code position using a language server. " +
        "Returns file paths and line numbers of all definition sites.",
      parameters: PositionParams,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const client = await ensureServer(state, ctx.cwd);
        if (!client) return fail("No language server available for this project.");
        const uri = syncDocument(state, params.file);
        if (!uri) return fail(`Cannot open file: ${params.file}`);
        try {
          const pos = positionToLsp(params.line, params.character);
          const result = await client.textDocumentDefinition(uri, pos);
          const locs = result === null ? [] : Array.isArray(result) ? result : [result];
          return ok(formatLocations(locs, "definitions"));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return fail(`LSP definition failed: ${msg}`);
        }
      },
    }),
  );

  // ── lsp_references ─────────────────────────────────────────────────────

  pi.registerTool(
    defineTool({
      name: "lsp_references",
      label: "LSP References",
      description:
        "Find all references to the symbol at a code position using a language server. " +
        "Returns file paths and line numbers of every usage site (including the definition).",
      parameters: PositionParams,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const client = await ensureServer(state, ctx.cwd);
        if (!client) return fail("No language server available for this project.");
        const uri = syncDocument(state, params.file);
        if (!uri) return fail(`Cannot open file: ${params.file}`);
        try {
          const pos = positionToLsp(params.line, params.character);
          const result = await client.textDocumentReferences(uri, pos);
          return ok(formatLocations(result, "references"));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return fail(`LSP references failed: ${msg}`);
        }
      },
    }),
  );

  // ── lsp_diagnostics ────────────────────────────────────────────────────

  pi.registerTool(
    defineTool({
      name: "lsp_diagnostics",
      label: "LSP Diagnostics",
      description:
        "Get compiler/linter diagnostics (errors, warnings, hints) for a file using a language server. " +
        "The server must have analyzed the file; results are cached from the last analysis.",
      parameters: FileParams,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const client = await ensureServer(state, ctx.cwd);
        if (!client) return fail("No language server available for this project.");
        const uri = syncDocument(state, params.file);
        if (!uri) return fail(`Cannot open file: ${params.file}`);
        try {
          // Diagnostics are pushed asynchronously; the syncDocument() call
          // above triggers analysis. Give the server a brief moment, then
          // return whatever has accumulated so far.
          await new Promise<void>((resolve) => { setTimeout(() => resolve(), 500); });
          const diags = client.getDiagnostics(uri);
          return ok(formatDiagnosticsForFile(params.file, diags));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return fail(`LSP diagnostics failed: ${msg}`);
        }
      },
    }),
  );

  // ── lsp_symbols ────────────────────────────────────────────────────────

  pi.registerTool(
    defineTool({
      name: "lsp_symbols",
      label: "LSP Symbols",
      description:
        "List symbols (functions, classes, variables, etc.) in a file or across the workspace using a language server. " +
        "Provide a file path for document symbols, or omit it and provide a query for workspace-wide symbol search.",
      parameters: SymbolsQueryParams,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const client = await ensureServer(state, ctx.cwd);
        if (!client) return fail("No language server available for this project.");

        try {
          // Workspace symbol search
          if (!params.file && params.query) {
            const result = await client.workspaceSymbol(params.query);
            if (!result || result.length === 0) return ok(`No symbols found matching "${params.query}".`);
            if (!isWorkspaceSymbolArray(result)) return ok(`No symbols found matching "${params.query}".`);

            const lines: string[] = [];
            for (const sym of result) {
              const loc = extractLocationFields(sym.location);
              if (loc) {
                lines.push(`  ${sym.name} [${sym.kind}] ${loc.uri.replace("file://", "")}:${loc.line + 1}`);
              } else {
                lines.push(`  ${sym.name} [${sym.kind}] (no location)`);
              }
            }
            return ok(`Workspace symbols matching "${params.query}" (${result.length}):\n${lines.join("\n")}`);
          }

          // Document symbols
          const filePath = params.file;
          if (!filePath) return fail("Provide either a file path or a query.");

          const uri = syncDocument(state, filePath);
          if (!uri) return fail(`Cannot open file: ${filePath}`);

          const result = await client.textDocumentDocumentSymbol(uri);
          if (!result || result.length === 0) return ok(`No symbols found in ${filePath}.`);

          // HierarchicalDocumentSymbol[] — has `selectionRange`
          if (isHierarchicalSymbolArray(result)) {
            const flat: DocumentSymbolFlat[] = flattenDocumentSymbols(result);
            return ok(formatDocumentSymbols(flat));
          }

          // SymbolInformation[] — flat list with `location`
          if (isFlatSymbolInfoArray(result)) {
            const lines: string[] = [];
            for (const sym of result) {
              const file = sym.location.uri.replace("file://", "");
              const container = sym.containerName ? ` (${sym.containerName})` : "";
              lines.push(`  ${sym.name} [${sym.kind}] ${file}:${sym.location.range.start.line + 1}${container}`);
            }
            return ok(`Symbols in ${filePath} (${result.length}):\n${lines.join("\n")}`);
          }

          return ok(`No symbols found in ${filePath}.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return fail(`LSP symbols failed: ${msg}`);
        }
      },
    }),
  );

  // ── Lifecycle ──────────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    await stopServer(state);
  });
};

export default lspExtension;
