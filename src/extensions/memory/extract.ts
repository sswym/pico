/**
 * Lightweight regex-based fact extraction.
 *
 * Direct port of hermes' `_auto_extract_facts`
 * (~/hermes-agent/plugins/memory/holographic/__init__.py:359-397).
 *
 * Runs at session shutdown over user messages: matches preference and
 * decision patterns, stores hits as facts. Never throws — extraction is
 * best-effort, and a failure must not break shutdown.
 *
 * Extended with correction, failure, insight, convention, and tool_quirk
 * pattern sets, plus project-scoped storage.
 */
import type { MemoryStore } from "./store.ts";
import type { Category, Scope } from "./schema.ts";
import { CORRECTED_BOOST, SCOPE_GLOBAL, SCOPE_PROJECT } from "./schema.ts";

// ---- Pattern sets (all case-insensitive) --------------------------------

const PREF_PATTERNS = [
  /\bI\s+(?:prefer|like|love|use|want|need)\b/i,
  /\bmy\s+(?:favorite|preferred|default)\s+\w+\s+is\b/i,
  /\bI\s+(?:always|never|usually)\b/i,
];

const DECISION_PATTERNS = [
  /\bwe\s+(?:decided|agreed|chose)\s+(?:to\s+)?/i,
  /\bthe\s+project\s+(?:uses|needs|requires)\b/i,
];

/** Patterns that indicate the user is correcting the agent. */
export const CORRECTION_PATTERNS = [
  /\bno[,.]?\s+(?:that'?s?\s+)?(?:wrong|incorrect|not right|not what I meant)\b/i,
  /\b(?:actually|instead|rather),?\s+(?:I\s+)?(?:want|need|prefer|use|meant)\b/i,
  /\bdon't\s+(?:do|use|write|put|add)\s+that\b/i,
  /\bI\s+(?:said|meant)\s+/i,
  /\bwrong[.!]?\s+(?:it(?:'s| is)|that(?:'s| is))\s+(?:should be|supposed to be)\b/i,
  /\b(?:fix|correct)\s+(?:that|this|it)\b/i,
];

/** Patterns that capture learnings from experience. */
const INSIGHT_PATTERNS = [
  /\b(?:note|remember|keep in mind)\s+that\s*[:.]?\s/i,
  /\b(?:insight|lesson|takeaway)\s*:/i,
  /\b(?:this\s+)?(?:always|never)\s+(?:fails|happens|works)\s+(?:because|when|if)\b/i,
];

/** Patterns that indicate something didn't work. */
const FAILURE_PATTERNS = [
  /\b(?:that\s+)?(?:didn't|doesn't|won't)\s+work\b/i,
  /\b(?:error|failure|bug)\s*:\s*.+\b/i,
  /\b(?:crash\w*|timeout|hang)\s+(?:when|if|on)\b/i,
];

/** Patterns that indicate project conventions. */
const CONVENTION_PATTERNS = [
  /\b(?:we\s+)?(?:always|never|must|should)\s+(?:use|follow|write)\s+/i,
  /\bour\s+(?:convention|standard|style|pattern)\s+(?:is|for)\b/i,
  /\b(?:by convention|as a rule|as standard)\b/i,
];

/** Patterns that capture tool-specific quirks or gotchas. */
const TOOL_QUIRK_PATTERNS = [
  /\b(?:works|behaves)\s+(?:differently|oddly|unexpectedly)\s+(?:in|on|with|when)\b/i,
  /\b(?:quirk|gotcha|caveat|limitation)\s*:/i,
  /\b(?:doesn't|don't|won't|can't)\s+support\s+/i,
  /\b(?:this|the|that)\s+\w+\s+(?:doesn't|don't|won't)\s+support\b/i,
];

// ---- Message helpers -----------------------------------------------------

export interface ExtractableMessage {
  role: string;
  content: unknown;
}

/** Extract plain text from a message content field (string or content block array). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => (c as { text?: string }).text ?? "")
      .join(" ");
  }
  return "";
}

// ---- Extraction ----------------------------------------------------------

export interface ExtractOptions {
  cwd?: string;
}

/**
 * Scan user messages for extractable patterns and store them as facts.
 * Returns the count of newly extracted facts.
 *
 * Pattern priority: correction > failure > insight > preference > convention >
 * tool_quirk > decision > (skip). First matching group wins.
 */
export function autoExtractFromMessages(
  store: MemoryStore,
  messages: ExtractableMessage[],
  opts?: ExtractOptions,
): number {
  let extracted = 0;
  const scope: Scope = opts?.cwd ? SCOPE_PROJECT : SCOPE_GLOBAL;

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const text = extractText(msg.content).trim();
    if (text.length < 10) continue;

    let category: Category | undefined;
    if (CORRECTION_PATTERNS.some((p) => p.test(text)))        category = "correction";
    else if (FAILURE_PATTERNS.some((p) => p.test(text)))      category = "failure";
    else if (INSIGHT_PATTERNS.some((p) => p.test(text)))      category = "insight";
    else if (PREF_PATTERNS.some((p) => p.test(text)))         category = "user_pref";
    else if (CONVENTION_PATTERNS.some((p) => p.test(text)))   category = "convention";
    else if (TOOL_QUIRK_PATTERNS.some((p) => p.test(text)))   category = "tool_quirk";
    else if (DECISION_PATTERNS.some((p) => p.test(text)))     category = "project";
    if (!category) continue;

    try {
      store.add(text.slice(0, 400), {
        category,
        scope,
        cwd: opts?.cwd,
        source: "auto",
        trust: category === "correction" ? CORRECTED_BOOST : undefined,
      });
      extracted++;
    } catch {
      // duplicate / invalid — skip silently
    }
  }
  return extracted;
}
