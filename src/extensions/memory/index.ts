/**
 * srcode memory extension.
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
import { formatFactLine, formatRecallBlock, systemPromptBlock } from "./prompt.ts";
import { type Fact, type MemoryWriteMetadata, type MemoryProvider } from "./provider.ts";
import { subscribeExtensionEvent } from "../events.ts";
import { MemoryStore } from "./store.ts";
import { resolveDbPath, ProviderManager, sanitizeContext, buildMemoryContextBlock } from "./provider-manager.ts";
import { CORRECTED_BOOST, SCOPE_PROJECT, VALID_CATEGORIES, type Category } from "./schema.ts";
const CATEGORY_LIST = VALID_CATEGORIES.join(" | ");

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
});

function asCategory(raw: unknown): Category | undefined {
  if (typeof raw !== "string") return undefined;
  return (VALID_CATEGORIES as readonly string[]).includes(raw) ? (raw as Category) : undefined;
}

function jsonResult(payload: unknown) {
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    details: payload,
  };
}

function errorResult(message: string) {
  const payload = { error: message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
}

// ---- /memory subcommand parsing ------------------------------------------

interface ParsedCommand {
  cmd: string;
  rest: string;
}
function parseCommand(args: string): ParsedCommand {
  const trimmed = args.trim();
  if (!trimmed) return { cmd: "list", rest: "" };
  const idx = trimmed.search(/\s/);
  if (idx < 0) return { cmd: trimmed.toLowerCase(), rest: "" };
  return { cmd: trimmed.slice(0, idx).toLowerCase(), rest: trimmed.slice(idx + 1).trim() };
}

// --------------------------------------------------------------------------

/** Module-level reference set by memoryExtension for cross-extension hooks. */
let activeMemoryProvider: MemoryProvider | null = null;

