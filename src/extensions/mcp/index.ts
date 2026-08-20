/**
 * pico MCP extension.
 *
 * Discovers MCP servers from config files and registers their tools as
 * LLM-callable tools with pi's extension system.
 *
 * Tool naming: mcp__<server>__<toolName>
 *   — compatible with the mcp__ prefix matching.
 *
 * Lifecycle:
 *   1. Extension init (async): read config, spawn servers, initialize, list
 *      tools, register each tool via pi.registerTool().
 *   2. Tool execute: forward arguments to the MCP server via tools/call.
 *   3. Session shutdown: close all MCP server processes.
 *
 * Slash command: /mcp — list connected servers and their tools.
 *
 * Config sources (JSON, Claude Code compatible):
 *   settings.json `mcpServers` key — home-wide (legacy ~/.pico/mcp-servers.json
 *       auto-migrated by `pico setup`; readers fall back while un-migrated)
 *   <cwd>/.pico/mcp-servers.json   — project-specific (overrides home)
 *
 * Format:
 *   { "mcpServers": { "name": { "command": "npx", "args": [...], "env": {} } } }
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { renderToolCallText, renderToolResultText } from "../tool-render.ts";
import { loadMcpConfig, loadInvalidMcpServers } from "./config.ts";
import { allowProjectMcp } from "../policy.ts";
import {
  spawnMcpServer,
  mcpInitialize,
  mcpListTools,
  mcpCallTool,
  closeMcpServer,
} from "./client.ts";
import type { McpServerConfig, McpServerHandle, McpTool, McpToolCallResult, McpInitializeResult } from "./types.ts";

interface ServerStatus {
  id: string;
  serverName: string;
  serverVersion: string;
  toolCount: number;
  toolNames: string[];
  handle: McpServerHandle;
  error?: undefined;
}

interface ServerFailure {
  id: string;
  error: string;
  handle?: undefined;
}

type ServerEntry = ServerStatus | ServerFailure;
const MCP_STATUS_KEY = "mcp";

export interface McpExtensionDeps {
  load: (cwd: string) => Record<string, McpServerConfig>;
  /** Optional: config-level validation failures for `cwd` — malformed entries
   *  that `load` silently skips (non-string command, bad args/env, ...).
   *  Surfaced as FAILED entries in /mcp instead of vanishing (P5). */
  loadInvalid?: (cwd: string) => Array<{ id: string; error: string }>;
  spawn: (id: string, config: McpServerConfig) => McpServerHandle;
  initialize: (handle: McpServerHandle) => Promise<McpInitializeResult>;
  listTools: (handle: McpServerHandle) => Promise<McpTool[]>;
  callTool: (handle: McpServerHandle, toolName: string, params: Record<string, unknown>) => Promise<McpToolCallResult>;
  close: (handle: McpServerHandle) => void;
  /** Optional: reconnect timing overrides (tests inject a fake clock). */
  reconnect?: {
    now?: () => number;
  };
}

function connectedEntries(entries: ServerEntry[]): ServerStatus[] {
  return entries.filter((entry): entry is ServerStatus => !entry.error);
}

function failedEntries(entries: ServerEntry[]): ServerFailure[] {
  return entries.filter((entry): entry is ServerFailure => !!entry.error);
}

export function formatMcpStatus(entries: ServerEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const connected = connectedEntries(entries).length;
  const failed = failedEntries(entries).length;
  if (failed > 0) return `MCP: ${connected} ok, ${failed} failed`;
  return `MCP: ${connected} connected`;
}

