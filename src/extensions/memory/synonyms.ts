/**
 * Lightweight synonym / alias expansion for memory retrieval.
 *
 * The builtin store uses TF-IDF sparse vectors (no embeddings — see
 * retrieval.ts). Pure keyword overlap cannot recall paraphrases or synonym
 * swaps. This module adds a small, dependency-free expansion layer so that
 * obvious aliases (TS <-> TypeScript, npm <-> node) and common Chinese
 * near-synonyms (简洁 <-> 精简, 数据库 <-> db) still match.
 *
 * NOTE: this is NOT true semantic search. Antonyms (简洁 vs 啰嗦) and
 * deep paraphrases are out of scope; a real embedding model would be needed
 * for that. This layer only bridges trivial synonym/alias gaps.
 */

/** Canonical alias map: alias -> canonical term (lowercased). */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  "node.js": "node",
  nodejs: "node",
  npm: "npm",
  yarn: "yarn",
  pnpm: "pnpm",
  bun: "bun",
  pg: "postgres",
  postgresql: "postgres",
  sqlite: "sqlite",
  db: "database",
  "数据库": "database",
  "存储": "database",
  "后端": "backend",
  "前端": "frontend",
  "记忆": "memory",
  "偏好": "preference",
  "喜欢": "preference",
  "倾向": "preference",
};

/** Synonym groups: terms that should recall each other (near-synonyms). */
const SYNONYM_GROUPS: string[][] = [
  ["简洁", "精简", "扼要", "简练"],
  ["啰嗦", "冗余", "繁琐", "冗长"],
  ["清晰", "清楚", "明了"],
  ["快速", "高效", "迅捷"],
  ["稳定", "健壮", "可靠"],
  ["config", "configuration", "配置"],
  ["test", "测试", "testing"],
  ["build", "构建", "编译"],
  ["deploy", "部署", "发布"],
  ["bug", "缺陷", "故障"],
  ["api", "接口", "endpoint"],
];

// Precompute reverse lookup: term -> expanded set.
const EXPANSION = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
  for (const term of group) {
    const set = EXPANSION.get(term) ?? new Set<string>();
    for (const other of group) if (other !== term) set.add(other);
    EXPANSION.set(term, set);
  }
}

/** Normalize a single token to its canonical alias (if any). */
export function normalizeTerm(token: string): string {
  const key = token.toLowerCase();
  if (ALIASES[key]) return ALIASES[key]!;
  // Strip Chinese plural/aspect suffixes only — never English suffixes
  // (stripping "s"/"ing" would corrupt code identifiers like postgres->postgre).
  const stripped = key.replace(/(?:的|了|吗|呢|们)$/, "");
  return ALIASES[stripped] ?? stripped;
}

  /**
 * Expand a list of query tokens with their synonyms and canonical aliases.
 * Returns the original tokens plus expansions (duplicates removed).
 * Expansion weight is handled by the caller (lower weight for expansions).
 */
export function expandQuery(tokens: string[]): { term: string; weight: number }[] {
  const out: { term: string; weight: number }[] = [];
  const seen = new Set<string>();

  const push = (t: string, w: number) => {
    const norm = normalizeTerm(t);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push({ term: norm, weight: w });
  };

  for (const t of tokens) {
    const lower = t.toLowerCase();
    // Original term (full weight).
    push(lower, 1.0);
    // Canonical alias of the original.
    const canon = ALIASES[lower];
    if (canon && canon !== lower) push(canon, 0.9);
    // Synonym group members (reduced weight).
    const syns = EXPANSION.get(lower);
    if (syns) {
      for (const s of syns) push(s, 0.6);
    }
  }

  return out;
}
