/**
 * `/memory` slash command routing.
 *
 * Kept out of index.ts so the pi registration file stays a shallow adapter.
 * Side effects (notify / confirm) arrive through deps, which also makes the
 * whole command surface testable without a live ExtensionAPI.
 */
import { formatFactLine } from "./prompt.ts";
import type { Fact, MemoryProvider } from "./provider.ts";
import { ProviderManager, resolveDbPath } from "./provider-manager.ts";
import type { CuratedMemoryStore, CuratedTarget } from "./curated-store.ts";
import { CATEGORY_LIST, VALID_CATEGORIES, type Category } from "./schema.ts";

export interface MemoryCommandDeps {
  provider: MemoryProvider;
  manager: ProviderManager;
  curated: CuratedMemoryStore;
  currentCwd: string | null;
  /** Surface a line to the user immediately; it is also kept in the transcript. */
  notify: (text: string) => void;
  confirm: (title: string, body: string) => Promise<boolean>;
}

interface ParsedCommand {
  cmd: string;
  rest: string;
}

export function parseCommand(args: string): ParsedCommand {
  const trimmed = args.trim();
  if (!trimmed) return { cmd: "list", rest: "" };
  const idx = trimmed.search(/\s/);
  if (idx < 0) return { cmd: trimmed.toLowerCase(), rest: "" };
  return { cmd: trimmed.slice(0, idx).toLowerCase(), rest: trimmed.slice(idx + 1).trim() };
}

function asCategory(raw: unknown): Category | undefined {
  if (typeof raw !== "string") return undefined;
  return (VALID_CATEGORIES as readonly string[]).includes(raw) ? (raw as Category) : undefined;
}

/** Strip a leading `--scope global|project` flag from the argument tail. */
function parseScope(text: string): { scope: "global" | "project" | undefined; rest: string } {
  const m = text.match(/--scope\s+(global|project)\s*/i);
  if (!m) return { scope: undefined, rest: text };
  return {
    scope: m[1]!.toLowerCase() as "global" | "project",
    rest: text.replace(/--scope\s+(global|project)\s*/i, "").trim(),
  };
}

function parseNotesTarget(text: string): { target: CuratedTarget; rest: string } {
  const trimmed = text.trim();
  const m = trimmed.match(/^(memory|user)\s*(.*)$/i);
  if (!m) return { target: "memory", rest: trimmed };
  return { target: m[1]!.toLowerCase() as CuratedTarget, rest: m[2]!.trim() };
}

function usageLines(): string[] {
  return [
    "Usage:",
    "  /memory list [--scope global|project] [category] — list facts",
    "  /memory search [--scope global|project] <query>  — full-text search",
    `  /memory add [category] [--scope project] <text>  — add a fact`,
    `    categories: ${CATEGORY_LIST}`,
    "  /memory remove <id>       — delete a fact",
    "  /memory clear             — wipe all memory (asks first)",
    "  /memory count             — show count + db path",
    "  /memory status            — show provider and note status",
    "  /memory setup <provider>  — set backend for next session",
    "  /memory off               — use builtin backend only",
    "  /memory notes             — list curated MEMORY.md / USER.md notes",
    "  /memory notes add user <text>       — add a user profile note",
    "  /memory notes replace memory <old> => <new> — replace a curated note",
    "  /memory related <entity>  — find facts related to an entity",
    "  /memory reason <e1>,<e2>  — find facts linking multiple entities",
    "  /memory contradict        — surface contradictory facts",
  ];
}

/**
 * Run one `/memory ...` invocation and return the text to display.
 * Never throws: failures are folded into the returned transcript.
 */
