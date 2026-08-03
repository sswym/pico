/**
 * pico LSP extension — unified `lsp` tool.
 *
 * One tool with an `action` parameter that routes to language server operations:
 *   hover, definition, type_definition, implementation, references,
 *   diagnostics, symbols, code_actions, rename, capabilities, status, reload, request
 *
 * Lazy server startup on first call. Graceful degradation when no server available.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { renderToolCallText, renderToolResultText } from "../tool-render.ts";
import { positionToLsp, LspError, COMMAND_NOT_FOUND } from "./client.ts";
import type { Location, Position, WorkspaceSymbol } from "./types.ts";
import {
  createLspManager,
  ensureServer,
  syncDocumentForFile,
  stopServer,
  getActiveClients,
  formatHoverResult,
  formatLocations,
  formatDiagnosticsForFile,
} from "./manager.ts";
import type { LspManagerState } from "./manager.ts";
import { resolveFormattingOptions } from "./format-options.ts";
import { getInstallHint, installServer, formatInstallHint } from "./install.ts";
import { applyTextEditsToString } from "./edits.ts";
import { DiagnosticsLedger } from "./diagnostics-ledger.ts";
import { allowLspFormatOnWrite } from "../policy.ts";
import {
  normalizeLocations,
  resolveSymbolColumn,
} from "./actions.ts";
import {
  ACTIONS,
  type Action,
  executeCapabilitiesAction,
  executeStatusAction,
  executeWorkspaceDiagnosticsAction,
  fail,
  formatDocumentSymbolsResult,
  formatWorkspaceSymbolsResult,
  isLspReadonlyInput,
  isLspWriteOrHighRiskInput,
  ok,
  READONLY_ACTIONS,
  BLOCKED_WRITE_OR_HIGH_RISK_ACTIONS,
} from "./executor.ts";

export function isLspReadonlyToolCall(input: unknown): boolean {
  return isLspReadonlyInput(input);
}

export function isLspWriteOrHighRiskToolCall(input: unknown): boolean {
  return isLspWriteOrHighRiskInput(input);
}

export function resolveSessionFilePath(cwd: string, filePath: string): string {
  return filePath.startsWith("/") ? filePath : resolve(cwd, filePath);
}

// ── Unified tool schema ───────────────────────────────────────────────────

const LspParams = Type.Object({
  action: Type.String({
    description:
      `LSP action. Read-only actions: ${READONLY_ACTIONS.join(", ")}. ` +
      `Currently blocked high-risk/write actions: ${BLOCKED_WRITE_OR_HIGH_RISK_ACTIONS.join(", ")}.`,
  }),
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

// ── Extension factory ─────────────────────────────────────────────────────

export const lspExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const state: LspManagerState = createLspManager();
  const ledger = new DiagnosticsLedger();

  /**
   * Try to start an LSP server. If the binary is missing (ENOENT),
   * prompt the user to auto-install and retry once.
   */
  async function withMissingServerInstall<T>(
    workspaceRoot: string,
    ctx: ExtensionContext,
    start: () => Promise<T | null>,
  ): Promise<T | null> {
    try {
      return await start();
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
      try {
        return await start();
      } catch (retryErr) {
        // The freshly installed binary may still be off PATH (e.g. npm
        // global dir not exported) — surface that as a tool failure, not a
        // bare exception escaping the execute path.
        if (!(retryErr instanceof LspError) || retryErr.errorCode !== COMMAND_NOT_FOUND) throw retryErr;
        ctx.ui.notify(
          `Installed ${cmd} but the binary is still not on PATH. Add it and retry.`,
          "error",
        );
        return null;
      }
    }
  }

  async function ensureServerWithInstall(
    workspaceRoot: string,
    ctx: ExtensionContext,
  ) {
    return await withMissingServerInstall(workspaceRoot, ctx, () => ensureServer(state, workspaceRoot));
  }

  async function syncDocumentWithInstall(
    workspaceRoot: string,
    filePath: string,
    ctx: ExtensionContext,
  ) {
    return await withMissingServerInstall(workspaceRoot, ctx, () => syncDocumentForFile(state, workspaceRoot, filePath));
  }

  pi.registerTool(
    defineTool({
      name: "lsp",
      label: "LSP",
      description:
        "Read-only LSP (language server) code intelligence: diagnostics, hover info, definitions, references, symbols, capabilities, and status. " +
        `Read-only actions: ${READONLY_ACTIONS.join(", ")}. ` +
        `High-risk/write actions are currently blocked by policy: ${BLOCKED_WRITE_OR_HIGH_RISK_ACTIONS.join(", ")}. ` +
        "Use symbol to auto-resolve column position from a name on the given line.",
      parameters: LspParams,
      renderCall(args, theme, context) {
        return renderToolCallText("lsp", args, theme, context);
      },
      renderResult(result, options, theme, context) {
        return renderToolResultText(result, options, theme, context, { collapsedLines: 10 });
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const action = params.action as Action;
        if (!ACTIONS.includes(action)) {
          return fail(`Unknown action: ${action}. Valid: ${ACTIONS.join(", ")}`);
        }
        if (isLspWriteOrHighRiskInput(params)) {
          return fail(
            "This lsp tool is read-only. Use explicit edit/write tools for file changes until LSP write actions have a separate permission tier.",
            { action, success: false },
          );
        }

        // ── Actions that don't need a running server ────────────────────
        if (action === "status") {
          return executeStatusAction(state, ctx.cwd);
        }

        let projectClient: Awaited<ReturnType<typeof ensureServerWithInstall>> | null = null;
        const getProjectClient = async () => {
          if (!projectClient) {
            projectClient = await ensureServerWithInstall(ctx.cwd, ctx);
            if (projectClient) {
              ctx.ui.setStatus("lsp", `LSP: ${projectClient.serverName} ${projectClient.displayVersion}`.trim());
            }
          }
          return projectClient;
        };

        if (action === "capabilities") {
          const client = await getProjectClient();
          if (!client) return fail("No language server available for this project.");
          return executeCapabilitiesAction(client);
        }

        // ── File-level actions ──────────────────────────────────────────
        if (action === "diagnostics") {
          if (!params.file || params.file === "*") {
            const client = await getProjectClient();
            if (!client) return fail("No language server available for this project.");
            return executeWorkspaceDiagnosticsAction(state);
          }
          const doc = await syncDocumentWithInstall(ctx.cwd, params.file, ctx);
          if (!doc) return fail(`Cannot open file: ${params.file}`);
          ctx.ui.setStatus("lsp", `LSP: ${doc.serverName}`.trim());
          try {
            await new Promise<void>((resolve) => { setTimeout(() => resolve(), 500); });
            const diags = doc.client.getDiagnostics(doc.uri);
            return ok(formatDiagnosticsForFile(params.file, diags));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return fail(`LSP diagnostics failed: ${msg}`);
          }
        }

        if (action === "symbols") {
          if (!params.file && params.query) {
            const client = await getProjectClient();
            if (!client) return fail("No language server available for this project.");

            const tryWorkspaceSymbol = async (): Promise<WorkspaceSymbol[] | null> => {
              for (let attempt = 0; attempt < 2; attempt++) {
                try {
                  return await client.workspaceSymbol(params.query!);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  if (msg.includes("No Project") && attempt === 0) {
                    await new Promise<void>((r) => { setTimeout(() => r(), 3000); });
                    continue;
                  }
                  throw err;
                }
              }
              return null;
            };
            try {
              const result = await tryWorkspaceSymbol();
              return formatWorkspaceSymbolsResult(params.query, result);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return fail(`Workspace symbol search failed: ${msg}`);
            }
          }
          if (!params.file) return fail("Provide a file path for document symbols, or a query for workspace search.");
          const doc = await syncDocumentWithInstall(ctx.cwd, params.file, ctx);
          if (!doc) return fail(`Cannot open file: ${params.file}`);
          ctx.ui.setStatus("lsp", `LSP: ${doc.serverName}`.trim());
          try {
            const result = await doc.client.textDocumentDocumentSymbol(doc.uri);
            return formatDocumentSymbolsResult(params.file, result);
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

        const doc = await syncDocumentWithInstall(ctx.cwd, params.file, ctx);
        if (!doc) return fail(`Cannot open file: ${params.file}`);
        ctx.ui.setStatus("lsp", `LSP: ${doc.serverName}`.trim());
        const pos = positionToLsp(params.line, character);

        try {
          switch (action) {
            case "hover": {
              const hover = await doc.client.textDocumentHover(doc.uri, pos);
              return ok(formatHoverResult(hover));
            }
            case "definition": {
              const result = await doc.client.textDocumentDefinition(doc.uri, pos);
              return ok(formatLocations(normalizeLocations(result), "definitions"));
            }
            case "type_definition": {
              const result = await doc.client.textDocumentTypeDefinition(doc.uri, pos);
              return ok(formatLocations(normalizeLocations(result), "type definitions"));
            }
            case "implementation": {
              const result = await doc.client.textDocumentImplementation(doc.uri, pos);
              return ok(formatLocations(normalizeLocations(result), "implementations"));
            }
            case "references": {
              const result = await doc.client.textDocumentReferences(doc.uri, pos);
              return ok(formatLocations(result, "references"));
            }
            case "code_actions": {
              const diags = doc.client.getDiagnostics(doc.uri);
              const lineDiags = diags.filter((d) => d.range.start.line === pos.line);
              const context = { diagnostics: lineDiags, only: params.query ? [params.query] : undefined };
              const actions = await doc.client.textDocumentCodeAction(doc.uri, { start: pos, end: pos }, context);
              if (!actions || actions.length === 0) return ok("No code actions available at this position.");
              const lines: string[] = [];
              for (let i = 0; i < actions.length; i++) {
                const a = actions[i]!;
                const kind = a.kind ? ` (${a.kind})` : "";
                const preferred = a.isPreferred ? " [preferred]" : "";
                lines.push(`  ${i + 1}. ${a.title}${kind}${preferred}`);
              }
              return ok(`Code actions (${actions.length}):\n${lines.join("\n")}\n\nThis lsp tool is read-only: apply=true is blocked by policy. Apply the fix manually with edit/write tools.`);
            }
            default:
              return fail(`Unknown action: ${action}`);
          }
        } catch (err) {
          const msg = err instanceof LspError ? err.message : err instanceof Error ? err.message : String(err);
          return fail(`LSP ${action} failed: ${msg}`, { serverName: doc.client.serverName, action, success: false });
        }
      },
    }),
  );

  // ── Write/Edit writethrough: optional formatOnWrite + diagnosticsOnWrite ─

  const CODE_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
    ".py", ".pyi", ".rs", ".go", ".java", ".kt", ".kts", ".scala",
    ".hs", ".lhs", ".ml", ".mli", ".ex", ".exs", ".rb", ".php",
    ".cs", ".lua", ".nix", ".zig", ".sh", ".bash", ".yaml", ".yml",
    ".json", ".jsonc", ".toml", ".css", ".scss", ".html", ".vue",
    ".svelte", ".astro", ".swift", ".dart", ".graphql", ".prisma",
    ".sql", ".tf", ".c", ".cpp", ".h", ".hpp",
  ]);
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "lsp") return;
    if (isLspReadonlyToolCall(event.input)) return;
    if (!isLspWriteOrHighRiskToolCall(event.input)) return;
    return {
      block: true,
      reason:
        "This lsp action can mutate files or language-server state. " +
        "Use explicit edit/write tools for file changes until LSP write actions are split into a separate permission tier.",
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    // Failed writes must not trigger format-on-write (it would rewrite the
    // stale on-disk content) or produce diagnostics for content that was
    // never written.
    if (event.isError) return;

    const input = event.input;
    const filePath = typeof input === "object" && input !== null && "path" in input
      ? String((input as Record<string, unknown>)["path"])
      : undefined;
    if (!filePath) return;

    const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
    if (!CODE_EXTENSIONS.has(ext)) return;

    // Upstream emitToolResult only applies the handler's RETURN value (it
    // shallow-copies the event before invoking handlers), so appends must be
    // returned, never applied in place.
    const additions: Array<{ type: "text"; text: string }> = [];

    try {
      const doc = await syncDocumentWithInstall(ctx.cwd, filePath, ctx);
      if (!doc) return;
      const { client, uri } = doc;
      const absFilePath = resolveSessionFilePath(ctx.cwd, filePath);

      if (state.config?.formatOnWrite === true && allowLspFormatOnWrite()) {
        try {
          const formatOpts = resolveFormattingOptions(absFilePath);
          const edits = await client.textDocumentFormatting(uri, formatOpts);
          if (edits && edits.length > 0) {
            const currentContent = readFileSync(absFilePath, "utf8");
            const formatted = applyTextEditsToString(currentContent, edits);
            if (formatted !== currentContent) {
              writeFileSync(absFilePath, formatted, "utf8");
              await syncDocumentWithInstall(ctx.cwd, filePath, ctx);
            }
          }
        } catch {
          additions.push({ type: "text", text: "\n[LSP] formatOnWrite failed; diagnostics still ran." });
        }
      } else if (state.config?.formatOnWrite === true) {
        additions.push({
          type: "text",
          text: "\n[LSP] formatOnWrite configured but skipped; set PICO_ALLOW_LSP_FORMAT_ON_WRITE=1 to allow automatic file rewrites.",
        });
      }

      client.didSave(uri);

      // Deferred diagnostics: 500ms inline, then a bounded background wait.
      // The 5s cap keeps the turn responsive while still catching slow servers.
      const diags = await client.waitForDiagnostics(uri, 500);
      let finalDiags = diags;
      if (!finalDiags || finalDiags.length === 0) {
        const deferredSignal = AbortSignal.timeout(5_000);
        finalDiags = await client.waitForDiagnostics(uri, 5_000, deferredSignal);
      }

      const diagText = formatDiagnosticsForFile(filePath, finalDiags ?? []);
      const messages = diagText.split("\n").filter(Boolean);
      // Key the ledger by the resolved path: the model may pass the same
      // file as relative or absolute across writes, and a mismatched key
      // would re-report every diagnostic.
      const freshMessages = ledger.reduce(absFilePath, messages);
      if (freshMessages.length > 0) {
        additions.push({ type: "text", text: `\n[LSP] ${freshMessages.join("\n")}` });
      }
    } catch {
      // Silently ignore writethrough failures
    }

    if (additions.length === 0) return;
    return { content: [...event.content, ...additions] };
  });

  // ── Startup warmup ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ledger.clear();
    try {
      const client = await ensureServerWithInstall(ctx.cwd, ctx);
      if (client) {
        ctx.ui.setStatus("lsp", `LSP: ${client.serverName} ${client.displayVersion}`.trim());
      }
    } catch {}
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("lsp", undefined);
    await stopServer(state);
  });
};

export default lspExtension;
