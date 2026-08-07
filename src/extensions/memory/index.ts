/**
 * pico memory extension.
 *
 * Wires a long-term-memory store into pi-coding-agent:
 *   - registers a `memory` tool (LLM-callable)
 *   - registers a `/memory` slash command (user-callable)

 */
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionFactory,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Text } from "@earendil-works/pi-tui";
import {
  autoExtractFromMessages,
  isLikelyCorrection,
  extractText,
  type ExtractableMessage,
} from "./extract.ts";
import { formatRecallBlock, systemPromptBlock } from "./prompt.ts";
import { type MemoryProvider } from "./provider.ts";
import { clearSessionExtensionSubscriptions, subscribeSessionExtensionEvent } from "../events.ts";
import { MemoryStore } from "./store.ts";
import { CuratedMemoryStore } from "./curated-store.ts";
import { ProviderManager, sanitizeContext, buildMemoryContextBlock } from "./provider-manager.ts";
import { CATEGORY_LIST, CORRECTED_BOOST, SCOPE_PROJECT } from "./schema.ts";
import { executeMemoryToolAction, type MemoryToolParams } from "./tool.ts";
import { executeMemoryCommand } from "./command.ts";
import { renderToolCallText, renderToolResultText } from "../tool-render.ts";

/**
 * Render a memory tool result without the internal plumbing. The raw result
 * is a JSON dump of the fact store row(s) — tfidf vectors, source flags,
 * correction metadata — which is noise on screen. Strip the internal keys
 * (the model still receives the full payload) and pretty-print what is left.
 */
const MEMORY_RENDER_NOISE_KEYS = new Set(["tfidf_vector", "vector", "embedding", "correction_of", "source"]);

function stripMemoryRenderNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMemoryRenderNoise);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (MEMORY_RENDER_NOISE_KEYS.has(key)) continue;
      out[key] = stripMemoryRenderNoise(child);
    }
    return out;
  }
  return value;
}

export function renderMemoryResultText(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { lastComponent?: unknown; isError?: boolean },
): Text {  const output = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return renderToolResultText(result, options, theme, context);
  }
  const slim = {
    ...result,
    content: [{ type: "text" as const, text: JSON.stringify(stripMemoryRenderNoise(parsed), null, 2) }],
  };
  return renderToolResultText(slim, options, theme, context);
}

const MemoryParams = Type.Object({
  action: Type.Union([
    Type.Literal("add"),
    Type.Literal("search"),
    Type.Literal("probe"),
    Type.Literal("related"),
    Type.Literal("reason"),
    Type.Literal("contradict"),
    Type.Literal("list"),
    Type.Literal("update"),
    Type.Literal("remove"),
    Type.Literal("feedback"),
    Type.Literal("note_add"),
    Type.Literal("note_list"),
    Type.Literal("note_replace"),
    Type.Literal("note_remove"),
  ], { description: "Operation to perform on the memory store." }),
  content: Type.Optional(Type.String({ description: "Fact body (required for add; optional for update)." })),
  query: Type.Optional(Type.String({ description: "Search query (required for search)." })),
  entity: Type.Optional(Type.String({ description: "Entity name (required for probe and related)." })),
  entities: Type.Optional(Type.Array(Type.String(), { description: "Entity names (required for reason)." })),
  fact_id: Type.Optional(Type.Number({ description: "Target fact id (update / remove / feedback)." })),
  category: Type.Optional(Type.String({ description: `One of: ${CATEGORY_LIST}.` })),
  tags: Type.Optional(Type.String({ description: "Comma-separated tags." })),
  helpful: Type.Optional(Type.Boolean({ description: "feedback: true=helpful, false=unhelpful." })),
  min_trust: Type.Optional(Type.Number({ description: "Minimum trust filter (default 0.3)." })),
  limit: Type.Optional(Type.Number({ description: "Max results (default 10)." })),
  scope: Type.Optional(Type.String({ description: "Scope: global | project. Default for reads: current project (project + global); default for add: global unless you omit scope in a project session." })),
  correction_of: Type.Optional(Type.Number({ description: "If this fact corrects a previous one, provide the original fact_id. The original's trust drops and this fact starts with high trust." })),
  target: Type.Optional(Type.String({ description: "Curated target: memory | user. Default: memory." })),
  old_text: Type.Optional(Type.String({ description: "Substring used to replace/remove a curated entry." })),
});