export const memoryExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const manager = new ProviderManager();
  const provider: MemoryProvider = manager.provider;
  // Expose for subagent extension's onDelegation hook.
  activeMemoryProvider = provider;
  /** Expose raw MemoryStore for extract.ts which needs low-level access. */
  const rawStore = provider.getRawStore() as MemoryStore;
  // Register delegation hook for subagent completion tracking.
  subscribeExtensionEvent("subagent_completed", (event) => {
    provider.onDelegation?.(event.task, event.result, event.childSessionId);
  });
  /** Track current working directory for project-scoped memory. */
  let currentCwd: string | null = null;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.cwd) currentCwd = ctx.cwd;
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
      provider.initialize(sessionId);
    } catch {
      // Memory should never prevent a session from starting.
    }
  });

  // --- 1. memory tool (LLM) ------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "memory",
      label: "Memory",
      description: [
        "Long-term memory for durable user prefs, project decisions, failures, corrections, insights, and reusable facts.",
        `Actions: add | search | probe | list | update | remove | feedback | related | reason | contradict.`,
        "Categories: " + CATEGORY_LIST + ".",
        "Call `search` BEFORE answering questions about the user or project.",
        "Call `add` whenever the user shares something they would expect you to remember.",
        "Call `feedback` after using a fact (helpful=true) to lift its trust score.",
        "Call `related(entity=...)` to find facts related to an entity.",
        "Call `reason(entities=[...])` to find facts linking multiple entities.",
        "Call `contradict()` to surface potentially contradictory facts.",
        "Use `scope=\"project\"` for facts that only apply in the current project directory.",
        "Use `correction_of` when a new fact supersedes an older one.",
      ].join(" "),
      promptSnippet:
        "memory(action) — long-term fact store; search before answering, add proactively.",
      promptGuidelines: [
        "Call `memory(action=\"search\", query=...)` when the user asks something whose answer might depend on previously remembered preferences or project decisions.",
        `When the user states a durable preference (\"I prefer X\", \"we use Y\", \"never Z\", \"that didn't work\", \"actually use W instead\"), call \`memory(action=\"add\")\` with an appropriate category (${CATEGORY_LIST}).`,
        "When you cite a stored fact, mention its id like `(memory:#42)` so the user can audit or correct it.",
      ],
      parameters: MemoryParams,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        // Capture cwd for project-scoped memory.
        if (ctx.cwd) currentCwd = ctx.cwd;

        try {
          switch (params.action) {
            case "add": {
              if (!params.content) return errorResult("'content' is required for add");
              const cat = asCategory(params.category);
              if (params.category && !cat) return errorResult(`invalid category '${params.category}'`);
              const scope = (params.scope === "project" || params.scope === "global") ? params.scope : undefined;
              const beforeAdd = provider.onBeforeWrite?.({ action: "add", content: params.content, category: cat, scope, tags: params.tags, source: "manual" });
              if (beforeAdd && beforeAdd.ok === false) return errorResult(beforeAdd.reason ?? "memory write denied");
              const id = provider.add(params.content, {
                category: cat,
                tags: params.tags,
                scope,
                cwd: scope === "project" ? (currentCwd ?? undefined) : undefined,
                correctionOf: params.correction_of,
                source: "manual",
              });
              manager.notifyMemoryToolWrite({
                action: "add",
                content: params.content,
                tags: params.tags,
                category: cat,
                scope,
                source: "manual",
                factId: id,
              });
              const fact = provider.get(id);
              return jsonResult({ status: "added", fact_id: id, fact });
            }
            case "search": {
              if (!params.query) return errorResult("'query' is required for search");
              const cat = asCategory(params.category);
              const scope = (params.scope === "project" || params.scope === "global") ? params.scope : undefined;
              const results = provider.search(params.query, {
                category: cat,
                minTrust: params.min_trust,
                limit: params.limit,
                scope,
                cwd: scope === "project" ? (currentCwd ?? undefined) : undefined,
              });
              return jsonResult({ count: results.length, results });
            }
            case "probe": {
              const target = params.entity ?? params.query;
              if (!target) return errorResult("'entity' is required for probe");
              const cat = asCategory(params.category);
              const scope = (params.scope === "project" || params.scope === "global") ? params.scope : undefined;
              const results = provider.probe(target, {
                category: cat,
                minTrust: params.min_trust,
                limit: params.limit,
                scope,
                cwd: scope === "project" ? (currentCwd ?? undefined) : undefined,
              });
              return jsonResult({ count: results.length, results });
            }
            case "list": {
              const cat = asCategory(params.category);
              const scope = (params.scope === "project" || params.scope === "global") ? params.scope : undefined;
              const results = provider.list({
                category: cat,
                minTrust: params.min_trust,
                limit: params.limit,
                scope,
                cwd: scope === "project" ? (currentCwd ?? undefined) : undefined,
              });
              return jsonResult({ count: results.length, facts: results });
            }
            case "related": {
              const target = params.entity ?? params.query;
              if (!target) return errorResult("'entity' is required for related");
              const cat = asCategory(params.category);
              const results = provider.related(target, {
                category: cat,
                minTrust: params.min_trust,
                limit: params.limit,
              });
              return jsonResult({ count: results.length, results });
            }
            case "reason": {
              const entities = params.entities;
              if (!entities || entities.length === 0) return errorResult("'entities' list is required for reason");
              const cat = asCategory(params.category);
              const results = provider.reason(entities, {
                category: cat,
                minTrust: params.min_trust,
                limit: params.limit,
              });
              return jsonResult({ count: results.length, results });
            }
            case "contradict": {
              const cat = asCategory(params.category);
              const results = provider.contradict({
                category: cat,
                limit: params.limit,
              });
              return jsonResult({ count: results.length, contradictions: results });
            }
            case "update": {
              if (params.fact_id === undefined) return errorResult("'fact_id' is required for update");
              const cat = asCategory(params.category);
              if (params.category && !cat) return errorResult(`invalid category '${params.category}'`);
              // Fetch previous content BEFORE update so previousContent
              // reflects the old value, not the new one (reviewer caught this).
              const prevFact = provider.get(params.fact_id);
              const beforeUpd = provider.onBeforeWrite?.({ action: "update", content: params.content, factId: params.fact_id, category: cat, tags: params.tags, previousContent: prevFact?.content });
              if (beforeUpd && beforeUpd.ok === false) return errorResult(beforeUpd.reason ?? "memory write denied");
              const ok = provider.update(params.fact_id, {
                content: params.content,
                category: cat,
                tags: params.tags,
              });
              manager.notifyMemoryToolWrite({
                action: "update",
                content: params.content,
                tags: params.tags,
                category: cat,
                factId: params.fact_id,
                previousContent: prevFact?.content,
              });
              return jsonResult({ status: ok ? "updated" : "not_found", fact_id: params.fact_id });
            }
            case "remove": {
              if (params.fact_id === undefined) return errorResult("'fact_id' is required for remove");
              const beforeRm = provider.onBeforeWrite?.({ action: "remove", factId: params.fact_id });
              if (beforeRm && beforeRm.ok === false) return errorResult(beforeRm.reason ?? "memory write denied");
              const ok = provider.remove(params.fact_id);
              manager.notifyMemoryToolWrite({
                action: "remove",
                factId: params.fact_id,
              });
              return jsonResult({ status: ok ? "removed" : "not_found", fact_id: params.fact_id });
            }
            case "feedback": {
              if (params.fact_id === undefined) return errorResult("'fact_id' is required for feedback");
              if (params.helpful === undefined) return errorResult("'helpful' is required for feedback");
              const fact = provider.feedback(params.fact_id, params.helpful);
              if (!fact) return jsonResult({ status: "not_found", fact_id: params.fact_id });
              return jsonResult({ status: "ok", fact });
            }
          }
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        return errorResult("unreachable");
      },
    }),
  );

  // --- 2. /memory slash command (user) -------------------------------------
  pi.registerCommand("memory", {
    description: "Manage long-term memory (list / add / remove / search / clear / count)",
    handler: async (args, ctx) => {
      // Capture cwd from command context.
      if (ctx.cwd) currentCwd = ctx.cwd;

      const { cmd, rest } = parseCommand(args);
      const lines: string[] = [];

      const announce = (text: string) => {
        ctx.ui.notify(text, "info");
        lines.push(text);
      };

      const renderFacts = (facts: Fact[], header?: string) => {
        if (header) lines.push(header);
        if (facts.length === 0) {
          lines.push("(no facts)");
        } else {
          for (const f of facts) lines.push(formatFactLine(f));
        }
      };

      // Parse --scope from rest arguments.
      const parseScope = (text: string): { scope: "global" | "project" | undefined; rest: string } => {
        const m = text.match(/--scope\s+(global|project)\s*/i);
        if (!m) return { scope: undefined, rest: text };
        return { scope: m[1]!.toLowerCase() as "global" | "project", rest: text.replace(/--scope\s+(global|project)\s*/i, "").trim() };
      };

      try {
        switch (cmd) {
          case "list": {
            const { scope, rest: filterRest } = parseScope(rest);
            const cat = asCategory(filterRest) || undefined;
            renderFacts(provider.list({ limit: 50, scope, cwd: scope === "project" ? (currentCwd ?? undefined) : undefined, category: cat }), `Memory — ${provider.count()} facts:`);
            break;
          }
          case "count": {
            announce(`Memory: ${provider.count()} facts at ${resolveDbPath()}`);
            break;
          }
          case "search": {
            const { scope, rest: queryRest } = parseScope(rest);
            if (!queryRest) {
              announce("Usage: /memory search [--scope global|project] <query>");
              break;
            }
            renderFacts(provider.search(queryRest, { limit: 20, minTrust: 0, scope, cwd: scope === "project" ? (currentCwd ?? undefined) : undefined }), `Search: ${queryRest}`);
            break;
          }
          case "add": {
            if (!rest) {
              announce(`Usage: /memory add [category] [--scope project] <content> (categories: ${CATEGORY_LIST})`);
              break;
            }
            const { scope, rest: addRest } = parseScope(rest);
            // Try to parse category prefix.
            const m = addRest.match(/^(user_pref|project|tool|general|failure|correction|insight|convention|tool_quirk)\s+(.+)$/);
            const category = (m?.[1] ?? "general") as Category;
            const content = m?.[2] ?? addRest;
            try {
              const id = provider.add(content, {
                category,
                scope,
                cwd: scope === "project" ? (currentCwd ?? undefined) : undefined,
                source: "manual",
              });
              const fact = provider.get(id);
              if (fact) renderFacts([fact], `Added:`);
            } catch (err) {
              announce(`Error: ${err instanceof Error ? err.message : String(err)}`);
            }
            break;
          }
          case "related": {
            if (!rest) {
              announce("Usage: /memory related <entity>");
              break;
            }
            const cat = asCategory(rest) || undefined;
            const results = provider.related(rest, { category: cat, limit: 20, minTrust: 0 });
            renderFacts(results, `Related to "${rest}":`);
            break;
          }
          case "reason": {
            if (!rest) {
              announce("Usage: /memory reason <entity1>,<entity2>[,...]");
              break;
            }
            const entities = rest.split(",").map((s) => s.trim()).filter(Boolean);
            const results = provider.reason(entities, { limit: 20, minTrust: 0 });
            renderFacts(results, `Reason over [${entities.join(", ")}]:`);
            break;
          }
          case "contradict": {
            const cat = asCategory(rest) || undefined;
            const results = provider.contradict({ category: cat, limit: 10 });
            if (results.length === 0) {
              announce("No contradictions found.");
            } else {
              lines.push(`Contradictions (${results.length}):`);
              for (const c of results) {
                lines.push(`  #${c.fact_a.fact_id} vs #${c.fact_b.fact_id} (score: ${c.contradiction_score.toFixed(3)})`);
                lines.push(`    A: ${c.fact_a.content.slice(0, 80)}`);
                lines.push(`    B: ${c.fact_b.content.slice(0, 80)}`);
              }
            }
            break;
          }
          case "remove":
          case "rm":
          case "delete": {
            const id = Number(rest);
            if (!Number.isInteger(id)) {
              announce("Usage: /memory remove <fact_id>");
              break;
            }
            const ok = provider.remove(id);
            announce(ok ? `Removed memory #${id}` : `No such memory #${id}`);
            break;
          }
          case "clear": {
            const confirm = await ctx.ui.confirm(
              "Clear all memory?",
              `Permanently delete ${provider.count()} facts at ${resolveDbPath()}?`,
            );
            if (confirm) {
              provider.clear();
              announce("Memory cleared.");
            } else {
              announce("Cancelled.");
            }
            break;
          }
          case "help":
          case "":
          default: {
            lines.push("Usage:");
            lines.push("  /memory list [--scope global|project] [category] — list facts");
            lines.push("  /memory search [--scope global|project] <query>  — full-text search");
            lines.push(`  /memory add [category] [--scope project] <text>  — add a fact`);
            lines.push(`    categories: ${CATEGORY_LIST}`);
            lines.push("  /memory remove <id>       — delete a fact");
            lines.push("  /memory clear             — wipe all memory (asks first)");
            lines.push("  /memory count             — show count + db path");
            lines.push("  /memory related <entity>  — find facts related to an entity");
            lines.push("  /memory reason <e1>,<e2>  — find facts linking multiple entities");
            lines.push("  /memory contradict        — surface contradictory facts");
          }
        }
      } catch (err) {
        lines.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Surface output in chat as a custom message so it's visible in the
      // session log and survives across re-renders.
      pi.sendMessage({
        customType: "srcode.memory",
        content: lines.join("\n"),
        display: true,
      });
    },
  });



  // --- 3. inject recall + system-prompt header (frozen snapshot) -----------
  //
  // At session start we capture a frozen snapshot of the memory context (header
  // + top recall facts). This snapshot is injected into the system prompt for
  // EVERY turn without re-querying, keeping the prefix cache stable across the
  // session. Mid-session writes update live state (tool results) but do NOT
  // change the system prompt — mirroring hermes-agent's MemoryStore frozen
  // snapshot pattern.
  //
  // The snapshot is regenerated only on the first turn of a new session.
  let frozenSnapshot: { header: string; recall: string } | null = null;

  pi.on("before_agent_start", (event) => {
    try {
      if (!frozenSnapshot) {
        const header = systemPromptBlock(provider.count());
        const recall = provider.search(event.prompt, {
          limit: 5,
          minTrust: 0.3,
          scope: SCOPE_PROJECT,
          cwd: currentCwd ?? undefined,
        });
        frozenSnapshot = { header, recall: formatRecallBlock(recall) };
      }
      const recallBlock = buildMemoryContextBlock(frozenSnapshot.recall);
      const extras = [frozenSnapshot.header, recallBlock]
        .filter((s) => s.length > 0).join("\n\n");
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
        provider.add(text.slice(0, 400), {
          category: "correction",
          scope: currentCwd ? "project" : undefined,
          cwd: currentCwd ?? undefined,
          source: "correction",
          trust: CORRECTED_BOOST,
        });
      }

      // Queue background prefetch for the next turn.
      provider.queuePrefetch(text, currentCwd ?? undefined);
    } catch {
      // best-effort — must not break the turn
    }
  });

  // --- 5. auto-extract + session message accumulation ----------------------
  const sessionMessages: unknown[] = [];

  pi.on("agent_end", (event) => {
    try {
      const messages = (event.messages ?? []) as ExtractableMessage[];
      autoExtractFromMessages(rawStore, messages, { cwd: currentCwd ?? undefined });
      // Keep a running total of all session messages for onSessionEnd
      sessionMessages.push(...messages);
    } catch {
      // best-effort
    }
  });

  pi.on("session_shutdown", () => {
    try {
      provider.onSessionEnd?.(sessionMessages);
      frozenSnapshot = null;  // next session gets a fresh snapshot
      provider.shutdown();
    } catch {
      // ignore
    }
  });
};