export function formatMcpReport(entries: ServerEntry[]): { text: string; level: "info" | "warning" } {
  const connected = connectedEntries(entries);
  const failed = failedEntries(entries);

  if (entries.length === 0) {
    return { text: "No MCP servers configured.", level: "info" };
  }

  const lines: string[] = [];
  lines.push(`MCP Servers (${connected.length} connected, ${failed.length} failed):\n`);

  for (const entry of entries) {
    if (!("serverName" in entry)) {
      lines.push(`  ! ${entry.id} - FAILED: ${entry.error}`);
    } else {
      lines.push(`  * ${entry.id} (${entry.serverName} ${entry.serverVersion}) - ${entry.toolCount} tools`);
      for (const name of entry.toolNames) {
        lines.push(`      ${name}`);
      }
      const diagnostics = entry.handle.diagnostics ?? [];
      if (diagnostics.length > 0) {
        lines.push("      diagnostics:");
        for (const line of diagnostics.slice(-5)) {
          lines.push(`        ${line}`);
        }
      }
    }
  }

  return { text: lines.join("\n"), level: failed.length > 0 ? "warning" : "info" };
}

    function updateMcpStatus(ctx: unknown, entries: ServerEntry[]): void {
      const ui = (ctx as { ui?: { setStatus?: (key: string, value: string | undefined) => void } }).ui;
      ui?.setStatus?.(MCP_STATUS_KEY, formatMcpStatus(entries));
    }

interface ActiveTool {
  handle: McpServerHandle | null;
  toolName: string;
}

/** Sanitize a server id for use inside a tool name (2.5.7): ids containing
 *  `__` or spaces would make `mcp__<id>__<tool>` ambiguous. */
function toolNameFor(serverId: string, toolName: string): string {
  const safeId = serverId.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return `mcp__${safeId}__${toolName}`;
}

