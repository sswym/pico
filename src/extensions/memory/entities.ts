/**
 * Entity extraction and resolution for the memory store.
 *
 * Ported from hermes-agent's holographic store.py:
 * - Regex-based entity extraction (capitalized words, quoted terms, AKA patterns)
 * - Entity resolution with alias support
 * - Fact-entity linking
 *
 * Entities unlock probe/related/reason queries that FTS5 alone can't do.
 */

const RE_CAPITALIZED = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
const RE_DOUBLE_QUOTE = /"([^"]+)"/g;
const RE_SINGLE_QUOTE = /'([^']+)'/g;
const RE_AKA = /\b(\w+)\s+aka\s+(\w+)\b/gi;

/** Extract entity candidates from text using simple regex rules. */
export function extractEntities(text: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  const add = (name: string) => {
    const stripped = name.trim();
    if (stripped && !seen.has(stripped.toLowerCase())) {
      seen.add(stripped.toLowerCase());
      candidates.push(stripped);
    }
  };

  for (const m of text.matchAll(RE_CAPITALIZED)) add(m[1]!);
  for (const m of text.matchAll(RE_DOUBLE_QUOTE)) add(m[1]!);
  for (const m of text.matchAll(RE_SINGLE_QUOTE)) add(m[1]!);
  for (const m of text.matchAll(RE_AKA)) {
    add(m[1]!);
    add(m[2]!);
  }

  return candidates;
}
