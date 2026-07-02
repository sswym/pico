/**
 * srcode LSP extension — unified `lsp` tool.
 *
 * One tool with an `action` parameter that routes to language server operations:
 *   hover, definition, type_definition, implementation, references,
 *   diagnostics, symbols, code_actions, rename, capabilities, status, reload, request
 *
 * Lazy server startup on first call. Graceful degradation when no server available.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  LspClient,
  positionToLsp,
  uriToPath,
  LspError,
} from "./client.ts";
import type { Location, Position } from "./types.ts";
import {
  createLspManager,
  ensureServer,
  stopServer,
  syncDocument,
  detectServer,
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

// ── Type guards ───────────────────────────────────────────────────────────

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

interface WorkspaceSymbolItem {
  name: string;
  kind: number;
  location: unknown;
  containerName?: string;
}

function isHierarchicalSymbolArray(symbols: unknown[]): symbols is HierarchicalSymbol[] {
  return symbols.length > 0 && symbols[0] !== null && typeof symbols[0] === "object" && "selectionRange" in symbols[0];
}

function isFlatSymbolInfoArray(symbols: unknown[]): symbols is FlatSymbolInfo[] {
  return symbols.length > 0 && symbols[0] !== null && typeof symbols[0] === "object" && "location" in symbols[0];
}

function isWorkspaceSymbolArray(symbols: unknown[]): symbols is WorkspaceSymbolItem[] {
  return symbols.length > 0 && symbols[0] !== null && typeof symbols[0] === "object" && "location" in symbols[0];
}

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

function normalizeLocations(result: unknown): Location[] {
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) {
    if (typeof result === "object" && "uri" in result && "range" in result) return [result as Location];
    return [];
  }
  if (result.length === 0) return [];
  const first = result[0]!;
  if (first && typeof first === "object" && "targetUri" in first) {
    return (result as Array<{ targetUri: string; targetRange: { start: Position; end: Position } }>).map((link) => ({
      uri: link.targetUri,
      range: link.targetRange,
    }));
  }
  return result as Location[];
}

// ── Actions ───────────────────────────────────────────────────────────────

const ACTIONS = [
  "hover", "definition", "type_definition", "implementation", "references",
  "diagnostics", "symbols", "code_actions", "rename",
  "capabilities", "status", "reload", "request",
] as const;

type Action = (typeof ACTIONS)[number];

// ── Unified tool schema ───────────────────────────────────────────────────

const LspParams = Type.Object({
  action: Type.String({ description: `LSP action. One of: ${ACTIONS.join(", ")}` }),
  file: Type.Optional(Type.String({ description: "File path (relative to cwd or absolute)." })),
  line: Type.Optional(Type.Integer({ description: "1-based line number." })),
  character: Type.Optional(Type.Integer({ description: "0-based character offset." })),
  symbol: Type.Optional(Type.String({ description: "Symbol name. Auto-resolves column on the given line." })),
  query: Type.Optional(Type.String({ description: "Search query (for symbols/workspace search, or code_actions filter, or raw request method)." })),
  newName: Type.Optional(Type.String({ description: "New name for rename action." })),
  apply: Type.Optional(Type.Boolean({ description: "For code_actions: apply the matched action." })),
  payload: Type.Optional(Type.Any({ description: "For request: raw JSON params to send." })),
  occurrence: Type.Optional(Type.Integer({ description: "When symbol appears multiple times on the line, pick the Nth (1-based)." })),
});

// ── Resolve symbol to column ──────────────────────────────────────────────

function resolveSymbolColumn(filePath: string, line: number, symbol: string, occurrence: number): number | undefined {
  try {
    const text = readFileSync(filePath, "utf8");
    const lines = text.split("\n");
    const lineText = lines[line - 1];
    if (!lineText) return undefined;
    let idx = 0;
    let count = 0;
    while (true) {
      const found = lineText.indexOf(symbol, idx);
      if (found === -1) return undefined;
      count++;
      if (count >= occurrence) return found;
      idx = found + 1;
    }
  } catch {
    return undefined;
  }
}

// ── Workspace edit application ────────────────────────────────────────────

function applyWorkspaceEdit(edit: { changes?: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>>; documentChanges?: unknown[] }): string {
  const lines: string[] = [];
  let fileCount = 0;

  if (edit.changes) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) {
      const filePath = uriToPath(uri);
      try {
        let content = readFileSync(filePath, "utf8");
        const sorted = [...textEdits].sort((a, b) => {
          if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
          return b.range.start.character - a.range.start.character;
        });
        const contentLines = content.split("\n");
        for (const te of sorted) {
          const startLine = te.range.start.line;
          const startChar = te.range.start.character;
          const endLine = te.range.end.line;
          const endChar = te.range.end.character;
          if (startLine === endLine) {
            const line = contentLines[startLine] ?? "";
            contentLines[startLine] = line.slice(0, startChar) + te.newText + line.slice(endChar);
          } else {
            const startLineText = contentLines[startLine] ?? "";
            const endLineText = contentLines[endLine] ?? "";
            const merged = startLineText.slice(0, startChar) + te.newText + endLineText.slice(endChar);
            contentLines.splice(startLine, endLine - startLine + 1, merged);
          }
        }
        content = contentLines.join("\n");
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, content, "utf8");
        fileCount++;
        lines.push(`  ${filePath} (${textEdits.length} edits)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lines.push(`  ${filePath}: FAILED — ${msg}`);
      }
    }
  }

  if (fileCount === 0) return "No files modified.";
  return `Modified ${fileCount} file(s):\n${lines.join("\n")}`;
}

// ── Extension factory ─────────────────────────────────────────────────────

export const lspExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const state: LspManagerState = createLspManager();

  pi.registerTool(
    defineTool({
      name: "lsp",
      label: "LSP",
      description:
        "Query LSP (language server) for diagnostics, hover info, references, and code intelligence. " +
        "Actions: hover, definition, type_definition, implementation, references, diagnostics, " +
        "symbols, code_actions, rename, capabilities, status, reload, request. " +
        "Use symbol to auto-resolve column position from a name on the given line.",
      parameters: LspParams,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const action = params.action as Action;
        if (!ACTIONS.includes(action)) {
          return fail(`Unknown action: ${action}. Valid: ${ACTIONS.join(", ")}`);
        }

        // ── Actions that don't need a running server ────────────────────
        if (action === "status") {
          const detection = detectServer(ctx.cwd);
          if (!detection) return ok("No language server detected for this project.");
          if (!state.client) return ok(`Server: ${detection.config.language} (not started yet)`);
          const client = state.client;
          const info = client.serverInfo;
          const name = info.name ?? detection.config.language;
          const ver = info.version ?? "unknown";
          const openCount = state.openDocuments.size;
          const capKeys = Object.keys(client.capabilities).filter(
            (k) => client.capabilities[k] === true || typeof client.capabilities[k] === "object",
          );
          return ok(`Server: ${name} v${ver}\nStatus: ${client.status}\nOpen documents: ${openCount}\nCapabilities: ${capKeys.join(", ")}`);
        }

        // ── Actions that need a running server ──────────────────────────
        const client = await ensureServer(state, ctx.cwd);
        if (!client) return fail("No language server available for this project.");

        if (action === "reload") {
          await stopServer(state);
          const refreshed = await ensureServer(state, ctx.cwd);
          if (!refreshed) return fail("Failed to restart language server.");
          return ok(`Restarted ${refreshed.serverName} v${refreshed.serverInfo.version ?? "unknown"}`);
        }

        if (action === "capabilities") {
          const caps = client.capabilities;
          const lines: string[] = [];
          for (const [key, value] of Object.entries(caps)) {
            if (value === true) lines.push(`  ${key}: supported`);
            else if (typeof value === "object" && value !== null) lines.push(`  ${key}: ${JSON.stringify(value)}`);
          }
          return ok(`Capabilities of ${client.serverName}:\n${lines.join("\n")}`);
        }

        if (action === "request") {
          if (!params.query) return fail("request action requires 'query' (LSP method name).");
          try {
            const result = await client.rawRequest(params.query, params.payload ?? null);
            return ok(JSON.stringify(result, null, 2));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return fail(`LSP request failed: ${msg}`);
          }
        }

        // ── File-level actions ──────────────────────────────────────────
        if (action === "diagnostics") {
          if (!params.file) {
            const allDiags = client.getAllDiagnostics();
            const lines: string[] = [];
            for (const [uri, diags] of allDiags) {
              if (diags.length > 0) {
                const filePath = uriToPath(uri);
                lines.push(formatDiagnosticsForFile(filePath, diags));
              }
            }
            if (lines.length === 0) return ok("No diagnostics across workspace.");
            return ok(lines.join("\n\n"));
          }
          const uri = syncDocument(state, params.file);
          if (!uri) return fail(`Cannot open file: ${params.file}`);
          try {
            await new Promise<void>((resolve) => { setTimeout(() => resolve(), 500); });
            const diags = client.getDiagnostics(uri);
            return ok(formatDiagnosticsForFile(params.file, diags));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return fail(`LSP diagnostics failed: ${msg}`);
          }
        }

        if (action === "symbols") {
          if (!params.file && params.query) {
            try {
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
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return fail(`Workspace symbol search failed: ${msg}`);
            }
          }
          if (!params.file) return fail("Provide a file path for document symbols, or a query for workspace search.");
          const uri = syncDocument(state, params.file);
          if (!uri) return fail(`Cannot open file: ${params.file}`);
          try {
            const result = await client.textDocumentDocumentSymbol(uri);
            if (!result || result.length === 0) return ok(`No symbols found in ${params.file}.`);
            if (isHierarchicalSymbolArray(result)) {
              const flat: DocumentSymbolFlat[] = flattenDocumentSymbols(result);
              return ok(formatDocumentSymbols(flat));
            }
            if (isFlatSymbolInfoArray(result)) {
              const lines: string[] = [];
              for (const sym of result) {
                const file = sym.location.uri.replace("file://", "");
                const container = sym.containerName ? ` (${sym.containerName})` : "";
                lines.push(`  ${sym.name} [${sym.kind}] ${file}:${sym.location.range.start.line + 1}${container}`);
              }
              return ok(`Symbols in ${params.file} (${result.length}):\n${lines.join("\n")}`);
            }
            return ok(`No symbols found in ${params.file}.`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return fail(`LSP symbols failed: ${msg}`);
          }
        }

        // ── Position-based actions ──────────────────────────────────────
        if (!params.file) return fail(`${action} requires 'file' parameter.`);
        if (!params.line) return fail(`${action} requires 'line' parameter.`);

        let character: number | undefined = params.character;
        if (character === undefined && params.symbol) {
          const absPath = params.file.startsWith("/") ? params.file : `${ctx.cwd}/${params.file}`;
          character = resolveSymbolColumn(absPath, params.line, params.symbol, params.occurrence ?? 1);
          if (character === undefined) {
            return fail(`Symbol "${params.symbol}" not found on line ${params.line} of ${params.file}`);
          }
        }
        if (character === undefined) return fail(`${action} requires 'character' parameter (or 'symbol' for auto-resolve).`);

        const uri = syncDocument(state, params.file);
        if (!uri) return fail(`Cannot open file: ${params.file}`);
        const pos = positionToLsp(params.line, character);

        try {
          switch (action) {
            case "hover": {
              const hover = await client.textDocumentHover(uri, pos);
              return ok(formatHoverResult(hover));
            }
            case "definition": {
              const result = await client.textDocumentDefinition(uri, pos);
              return ok(formatLocations(normalizeLocations(result), "definitions"));
            }
            case "type_definition": {
              const result = await client.textDocumentTypeDefinition(uri, pos);
              return ok(formatLocations(normalizeLocations(result), "type definitions"));
            }
            case "implementation": {
              const result = await client.textDocumentImplementation(uri, pos);
              return ok(formatLocations(normalizeLocations(result), "implementations"));
            }
            case "references": {
              const result = await client.textDocumentReferences(uri, pos);
              return ok(formatLocations(result, "references"));
            }
            case "code_actions": {
              const diags = client.getDiagnostics(uri);
              const lineDiags = diags.filter((d) => d.range.start.line === pos.line);
              const context = { diagnostics: lineDiags, only: params.query ? [params.query] : undefined };
              const actions = await client.textDocumentCodeAction(uri, { start: pos, end: pos }, context);
              if (!actions || actions.length === 0) return ok("No code actions available at this position.");
              if (params.apply) {
                const matchTitle = params.query;
                const target = matchTitle
                  ? actions.find((a) => a.title.toLowerCase().includes(matchTitle.toLowerCase())) ?? actions[0]
                  : actions[0];
                if (!target) return fail("No matching code action found.");
                let resolved = target;
                try { resolved = await client.codeActionResolve(target); } catch {}
                if (resolved.edit) {
                  return ok(`Applied: ${resolved.title}\n${applyWorkspaceEdit(resolved.edit)}`);
                }
                if (resolved.command) {
                  return ok(`Action requires command execution (not yet supported): ${resolved.title}`);
                }
                return ok(`Applied: ${resolved.title}`);
              }
              const lines: string[] = [];
              for (let i = 0; i < actions.length; i++) {
                const a = actions[i]!;
                const kind = a.kind ? ` (${a.kind})` : "";
                const preferred = a.isPreferred ? " [preferred]" : "";
                lines.push(`  ${i + 1}. ${a.title}${kind}${preferred}`);
              }
              return ok(`Code actions (${actions.length}):\n${lines.join("\n")}\n\nUse apply=true with query=<title substring> to apply one.`);
            }
            case "rename": {
              if (!params.newName) return fail("rename requires 'newName' parameter.");
              const edit = await client.textDocumentRename(uri, pos, params.newName);
              if (!edit) return ok("No rename edits returned.");
              return ok(`Renamed to "${params.newName}"\n${applyWorkspaceEdit(edit)}`);
            }
            default:
              return fail(`Unknown action: ${action}`);
          }
        } catch (err) {
          const msg = err instanceof LspError ? err.message : err instanceof Error ? err.message : String(err);
          return fail(`LSP ${action} failed: ${msg}`);
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
