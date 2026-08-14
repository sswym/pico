/**
 * pico LSP extension — unified `lsp` tool.
 *
 * One tool with an `action` parameter that routes to language server operations:
 *   hover, definition, type_definition, implementation, references,
 *   diagnostics, symbols, code_actions, rename, capabilities, status, reload, request
 *
 * Lazy server startup on first call. Graceful degradation when no server available.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { renderToolCallText, renderToolResultText } from "../tool-render.ts";
import { positionToLsp, LspError, COMMAND_NOT_FOUND, type LspClient } from "./client.ts";
import type { Diagnostic, WorkspaceSymbol } from "./types.ts";
import {
  createLspManager,
  ensureServer,
  syncDocumentForFile,
  stopServer,
  formatHoverResult,
  formatLocations,
  formatDiagnosticsForFile,
  getInitFailures,
} from "./manager.ts";
import type { LspManagerState } from "./manager.ts";
import { resolveFormattingOptions } from "./format-options.ts";
import { getInstallHint, installServer, formatInstallHint } from "./install.ts";
import { applyTextEditsToString } from "./edits.ts";
import { DiagnosticsLedger } from "./diagnostics-ledger.ts";
import { allowLspFormatOnWrite, allowProjectLsp } from "../policy.ts";
import { publishExtensionEvent } from "../events.ts";
import { sanitizeTerminalText } from "../ui/rendering.ts";
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
  timeout: Type.Optional(Type.Integer({ description: "Request timeout in seconds (1-300, default 30). Slow cold-start requests may need a larger value." })),
});

// ── Extension factory ─────────────────────────────────────────────────────

// A missing server binary is warned/prompted once per command per process.
// Module-level (not closure) on purpose: upstream can re-run inline extension
// factories on startup reloads, and a closure set would start empty again —
// duplicating the warning. Startup warmup + every write of a matching file
// would otherwise re-fire the notification (and re-ask the install dialog
// after a decline).
const warnedMissingCommands = new Set<string>();
/** Commands the user explicitly declined to install this session — later
 *  LSP calls must explain WHY nothing starts, instead of a bare
 *  "No language server available" (2.5.11). */
const declinedMissingCommands = new Set<string>();
/** Commands observed missing on PATH this process — feeds the root-cause
 *  detail appended to "Cannot open file" errors. */
const missingCommands = new Set<string>();

function shouldWarnAboutMissingCommand(command: string): boolean {
  if (warnedMissingCommands.has(command)) return false;
  warnedMissingCommands.add(command);
  return true;
}

/** Root-cause detail for syncDocument failures: which server(s) failed and
 *  why, so the model stops guessing and can pick a fallback (read/grep/tsc). */
function describeServerStartFailures(state: LspManagerState, filePath: string): string {
  const parts: string[] = [];
  if (missingCommands.size > 0) {
    parts.push(`command(s) not found on PATH: ${[...missingCommands].sort().join(", ")}`);
  }
  for (const [name, failure] of state.runtime.initFailures) {
    parts.push(`${name}: ${failure.message}`);
  }
  if (parts.length === 0) {
    const ext = extname(filePath);
    return (
      ` — no language server started for "${ext || filePath}": no configured server matched this project's ` +
      "root markers (package.json/tsconfig.json etc.). Create the marker file and retry, or verify with read/grep/tsc directly."
    );
  }
  return ` — no language server started: ${parts.join("; ")}`;
}

/**
 * Slow-server tracking for deferred diagnostic waits.
 *
 * The writethrough path waits per file: 500ms inline, then a 5s deferred
 * catch-up window. With a slow (or stalled) language server, a turn that
 * writes N files pays N × ~5.5s serially — upstream dispatches tool_result
 * events one at a time, so the windows cannot overlap.
 *
 * When a full 5s deferred window elapses without ANY publish, the server is
 * almost certainly not going to answer faster for the next file. We record
 * that and give subsequent files on the SAME server a short 1s window
 * instead of another full 5s. The fallback is identical either way — the
 * caller already resolves `null` to the cached diagnostics — so the only
 * change is how long we wait before taking it. Reset on session_start so a
 * restarted server starts fresh.
 */

/** A server that burned a full deferred window is "slow" for this long. */
const SLOW_SERVER_WINDOW_MS = 30_000;
/** Deferred budget for a known-slow server (vs the normal 5s). */
const SLOW_SERVER_DEFERRED_MS = 1_000;

const slowServerTimeouts = new Map<string, number>();

/** Test-only: clear slow-server state between tests. */
export function __resetSlowServerTrackingForTests(): void {
  slowServerTimeouts.clear();
}

