/**
 * srcode memory extension.
 *
 * Wires a long-term-memory store into pi-coding-agent:
 *   - registers a `memory` tool (LLM-callable)
 *   - registers a `/memory` slash command (user-callable)
 *   - injects a recall block into the system prompt at the start of each turn
 *   - auto-extracts user prefs / project decisions on session shutdown
 *
 * Storage layout: ~/.config/srcode/memory.db (overridable via $SRCODE_MEMORY_DB).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { autoExtractFromMessages, type ExtractableMessage } from "./extract.ts";
import { formatFactLine, formatRecallBlock, systemPromptBlock } from "./prompt.ts";
import { MemoryStore, type Fact } from "./store.ts";
import { VALID_CATEGORIES, type Category } from "./schema.ts";

function resolveDbPath(): string {
  const override = process.env.SRCODE_MEMORY_DB;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  const root = xdg ? join(xdg, "srcode") : join(homedir(), ".config", "srcode");
  return join(root, "memory.db");
}

const MemoryParams = Type.Object({
  action: Type.Union([
    Type.Literal("add"),
    Type.Literal("search"),
    Type.Literal("probe"),
    Type.Literal("list"),
    Type.Literal("update"),
    Type.Literal("remove"),
    Type.Literal("feedback"),
  ], { description: "Operation to perform on the memory store." }),
  content: Type.Optional(Type.String({ description: "Fact body (required for add; optional for update)." })),
  query: Type.Optional(Type.String({ description: "Search query (required for search)." })),
  entity: Type.Optional(Type.String({ description: "Entity name (required for probe)." })),
  fact_id: Type.Optional(Type.Number({ description: "Target fact id (update / remove / feedback)." })),
  category: Type.Optional(Type.String({ description: "One of: user_pref | project | tool | general." })),
  tags: Type.Optional(Type.String({ description: "Comma-separated tags." })),
  helpful: Type.Optional(Type.Boolean({ description: "feedback: true=helpful, false=unhelpful." })),
  min_trust: Type.Optional(Type.Number({ description: "Minimum trust filter (default 0.3)." })),
  limit: Type.Optional(Type.Number({ description: "Max results (default 10)." })),
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

export const memoryExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const store = new MemoryStore(resolveDbPath());

  // --- 1. memory tool (LLM) ------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "memory",
      label: "Memory",
      description: [
        "Long-term memory for durable user prefs, project decisions, and reusable facts.",
        "Actions: add | search | probe | list | update | remove | feedback.",
        "Call `search` BEFORE answering questions about the user or project.",
        "Call `add` whenever the user shares something they would expect you to remember.",
        "Call `feedback` after using a fact (helpful=true) to lift its trust score.",
      ].join(" "),
      promptSnippet:
        "memory(action) — long-term fact store; search before answering, add proactively.",
      promptGuidelines: [
        "Call `memory(action=\"search\", query=...)` when the user asks something whose answer might depend on previously remembered preferences or project decisions.",
        "When the user states a durable preference (\"I prefer X\", \"we use Y\", \"never Z\"), call `memory(action=\"add\")` with an appropriate category (user_pref / project / tool / general).",
        "When you cite a stored fact, mention its id like `(memory:#42)` so the user can audit or correct it.",
      ],
      parameters: MemoryParams,
      async execute(_id, params) {
        try {
          switch (params.action) {
            case "add": {
              if (!params.content) return errorResult("'content' is required for add");
              const cat = asCategory(params.category);
              if (params.category && !cat) return errorResult(`invalid category '${params.category}'`);
              const id = store.add(params.content, { category: cat, tags: params.tags });
              const fact = store.get(id);
              return jsonResult({ status: "added", fact_id: id, fact });
            }
            case "search": {
              if (!params.query) return errorResult("'query' is required for search");
              const cat = asCategory(params.category);
              const results = store.search(params.query, {
                category: cat,
                minTrust: params.min_trust,
                limit: params.limit,
              });
              return jsonResult({ count: results.length, results });
            }
            case "probe": {
              const target = params.entity ?? params.query;
              if (!target) return errorResult("'entity' is required for probe");
              const cat = asCategory(params.category);
              const results = store.probe(target, {
                category: cat,
                minTrust: params.min_trust,
                limit: params.limit,
              });
              return jsonResult({ count: results.length, results });
            }
            case "list": {
              const cat = asCategory(params.category);
              const results = store.list({
                category: cat,
                minTrust: params.min_trust,
                limit: params.limit,
              });
              return jsonResult({ count: results.length, facts: results });
            }
            case "update": {
              if (params.fact_id === undefined) return errorResult("'fact_id' is required for update");
              const cat = asCategory(params.category);
              if (params.category && !cat) return errorResult(`invalid category '${params.category}'`);
              const ok = store.update(params.fact_id, {
                content: params.content,
                category: cat,
                tags: params.tags,
              });
              return jsonResult({ status: ok ? "updated" : "not_found", fact_id: params.fact_id });
            }
            case "remove": {
              if (params.fact_id === undefined) return errorResult("'fact_id' is required for remove");
              const ok = store.remove(params.fact_id);
              return jsonResult({ status: ok ? "removed" : "not_found", fact_id: params.fact_id });
            }
            case "feedback": {
              if (params.fact_id === undefined) return errorResult("'fact_id' is required for feedback");
              if (params.helpful === undefined) return errorResult("'helpful' is required for feedback");
              const fact = store.feedback(params.fact_id, params.helpful);
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

      try {
        switch (cmd) {
          case "list": {
            renderFacts(store.list({ limit: 50 }), `Memory — ${store.count()} facts:`);
            break;
          }
          case "count": {
            announce(`Memory: ${store.count()} facts at ${store.dbPath}`);
            break;
          }
          case "search": {
            if (!rest) {
              announce("Usage: /memory search <query>");
              break;
            }
            renderFacts(store.search(rest, { limit: 20, minTrust: 0 }), `Search: ${rest}`);
            break;
          }
          case "add": {
            if (!rest) {
              announce("Usage: /memory add [category=general] <content>");
              break;
            }
            const m = rest.match(/^(user_pref|project|tool|general)\s+(.+)$/);
            const category = (m?.[1] ?? "general") as Category;
            const content = m?.[2] ?? rest;
            const id = store.add(content, { category });
            const fact = store.get(id);
            if (fact) renderFacts([fact], `Added:`);
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
            const ok = store.remove(id);
            announce(ok ? `Removed memory #${id}` : `No such memory #${id}`);
            break;
          }
          case "clear": {
            const confirm = await ctx.ui.confirm(
              "Clear all memory?",
              `Permanently delete ${store.count()} facts at ${store.dbPath}?`,
            );
            if (confirm) {
              store.clear();
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
            lines.push("  /memory list              — list all facts");
            lines.push("  /memory search <query>    — full-text search");
            lines.push("  /memory add [cat] <text>  — add a fact (cat: user_pref|project|tool|general)");
            lines.push("  /memory remove <id>       — delete a fact");
            lines.push("  /memory clear             — wipe all memory (asks first)");
            lines.push("  /memory count             — show count + db path");
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

  // --- 3. inject recall + system-prompt header ----------------------------
  pi.on("before_agent_start", (event) => {
    try {
      const headerBlock = systemPromptBlock(store.count());
      const recall = store.search(event.prompt, { limit: 5, minTrust: 0.3 });
      const recallBlock = formatRecallBlock(recall);
      const extras = [headerBlock, recallBlock].filter((s) => s.length > 0).join("\n\n");
      if (!extras) return {};
      return { systemPrompt: `${event.systemPrompt}\n\n${extras}` };
    } catch {
      return {};
    }
  });

  // --- 4. auto-extract on shutdown ----------------------------------------
  pi.on("agent_end", (event) => {
    try {
      const messages = (event.messages ?? []) as ExtractableMessage[];
      autoExtractFromMessages(store, messages);
    } catch {
      // best-effort
    }
  });

  pi.on("session_shutdown", () => {
    try {
      store.close();
    } catch {
      // ignore
    }
  });
};
