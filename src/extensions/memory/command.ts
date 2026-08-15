/**
 * `/memory` slash command routing.
 *
 * Kept out of index.ts so the pi registration file stays a shallow adapter.
 * Side effects (notify / confirm) arrive through deps, which also makes the
 * whole command surface testable without a live ExtensionAPI.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatFactLine } from "./prompt.ts";
import type { Fact, MemoryProvider } from "./provider.ts";
import { ProviderManager, resolveDbPath } from "./provider-manager.ts";
import type { CuratedMemoryStore, CuratedTarget } from "./curated-store.ts";
import { CATEGORY_LIST, VALID_CATEGORIES, type Category } from "./schema.ts";
import { projectScopeKey } from "./query-scope.ts";

/** Export facts to a timestamped JSON backup next to the memory DB. */
function backupFactsBeforeClear(facts: Fact[]): string | null {
  try {
    const backup = join(dirname(resolveDbPath()), `memory-backup-${Date.now()}.json`);
    writeFileSync(backup, `${JSON.stringify(facts, null, 2)}\n`, "utf-8");
    return backup;
  } catch {
    return null;
  }
}

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
  if (!trimmed) return { cmd: "help", rest: "" };
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

/** Strip a leading `--limit <n>` flag from the argument tail. */
function parseLimit(text: string): { limit: number | undefined; rest: string } {
  const m = text.match(/--limit\s+(\d+)\s*/i);
  if (!m) return { limit: undefined, rest: text };
  const limit = Number(m[1]);
  return { limit: Number.isInteger(limit) && limit > 0 ? limit : undefined, rest: text.replace(/--limit\s+\d+\s*/i, "").trim() };
}

/**
 * Ownership gate (2.3.4): refuse to remove a fact that belongs to another
 * project's scope.
 */
