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
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  autoExtractFromMessages,
  CORRECTION_PATTERNS,
  extractText,
  type ExtractableMessage,
} from "./extract.ts";
import { formatRecallBlock, systemPromptBlock } from "./prompt.ts";
import { type MemoryWriteMetadata, type MemoryProvider } from "./provider.ts";
import { subscribeExtensionEvent } from "../events.ts";
import { MemoryStore } from "./store.ts";
import { CuratedMemoryStore } from "./curated-store.ts";
import { ProviderManager, sanitizeContext, buildMemoryContextBlock } from "./provider-manager.ts";
import { CATEGORY_LIST, CORRECTED_BOOST, SCOPE_PROJECT } from "./schema.ts";
import { executeMemoryToolAction, type MemoryToolParams } from "./tool.ts";
import { executeMemoryCommand } from "./command.ts";
import { renderToolCallText, renderToolResultText } from "../tool-render.ts";

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
  scope: Type.Optional(Type.String({ description: "Scope: global | project. Default: global. Project-scoped facts are isolated to the current working directory." })),
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

export const memoryExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const manager = new ProviderManager();
  const provider: MemoryProvider = manager.provider;
  const curated = new CuratedMemoryStore();
  /** Expose raw MemoryStore for extract.ts when the active provider has one. */
  const rawStore = provider.getRawStore();
  // Register delegation hook for subagent completion tracking.
  subscribeExtensionEvent("subagent_completed", (event) => {
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
        "Call `search` BEFORE answering questions about the user or project.",
        "Call `add` whenever the user shares something they would expect you to remember.",
        "Call `feedback` after using a fact (helpful=true) to lift its trust score.",
        "Call `related(entity=...)` to find facts related to an entity.",
        "Call `reason(entities=[...])` to find facts linking multiple entities.",
        "Call `contradict()` to surface potentially contradictory facts.",
        "Use `scope=\"project\"` for facts that only apply in the current project directory.",
        "Use `correction_of` when a new fact supersedes an older one.",
        "Use note_add/note_replace/note_remove for short curated MEMORY.md/USER.md entries that should be in every next-session prompt snapshot.",
      ].join(" "),
      promptSnippet:
        "memory(action) — long-term fact store; search before answering, add proactively.",
      promptGuidelines: [
        "Call `memory(action=\"search\", query=...)` when the user asks something whose answer might depend on previously remembered preferences or project decisions.",
        `When the user states a durable preference (\"I prefer X\", \"we use Y\", \"never Z\", \"that didn't work\", \"actually use W instead\"), call \`memory(action=\"add\")\` with an appropriate category (${CATEGORY_LIST}).`,
        "When you cite a stored fact, mention its id like `(memory:#42)` so the user can audit or correct it.",
      ],
      parameters: MemoryParams,
      renderCall(args, theme, context) {
        return renderToolCallText("memory", args, theme, context);
      },
      renderResult(result, options, theme, context) {
        return renderToolResultText(result, options, theme, context);
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
          return renderToolResultText(result, options, theme, context);
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
        systemPromptBlock(manager.count()),
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
      const msg = event.message;
      if (!msg || msg.role !== "user") return;

      const text = sanitizeContext(extractText(msg.content).trim());
      if (text.length < 10) return;

      // Only run correction patterns — keep per-turn overhead minimal.
      if (CORRECTION_PATTERNS.some((p) => p.test(text))) {
        manager.add(text.slice(0, 400), {
          category: "correction",
          scope: currentCwd ? "project" : undefined,
          cwd: currentCwd ?? undefined,
          source: "correction",
          trust: CORRECTED_BOOST,
        });
        curated.add("memory", text.slice(0, 400));
      }

      // Queue background prefetch for the next turn.
      manager.queuePrefetch(text, currentCwd ?? undefined);
    } catch {
      // best-effort — must not break the turn
    }
  });

  // --- 5. auto-extract + session message accumulation ----------------------
  const sessionMessages: unknown[] = [];

  pi.on("agent_end", (event) => {
    try {
      const messages = (event.messages ?? []) as ExtractableMessage[];
      if (rawStore instanceof MemoryStore) {
        autoExtractFromMessages(rawStore, messages, { cwd: currentCwd ?? undefined });
      }
      curated.autoExtract(messages);
      // Keep a running total of all session messages for onSessionEnd
      sessionMessages.push(...messages);
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

  pi.on("session_shutdown", async () => {
    try {
      manager.onSessionEnd(sessionMessages);
      await manager.flushPending();
      manager.shutdown();
    } catch {
      // ignore
    }
  });
};