/** Reset slow-server state on session start. */
export function resetSlowServerTracking(): void {
  slowServerTimeouts.clear();
}

/**
 * Wait for post-save diagnostics: a short inline window, then a bounded
 * deferred window only when the inline window produced nothing (timed out).
 *
 * An explicit empty publish (`[]`) means the server responded — the turn must
 * not stall for a second publish that will never come. `null` means the
 * inline window elapsed without any publish (slow server), which is the only
 * case worth the deferred wait. Once a full deferred window burns with no
 * publish, the server is marked slow and subsequent files get a short
 * deferred budget instead — the null fallback (cached diagnostics) is
 * identical either way.
 */
export async function waitForFreshDiagnostics(
  client: Pick<LspClient, "waitForDiagnostics" | "serverName">,
  uri: string,
  inlineMs = 500,
  deferredMs = 5_000,
): Promise<Diagnostic[] | null> {
  const diags = await client.waitForDiagnostics(uri, inlineMs);
  if (diags !== null) return diags;

  const serverKey = client.serverName ?? "";
  const lastFullTimeout = slowServerTimeouts.get(serverKey) ?? 0;
  const knownSlow = Date.now() - lastFullTimeout < SLOW_SERVER_WINDOW_MS;
  const budget = knownSlow ? SLOW_SERVER_DEFERRED_MS : deferredMs;

  const deferredSignal = AbortSignal.timeout(budget);
  const result = await client.waitForDiagnostics(uri, budget, deferredSignal);
  if (result === null && !knownSlow) {
    // Burned the full window with no publish — remember it for the next file.
    slowServerTimeouts.set(serverKey, Date.now());
  }
  return result;
}