export function createMcpExtension(deps: McpExtensionDeps): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const entries: ServerEntry[] = [];
    const activeTools = new Map<string, ActiveTool>();
    /**
     * Per-tool mutable holder of the CURRENT active handle. pi has no tool
     * unregistration API, so a tool is registered once per process and its
     * execute closure must read the holder on every call — reconnects then
     * just swap the holder's ref instead of leaving the old closure pointing
     * at a closed handle (which made every MCP tool fail after the first
     * session switch).
     */
    const toolRefHolders = new Map<string, { ref: ActiveTool | null }>();
    /** Tool names registered this process — reconnect must not re-register. */
    const registeredTools = new Set<string>();
    let connectedCwd: string | null = null;
    /** Servers connected successfully for the current cwd. */
    const connectedServerIds = new Set<string>();
    /** Servers that failed this connect pass; retried on the next session_start. */
    const failedServerIds = new Set<string>();
    /** Bumped per connect; stale generations close their own handles and stop. */
    let connectGeneration = 0;

    /**
     * Reconnect state machine (2.5.7). Per-server exponential backoff so a
     * crashing server is not cold-restarted on every call. The state survives
     * a SUCCESSFUL reconnect — only the backoff ladder resets — so a server
     * that dies again inside the current window actually waits ("retry in
     * Ns") instead of being re-spawned immediately; resetting nextAttemptAt
     * on success made that branch unreachable dead code.
     */
    const reconnectState = new Map<string, { nextAttemptAt: number; backoffMs: number }>();
    /** Single-flight reconnect attempts: parallel callers of the same dead
     *  handle share one reconnect result instead of racing each other. */
    const reconnectInFlight = new Map<string, Promise<void>>();
    /** Handles whose process has exited — detected for auto-reconnect (2.5.7). */
    const deadHandles = new WeakSet<McpServerHandle>();
    const initialBackoffMs = 5_000;
    const maxBackoffMs = 60_000;
    const nowMs = deps.reconnect?.now ?? Date.now;

    /** Mark a handle dead once its process exits. */
    function watchHandleDeath(handle: McpServerHandle): void {
      handle.proc.exited
        .then(() => deadHandles.add(handle))
        .catch(() => deadHandles.add(handle));
    }

    function isHandleDead(handle: McpServerHandle): boolean {
      return deadHandles.has(handle);
    }

    /** Observable backoff-wait error: the server is unavailable and the next
     *  reconnect attempt is scheduled — the caller must wait, not retry now. */
    function reconnectRetryError(id: string, state: { nextAttemptAt: number }): Error {
      const wait = Math.max(1, Math.ceil((state.nextAttemptAt - nowMs()) / 1000));
      return new Error(
        `MCP server "${id}" is unavailable (will retry in ${wait}s). ` +
        `Note: a timed-out MCP call does NOT cancel server-side execution — avoid blind retries of mutating calls.`,
      );
    }

  // ── Register /mcp command BEFORE async server connections ──────────────

    pi.registerCommand("mcp", {
      description: "List connected MCP servers and their tools",
      handler: async (_args, ctx) => {
        const report = formatMcpReport(entries);
        ctx.ui.notify(report.text, report.level);
      },
    });

  // ── Connect to MCP servers once the session cwd is known ────────────────

    async function connect(cwd: string): Promise<void> {
      const generation = ++connectGeneration;
      if (connectedCwd !== cwd) {
        // Invalidate every active tool ref so in-flight closures fail fast
        // instead of calling a server that is about to be closed. The
        // toolRefHolders get repointed to the new generation below.
        for (const ref of activeTools.values()) ref.handle = null;
        for (const entry of entries) {
          if (entry.handle) deps.close(entry.handle);
        }
        entries.length = 0;
        activeTools.clear();
        reconnectState.clear();
        reconnectInFlight.clear();
        connectedCwd = cwd;
        failedServerIds.clear();
        connectedServerIds.clear();
      }

      const servers = deps.load(cwd);

      // Config-level validation failures (non-string command, malformed args,
      // ...) are user-visible status: surface them as FAILED entries in /mcp
      // instead of silently dropping the server (P5).
      const invalid = deps.loadInvalid?.(cwd) ?? [];
      for (const { id, error } of invalid) {
        if (!entries.some((e) => e.id === id)) {
          entries.push({ id, error: `配置无效：${error}` });
        }
      }

      // Only servers not yet connected for this cwd are attempted; previously
      // failed ones are retried on every later session_start instead of being
      // given up silently for the rest of the session.
      const targets = Object.entries(servers).filter(
        ([id]) => !connectedServerIds.has(id),
      );
      if (targets.length === 0) {
        updateMcpStatus(lastCtx, entries);
        return;
      }

      // Connect servers in parallel: a slow/hung server must not delay the
      // healthy ones (previously serial, one 30s timeout per server).
      await Promise.allSettled(targets.map(async ([id, config]) => {
        let handle: McpServerHandle | undefined;
        const registeredThisServer: string[] = [];
        try {
          handle = deps.spawn(id, config);
          watchHandleDeath(handle);
          const initResult = await deps.initialize(handle);
          // A newer connect superseded this one mid-initialization: close
          // this process and stop publishing its tools (its entries/refs
          // were already cleared by the newer connect).
          if (generation !== connectGeneration) {
            deps.close(handle);
            return;
          }
          const tools = await deps.listTools(handle);
          if (generation !== connectGeneration) {
            deps.close(handle);
            return;
          }

          const { name: serverName, version: serverVersion } = initResult.serverInfo;

          const toolNames: string[] = [];
          for (const tool of tools) {
            const piToolName = toolNameFor(id, tool.name);
            toolNames.push(piToolName);
            const schema = tool.inputSchema ?? { type: "object" as const, properties: {} };
            const ref: ActiveTool = { handle, toolName: tool.name };
            activeTools.set(piToolName, ref);
            registeredThisServer.push(piToolName);

            let holder = toolRefHolders.get(piToolName);
            if (!holder) {
              holder = { ref };
              toolRefHolders.set(piToolName, holder);
            } else {
              holder.ref = ref;
            }

            // pi has no tool-unregistration API; registering the same name
            // twice would leave stale closures behind. Reconnects (cwd change)
            // reuse the first registration — its closure reads the holder,
            // so it picks up the new generation's handle automatically.
            if (registeredTools.has(piToolName)) continue;
            registeredTools.add(piToolName);

            pi.registerTool(
              defineTool({
                name: piToolName,
                label: `MCP: ${id} › ${tool.name}`,
                description: tool.description ?? `MCP tool "${tool.name}" from server "${id}"` +
                  " Note: if the call times out, the server may still be executing it server-side — a retry can duplicate side effects.",
                promptSnippet:
                  `${piToolName} — call "${tool.name}" on MCP server "${id}" (timeout does not cancel server-side execution)`,
                parameters: Type.Unsafe(schema),
                renderCall(args, theme, context) {
                  return renderToolCallText(piToolName, args, theme, context);
                },
                renderResult(result, options, theme, context) {
                  return renderToolResultText(result, options, theme, context);
                },
                async execute(_tcId, params, _signal) {
                  const current = holder!.ref;
                  const state = reconnectState.get(id);
                  const inFlight = reconnectInFlight.get(id);

                  // 2.5.7: a server that crashed mid-session must recover
                  // without a /reload — detect the dead process and reconnect
                  // (with backoff) instead of failing permanently. Parallel
                  // callers of the same dead handle share ONE reconnect
                  // attempt (single-flight) and all observe its outcome
                  // instead of racing and seeing a misleading "not active".
                  if (inFlight) {
                    // Another call is already reconnecting this server: wait
                    // for the shared attempt, then use its resulting handle.
                    await inFlight;
                  } else if (current?.handle && isHandleDead(current.handle)) {
                    if (state && nowMs() < state.nextAttemptAt) {
                      throw reconnectRetryError(id, state);
                    }
                    await reconnectServer(id);
                  } else if (!current?.handle && state) {
                    // A previous reconnect attempt failed and left no usable
                    // handle; keep retrying on the backoff schedule instead of
                    // giving up for the rest of the session (previously only
                    // /reload recovered it).
                    if (nowMs() < state.nextAttemptAt) {
                      throw reconnectRetryError(id, state);
                    }
                    await reconnectServer(id);
                  } else if (!current?.handle) {
                    // Throw so the failure is marked as an error upstream (a
                    // returned isError flag is dropped by the agent loop).
                    throw new Error(
                      `MCP tool "${tool.name}" is not active (server disconnected or reconnecting)`,
                    );
                  }
                  const currentAfterReconnect = holder!.ref;
                  if (!currentAfterReconnect || currentAfterReconnect.handle === null) {
                    const st = reconnectState.get(id);
                    if (st && nowMs() < st.nextAttemptAt) {
                      throw reconnectRetryError(id, st);
                    }
                    // Throw so the failure is marked as an error upstream (a
                    // returned isError flag is dropped by the agent loop).
                    throw new Error(
                      `MCP tool "${tool.name}" is not active (server disconnected or reconnecting)`,
                    );
                  }
                  try {
                    const result = await deps.callTool(currentAfterReconnect.handle, currentAfterReconnect.toolName, params as Record<string, unknown>);
                    // The agent loop derives isError ONLY from thrown errors —
                    // a returned isError field is dropped, so a server-side
                    // tool failure must throw to render as an error.
                    if (result.isError === true) {
                      const text = result.content
                        .filter((c) => c.type === "text")
                        .map((c) => c.text)
                        .join("\n")
                        .trim();
                      throw new Error(text || `MCP tool "${tool.name}" failed (server reported isError)`);
                    }
                    return {
                      content: result.content.map((c) => {
                        if (c.type === "text") return { type: "text" as const, text: c.text };
                        if (c.type === "image") {
                          return {
                            type: "text" as const,
                            text: `[Image: ${c.mimeType} (${c.data.length} bytes base64)]`,
                          };
                        }
                        return {
                          type: "text" as const,
                          text: c.type === "resource"
                            ? (c.resource.text ?? "[binary resource]")
                            : JSON.stringify(c),
                        };
                      }),
                      details: { server: id, tool: tool.name },
                    };
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    // Throw so the failure is marked as an error upstream (a
                    // returned isError flag is dropped by the agent loop).
                    throw new Error(`MCP tool "${tool.name}" failed: ${msg}`);
                  }
                },
              }),
            );
          }

          // Replace any prior entry for this server (a stale failure or an
          // invalid-config entry from an earlier pass) rather than
          // accumulating duplicates in /mcp.
          const prevIdx = entries.findIndex((entry) => entry.id === id);
          if (prevIdx !== -1) entries.splice(prevIdx, 1);
          entries.push({ id, serverName, serverVersion, toolCount: tools.length, toolNames, handle });
          connectedServerIds.add(id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (handle) deps.close(handle);
          // Roll back this server's own registrations so a half-connected
          // server leaves no dangling active tools behind.
          for (const name of registeredThisServer) {
            const ref = activeTools.get(name);
            if (ref) ref.handle = null;
            activeTools.delete(name);
            toolRefHolders.delete(name);
          }
          failedServerIds.add(id);
          // Replace any prior entry for this server (a stale failure from an
          // earlier attempt, or a dead-handle status removed by the reconnect
          // path) rather than accumulating duplicates in /mcp.
          const prevIdx = entries.findIndex((entry) => entry.id === id);
          if (prevIdx !== -1) entries.splice(prevIdx, 1);
          entries.push({ id, error: msg });
        }
      }));
      updateMcpStatus(lastCtx, entries);
    }

    let lastCtx: unknown;

    /**
     * Drop a dead server and reconnect it with exponential backoff (2.5.7).
     * The tool that triggered this is retried transparently by the caller.
     * Concurrent triggers for the same server share a single in-flight
     * attempt. After a SUCCESSFUL reconnect only the backoff ladder resets —
     * the current window stays in force, so a server that dies again inside
     * it is throttled ("retry in Ns") instead of being cold-restarted per
     * call. A FAILED reconnect keeps the (doubled) window and leaves the
     * holder nulled; the next call past the window retries automatically, so
     * a transient respawn failure self-heals without /reload.
     */
    async function reconnectServer(id: string): Promise<void> {
      const inFlight = reconnectInFlight.get(id);
      if (inFlight) return inFlight;

      const attempt = (async () => {
        const state = reconnectState.get(id) ?? { nextAttemptAt: 0, backoffMs: initialBackoffMs };
        state.nextAttemptAt = nowMs() + state.backoffMs;
        state.backoffMs = Math.min(state.backoffMs * 2, maxBackoffMs);
        reconnectState.set(id, state);

        const idx = entries.findIndex((e) => e.id === id);
        const entry = entries[idx];
        if (entry?.handle) {
          for (const ref of activeTools.values()) {
            if (ref.handle === entry.handle) ref.handle = null;
          }
          connectedServerIds.delete(id);
        }
        // Drop the previous entry (a dead-handle status or a stale failure)
        // so the next connect() publishes a fresh one for this server.
        if (idx !== -1) entries.splice(idx, 1);
        if (!connectedCwd) return;
        await connect(connectedCwd);
        if (connectedServerIds.has(id)) {
          state.backoffMs = initialBackoffMs;
        }
      })();

      reconnectInFlight.set(id, attempt);
      try {
        await attempt;
      } finally {
        reconnectInFlight.delete(id);
      }
    }

    pi.on("session_start", async (_event, ctx) => {
      lastCtx = ctx;
      // 2.2.3: a project MCP config that is silently ignored looks like a
      // broken tool — tell the user the safety switch is off and how to
      // enable it.
      try {
        const projectPath = join(ctx.cwd ?? "", ".pico", "mcp-servers.json");
        if (existsSync(projectPath) && !allowProjectMcp()) {
          ctx.ui.notify(
            "检测到项目 MCP 配置（.pico/mcp-servers.json），但当前被安全策略禁用。运行 /doctor 查看如何开启（PICO_ENABLE_PROJECT_MCP）。",
            "warning",
          );
        }
      } catch {
        // best-effort hint
      }
      await connect(ctx.cwd);
    });

  // Cleanup on shutdown
    pi.on("session_shutdown", () => {
      // Null every holder ref first: tools invoked between shutdown and the
      // next connect must fail fast ("not active") instead of writing to a
      // closed handle and hanging for the request timeout.
      for (const ref of activeTools.values()) ref.handle = null;
      for (const entry of entries) {
        if (entry.handle) deps.close(entry.handle);
      }
      entries.length = 0;
      activeTools.clear();
      connectedCwd = null;
      connectedServerIds.clear();
      failedServerIds.clear();
      reconnectState.clear();
      reconnectInFlight.clear();
      updateMcpStatus(lastCtx, entries);
      lastCtx = undefined;
    });
  };
}

export const mcpExtension: ExtensionFactory = createMcpExtension({
  load: loadMcpConfig,
  loadInvalid: loadInvalidMcpServers,
  spawn: spawnMcpServer,
  initialize: mcpInitialize,
  listTools: mcpListTools,
  callTool: mcpCallTool,
  close: closeMcpServer,
});