function schemaName(schema: Record<string, unknown>): string | null {
  const name = schema.name;
  return typeof name === "string" && name.trim() ? name : null;
}

function parseJsonDetails(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

// --------------------------------------------------------------------------

/**
 * Provider construction must never take down the whole extension (2.3.3):
 * a corrupt DB / bad settings file currently throws in the factory top level.
 * Fall back to a bare builtin provider on any failure so the session still
 * starts with a working (if empty) memory.
 */
function createManager(): ProviderManager {
  try {
    return new ProviderManager();
  } catch (err) {
    console.warn(`[pico memory] ProviderManager failed to construct: ${err instanceof Error ? err.message : String(err)}`);
    return new ProviderManager({ backend: "builtin" });
  }
}

export const memoryExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const manager = createManager();
  const provider: MemoryProvider = manager.provider;
  const curated = new CuratedMemoryStore();
  /** Expose raw MemoryStore for extract.ts when the active provider has one. */
  const rawStore = provider.getRawStore();
  // A corrupt memory DB must not block startup silently: surface the
  // recovery notice to the user on the first session_start.
  let recoveryNoticeShown = false;
  // manager.count() is a SQLite COUNT on every before_agent_start — cache it
  // briefly; a few-seconds-stale header number is harmless.
  let factCountCache: { at: number; value: number } | null = null;
  const FACT_COUNT_TTL_MS = 5_000;
  const cachedFactCount = (): number => {
    const now = Date.now();
    if (factCountCache && now - factCountCache.at < FACT_COUNT_TTL_MS) return factCountCache.value;
    const value = manager.count();
    factCountCache = { at: now, value };
    return value;
  };
  // Register delegation hook for subagent completion tracking.
  // Session-scoped: /reload re-runs the factory, so the subscription must not
  // accumulate across reloads (see clearSessionExtensionSubscriptions).
  subscribeSessionExtensionEvent("subagent_completed", (event) => {
    manager.onDelegation(event.task, event.result, event.childSessionId);
  });
  /** Track current working directory for project-scoped memory. */
  let currentCwd: string | null = null;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.cwd) currentCwd = ctx.cwd;
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
      curated.loadFromDisk();
      manager.initialize(sessionId, { cwd: ctx.cwd, sessionReason: (_event as { reason?: string })?.reason });
      // Surface a memory-DB corruption recovery notice once per session.
      const store = rawStore as { recoveryNotice?: string | null } | null;
      const notice = store?.recoveryNotice;
      if (notice && !recoveryNoticeShown) {
        recoveryNoticeShown = true;
        try {
          ctx.ui.notify(`[memory] ${notice}`, "warning");
        } catch {
          // notify is best-effort
        }
      }
    } catch {
      // Memory should never prevent a session from starting.
    }
  });

  pi.on("session_before_switch", () => {
    curated.loadFromDisk();
    return {};
  });

  pi.on("session_before_fork", () => {
    curated.loadFromDisk();
    return {};
  });

  // --- 1. memory tool (LLM) ------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "memory",
      label: "Memory",
      description: [
        "Long-term memory for durable user prefs, project decisions, failures, corrections, insights, and reusable facts.",
        `Actions: add | search | probe | list | update | remove | feedback | related | reason | contradict | note_add | note_list | note_replace | note_remove.`,
        "Categories: " + CATEGORY_LIST + ".",
        "Call `related(entity=...)` to find facts related to an entity.",
        "Call `reason(entities=[...])` to find facts linking multiple entities.",
        "Call `contradict()` to surface potentially contradictory facts.",
        "Reads default to the CURRENT PROJECT scope (project facts + global facts) when you omit `scope`; use `scope=\"global\"` for global-only, `scope=\"project\"` for project-only.",
        "Use `scope=\"project\"` for facts that only apply in the current project directory.",
        "Use `correction_of` when a new fact supersedes an older one.",
        "Use note_add/note_replace/note_remove for short curated MEMORY.md/USER.md entries that should be in every next-session prompt snapshot.",
      ].join(" "),
      promptSnippet:
        "memory(action) — long-term fact store; search before answering, add proactively.",
      // Usage guidance (when to search/add/feedback, how to cite facts) lives
      // in src/prompts/memory-tool.md and is injected into the system prompt
      // via systemPromptBlock() — the md is the single source of truth.
      parameters: MemoryParams,
      renderCall(args, theme, context) {
        return renderToolCallText("memory", args, theme, context);
      },
      renderResult(result, options, theme, context) {
        return renderMemoryResultText(result, options, theme, context);
      },
      async execute(_id, params, _signal, _onUpdate, ctx) {
        // Capture cwd for project-scoped memory.
        if (ctx.cwd) currentCwd = ctx.cwd;

        return executeMemoryToolAction(params as MemoryToolParams, { provider, manager, currentCwd, curated });
      },
    }),
  );

  for (const schema of manager.getAllToolSchemas()) {
    const name = schemaName(schema);
    if (!name || name === "memory") continue;
    pi.registerTool(
      defineTool({
        name,
        label: `Memory: ${name}`,
        description: typeof schema.description === "string" ? schema.description : `Memory provider tool ${name}`,
        promptSnippet: `${name} — external memory provider tool`,
        parameters: Type.Unsafe(schema.parameters ?? { type: "object", properties: {} }),
        renderCall(args, theme, context) {
          return renderToolCallText(name, args, theme, context);
        },
        renderResult(result, options, theme, context) {
          return renderMemoryResultText(result, options, theme, context);
        },
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const text = manager.handleToolCall(name, params as Record<string, unknown>, {
            cwd: ctx.cwd,
            sessionId: ctx.sessionManager?.getSessionId?.(),
          });
          return {
            content: [{ type: "text" as const, text }],
            details: parseJsonDetails(text),
          };
        },
      }),
    );
  }

  // --- 2. /memory slash command (user) -------------------------------------
  pi.registerCommand("memory", {
    description: "Manage long-term memory (list / add / remove / search / clear / count)",
    handler: async (args, ctx) => {
      // Capture cwd from command context.
      if (ctx.cwd) currentCwd = ctx.cwd;

      const content = await executeMemoryCommand(args, {
        provider,
        manager,
        curated,
        currentCwd,
        notify: (text) => ctx.ui.notify(text, "info"),
        confirm: (title, body) => ctx.ui.confirm(title, body),
      });

      // Surface output in chat as a custom message so it's visible in the
      // session log and survives across re-renders.
      pi.sendMessage({
        customType: "pico.memory",
        content,
        display: true,
      });
    },
  });



  // --- 3. inject memory header + per-turn recall --------------------------
  //
  pi.on("before_agent_start", (event) => {
    try {
      const recall = manager.prefetch(event.prompt, {
        limit: 5,
        minTrust: 0.3,
        scope: SCOPE_PROJECT,
        cwd: currentCwd ?? undefined,
      });
      const recallBlock = buildMemoryContextBlock(formatRecallBlock(recall));
      const extras = [
        systemPromptBlock(cachedFactCount()),
        curated.formatForSystemPrompt(),
        recallBlock,
      ].filter((s) => s.length > 0).join("\n\n");
      if (!extras) return {};
      return { systemPrompt: `${event.systemPrompt}\n\n${extras}` };
    } catch {
      return {};
    }
  });

  // --- 4. real-time correction detection + prefetch queue -------------------
  pi.on("turn_end", (event) => {
    try {
      // New turn — reset the curated-store consolidation retry cap so the
      // model gets a fresh budget of capacity errors (mirrors hermes #42405).
      curated.resetConsolidationFailures();

      const msg = event.message;
      if (!msg || msg.role !== "user") return;

      const text = sanitizeContext(extractText(msg.content).trim());
      if (text.length < 4) return;

      // Gated correction detection: bare "actually I want…" chatter must not
      // be stored as a 0.7-trust correction (2.3.5). Questions and long
      // contextual turns are skipped.
      if (isLikelyCorrection(text)) {
        manager.add(text.slice(0, 200), {
          category: "correction",
          scope: currentCwd ? "project" : undefined,
          cwd: currentCwd ?? undefined,
          source: "correction",
          trust: CORRECTED_BOOST,
        });
      }

      // Queue background prefetch for the next turn.
      manager.queuePrefetch(text, currentCwd ?? undefined);
    } catch {
      // best-effort — must not break the turn
    }
  });

  // --- 5. auto-extract + session message accumulation ----------------------
  const sessionMessages: unknown[] = [];
  /** Text fingerprints of messages already extracted — prevents re-scanning
   *  the whole accumulated history on every agent_end (2.6.2). */
  const seenMessageTexts = new Set<string>();
  const MAX_SESSION_MESSAGES = 200;

  pi.on("agent_end", (event) => {
    try {
      const messages = (event.messages ?? []) as ExtractableMessage[];
      // Only the messages we have not scanned before.
      const fresh: ExtractableMessage[] = [];
      for (const m of messages) {
        const fingerprint = `${m.role}\u0000${extractText(m.content)}`;
        if (seenMessageTexts.has(fingerprint)) continue;
        seenMessageTexts.add(fingerprint);
        fresh.push(m);
      }
      if (fresh.length > 0 && rawStore instanceof MemoryStore) {
        autoExtractFromMessages(rawStore, fresh, { cwd: currentCwd ?? undefined });
      }
      curated.autoExtract(fresh);
      // Keep a bounded running total for onSessionEnd.
      sessionMessages.push(...fresh);
      if (sessionMessages.length > MAX_SESSION_MESSAGES) {
        sessionMessages.splice(0, sessionMessages.length - MAX_SESSION_MESSAGES);
      }
    } catch {
      // best-effort
    }
  });

  pi.on("session_before_compact", (event) => {
    try {
      const branchEntries = (event as { branchEntries?: unknown[] }).branchEntries ?? [];
      const contribution = manager.onPreCompress(branchEntries);
      if (!contribution) return {};
      const preparation = (event as { preparation?: { firstKeptEntryId?: string; tokensBefore?: number } }).preparation;
      if (!preparation?.firstKeptEntryId || preparation.tokensBefore === undefined) return {};
      return {
        compaction: {
          summary: contribution,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    } catch {
      return {};
    }
  });

  pi.on("session_shutdown", async (event) => {
    try {
      const reason = (event as { reason?: string }).reason;
      // /reload re-runs every extension factory (upstream clears the extension
      // cache and loads them again); drop the session-scoped event-bus
      // subscriptions so handlers do not accumulate across reloads.
      if (reason === "reload") {
        clearSessionExtensionSubscriptions();
      }
      manager.onSessionEnd(sessionMessages);
      // resume/fork/new keep the SAME manager/store instances for the next
      // session in this process (factories do not re-run) — draining must not
      // close the store or the background queue, or memory dies for the rest
      // of the process lifetime. Only quit/reload (process exit / factory
      // re-run) gets the permanent close.
      if (reason === "quit" || reason === "reload") {
        await manager.flushPending();
        manager.shutdown();
      } else {
        await manager.flushPending(2_000, { closeQueue: false });
        manager.shutdown(false);
      }
    } catch {
      // ignore
    }
  });
};