export const lspExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const state: LspManagerState = createLspManager();
  const ledger = new DiagnosticsLedger();

  /**
   * Try to start an LSP server. If the binary is missing (ENOENT),
   * prompt the user to auto-install and retry once.
   *
   * `quietMissingCommand` suppresses the missing-command warning/install
   * dialog entirely — used for the startup warmup, which must not nag while
   * the user has not asked for LSP yet (and which upstream's early UI frame
   * would render twice). Real tool/write paths stay loud.
   */
  async function withMissingServerInstall<T>(
    ctx: ExtensionContext,
    start: () => Promise<T | null>,
    opts?: { quietMissingCommand?: boolean },
  ): Promise<T | null> {
    try {
      return await start();
    } catch (err) {
      if (!(err instanceof LspError) || err.errorCode !== COMMAND_NOT_FOUND) throw err;
      const fullCmd = err.message.match(/"(.+?)"/)?.[1];
      const cmd = fullCmd ? basename(fullCmd) : null;
      const warnKey = cmd ?? fullCmd ?? "unknown";
      missingCommands.add(warnKey);
      if (declinedMissingCommands.has(warnKey)) {
        // The user already refused the install — re-explain instead of
        // nagging again (2.5.11): a bare "no server available" reads as a
        // broken tool, not as a consequence of the earlier decline.
        ctx.ui.notify(
          `LSP server "${warnKey}" was declined earlier and is not installed — no language server is running. Run /doctor or retry this action to install it.`,
          "warning",
        );
        return null;
      }
      if (!shouldWarnAboutMissingCommand(warnKey)) return null;
      const hint = cmd ? getInstallHint(cmd) : null;
      if (!hint) {
        if (!opts?.quietMissingCommand) {
          ctx.ui.notify(formatInstallHint(fullCmd ?? "unknown"), "warning");
        }
        return null;
      }
      if (opts?.quietMissingCommand) return null;
      if (!ctx.hasUI) {
        // Non-interactive runs cannot answer the install dialog — explain
        // once on stderr instead of silently degrading every lsp call to a
        // reasonless "Cannot open file" (observed as a multi-minute agent
        // death spiral in -p mode).
        const hintText = hint ? `Install with: ${hint.command}. ` : "";
        try {
          process.stderr.write(
            `[pico] LSP server "${warnKey}" not found on PATH. ${hintText}LSP actions will fail until it is installed.\n`,
          );
        } catch {}
        declinedMissingCommands.add(warnKey);
        return null;
      }
      const doInstall = await ctx.ui.confirm(
        `Install LSP server "${cmd}"?`,
        `Command "${cmd}" not found. Install with:\n  ${hint.command}\n\nProceed?`,
      );
      if (!doInstall) {
        declinedMissingCommands.add(warnKey);
        return null;
      }
      const result = await installServer(cmd!);
      if (!result.ok) {
        ctx.ui.notify(`Installation failed:\n${sanitizeTerminalText(result.output)}`, "error");
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
    opts?: { quietMissingCommand?: boolean },
  ) {
    return await withMissingServerInstall(ctx, () => ensureServer(state, workspaceRoot), opts);
  }

  /** Push the current init-failure snapshot so /doctor can surface it. */
  function publishLspStatus(): void {
    publishExtensionEvent("lsp_status", { failures: getInitFailures(state) });
  }

  async function syncDocumentWithInstall(
    workspaceRoot: string,
    filePath: string,
    ctx: ExtensionContext,
  ) {
    return await withMissingServerInstall(ctx, () => syncDocumentForFile(state, workspaceRoot, filePath));
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
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const action = params.action as Action;
        if (!ACTIONS.includes(action)) {
          return fail(`Unknown action: ${action}. Valid: ${ACTIONS.join(", ")}`);
        }
        if (isLspWriteOrHighRiskInput(params)) {
          return fail(
            "This lsp tool is read-only. Use explicit edit/write tools for file changes until LSP write actions have a separate permission tier.",
            { action, success: false },
            undefined,
            "blocked",
          );
        }

        // ── Actions that don't need a running server ────────────────────
        if (action === "status") {
          publishLspStatus();
          return executeStatusAction(state, ctx.cwd);
        }

        const timeoutMs = params.timeout !== undefined
          ? Math.min(Math.max(params.timeout, 1), 300) * 1000
          : undefined;

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

        if (action === "reload") {
          const client = await getProjectClient();
          if (!client) return fail("No language server available for this project.");
          const oldName = client.serverName;
          // Restart the server(s) for this project: config/settings changes
          // take effect on the next initialize. Does not touch the filesystem.
          await stopServer(state);
          const restarted = await ensureServerWithInstall(ctx.cwd, ctx);
          if (!restarted) return fail("Reload failed: could not restart a language server for this project.");
          ctx.ui.setStatus("lsp", `LSP: ${restarted.serverName} ${restarted.displayVersion}`.trim());
          return ok(
            `Reloaded ${oldName} → ${restarted.serverName} ${restarted.displayVersion}`.trim(),
            { serverName: restarted.serverName, action: "reload", success: true },
          );
        }

        // ── File-level actions ──────────────────────────────────────────
        if (action === "diagnostics") {
          if (!params.file || params.file === "*") {
            const client = await getProjectClient();
            if (!client) return fail("No language server available for this project.");
            return executeWorkspaceDiagnosticsAction(state);
          }
          const doc = await syncDocumentWithInstall(ctx.cwd, params.file, ctx);
          if (!doc) return fail(`Cannot open file: ${params.file}${describeServerStartFailures(state, params.file)}`);
          ctx.ui.setStatus("lsp", `LSP: ${doc.serverName}`.trim());
          try {
            // Pull-model servers (LSP 3.17, diagnosticProvider) answer a
            // snapshot request; push-model servers publish after didSave.
            // Prefer the pull when advertised, fall back to the push wait.
            let diags: Diagnostic[] | null = null;
            if (doc.client.supportsDocumentDiagnostics) {
              try {
                diags = await doc.client.requestDiagnostic(doc.uri, signal);
              } catch {
                // -32601 / timeout: server doesn't actually support pulls —
                // fall through to the push-based wait.
              }
            }
            if (diags === null) {
              // 2.5.11: a fixed 500ms sleep returned stale/empty diagnostics on
              // slow servers — wait for the server's own publish instead
              // (inline window, then a bounded deferred catch-up).
              const fresh = await waitForFreshDiagnostics(doc.client, doc.uri, 500, 5_000);
              // An unchanged (already-synced) file makes the server never
              // re-publish, so both windows time out — fall back to the cached
              // diagnostics instead of reporting a false "no diagnostics".
              diags = fresh ?? doc.client.getDiagnostics(doc.uri);
            }
            return ok(formatDiagnosticsForFile(params.file, diags));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return fail(`LSP diagnostics failed: ${msg}`, undefined, err);
          }
        }

        if (action === "symbols") {
          if (!params.file && params.query) {
            const client = await getProjectClient();
            if (!client) return fail("No language server available for this project.");

            const tryWorkspaceSymbol = async (): Promise<WorkspaceSymbol[] | null> => {
              for (let attempt = 0; attempt < 2; attempt++) {
                try {
                  return await client.workspaceSymbol(params.query!, signal, timeoutMs);
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
              return fail(`Workspace symbol search failed: ${msg}`, undefined, err);
            }
          }
          if (!params.file) return fail("Provide a file path for document symbols, or a query for workspace search.");
          const doc = await syncDocumentWithInstall(ctx.cwd, params.file, ctx);
          if (!doc) return fail(`Cannot open file: ${params.file}${describeServerStartFailures(state, params.file)}`);
          ctx.ui.setStatus("lsp", `LSP: ${doc.serverName}`.trim());
          try {
            const result = await doc.client.textDocumentDocumentSymbol(doc.uri, signal, timeoutMs);
            return formatDocumentSymbolsResult(params.file, result);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return fail(`LSP symbols failed: ${msg}`, undefined, err);
          }
        }

        // ── Position-based actions ──────────────────────────────────────
        if (!params.file) return fail(`${action} requires 'file' parameter.`);
        if (typeof params.line !== "number" || !Number.isInteger(params.line) || params.line < 1) {
          // `!params.line` would pass negative values (truthy) and reject 0
          // with a misleading message — validate the real contract instead.
          return fail(`${action} requires a positive integer 'line' parameter (got ${JSON.stringify(params.line)}).`);
        }

        let character: number | undefined = params.character;
        if (character !== undefined && (typeof character !== "number" || !Number.isInteger(character) || character < 0)) {
          return fail(`${action} requires a non-negative integer 'character' parameter (got ${JSON.stringify(character)}).`);
        }
        if (character === undefined && params.symbol) {
          const absPath = params.file.startsWith("/") ? params.file : `${ctx.cwd}/${params.file}`;
          character = resolveSymbolColumn(absPath, params.line, params.symbol, params.occurrence ?? 1);
          if (character === undefined) {
            return fail(`Symbol "${params.symbol}" not found on line ${params.line} of ${params.file}`);
          }
        }
        if (character === undefined) return fail(`${action} requires 'character' parameter (or 'symbol' for auto-resolve).`);

        const doc = await syncDocumentWithInstall(ctx.cwd, params.file, ctx);
        if (!doc) return fail(`Cannot open file: ${params.file}${describeServerStartFailures(state, params.file)}`);
        ctx.ui.setStatus("lsp", `LSP: ${doc.serverName}`.trim());
        const pos = positionToLsp(params.line, character);

        try {
          switch (action) {
            case "hover": {
              const hover = await doc.client.textDocumentHover(doc.uri, pos, signal, timeoutMs);
              return ok(formatHoverResult(hover));
            }
            case "definition": {
              const result = await doc.client.textDocumentDefinition(doc.uri, pos, signal, timeoutMs);
              return ok(formatLocations(normalizeLocations(result), "definitions"));
            }
            case "type_definition": {
              const result = await doc.client.textDocumentTypeDefinition(doc.uri, pos, signal, timeoutMs);
              return ok(formatLocations(normalizeLocations(result), "type definitions"));
            }
            case "implementation": {
              const result = await doc.client.textDocumentImplementation(doc.uri, pos, signal, timeoutMs);
              return ok(formatLocations(normalizeLocations(result), "implementations"));
            }
            case "references": {
              const result = await doc.client.textDocumentReferences(doc.uri, pos, signal, timeoutMs);
              return ok(formatLocations(result, "references"));
            }
            case "code_actions": {
              const diags = doc.client.getDiagnostics(doc.uri);
              const lineDiags = diags.filter((d) => d.range.start.line === pos.line);
              const context = { diagnostics: lineDiags, only: params.query ? [params.query] : undefined };
              const actions = await doc.client.textDocumentCodeAction(doc.uri, { start: pos, end: pos }, context, signal, timeoutMs);
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
          return fail(`LSP ${action} failed: ${msg}`, { serverName: doc.client.serverName, action, success: false }, err);
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
          // Snapshot the on-disk state BEFORE the server round-trip: the
          // formatting edits are computed against the server's document view,
          // so a file changed on disk meanwhile must not be clobbered.
          const snapshot = statSync(absFilePath, { throwIfNoEntry: false });
          const formatOpts = resolveFormattingOptions(absFilePath);
          const edits = await client.textDocumentFormatting(uri, formatOpts);
          if (edits && edits.length > 0) {
            const raw = readFileSync(absFilePath);
            const currentContent = raw.toString("utf8");
            // Non-UTF-8 files (GBK/Latin-1 legacy) read as utf8 silently
            // replace invalid bytes with U+FFFD — formatting those and
            // writing the result back would permanently corrupt the file.
            if (!Buffer.from(currentContent, "utf8").equals(raw)) {
              additions.push({
                type: "text",
                text: "\n[LSP] formatOnWrite skipped: file is not valid UTF-8 (a rewrite would corrupt non-ASCII content).",
              });
            } else {
              const formatted = applyTextEditsToString(currentContent, edits);
              if (formatted !== currentContent) {
                const now = statSync(absFilePath, { throwIfNoEntry: false });
                if (snapshot && now && now.mtimeMs !== snapshot.mtimeMs) {
                  additions.push({
                    type: "text",
                    text: "\n[LSP] file changed on disk during formatting; rewrite skipped to avoid clobbering external edits.",
                  });
                } else {
                  writeFileSync(absFilePath, formatted, "utf8");
                  await syncDocumentWithInstall(ctx.cwd, filePath, ctx);
                }
              }
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
      // Files changed on disk by write/edit: notify servers that cache
      // filesystem state (tsconfig/Cargo.toml watchers) so they re-index.
      client.didChangeWatchedFiles(uri, 2);

      // Deferred diagnostics: a short inline window, then a bounded catch-up
      // window ONLY when the inline window elapsed without a publish (null).
      // A fast publish of [] means the server already answered — waiting
      // another 5s for nothing would stall every clean write ~5.5s.
      const finalDiags = await waitForFreshDiagnostics(client, uri);
      // A server that stays silent after didSave must not degrade to a false
      // "no diagnostics" — fall back to the last published set (pre-save
      // state, still the best available signal) instead of reporting an
      // empty result.
      const diags = finalDiags ?? client.getDiagnostics(uri);
      const diagText = formatDiagnosticsForFile(filePath, diags);
      const messages = diagText.split("\n").filter(Boolean);
      // Key the ledger by the resolved path: the model may pass the same
      // file as relative or absolute across writes, and a mismatched key
      // would re-report every diagnostic.
      const freshMessages = ledger.reduce(absFilePath, messages);
      if (freshMessages.length > 0) {
        additions.push({ type: "text", text: `\n[LSP] ${freshMessages.join("\n")}` });
      }
    } catch (err) {
      // 2.5.2: a crashed/disconnected server must not turn write-through into
      // total silence — the user just wrote a file and the model believes it
      // was verified. Say so, visibly.
      const reason = err instanceof Error ? err.message : String(err);
      additions.push({
        type: "text",
        text: `\n[LSP] server unavailable; diagnostics skipped for this write${reason && !reason.includes("Server not running") ? ` (${reason})` : ""}. The file was written without LSP verification.`,
      });
    }

    if (additions.length === 0) return;
    return { content: [...event.content, ...additions] };
  });

  // ── Startup warmup ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ledger.clear();
    // A new session may start a fresh server — clear the slow-server marker
    // so a restarted process gets full deferred windows again.
    resetSlowServerTracking();
    // A project LSP config that is silently ignored looks like a broken
    // tool — tell the user the safety switch is off and how to enable it
    // (mirrors the project MCP pattern).
    try {
      const projectPath = join(ctx.cwd ?? "", ".pico", "lsp.json");
      if (existsSync(projectPath) && !allowProjectLsp()) {
        ctx.ui.notify(
          "检测到项目 LSP 配置（.pico/lsp.json），但当前被安全策略禁用。运行 /doctor 查看如何开启（PICO_ENABLE_PROJECT_LSP）。",
          "warning",
        );
      }
    } catch {
      // best-effort hint
    }
    try {
      // Startup warmup is quiet: no missing-command nagging (and no
      // double-rendered early-frame warning) until the user actually
      // triggers LSP or writes a matching file.
      const client = await ensureServerWithInstall(ctx.cwd, ctx, { quietMissingCommand: true });
      if (client) {
        ctx.ui.setStatus("lsp", `LSP: ${client.serverName} ${client.displayVersion}`.trim());
      }
    } catch (err) {
      // COMMAND_NOT_FOUND is already handled quietly by
      // withMissingServerInstall; anything else must not vanish silently.
      if (!(err instanceof LspError) || err.errorCode !== COMMAND_NOT_FOUND) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[lsp] startup warmup failed: ${msg}`);
      }
    } finally {
      // Surfacing failures (e.g. "typescript-language-server init failed")
      // on the /doctor panel — the stderr line alone was easy to miss.
      publishLspStatus();
    }
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  // A session switch/fork must not carry the old project's server processes
  // (and their open documents) into the new session — they would serve stale
  // cwd state and leak until shutdown.
  pi.on("session_before_switch", async (_event, ctx) => {
    ctx.ui.setStatus("lsp", undefined);
    await stopServer(state);
    return {};
  });
  pi.on("session_before_fork", async (_event, ctx) => {
    ctx.ui.setStatus("lsp", undefined);
    await stopServer(state);
    return {};
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("lsp", undefined);
    await stopServer(state);
  });
};

export default lspExtension;
