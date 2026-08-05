/**
 * FactRetriever — hybrid keyword/semantic retrieval for the memory store.
 *
 * Ported from hermes-agent's holographic/retrieval.py, replacing HRR vectors
 * with TF-IDF sparse vectors (pure TS, no numpy dependency).
 *
 * Pipeline: FTS5 candidates -> Jaccard rerank -> TF-IDF similarity -> trust weighting
 */
import type { Database } from "bun:sqlite";
import { tokenize, filterStopwords, cosineSimilarity, vectorFromJson, type SparseVector } from "./tfidf.ts";
import { expandQuery, normalizeTerm } from "./synonyms.ts";
import type { Scope } from "./schema.ts";
import { scopeFilter, scoreScopeBoost } from "./query-scope.ts";

/** FTS5 stopwords. */
const FTS_STOPWORDS: Record<string, true> = {
  "a": true, "about": true, "above": true, "after": true, "again": true,
  "all": true, "am": true, "an": true, "and": true, "any": true,
  "are": true, "as": true, "at": true, "be": true, "because": true,
  "been": true, "before": true, "being": true, "between": true,
  "both": true, "but": true, "by": true, "can": true, "could": true,
  "did": true, "do": true, "does": true, "doing": true, "don": true,
  "down": true, "during": true, "each": true, "few": true, "for": true,
  "from": true, "further": true, "had": true, "has": true, "have": true,
  "having": true, "he": true, "her": true, "here": true, "hers": true,
  "herself": true, "him": true, "himself": true, "his": true, "how": true,
  "i": true, "if": true, "in": true, "into": true, "is": true, "it": true,
  "its": true, "itself": true, "just": true, "me": true, "more": true,
  "most": true, "my": true, "myself": true, "no": true, "nor": true,
  "not": true, "now": true, "of": true, "off": true, "on": true,
  "once": true, "only": true, "or": true, "other": true, "our": true,
  "ours": true, "ourselves": true, "out": true, "over": true, "own": true,
  "same": true, "she": true, "should": true, "so": true, "some": true,
  "such": true, "than": true, "that": true, "the": true, "their": true,
  "theirs": true, "them": true, "themselves": true, "then": true,
  "there": true, "these": true, "they": true, "this": true, "those": true,
  "through": true, "to": true, "too": true, "under": true, "until": true,
  "up": true, "very": true, "was": true, "we": true, "were": true,
  "what": true, "when": true, "where": true, "which": true, "while": true,
  "who": true, "whom": true, "why": true, "will": true, "with": true,
  "would": true, "you": true, "your": true, "yours": true,
  "yourself": true, "yourselves": true,
};

