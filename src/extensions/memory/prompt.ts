/**
 * Render helpers for the memory extension.
 *
 * Two main outputs:
 *   1. systemPromptBlock(store) — a short header describing the memory tool;
 *      kept in the system prompt at all times so the model knows the tool exists.
 *   2. formatRecallBlock(facts) — a block injected per-turn with retrieved facts,
 *      so the model can answer without re-searching. Mirrors hermes' prefetch().
 */
import type { Fact } from "./store.ts";

export function systemPromptBlock(factCount: number): string {
  if (factCount === 0) {
    return [
      "## Long-term memory",
      "Your `memory` tool is empty. Proactively call `memory(action=\"add\", content=..., category=\"user_pref\"|\"project\"|\"tool\"|\"general\")` whenever the user shares a durable preference, decision, or stack choice they would expect you to remember next session.",
      "Before answering questions about the user or project, call `memory(action=\"search\", query=...)` first.",
    ].join("\n");
  }
  return [
    "## Long-term memory",
    `Active. ${factCount} facts stored, weighted by trust score (0..1). Call \`memory(action=\"search\", query=...)\` before answering questions about the user or project; call \`memory(action=\"add\", ...)\` when the user shares something durable; call \`memory(action=\"feedback\", fact_id=..., helpful=true|false)\` after using a fact to train trust.`,
  ].join("\n");
}

export function formatRecallBlock(facts: Fact[]): string {
  if (facts.length === 0) return "";
  const lines = facts.map((f) => {
    const trust = f.trust_score.toFixed(2);
    const cat = f.category !== "general" ? ` (${f.category})` : "";
    return `- [${trust}${cat}] ${f.content} <memory:${f.fact_id}>`;
  });
  return ["## Recalled memory (consult before answering)", ...lines].join("\n");
}

/** Pretty single-fact render for /memory list & friends. */
export function formatFactLine(f: Fact): string {
  const trust = f.trust_score.toFixed(2);
  const cat = f.category;
  const tags = f.tags ? ` #${f.tags.split(",").map((t) => t.trim()).filter(Boolean).join(" #")}` : "";
  return `#${f.fact_id} [${trust} ${cat}]${tags} — ${f.content}`;
}