function ownershipViolation(fact: Fact | null | undefined, currentCwd: string | null): string | null {
  if (!fact) return null;
  if (!fact.scope.startsWith("project:")) return null;
  if (!currentCwd) return `fact #${fact.fact_id} belongs to project scope '${fact.scope}' — refusing without a session cwd`;
  if (fact.scope === projectScopeKey(currentCwd)) return null;
  return `fact belongs to another project ('${fact.scope}') — refusing cross-project removal`;
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
    "  /memory list [--scope global|project] [--limit N] [category] — list facts",
    "  /memory search [--scope global|project] <query>  — full-text search",
    `  /memory add [category] [--scope project] <text>  — add a fact`,
    `    categories: ${CATEGORY_LIST}`,
    "  /memory remove <id>       — delete a fact (asks first; project-scoped facts are protected)",
    "  /memory prune             — delete low-value facts (trust < 0.2, never retrieved; asks first)",
    "  /memory clear [--scope project] — wipe memory (asks first; backs up first)",
    "  /memory count             — show count + db path",
    "  /memory status            — show provider and note status",
    "  /memory setup <provider>  — set backend for next session",
    "  /memory off               — use builtin backend only",
    "  /memory notes             — list curated MEMORY.md / USER.md notes",
    "  /memory notes add user <text>       — add a user profile note",
    "  /memory notes replace memory <old> => <new> — replace a curated note",
    "  /memory related [--scope global|project] <entity> — find facts related to an entity",
    "  /memory reason [--scope global|project] <e1>,<e2> — find facts linking multiple entities",
    "  /memory contradict [--scope global|project] — surface contradictory facts",
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
  // 2.3.1: reads with no explicit --scope default to the CURRENT PROJECT
  // scope (project + global) when a session cwd is known. A cwd alone is not
  // enough — the store only unions project+global when scope="project" AND
  // cwd, otherwise an undefined scope degrades to global-only and project
  // facts stay invisible to every default read/command.
  const readScope = (scope: "global" | "project" | undefined): "global" | "project" | undefined =>
    scope ?? (currentCwd ? "project" : undefined);

  try {
    switch (cmd) {
      case "status": {
        const info = manager.getInfo();
        lines.push(`Memory provider: ${info.name}`);
        lines.push(`Available: ${info.available ? "yes" : "no"}`);
        lines.push(`Facts: ${info.factCount}`);
        if (info.categoryCounts && info.categoryCounts.length > 0) {
          const byCategory = info.categoryCounts.map((c) => `${c.category} ${c.n}`).join(", ");
          lines.push(`By category: ${byCategory}`);
        }
        if (info.dbPath) {
          lines.push(`Database: ${info.dbPath}`);
        }
        lines.push(`Curated notes: ${curated.count()} (MEMORY.md ${curated.usageOf("memory")} chars, USER.md ${curated.usageOf("user")} chars)`);
        const providers = ProviderManager.availableProviders()
          .map((p) => (p === "holographic" ? `${p} (demo stub — use builtin)` : p))
          .join(", ");
        lines.push(`Providers: ${providers}`);
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
        const { limit, rest: catRest } = parseLimit(filterRest);
        const cat = asCategory(catRest) || undefined;
        renderFacts(
          manager.list({ limit: limit ?? 50, scope: readScope(scope), cwd: scopedCwd(readScope(scope)), category: cat }),
          `Memory — ${manager.count()} facts:`,
        );
        if (limit === undefined && manager.count() > 50) {
          lines.push(`(showing 50 of ${manager.count()} — use --limit N or a category filter)`);
        }
        break;
      }
      case "count": {
        const facts = manager.list({ limit: 10_000, minTrust: 0, scope: readScope(undefined), cwd: scopedCwd(readScope(undefined)) });
        const global = facts.filter((f) => f.scope === "global").length;
        const project = facts.length - global;
        announce(`Memory: ${manager.count()} facts (${global} global, ${project} project) at ${resolveDbPath()}; ${curated.count()} curated notes`);
        break;
      }
      case "search": {
        const { scope, rest: queryRest } = parseScope(rest);
        if (!queryRest) {
          announce("Usage: /memory search [--scope global|project] <query>");
          break;
        }
        renderFacts(
          manager.search(queryRest, { limit: 20, minTrust: 0, scope: readScope(scope), cwd: scopedCwd(readScope(scope)) }),
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
        const { scope, rest: entityRest } = parseScope(rest);
        if (!entityRest) {
          announce("Usage: /memory related [--scope global|project] <entity>");
          break;
        }
        // The whole argument is the entity — never treat it as a category
        // (an entity named like a category would silently filter results).
        // Defaults to the current project scope (project + global) when a
        // cwd is known — project facts were previously unreachable here.
        const results = manager.related(entityRest, {
          limit: 20,
          minTrust: 0,
          scope: readScope(scope),
          cwd: scopedCwd(readScope(scope)),
        });
        renderFacts(results, `Related to "${entityRest}":`);
        break;
      }
      case "reason": {
        const { scope, rest: entitiesRest } = parseScope(rest);
        if (!entitiesRest) {
          announce("Usage: /memory reason [--scope global|project] <entity1>,<entity2>[,...]");
          break;
        }
        const entities = entitiesRest.split(",").map((s) => s.trim()).filter(Boolean);
        const results = manager.reason(entities, {
          limit: 20,
          minTrust: 0,
          scope: readScope(scope),
          cwd: scopedCwd(readScope(scope)),
        });
        renderFacts(results, `Reason over [${entities.join(", ")}]:`);
        break;
      }
      case "contradict": {
        const { scope, rest: filterRest } = parseScope(rest);
        const cat = asCategory(filterRest) || undefined;
        const results = manager.contradict({ category: cat, limit: 10, scope: readScope(scope), cwd: scopedCwd(readScope(scope)) });
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
        const target = provider.get(id);
        const violation = ownershipViolation(target, currentCwd);
        if (violation) {
          announce(`Refused: ${violation}`);
          break;
        }
        if (target && !target.scope.startsWith("project:")) {
          const confirmed = await confirm(
            "Remove memory?",
            `Delete #${id}: "${target.content.slice(0, 80)}"? This cannot be undone.`,
          );
          if (!confirmed) {
            announce("Cancelled.");
            break;
          }
        }
        const ok = manager.remove(id);
        announce(ok ? `Removed memory #${id}` : `No such memory #${id}`);
        break;
      }
      case "clear": {
        const { scope, rest: clearRest } = parseScope(rest);
        const projectOnly = scope === "project";
        if (clearRest) {
          announce("Usage: /memory clear [--scope project]");
          break;
        }
        const facts = manager.list({ limit: 50_000, minTrust: 0, scope, cwd: scopedCwd(scope) });
        const scopeLabel = projectOnly
          ? `the current project scope (${facts.length} facts, incl. global)`
          : `ALL memory (${manager.count()} facts across every project + ${curated.count()} curated notes)`;
        const confirmed = await confirm("Clear memory?", `Permanently delete ${scopeLabel}? A backup will be saved first.`);
        if (!confirmed) {
          announce("Cancelled.");
          break;
        }
        // Backup before destructive ops: export current facts to a JSON file.
        const backupPath = backupFactsBeforeClear(facts);
        if (backupPath) lines.push(`Backup saved to ${backupPath}`);
        if (projectOnly) {
          let removed = 0;
          let failed = 0;
          for (const f of facts) {
            if (f.scope !== "global") {
              try {
                manager.remove(f.fact_id);
                removed++;
              } catch {
                failed++;
              }
            }
          }
          const total = removed + failed;
          lines.push(
            failed > 0
              ? `Cleared project-scoped memory (${removed} of ${total} facts removed, ${failed} failed).`
              : `Cleared project-scoped memory (${total} facts removed).`,
          );
        } else {
          manager.clear();
          curated.clear();
          lines.push("Memory cleared.");
        }
        break;
      }
      case "prune": {
        // Manual stand-in for automatic forgetting: drop facts that have
        // never been retrieved and carry near-zero trust — they cost recall
        // slots without ever earning their keep.
        const facts = manager.list({ limit: 50_000, minTrust: 0 });
        const lowValue = facts.filter((f) => f.trust_score < 0.2 && f.retrieval_count === 0);
        const removable = lowValue.filter((f) => !ownershipViolation(f, currentCwd));
        const protectedCount = lowValue.length - removable.length;
        if (removable.length === 0) {
          announce(
            protectedCount > 0
              ? `No removable low-value facts (${protectedCount} low-value fact(s) belong to other projects and were kept).`
              : "No low-value facts (trust < 0.2 and never retrieved).",
          );
          break;
        }
        const confirmed = await confirm(
          "Prune low-value memory?",
          `Delete ${removable.length} fact(s) with trust < 0.2 that were never retrieved?` +
            (protectedCount > 0 ? ` ${protectedCount} other-project fact(s) will be kept.` : ""),
        );
        if (!confirmed) {
          announce("Cancelled.");
          break;
        }
        let removed = 0;
        let failed = 0;
        for (const f of removable) {
          try {
            manager.remove(f.fact_id);
            removed++;
          } catch {
            failed++;
          }
        }
        announce(
          failed > 0
            ? `Pruned ${removed} low-value fact(s), ${failed} failed.`
            : `Pruned ${removed} low-value fact(s).`,
        );
        break;
      }
      case "notes": {
        const { cmd: notesCmd, rest: notesRest } = parseCommand(rest);
        if (!notesCmd || notesCmd === "list" || notesCmd === "show" || notesCmd === "help") {
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
          if (result.success) {
            // The prompt snapshot is frozen per session for prompt-cache
            // stability — say so explicitly, otherwise the user (or the
            // model) concludes the write silently failed (2.3.11).
            announce(`Added ${target} note. Takes effect from the NEXT session (/new) — this session's snapshot is frozen.`);
          } else {
            announce(`Error: ${result.error}`);
          }
          break;
        }
        if (notesCmd === "remove" || notesCmd === "rm") {
          const { target, rest: oldText } = parseNotesTarget(notesRest);
          const result = curated.remove(target, oldText);
          if (result.success) announce(`Removed ${target} note. Takes effect from the NEXT session (/new).`);
          else announce(`Error: ${result.error}`);
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
          if (result.success) announce(`Replaced ${target} note. Takes effect from the NEXT session (/new).`);
          else announce(`Error: ${result.error}`);
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
