/**
 * Entity extraction and resolution for the memory store.
 *
 * Ported from hermes-agent's holographic store.py:
 * - Regex-based entity extraction (capitalized words, quoted terms, AKA patterns)
 * - Entity resolution with alias support
 * - Fact-entity linking
 *
 * Entities unlock probe/related/reason queries that FTS5 alone can't do.
 *
 * Extraction rules (extended beyond hermes' English-only regexes for the
 * pico use case, which mixes Chinese prose with ASCII code identifiers
 * like npm / bun / Postgres / TypeScript):
 *   - Multi-word capitalized proper nouns (English)         -> "Alice Wong"
 *   - Single quoted terms (double / single / 「」)           -> "Redis"
 *   - X aka Y alias patterns                                -> X, Y
 *   - ASCII identifier tokens (npm, bun, github, Postgres)  -> filtered via stopword list
 */

const RE_CAPITALIZED = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
const RE_DOUBLE_QUOTE = /"([^"]+)"/g;
const RE_SINGLE_QUOTE = /'([^']+)'/g;
const RE_CJK_QUOTE = /[「『]([^」』]+)[」』]/g;
const RE_AKA = /\b(\w+)\s+aka\s+(\w+)\b/gi;

// ASCII identifier token: starts with a letter, may contain alphanumerics,
// dots, slashes, underscores, hyphens (covers npm, bun, github.com, postgres).
const RE_IDENTIFIER = /\b[A-Za-z][A-Za-z0-9_./-]*\b/g;

// Common English function words that should never be treated as entities.
const IDENTIFIER_STOPWORDS = new Set([
  "we", "use", "uses", "used", "using", "the", "for", "and", "our", "this",
  "that", "these", "those", "with", "from", "they", "them", "their", "you",
  "your", "are", "were", "was", "is", "it", "its", "in", "on", "of", "to",
  "at", "by", "as", "or", "not", "no", "do", "don", "does", "did", "but",
  "if", "when", "actually", "rather", "instead", "than", "prefer", "like",
  "want", "need", "decided", "agreed", "chose", "require", "requires", "manage",
  "manages", "managed", "built", "builds", "rewrote", "rebuilt", "works", "work",
  "avoid", "hate", "love", "default", "favorite", "preferred", "always", "never",
]);

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
  for (const m of text.matchAll(RE_CJK_QUOTE)) add(m[1]!);
  for (const m of text.matchAll(RE_AKA)) {
    add(m[1]!);
    add(m[2]!);
  }
  // ASCII identifier tokens (code symbols / tech nouns). Filtered against a
  // stopword list so ordinary English prose words are not captured as entities.
  for (const m of text.matchAll(RE_IDENTIFIER)) {
    const tok = m[0]!;
    if (tok.length < 2) continue;
    if (IDENTIFIER_STOPWORDS.has(tok.toLowerCase())) continue;
    add(tok);
  }

  return candidates;
}