export async function executeMemoryCommand(args: string, deps: MemoryCommandDeps): Promise<string> {
  const { provider, manager, curated, currentCwd, notify, confirm } = deps;
  const { cmd, rest } = parseCommand(args);
  const lines: string[] = [];

  const announce = (text: string) => {
    notify(text);
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

  const scopedCwd = (scope: "global" | "project" | undefined): string | undefined =>
    scope === "project" ? (currentCwd ?? undefined) : undefined;

  try {
    switch (cmd) {
      case "status": {
        const info = manager.getInfo();
        lines.push(`Memory provider: ${info.name}`);
        lines.push(`Available: ${info.available ? "yes" : "no"}`);
        lines.push(`Facts: ${info.factCount}`);
        lines.push(`Curated notes: ${curated.count()}`);
        lines.push(`Providers: ${ProviderManager.availableProviders().join(", ")}`);
        break;
      }
      case "setup": {
        const backend = rest.trim() || "builtin";
        const result = ProviderManager.saveBackend(backend);
        if (result.ok) {
          announce(`Memory backend set to '${backend}'. Restart or reload the session to activate it.`);
        } else {
          announce(`Error: ${result.reason}`);
        }
        break;
      }
      case "off": {
        const result = ProviderManager.saveBackend("builtin");
        announce(result.ok ? "External memory provider disabled; builtin remains active." : `Error: ${result.reason}`);
        break;
      }
      case "list": {
        const { scope, rest: filterRest } = parseScope(rest);
        const cat = asCategory(filterRest) || undefined;
        renderFacts(
          manager.list({ limit: 50, scope, cwd: scopedCwd(scope), category: cat }),
          `Memory — ${manager.count()} facts:`,
        );
        break;
      }
      case "count": {
        announce(`Memory: ${manager.count()} facts at ${resolveDbPath()}; ${curated.count()} curated notes`);
        break;
      }
      case "search": {
        const { scope, rest: queryRest } = parseScope(rest);
        if (!queryRest) {
          announce("Usage: /memory search [--scope global|project] <query>");
          break;
        }
        renderFacts(
          manager.search(queryRest, { limit: 20, minTrust: 0, scope, cwd: scopedCwd(scope) }),
          `Search: ${queryRest}`,
        );
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
          const id = manager.add(content, {
            category,
            scope,
            cwd: scopedCwd(scope),
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
        // The whole argument is the entity — never treat it as a category
        // (an entity named like a category would silently filter results).
        const results = manager.related(rest, { limit: 20, minTrust: 0 });
        renderFacts(results, `Related to "${rest}":`);
        break;
      }
      case "reason": {
        if (!rest) {
          announce("Usage: /memory reason <entity1>,<entity2>[,...]");
          break;
        }
        const entities = rest.split(",").map((s) => s.trim()).filter(Boolean);
        const results = manager.reason(entities, { limit: 20, minTrust: 0 });
        renderFacts(results, `Reason over [${entities.join(", ")}]:`);
        break;
      }
      case "contradict": {
        const cat = asCategory(rest) || undefined;
        const results = manager.contradict({ category: cat, limit: 10 });
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
        const ok = manager.remove(id);
        announce(ok ? `Removed memory #${id}` : `No such memory #${id}`);
        break;
      }
      case "clear": {
        const confirmed = await confirm(
          "Clear all memory?",
          `Permanently delete ${manager.count()} facts at ${resolveDbPath()} and ${curated.count()} curated notes?`,
        );
        if (confirmed) {
          manager.clear();
          curated.clear();
          announce("Memory cleared.");
        } else {
          announce("Cancelled.");
        }
        break;
      }
      case "notes": {
        const { cmd: notesCmd, rest: notesRest } = parseCommand(rest);
        if (!notesCmd || notesCmd === "list" || notesCmd === "show") {
          const target = notesRest === "memory" || notesRest === "user" ? notesRest : undefined;
          const entries = curated.list(target);
          lines.push(`Curated memory (${curated.count(target)} entries):`);
          if (!target || target === "memory") {
            lines.push("MEMORY.md:");
            lines.push(...(entries.memory.length ? entries.memory.map((e, i) => `  ${i + 1}. ${e}`) : ["  (empty)"]));
          }
          if (!target || target === "user") {
            lines.push("USER.md:");
            lines.push(...(entries.user.length ? entries.user.map((e, i) => `  ${i + 1}. ${e}`) : ["  (empty)"]));
          }
          break;
        }
        if (notesCmd === "add") {
          const { target, rest: content } = parseNotesTarget(notesRest);
          const result = curated.add(target, content);
          announce(result.success ? `Added ${target} note.` : `Error: ${result.error}`);
          break;
        }
        if (notesCmd === "remove" || notesCmd === "rm") {
          const { target, rest: oldText } = parseNotesTarget(notesRest);
          const result = curated.remove(target, oldText);
          announce(result.success ? `Removed ${target} note.` : `Error: ${result.error}`);
          break;
        }
        if (notesCmd === "replace") {
          const { target, rest: replaceRest } = parseNotesTarget(notesRest);
          const [oldText, content] = replaceRest.split(/\s+=>\s+/, 2);
          if (!oldText || !content) {
            announce("Usage: /memory notes replace [memory|user] <old_text> => <new_content>");
            break;
          }
          const result = curated.replace(target, oldText, content);
          announce(result.success ? `Replaced ${target} note.` : `Error: ${result.error}`);
          break;
        }
        if (notesCmd === "clear") {
          const target = notesRest === "memory" || notesRest === "user" ? notesRest : undefined;
          const confirmed = await confirm(
            "Clear curated memory?",
            `Permanently delete ${target ?? "all"} curated notes?`,
          );
          if (confirmed) {
            curated.clear(target);
            announce(`Cleared ${target ?? "all"} curated notes.`);
          } else {
            announce("Cancelled.");
          }
          break;
        }
        lines.push("Usage: /memory notes [list|add|remove|replace|clear] [memory|user] ...");
        break;
      }
      case "help":
      case "":
      default: {
        lines.push(...usageLines());
      }
    }
  } catch (err) {
    lines.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return lines.join("\n");
}
