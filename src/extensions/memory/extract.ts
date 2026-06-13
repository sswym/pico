/**
 * Lightweight regex-based fact extraction.
 *
 * Direct port of hermes' `_auto_extract_facts`
 * (~/hermes-agent/plugins/memory/holographic/__init__.py:359-397).
 *
 * Runs at session shutdown over user messages: matches preference and
 * decision patterns, stores hits as facts. Never throws — extraction is
 * best-effort, and a failure must not break shutdown.
 */
import type { MemoryStore } from "./store.ts";

const PREF_PATTERNS = [
  /\bI\s+(?:prefer|like|love|use|want|need)\b/i,
  /\bmy\s+(?:favorite|preferred|default)\s+\w+\s+is\b/i,
  /\bI\s+(?:always|never|usually)\b/i,
];

const DECISION_PATTERNS = [
  /\bwe\s+(?:decided|agreed|chose)\s+(?:to\s+)?/i,
  /\bthe\s+project\s+(?:uses|needs|requires)\b/i,
];

export interface ExtractableMessage {
  role: string;
  content: unknown;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => (c as { text?: string }).text ?? "")
      .join(" ");
  }
  return "";
}

export function autoExtractFromMessages(store: MemoryStore, messages: ExtractableMessage[]): number {
  let extracted = 0;
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const text = extractText(msg.content).trim();
    if (text.length < 10) continue;

    let category: "user_pref" | "project" | undefined;
    if (PREF_PATTERNS.some((p) => p.test(text))) category = "user_pref";
    else if (DECISION_PATTERNS.some((p) => p.test(text))) category = "project";
    if (!category) continue;

    try {
      store.add(text.slice(0, 400), { category });
      extracted++;
    } catch {
      // duplicate / invalid — skip silently
    }
  }
  return extracted;
}
