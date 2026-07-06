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
import { VALID_CATEGORIES } from "./schema.ts";
import MEMORY_PROMPT_TEMPLATE from "../../prompts/memory-tool.md" with { type: "text" };

const CATEGORY_LIST = VALID_CATEGORIES.join(" | ");

/** Extract a named section from the memory prompt template. */
function extractSection(name: string): string {
  const regex = new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n##|$)`);
  const match = MEMORY_PROMPT_TEMPLATE.match(regex);
  return match?.[1]?.trim() ?? "";
}

export function systemPromptBlock(factCount: number): string {
  if (factCount === 0) {
    const template = extractSection("Long-term memory (empty)");
    return [
      "## Long-term memory",
      template
        .replace("{{categories}}", CATEGORY_LIST)
        .replace(/^[^\n]*\n/, ""),  // Remove the first line (description)
    ].join("\n");
  }
  const template = extractSection("Long-term memory (active)");
  return [
    "## Long-term memory",
    template
      .replace("{{factCount}}", String(factCount))
      .replace(/^[^\n]*\n/, ""),  // Remove the first line (description)
  ].join("\n");
}

/** Render a fact's scope as a short tag (empty for global, "[proj]" for project). */
function scopeTag(scope: string): string {
  if (!scope || scope === "global") return "";
  if (scope.startsWith("project:")) return "[proj] ";
  return `[${scope}] `;
}

export function formatRecallBlock(facts: Fact[]): string {
  if (facts.length === 0) return "";
  const lines = facts.map((f) => {
    const trust = f.trust_score.toFixed(2);
    const cat = f.category !== "general" ? ` (${f.category})` : "";
    const scope = scopeTag(f.scope);
    return `- [${trust}${cat}] ${scope}${f.content} <memory:${f.fact_id}>`;
  });
  return ["## Recalled memory (consult before answering)", ...lines].join("\n");
}

/** Pretty single-fact render for /memory list & friends. */
export function formatFactLine(f: Fact): string {
  const trust = f.trust_score.toFixed(2);
  const cat = f.category;
  const scope = scopeTag(f.scope);
  const tags = f.tags ? ` #${f.tags.split(",").map((t) => t.trim()).filter(Boolean).join(" #")}` : "";
  return `#${f.fact_id} [${trust} ${cat}] ${scope}${tags ? tags + " " : ""}— ${f.content}`;
}