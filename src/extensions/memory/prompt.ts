/**
 * Render helpers for the memory extension.
 *
 * Two main outputs:
 *   1. systemPromptBlock(store) — a short header describing the memory tool;
 *      kept in the system prompt at all times so the model knows the tool exists.
 *   2. formatRecallBlock(facts) — a block injected per-turn with retrieved facts,
 *      so the model can answer without re-searching. Mirrors hermes' prefetch().
 */
import type { Fact } from "./provider.ts";
import { VALID_CATEGORIES } from "./schema.ts";
import MEMORY_PROMPT_TEMPLATE from "../../prompts/memory-tool.md" with { type: "text" };

const CATEGORY_LIST = VALID_CATEGORIES.join(" | ");

/** Extract a named section from the memory prompt template. */
function extractSection(...names: string[]): string {
  for (const name of names) {
    const regex = new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n##|$)`);
    const match = MEMORY_PROMPT_TEMPLATE.match(regex);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return "";
}

function stripSectionDescription(template: string): string {
  if (!template) return "";
  const match = template.match(/^[^\n]*\n([\s\S]*)$/);
  return (match?.[1] ?? template).trim();
}

function fillTemplate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

function sectionBody(template: string, fallback: string, values: Record<string, string>): string {
  const source = template || fallback;
  return stripSectionDescription(fillTemplate(source, values));
}

export function systemPromptBlock(factCount: number): string {
  if (factCount === 0) {
    const template = extractSection("Long-term memory (empty)", "长期记忆（空）");
    return [
      "## Long-term memory",
      sectionBody(
        template,
        "Memory is available. Use `memory(action=\"search\", query=...)` before answering questions about the user or project. Categories: {{categories}}.",
        { categories: CATEGORY_LIST },
      ),
    ].join("\n");
  }
  const template = extractSection("Long-term memory (active)", "长期记忆（活跃）");
  return [
    "## Long-term memory",
    sectionBody(
      template,
      "Memory is active with {{factCount}} stored facts. Search memory before answering questions about the user or project.",
      { factCount: String(factCount) },
    ),
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