/** Convert a natural-language query to FTS5-safe OR expression. */
export function sanitizeFtsQuery(query: string): string {
  if (!query) return "";
  const FTS_SPECIAL = /["'*^:()+\-]/g;
  const tokens: string[] = [];
  for (const raw of query.toLowerCase().split(/\s+/)) {
    const cleaned = raw.replace(/^[.,;:!?'"()[\]{}#@<>]+|[.,;:!?'"()[\]{}#@<>]+$/g, "").replace(FTS_SPECIAL, "");
    if (cleaned.length < 2) continue;
    if (FTS_STOPWORDS[cleaned]) continue;
    tokens.push(`"${cleaned}"`);
  }
  // No usable tokens (all stopwords / too short): return empty so the caller
  // skips the match instead of feeding raw, unsanitised text to FTS5 (which
  // could contain FTS5 syntax characters and raise a query error).
  if (tokens.length === 0) return "";
  return tokens.join(" OR ");
}

/** Escape LIKE wildcards so entity names containing %/_ are matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Whitespace tokenization for Jaccard similarity. */
function jaccardTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of text.toLowerCase().split(/\s+/)) {
    const cleaned = word.replace(/^[.,;:!?'"()[\]{}#@<>]+|[.,;:!?'"()[\]{}#@<>]+$/g, "");
    if (cleaned) tokens.add(cleaned);
  }
  return tokens;
}

/** Jaccard similarity: |A ∩ B| / |A ∪ B|. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Result row from the facts table. */
export interface FactRow {
  fact_id: number;
  content: string;
  category: string;
  tags: string;
  trust_score: number;
  retrieval_count: number;
  helpful_count: number;
  created_at: string;
  updated_at: string;
  scope: string;
  correction_of: number | null;
  source: string;
  tfidf_vector: string;
  fts_rank?: number;
}

/** Scored result with combined relevance score. */
export interface ScoredFact extends FactRow {
  score: number;
}

/** Contradiction pair result. */
export interface ContradictionResult {
  fact_a: FactRow;
  fact_b: FactRow;
  entity_overlap: number;
  content_similarity: number;
  contradiction_score: number;
  shared_entities: string[];
}

export interface RetrieverOptions {
  ftsWeight?: number;
  jaccardWeight?: number;
  tfidfWeight?: number;
  /** Temporal decay half-life in days. 0 = disabled. Default: 0. */
  temporalDecayHalfLife?: number;
}

export interface RetrievalQueryOptions {
  category?: string;
  minTrust?: number;
  limit?: number;
  scope?: Scope;
  cwd?: string;
}

export class FactRetriever {
  private readonly db: Database;
  readonly ftsWeight: number;
  readonly jaccardWeight: number;
  readonly tfidfWeight: number;
  readonly temporalDecayHalfLife: number;

  constructor(db: Database, opts: RetrieverOptions = {}) {
    this.db = db;
    this.ftsWeight = opts.ftsWeight ?? 0.4;
    this.jaccardWeight = opts.jaccardWeight ?? 0.3;
    this.tfidfWeight = opts.tfidfWeight ?? 0.3;
    this.temporalDecayHalfLife = opts.temporalDecayHalfLife ?? 0;
  }

  /**
   * Hybrid search: FTS5 candidates -> Jaccard rerank -> TF-IDF similarity -> trust weighting.
   */
  search(query: string, opts: RetrievalQueryOptions = {}): ScoredFact[] {
    const minTrust = opts.minTrust ?? 0.3;
    const limit = Math.max(1, opts.limit ?? 10);

    // Expand query with synonyms/aliases for both FTS5 candidate retrieval
    // and lexical scoring, so paraphrases (TS vs TypeScript) still match.
    const expandedTerms = expandQuery(filterStopwords(tokenize(query))).map((e) => e.term);
    const expandedQuery = expandedTerms.join(" ");

    const candidates = this.ftsCandidates(expandedQuery, opts, minTrust, limit * 3);
    // 2.3.9: FTS silence must not be treated as "no matches" — fall back to
    // substring ranking (Chinese queries almost always miss FTS5's run-based
    // tokenizer), mirroring MemoryStore.search's behaviour.
    if (candidates.length === 0) return this._substringFallback(expandedTerms, opts, minTrust, limit);

    const queryTokens = jaccardTokens(expandedQuery);
    const idfAvailable = candidates.some((c) => c.tfidf_vector && c.tfidf_vector !== "{}");

    const scored: ScoredFact[] = [];
    for (const fact of candidates) {
      const contentTokens = jaccardTokens(fact.content);
      const tagTokens = jaccardTokens(fact.tags);
      const allTokens = new Set([...contentTokens, ...tagTokens]);

      const jac = jaccardSimilarity(queryTokens, allTokens);
      const ftsRank = fact.fts_rank ?? 0;

      let tfidfSim = 0.5;
      if (idfAvailable && fact.tfidf_vector && fact.tfidf_vector !== "{}") {
        const factVec = vectorFromJson(fact.tfidf_vector);
        // Expand query with synonyms/aliases so paraphrases still match.
        const queryTerms = filterStopwords(tokenize(query));
        const expanded = expandQuery(queryTerms);
        const qVec: SparseVector = {};
        for (const { term, weight } of expanded) {
          qVec[term] = (qVec[term] ?? 0) + weight / expanded.length;
        }
        tfidfSim = cosineSimilarity(qVec, factVec);
      }

      const relevance =
        this.ftsWeight * ftsRank +
        this.jaccardWeight * jac +
        this.tfidfWeight * tfidfSim;
      let score = scoreScopeBoost(relevance * fact.trust_score, fact.scope, scopeFilter(opts).projectScope);
      score *= this._temporalDecay(fact.updated_at);
      scored.push({ ...fact, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Entity probe: find facts linked to a specific entity.
   */
  probe(entity: string, opts: RetrievalQueryOptions = {}): ScoredFact[] {
    const minTrust = opts.minTrust ?? 0.3;
    const limit = Math.max(1, opts.limit ?? 10);
    const name = entity.trim().toLowerCase();
    if (!name) return [];

    const entityRow = this.db
      .query<{ entity_id: number }, [string, string]>(
        "SELECT entity_id FROM entities WHERE LOWER(name) = ? OR (',' || aliases || ',') LIKE ? ESCAPE '\\'",
      )
      .get(name, `%,${escapeLike(name)},%`);

    if (!entityRow) return this.search(`"${entity}"`, opts);

    const scope = scopeFilter(opts);

    // Build parameterized query
    if (opts.category) {
      const rows = this.db
        .query<FactRow, [number, number, ...string[], string, number]>(
          `SELECT f.* FROM facts f
           JOIN fact_entities fe ON fe.fact_id = f.fact_id
           WHERE fe.entity_id = ? AND f.trust_score >= ? ${scope.clause} AND f.category = ?
           ORDER BY f.trust_score DESC, f.fact_id DESC
           LIMIT ?`,
        )
        .all(entityRow.entity_id, minTrust, ...scope.params, opts.category, limit) as FactRow[];
      return rows.map((r) => ({ ...r, score: scoreScopeBoost(r.trust_score, r.scope, scope.projectScope) }));
    }

    const rows = this.db
      .query<FactRow, [number, number, ...string[], number]>(
        `SELECT f.* FROM facts f
         JOIN fact_entities fe ON fe.fact_id = f.fact_id
         WHERE fe.entity_id = ? AND f.trust_score >= ? ${scope.clause}
         ORDER BY f.trust_score DESC, f.fact_id DESC
         LIMIT ?`,
      )
      .all(entityRow.entity_id, minTrust, ...scope.params, limit) as FactRow[];
    return rows.map((r) => ({ ...r, score: scoreScopeBoost(r.trust_score, r.scope, scope.projectScope) }));
  }

  /**
   * Related: find facts that share entities with the given entity.
   */
  related(entity: string, opts: RetrievalQueryOptions = {}): ScoredFact[] {
    const minTrust = opts.minTrust ?? 0.3;
    const limit = Math.max(1, opts.limit ?? 10);
    const name = entity.trim().toLowerCase();
    if (!name) return [];

    const entityRow = this.db
      .query<{ entity_id: number }, [string, string]>(
        "SELECT entity_id FROM entities WHERE LOWER(name) = ? OR (',' || aliases || ',') LIKE ? ESCAPE '\\'",
      )
      .get(name, `%,${escapeLike(name)},%`);

    if (!entityRow) return this.search(entity, opts);
    const scope = scopeFilter(opts);

    if (opts.category) {
      const rows = this.db
        .query<FactRow & { co_occurrence: number }, [number, number, ...string[], string, number]>(
          `SELECT f3.*, COUNT(DISTINCT fe2.entity_id) as co_occurrence
           FROM fact_entities fe1
           JOIN fact_entities fe2 ON fe2.entity_id = fe1.entity_id AND fe2.fact_id != fe1.fact_id
           JOIN facts f3 ON f3.fact_id = fe2.fact_id
           WHERE fe1.entity_id = ? AND f3.trust_score >= ? ${scopeFilter(opts, "f3").clause} AND f3.category = ?
           GROUP BY f3.fact_id
           ORDER BY co_occurrence DESC, f3.trust_score DESC
           LIMIT ?`,
        )
        .all(entityRow.entity_id, minTrust, ...scope.params, opts.category, limit) as (FactRow & { co_occurrence: number })[];
      return rows.map((r) => ({ ...r, score: scoreScopeBoost((r.co_occurrence * 0.5) + (r.trust_score * 0.5), r.scope, scope.projectScope) }));
    }

    const rows = this.db
      .query<FactRow & { co_occurrence: number }, [number, number, ...string[], number]>(
        `SELECT f3.*, COUNT(DISTINCT fe2.entity_id) as co_occurrence
         FROM fact_entities fe1
         JOIN fact_entities fe2 ON fe2.entity_id = fe1.entity_id AND fe2.fact_id != fe1.fact_id
         JOIN facts f3 ON f3.fact_id = fe2.fact_id
         WHERE fe1.entity_id = ? AND f3.trust_score >= ? ${scopeFilter(opts, "f3").clause}
         GROUP BY f3.fact_id
         ORDER BY co_occurrence DESC, f3.trust_score DESC
         LIMIT ?`,
      )
      .all(entityRow.entity_id, minTrust, ...scope.params, limit) as (FactRow & { co_occurrence: number })[];
    return rows.map((r) => ({ ...r, score: scoreScopeBoost((r.co_occurrence * 0.5) + (r.trust_score * 0.5), r.scope, scope.projectScope) }));
  }

  /**
   * Reason: multi-entity compositional query.
   * Finds facts linked to ALL given entities (AND semantics).
   */
  reason(entities: string[], opts: RetrievalQueryOptions = {}): ScoredFact[] {
    if (entities.length === 0) return [];
    const minTrust = opts.minTrust ?? 0.3;
    const limit = Math.max(1, opts.limit ?? 10);

    // Resolve entity IDs
    const entityIds: number[] = [];
    for (const name of entities) {
      const row = this.db
        .query<{ entity_id: number }, [string, string]>(
          "SELECT entity_id FROM entities WHERE LOWER(name) = ? OR (',' || aliases || ',') LIKE ? ESCAPE '\\'",
        )
        .get(name.trim().toLowerCase(), `%,${escapeLike(name.trim().toLowerCase())},%`);
      if (row) entityIds.push(row.entity_id);
    }

    if (entityIds.length === 0) return this.search(entities.join(" "), opts);

    // Build IN clause
    const placeholders = entityIds.map(() => "?").join(",");
    const scope = scopeFilter(opts);

    if (opts.category) {
      const rows = this.db
        .query<FactRow, Array<number | string>>(
          `SELECT f.* FROM facts f
           JOIN fact_entities fe ON fe.fact_id = f.fact_id
           WHERE fe.entity_id IN (${placeholders}) AND f.category = ? ${scope.clause}
           GROUP BY f.fact_id
           HAVING COUNT(DISTINCT fe.entity_id) = ?
           AND f.trust_score >= ?
           ORDER BY f.trust_score DESC
           LIMIT ?`,
        )
        .all(...entityIds, opts.category, ...scope.params, entityIds.length, minTrust, limit) as FactRow[];
      return rows.map((r) => ({ ...r, score: scoreScopeBoost(r.trust_score, r.scope, scope.projectScope) }));
    }

    const rows = this.db
        .query<FactRow, Array<number | string>>(
        `SELECT f.* FROM facts f
         JOIN fact_entities fe ON fe.fact_id = f.fact_id
         WHERE fe.entity_id IN (${placeholders}) ${scope.clause}
         GROUP BY f.fact_id
         HAVING COUNT(DISTINCT fe.entity_id) = ?
         AND f.trust_score >= ?
         ORDER BY f.trust_score DESC
         LIMIT ?`,
      )
      .all(...entityIds, ...scope.params, entityIds.length, minTrust, limit) as FactRow[];
    return rows.map((r) => ({ ...r, score: scoreScopeBoost(r.trust_score, r.scope, scope.projectScope) }));
  }

  /**
   * Contradict: find potentially contradictory facts via entity overlap + content divergence.
   * Honors the same scope/cwd isolation as search/probe so facts from other
   * projects never surface in this project's contradiction report.
   */
  contradict(opts: { category?: string; threshold?: number; limit?: number; scope?: Scope; cwd?: string } = {}): ContradictionResult[] {
    const threshold = opts.threshold ?? 0.3;
    // Negative/zero limits would invert or unboundedly slice the result list.
    const limit = Math.max(1, Math.floor(opts.limit ?? 10));
    const MAX_FACTS = 500;
    const scope = scopeFilter(opts);

    let rows: FactRow[];
    if (opts.category) {
      rows = this.db
        .query<FactRow, [string, ...string[], number]>(
          `SELECT DISTINCT f.* FROM facts f
           JOIN fact_entities fe ON fe.fact_id = f.fact_id
           WHERE f.category = ? ${scope.clause}
           ORDER BY f.updated_at DESC
           LIMIT ?`,
        )
        .all(opts.category, ...scope.params, MAX_FACTS) as FactRow[];
    } else {
      rows = this.db
        .query<FactRow, [...string[], number]>(
          `SELECT DISTINCT f.* FROM facts f
           JOIN fact_entities fe ON fe.fact_id = f.fact_id
           WHERE 1=1 ${scope.clause}
           ORDER BY f.updated_at DESC
           LIMIT ?`,
        )
        .all(...scope.params, MAX_FACTS) as FactRow[];
    }

    if (rows.length < 2) return [];

    if (rows.length >= MAX_FACTS) {
      console.warn(
        `[pico memory] contradict() compared only the ${MAX_FACTS} most recently updated facts; ` +
          `older facts were not analysed.`,
      );
    }

    // Build entity sets per fact. A single batched query avoids one round-trip
    // per fact (previously O(N) subqueries for up to MAX_FACTS rows).
    const factEntities = new Map<number, Set<string>>();
    for (const row of rows) factEntities.set(row.fact_id, new Set());
    const ids = rows.map((r) => r.fact_id);
    const idPlaceholders = ids.map(() => "?").join(",");
    const entityRows = this.db
      .query<{ fact_id: number; name: string }, number[]>(
        `SELECT fe.fact_id, e.name FROM entities e
         JOIN fact_entities fe ON fe.entity_id = e.entity_id
         WHERE fe.fact_id IN (${idPlaceholders})`,
      )
      .all(...ids) as { fact_id: number; name: string }[];
    for (const er of entityRows) {
      factEntities.get(er.fact_id)?.add(er.name.toLowerCase());
    }

    const contradictions: ContradictionResult[] = [];

    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const f1 = rows[i]!;
        const f2 = rows[j]!;
        const ents1 = factEntities.get(f1.fact_id)!;
        const ents2 = factEntities.get(f2.fact_id)!;

        if (ents1.size === 0 || ents2.size === 0) continue;

        const entityOverlap = jaccardSimilarity(ents1, ents2);
        if (entityOverlap < 0.3) continue;

        const contentSim = jaccardSimilarity(jaccardTokens(f1.content), jaccardTokens(f2.content));
        const contradictionScore = entityOverlap * (1.0 - contentSim);

        if (contradictionScore >= threshold) {
          const shared = [...ents1].filter((e) => ents2.has(e));
          contradictions.push({
            fact_a: f1,
            fact_b: f2,
            entity_overlap: Math.round(entityOverlap * 1000) / 1000,
            content_similarity: Math.round(contentSim * 1000) / 1000,
            contradiction_score: Math.round(contradictionScore * 1000) / 1000,
            shared_entities: shared,
          });
        }
      }
    }

    contradictions.sort((a, b) => b.contradiction_score - a.contradiction_score);
    return contradictions.slice(0, limit);
  }

  /**
   * Substring fallback used when FTS5 returns nothing: ranks facts by raw
   * term inclusion (canonical alias aware) with trust weighting, and applies
   * a negation penalty so "我不用 bun" never ranks as recall for "bun".
   */
  private _substringFallback(terms: string[], opts: RetrievalQueryOptions, minTrust: number, limit: number): ScoredFact[] {
    const canonicalTerms = Array.from(new Set(terms.map(normalizeTerm).filter((t) => t.length > 0)));
    if (canonicalTerms.length === 0) return [];
    const scope = scopeFilter(opts);

    const sql = opts.category
      ? `SELECT f.* FROM facts f WHERE f.trust_score >= ? ${scope.clause} AND f.category = ? LIMIT ?`
      : `SELECT f.* FROM facts f WHERE f.trust_score >= ? ${scope.clause} LIMIT ?`;
    const rows = opts.category
      ? this.db.query<FactRow, [...(number | string)[]]>(sql).all(minTrust, ...scope.params, opts.category, 500) as FactRow[]
      : this.db.query<FactRow, [...(number | string)[]]>(sql).all(minTrust, ...scope.params, 500) as FactRow[];

    const scored: ScoredFact[] = [];
    for (const fact of rows) {
      const raw = `${fact.content} ${fact.tags}`;
      const content = raw.toLowerCase();
      const canonical = new Set(filterStopwords(tokenize(raw)).map(normalizeTerm));
      let score = 0;
      let negated = false;
      for (const term of canonicalTerms) {
        if (canonical.has(term) || content.includes(term)) {
          score += term.length >= 4 ? 2 : 1;
          if (!negated) {
            let idx = content.indexOf(term);
            while (idx >= 0) {
              if (this._negationNear(content, idx, term)) { negated = true; break; }
              idx = content.indexOf(term, idx + Math.max(1, term.length));
            }
          }
        }
      }
      if (score === 0) continue;
      if (negated) score *= 0.2;
      let s = scoreScopeBoost(score * fact.trust_score, fact.scope, scope.projectScope);
      s *= this._temporalDecay(fact.updated_at);
      scored.push({ ...fact, score: s });
    }
    scored.sort((a, b) => b.score - a.score || b.fact_id - a.fact_id);
    return scored.slice(0, limit);
  }

  /** Negation words that flip a fact's assertion about a nearby term. */
  private static readonly NEGATION_RE = /(?:不|没|别|无|非|莫|never|not\b|no\b|without|instead\s+of)/i;

  private _negationNear(text: string, idx: number, token: string): boolean {
    const before = text.slice(Math.max(0, idx - 4), idx);
    const after = text.slice(idx + token.length, idx + token.length + 2);
    return FactRetriever.NEGATION_RE.test(before) || FactRetriever.NEGATION_RE.test(after);
  }

  /** Get raw FTS5 candidates from the store. */
  private ftsCandidates(query: string, opts: RetrievalQueryOptions, minTrust: number, limit: number): FactRow[] {
    const matchQuery = sanitizeFtsQuery(query);
    if (!matchQuery) return [];
    const scope = scopeFilter(opts);

    try {
      if (opts.category) {
        const rows = this.db
          .query<FactRow & { fts_rank_raw: number }, [string, number, ...string[], string, number]>(
            `SELECT f.*, facts_fts.rank as fts_rank_raw
             FROM facts_fts
             JOIN facts f ON f.fact_id = facts_fts.rowid
             WHERE facts_fts MATCH ? AND f.trust_score >= ? ${scope.clause} AND f.category = ?
             ORDER BY facts_fts.rank
             LIMIT ?`,
          )
          .all(matchQuery, minTrust, ...scope.params, opts.category, limit) as (FactRow & { fts_rank_raw: number })[];

        if (rows.length === 0) return [];
        const rawRanks = rows.map((r) => Math.abs(r.fts_rank_raw));
        const maxRank = Math.max(...rawRanks, 1e-6);
        return rows.map((r) => {
          const { fts_rank_raw: _, ...rest } = r;
          return { ...rest, fts_rank: Math.abs(r.fts_rank_raw) / maxRank };
        });
      }

      const rows = this.db
        .query<FactRow & { fts_rank_raw: number }, [string, number, ...string[], number]>(
          `SELECT f.*, facts_fts.rank as fts_rank_raw
           FROM facts_fts
           JOIN facts f ON f.fact_id = facts_fts.rowid
           WHERE facts_fts MATCH ? AND f.trust_score >= ? ${scope.clause}
           ORDER BY facts_fts.rank
           LIMIT ?`,
        )
        .all(matchQuery, minTrust, ...scope.params, limit) as (FactRow & { fts_rank_raw: number })[];

      if (rows.length === 0) return [];
      const rawRanks = rows.map((r) => Math.abs(r.fts_rank_raw));
      const maxRank = Math.max(...rawRanks, 1e-6);
      return rows.map((r) => {
        const { fts_rank_raw: _, ...rest } = r;
        return { ...rest, fts_rank: Math.abs(r.fts_rank_raw) / maxRank };
      });
    } catch (err) {
      // A failing FTS query silently returning [] reads as "no matches" —
      // surface it so a broken index/schema is diagnosable.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[pico memory] FTS candidate query failed: ${message}`);
      return [];
    }
  }
  /**
   * Exponential temporal decay: 0.5^(age_days / half_life_days).
   * Ported from hermes-agent's holographic/retrieval.py.
   * Returns 1.0 (no decay) when half-life is 0 or the timestamp is unparseable.
   */
  private _temporalDecay(timestampStr: string): number {
    if (this.temporalDecayHalfLife <= 0) return 1.0;
    if (!timestampStr) return 1.0;
    // updated_at comes from SQLite CURRENT_TIMESTAMP — a UTC string WITHOUT
    // a timezone suffix ("2026-08-05 18:40:00"). `new Date()` would parse it
    // as LOCAL time, skewing every fact's age by the local offset; append Z.
    const dt = new Date(`${timestampStr.replace(" ", "T")}Z`);
    if (isNaN(dt.getTime())) return 1.0;
    const ageMs = Date.now() - dt.getTime();
    const ageDays = ageMs / 86_400_000;
    return Math.pow(0.5, ageDays / this.temporalDecayHalfLife);
  }
}
