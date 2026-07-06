/**
 * srcode LSP extension — unified `lsp` tool.
 *
 * One tool with an `action` parameter that routes to language server operations:
 *   hover, definition, type_definition, implementation, references,
 *   diagnostics, symbols, code_actions, rename, capabilities, status, reload, request
 *
 * Lazy server startup on first call. Graceful degradation when no server available.
 */
import { readFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { positionToLsp, uriToPath, pathToUri, lspPositionToDisplay, LspError, COMMAND_NOT_FOUND } from "./client.ts";
import type { Location, Position, WorkspaceEdit, FileRenameEvent } from "./types.ts";
import { loadConfig } from "./config.ts";
import {
  createLspManager,
  ensureServer,
  stopServer,
  syncDocument,
  getActiveClients,
  formatHoverResult,
  formatLocations,
  formatDiagnosticsForFile,
  flattenDocumentSymbols,
  formatDocumentSymbols,
} from "./manager.ts";
import type { DocumentSymbolFlat, LspManagerState } from "./manager.ts";
import { resolveFormattingOptions } from "./format-options.ts";
import { getInstallHint, installServer, formatInstallHint } from "./install.ts";
import { applyWorkspaceEdit } from "./edits.ts";

// ── Result helpers ────────────────────────────────────────────────────────

const TEXT: "text" = "text";

interface LspDetails {
  serverName?: string;
  action?: string;
  success: boolean;
}

function ok(text: string, details?: LspDetails) {
  return { content: [{ type: TEXT, text }], details: details ?? { success: true } };
}

function fail(text: string, details?: LspDetails) {
  return { content: [{ type: TEXT, text }], details: details ?? { success: false }, isError: true };
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
  "diagnostics", "symbols", "code_actions", "rename", "rename_file",
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


// ── Extension factory ─────────────────────────────────────────────────────

export const lspExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const state: LspManagerState = createLspManager();

  /**
   * Try to start an LSP server. If the binary is missing (ENOENT),
   * prompt the user to auto-install and retry once.
   */
  async function ensureServerWithInstall(
    workspaceRoot: string,
    ctx: ExtensionContext,
  ) {
    try {
      return await ensureServer(state, workspaceRoot);
    } catch (err) {
      if (!(err instanceof LspError) || err.errorCode !== COMMAND_NOT_FOUND) throw err;
      const fullCmd = err.message.match(/"(.+?)"/)?.[1];
      const cmd = fullCmd ? basename(fullCmd) : null;
      const hint = cmd ? getInstallHint(cmd) : null;
      if (!hint) {
        ctx.ui.notify(formatInstallHint(fullCmd ?? "unknown"), "warning");
        return null;
      }
      const doInstall = await ctx.ui.confirm(
        `Install LSP server "${cmd}"?`,
        `Command "${cmd}" not found. Install with:\n  ${hint.command}\n\nProceed?`,
      );
      if (!doInstall) return null;
      const result = await installServer(cmd!);
      if (!result.ok) {
        ctx.ui.notify(`Installation failed:\n${result.output}`, "error");
        return null;
      }
      ctx.ui.notify(`Installed ${cmd}. Starting language server…`, "info");
      return await ensureServer(state, workspaceRoot);
    }
  }

  pi.registerTool(
    defineTool({
      name: "lsp",
      label: "LSP",
      description:
        "Query LSP (language server) for diagnostics, hover info, references, and code intelligence. " +
        "Actions: hover, definition, type_definition, implementation, references, diagnostics, " +
        "symbols, code_actions, rename, rename_file, capabilities, status, reload, request. " +
        "Use symbol to auto-resolve column position from a name on the given line.",
      parameters: LspParams,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const action = params.action as Action;
        if (!ACTIONS.includes(action)) {
          return fail(`Unknown action: ${action}. Valid: ${ACTIONS.join(", ")}`);
        }

        // ── Actions that don't need a running server ────────────────────
        if (action === "status") {
          if (!state.config) state.config = loadConfig(ctx.cwd);
          const serverNames = Object.keys(state.config.servers);
          if (serverNames.length === 0) return ok("No language servers configured for this project.");
          const active = getActiveClients(state);
          if (active.length === 0) {
            return ok(`Configured servers: ${serverNames.join(", ")}\nNo servers started yet.`);
          }
          const lines: string[] = [];
          for (const [name, client] of active) {
            const ver = client.displayVersion || "unknown";
            const openCount = client.getAllDiagnostics().size;
            lines.push(`  ${name} v${ver} — ${client.status} (${openCount} files with diagnostics)`);
          }
          return ok(`Active language servers:\n${lines.join("\n")}`, { action: "status", success: true });
        }

        // ── Actions that need a running server ──────────────────────────
        const client = await ensureServerWithInstall(ctx.cwd, ctx);
        if (!client) return fail("No language server available for this project.");
        ctx.ui.setStatus("lsp", `LSP: ${client.serverName} ${client.displayVersion}`.trim());

        if (action === "reload") {
          await stopServer(state);
          const refreshed = await ensureServerWithInstall(ctx.cwd, ctx);
          if (!refreshed) return fail("Failed to restart language server.");
          ctx.ui.setStatus("lsp", `LSP: ${refreshed.serverName} ${refreshed.displayVersion}`.trim());
          return ok(`Restarted ${refreshed.serverName} v${refreshed.displayVersion || "unknown"}`, { serverName: refreshed.serverName, action: "reload", success: true });
        }

        if (action === "capabilities") {
          const caps = client.capabilities;
          const lines: string[] = [];
          for (const [key, value] of Object.entries(caps)) {
            if (value === true) lines.push(`  ${key}: supported`);
            else if (typeof value === "object" && value !== null) lines.push(`  ${key}: ${JSON.stringify(value)}`);
          }
          return ok(`Capabilities of ${client.serverName}:\n${lines.join("\n")}`, { serverName: client.serverName, action: "capabilities", success: true });
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
          if (!params.file || params.file === "*") {
            // Collect from ALL active servers
            const activeClients = getActiveClients(state);
            if (activeClients.length === 0) return ok("No active language servers.");
            const allMessages: string[] = [];
            for (const [serverName, managed] of activeClients) {
              const allDiags = managed.getAllDiagnostics();
              for (const [uri, diags] of allDiags) {
                if (diags.length === 0) continue;
                const filePath = uriToPath(uri);
                for (const d of diags) {
                  const pos = lspPositionToDisplay(d.range.start);
                  const sev = d.severity === 1 ? "ERROR" : d.severity === 2 ? "WARNING" : d.severity === 3 ? "INFO" : "HINT";
                  const code = d.code ? ` [${d.code}]` : "";
                  const src = d.source ? ` (${d.source})` : "";
                  allMessages.push(`${filePath}:${pos.line}:${pos.character} ${sev}${code}${src}: ${d.message}`);
                }
              }
            }
            if (allMessages.length === 0) return ok("No diagnostics found.", { action: "diagnostics", success: true });
            return ok(`Workspace diagnostics (${allMessages.length}):\n${allMessages.join("\n")}`, { action: "diagnostics", success: true });
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


        if (action === "rename_file") {
          if (!params.file || !params.newName) {
            return fail("rename_file requires both 'file' (source) and 'newName' (destination).");
          }
          const absPath = params.file.startsWith("/") ? params.file : `${ctx.cwd}/${params.file}`;
          const absNew = params.newName.startsWith("/") ? params.newName : `${ctx.cwd}/${params.newName}`;

          // Step 1: willRenameFiles
          let workspaceEdit: WorkspaceEdit | null = null;
          try {
            workspaceEdit = await client.workspaceWillRenameFiles([
              { oldUri: pathToUri(absPath), newUri: pathToUri(absNew) } satisfies FileRenameEvent,
            ]);
          } catch {
            // Server may not support willRenameFiles — continue with just the rename
          }

          // Step 2: Apply workspace edits if any
          if (workspaceEdit) {
            const result = applyWorkspaceEdit(workspaceEdit, ctx.cwd);
            if (!result.ok) {
              return fail(`Failed to apply workspace edits:\n${result.messages.join("\n")}`);
            }
          }

          // Step 3: Filesystem rename
          try {
            mkdirSync(dirname(absNew), { recursive: true });
            renameSync(absPath, absNew);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return fail(`Filesystem rename failed: ${msg}`);
          }

          // Step 4: didRenameFiles notification
          try {
            client.workspaceDidRenameFiles([
              { oldUri: pathToUri(absPath), newUri: pathToUri(absNew) } satisfies FileRenameEvent,
            ]);
          } catch {}

          // Step 5: Sync new file into document cache
          try { syncDocument(state, absNew); } catch {}

          const lines = [`Renamed: ${params.file} → ${params.newName}`];
          if (workspaceEdit) lines.push("Applied workspace edits from LSP server.");
          return ok(lines.join("\n"), { action: "rename_file", success: true });
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
                  const applyResult = applyWorkspaceEdit(resolved.edit, ctx.cwd);
                  return ok(`Applied: ${resolved.title}\n${applyResult.messages.join("\n")}`);
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
              const applyResult = applyWorkspaceEdit(edit, ctx.cwd);
              return ok(`Renamed to "${params.newName}"\n${applyResult.messages.join("\n")}`);
            }
            default:
              return fail(`Unknown action: ${action}`);
          }
        } catch (err) {
          const msg = err instanceof LspError ? err.message : err instanceof Error ? err.message : String(err);
          return fail(`LSP ${action} failed: ${msg}`, { serverName: client.serverName, action, success: false });
        }
      },
    }),
  );

  // ── Write/Edit writethrough: formatOnWrite + diagnosticsOnWrite ─────────

  const CODE_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
    ".py", ".pyi", ".rs", ".go", ".java", ".kt", ".kts", ".scala",
    ".hs", ".lhs", ".ml", ".mli", ".ex", ".exs", ".rb", ".php",
    ".cs", ".lua", ".nix", ".zig", ".sh", ".bash", ".yaml", ".yml",
    ".json", ".jsonc", ".toml", ".css", ".scss", ".html", ".vue",
    ".svelte", ".astro", ".swift", ".dart", ".graphql", ".prisma",
    ".sql", ".tf", ".c", ".cpp", ".h", ".hpp",
  ]);

  pi.on("tool_result", async (event) => {
    // Only intercept write/edit tools on code files
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    // Extract file path from the tool input
    const input = event.input;
    const filePath = typeof input === "object" && input !== null && "path" in input
      ? String((input as Record<string, unknown>)["path"])
      : undefined;
    if (!filePath) return;

    const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
    if (!CODE_EXTENSIONS.has(ext)) return;

    // Skip if server not running
    const client = state.servers.size > 0
      ? Array.from(state.servers.values()).find((s) => s.client.ready)?.client
      : null;
    if (!client) return;

    try {
      // Sync the file to the LSP server
      const uri = syncDocument(state, filePath);
      if (!uri) return;

      // Notify the server the file was saved
      client.didSave(uri);

      // Collect diagnostics after a brief wait for the server to process
      await new Promise<void>((r) => { setTimeout(() => r(), 800); });
      const diags = client.getDiagnostics(uri);
      if (diags.length === 0) return;

      // Append diagnostics to the tool result
      const diagText = formatDiagnosticsForFile(filePath, diags);
      event.content = [
        ...event.content,
        { type: "text", text: `\n[LSP] ${diagText}` },
      ];
    } catch {
      // Silently ignore writethrough failures
    }
  });

  // ── Startup warmup ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Start the language server in the background; offer install if binary is missing.
    ensureServerWithInstall(ctx.cwd, ctx).then((client) => {
      if (client) {
        ctx.ui.setStatus("lsp", `LSP: ${client.serverName} ${client.displayVersion}`.trim());
      }
    }).catch(() => {});
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("lsp", undefined);
    await stopServer(state);
  });
};

export default lspExtension;
