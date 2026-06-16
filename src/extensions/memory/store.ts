/**
 * MemoryStore — SQLite-backed long-term memory for srcode.
 *
 * Port of hermes-agent holographic store, minus HRR.
 * (See ~/hermes-agent/plugins/memory/holographic/store.py)
 *
 * Single-process, single-file. Uses bun:sqlite with FTS5 for search.
 * Trust score lives in [0, 1] and shifts with user feedback.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  CORRECTED_BOOST,
  CORRECTION_DELTA,
  HELPFUL_DELTA,
  MIGRATIONS,
  SCHEMA,
  SCOPE_GLOBAL,
  SCOPE_PROJECT,
  TRUST_MAX,
  TRUST_MIN,
  UNHELPFUL_DELTA,
  VALID_CATEGORIES,
  VALID_SCOPES,
  type Category,
  type Scope,
} from "./schema.ts";
import { scanSecrets } from "./secrets.ts";

export interface Fact {
  fact_id: number;
  content: string;
  category: Category;
  tags: string;
  trust_score: number;
  retrieval_count: number;
  helpful_count: number;
  created_at: string;
  updated_at: string;
  scope: string;
  correction_of: number | null;
  source: string;
}

export interface AddOptions {
  category?: Category;
  tags?: string;
  trust?: number;
  scope?: Scope;
  correctionOf?: number;
  source?: string;
  cwd?: string;
}

export interface SearchOptions {
  category?: Category;
  minTrust?: number;
  limit?: number;
  scope?: Scope;
  cwd?: string;
}

export interface ListOptions {
  category?: Category;
  minTrust?: number;
  limit?: number;
  scope?: Scope;
  cwd?: string;
}

export interface UpdateOptions {
  content?: string;
  category?: Category;
  tags?: string;
  trustDelta?: number;
}

const clampTrust = (n: number) => Math.max(TRUST_MIN, Math.min(TRUST_MAX, n));

/**
 * Build a project scope key from a cwd path.
 * Stored as "project:/absolute/path" so it's unique per project directory.
 */
export function projectScopeKey(cwd: string): string {
  return `${SCOPE_PROJECT}:${cwd}`;
}

/**
 * FTS5 MATCH wants a query that won't blow up on user input. We strip
 * characters that have special meaning (quotes, parens, asterisks, colons)
 * and split on whitespace, joining tokens with OR. Empty input returns "".
 */
function normaliseFtsQuery(raw: string): string {
  const cleaned = raw
    .replace(/["'()*:^-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1); // drop noise like "a", "i"
  if (cleaned.length === 0) return "";
  return cleaned.map((t) => `"${t}"`).join(" OR ");
}

export class MemoryStore {
  readonly dbPath: string;
  private readonly db: Database;
  private readonly defaultTrust: number;

  constructor(dbPath: string, opts: { defaultTrust?: number } = {}) {
    this.dbPath = dbPath;
    this.defaultTrust = clampTrust(opts.defaultTrust ?? 0.5);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Idempotent schema migration — adds columns introduced after v1. */
  private migrate(): void {
    for (const sql of MIGRATIONS) {
      try {
        this.db.exec(sql);
      } catch {
        // ALTER TABLE fails silently if column already exists;
        // CREATE INDEX IF NOT EXISTS never fails.
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- write -------------------------------------------------------------

  /**
   * Insert a fact. Content is UNIQUE — re-adding the same content returns
   * the existing fact_id without changing its trust/timestamps.
   *
   * If `opts.correctionOf` is set, the referenced fact's trust is penalised
   * and the new fact starts with CORRECTED_BOOST trust.
   */
  add(content: string, opts: AddOptions = {}): number {
    const trimmed = content.trim();
    if (!trimmed) throw new Error("memory.add: content is empty");

    // Secret scanning — block before any DB interaction.
    const scan = scanSecrets(trimmed);
    if (scan.blocked) throw new Error(`memory.add: ${scan.reason}`);

    const category: Category = opts.category ?? "general";
    if (!VALID_CATEGORIES.includes(category)) {
      throw new Error(`memory.add: invalid category '${category}'`);
    }
    const tags = (opts.tags ?? "").trim();

    // Resolve scope: project-scoped if scope="project" and cwd provided.
    const scopeKey = opts.scope === SCOPE_PROJECT && opts.cwd
      ? projectScopeKey(opts.cwd)
      : opts.scope ?? SCOPE_GLOBAL;
    if (!VALID_SCOPES.includes(scopeKey as Scope) && !scopeKey.startsWith("project:")) {
      throw new Error(`memory.add: invalid scope '${scopeKey}'`);
    }

    const correctionOf = opts.correctionOf ?? null;
    const source = opts.source ?? "auto";

    // If this is a correction, validate and penalise the original fact.
    let trust = clampTrust(opts.trust ?? this.defaultTrust);
    if (correctionOf !== null) {
      const original = this.get(correctionOf);
      if (!original) throw new Error(`memory.add: correction_of #${correctionOf} not found`);
      // Penalise the original fact.
      this.update(correctionOf, { trustDelta: CORRECTION_DELTA });
      trust = CORRECTED_BOOST;
    }

    const existing = this.db
      .query<{ fact_id: number }, [string]>("SELECT fact_id FROM facts WHERE content = ?")
      .get(trimmed);
    if (existing) return existing.fact_id;

    const stmt = this.db.query<
      { fact_id: number },
      [string, string, string, number, string, number | null, string]
    >(
      `INSERT INTO facts (content, category, tags, trust_score, scope, correction_of, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING fact_id`,
    );
    const row = stmt.get(trimmed, category, tags, trust, scopeKey, correctionOf, source);
    if (!row) throw new Error("memory.add: insert returned no row");
    return row.fact_id;
  }

  update(fact_id: number, opts: UpdateOptions): boolean {
    const fact = this.get(fact_id);
    if (!fact) return false;

    const next = {
      content: opts.content?.trim() ?? fact.content,
      category: opts.category ?? fact.category,
      tags: opts.tags?.trim() ?? fact.tags,
      trust_score:
        opts.trustDelta !== undefined ? clampTrust(fact.trust_score + opts.trustDelta) : fact.trust_score,
    };

    if (opts.category && !VALID_CATEGORIES.includes(opts.category)) {
      throw new Error(`memory.update: invalid category '${opts.category}'`);
    }

    this.db
      .query(
        `UPDATE facts
            SET content = ?, category = ?, tags = ?, trust_score = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE fact_id = ?`,
      )
      .run(next.content, next.category, next.tags, next.trust_score, fact_id);
    return true;
  }

  remove(fact_id: number): boolean {
    const res = this.db.query("DELETE FROM facts WHERE fact_id = ?").run(fact_id);
    return res.changes > 0;
  }

  feedback(fact_id: number, helpful: boolean): Fact | null {
    const fact = this.get(fact_id);
    if (!fact) return null;
    const delta = helpful ? HELPFUL_DELTA : UNHELPFUL_DELTA;
    const next = clampTrust(fact.trust_score + delta);
    this.db
      .query(
        `UPDATE facts
            SET trust_score = ?,
                helpful_count = helpful_count + ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE fact_id = ?`,
      )
      .run(next, helpful ? 1 : 0, fact_id);
    return this.get(fact_id);
  }

  // ---- read --------------------------------------------------------------

  get(fact_id: number): Fact | null {
    const row = this.db
      .query<Fact, [number]>("SELECT * FROM facts WHERE fact_id = ?")
      .get(fact_id);
    return row ?? null;
  }

  list(opts: ListOptions = {}): Fact[] {
    const minTrust = opts.minTrust ?? 0.0;
    const limit = Math.max(1, opts.limit ?? 50);

    // Build scope filter.
    const scopeClauses: string[] = [];
    const params: unknown[] = [];

    if (opts.scope === SCOPE_PROJECT && opts.cwd) {
      const pKey = projectScopeKey(opts.cwd);
      scopeClauses.push(`AND (scope = ? OR scope = ?)`);
      params.push(SCOPE_GLOBAL, pKey);
    } else if (opts.scope === SCOPE_GLOBAL || !opts.scope) {
      scopeClauses.push(`AND scope = ?`);
      params.push(SCOPE_GLOBAL);
    }

    if (opts.category) {
      return this.db
        .query<Fact, (string | number)[]>(
          `SELECT * FROM facts
            WHERE category = ? AND trust_score >= ?
            ${scopeClauses.join(" ")}
            ORDER BY trust_score DESC, fact_id DESC
            LIMIT ?`,
        )
        .all(opts.category, minTrust, ...params as (string | number)[], limit);
    }
    return this.db
      .query<Fact, (string | number)[]>(
        `SELECT * FROM facts
          WHERE trust_score >= ?
          ${scopeClauses.join(" ")}
          ORDER BY trust_score DESC, fact_id DESC
          LIMIT ?`,
      )
      .all(minTrust, ...params as (string | number)[], limit);
  }

  /**
   * Full-text search. Boost FTS rank by trust_score so high-trust facts
   * surface first. Bumps retrieval_count for every returned row.
   *
   * When scope="project" and cwd is provided, returns both global and
   * project-scoped facts, with a 10% ranking boost for project facts.
   */
  search(query: string, opts: SearchOptions = {}): Fact[] {
    const fts = normaliseFtsQuery(query);
    if (!fts) return [];

    const minTrust = opts.minTrust ?? 0.3;
    const limit = Math.max(1, opts.limit ?? 10);

    // Build scope filter and ranking boost.
    let scopeClause = "";
    let scopeBoost = "";
    const scopeParams: unknown[] = [];

    if (opts.scope === SCOPE_PROJECT && opts.cwd) {
      const pKey = projectScopeKey(opts.cwd);
      scopeClause = `AND (f.scope = ? OR f.scope = ?)`;
      scopeParams.push(SCOPE_GLOBAL, pKey);
      // Give project-scoped facts a 50% ranking boost so they surface
      // above global facts of similar relevance.
      scopeBoost = `(CASE WHEN f.scope = ? THEN 1.5 ELSE 1.0 END) * `;
      scopeParams.push(pKey);
    } else if (opts.scope === SCOPE_GLOBAL || !opts.scope) {
      scopeClause = `AND f.scope = ?`;
      scopeParams.push(SCOPE_GLOBAL);
    }

    const baseSql = `
      SELECT f.*
        FROM facts_fts m
        JOIN facts f ON f.fact_id = m.rowid
       WHERE facts_fts MATCH ?
         AND f.trust_score >= ?
         ${scopeClause}
         ${opts.category ? "AND f.category = ?" : ""}
       ORDER BY ${scopeBoost}(-bm25(facts_fts)) * f.trust_score DESC,
                f.trust_score DESC,
                f.fact_id DESC
       LIMIT ?
    `;

    // Interleave params in the correct order.
    const allParams: unknown[] = [fts, minTrust, ...scopeParams];
    if (opts.category) allParams.push(opts.category);
    allParams.push(limit);

    const rows = this.db.query<Fact, unknown[]>(baseSql).all(...allParams);

    if (rows.length > 0) {
      const ids = rows.map((r) => r.fact_id);
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .query(
          `UPDATE facts
              SET retrieval_count = retrieval_count + 1
            WHERE fact_id IN (${placeholders})`,
        )
        .run(...ids);
    }
    return rows;
  }

  /**
   * Probe: same shape as `search` but treats the input as an entity name —
   * we wrap it in a phrase match so multi-word names resolve cleanly.
   * (v1 is FTS-only; entity table reserved for v2.)
   */
  probe(entity: string, opts: SearchOptions = {}): Fact[] {
    const trimmed = entity.trim();
    if (!trimmed) return [];
    const phrase = `"${trimmed.replace(/"/g, " ")}"`;
    const minTrust = opts.minTrust ?? 0.3;
    const limit = Math.max(1, opts.limit ?? 10);

    // Build scope filter.
    let scopeClause = "";
    const scopeParams: unknown[] = [];

    if (opts.scope === SCOPE_PROJECT && opts.cwd) {
      const pKey = projectScopeKey(opts.cwd);
      scopeClause = `AND (f.scope = ? OR f.scope = ?)`;
      scopeParams.push(SCOPE_GLOBAL, pKey);
    } else if (opts.scope === SCOPE_GLOBAL || !opts.scope) {
      scopeClause = `AND f.scope = ?`;
      scopeParams.push(SCOPE_GLOBAL);
    }

    const sql = `
      SELECT f.*
        FROM facts_fts m
        JOIN facts f ON f.fact_id = m.rowid
       WHERE facts_fts MATCH ?
         AND f.trust_score >= ?
         ${scopeClause}
         ${opts.category ? "AND f.category = ?" : ""}
       ORDER BY f.trust_score DESC, f.fact_id DESC
       LIMIT ?
    `;

    const allParams: unknown[] = [phrase, minTrust, ...scopeParams];
    if (opts.category) allParams.push(opts.category);
    allParams.push(limit);

    return this.db.query<Fact, unknown[]>(sql).all(...allParams);
  }

  count(): number {
    const row = this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM facts")
      .get();
    return row?.n ?? 0;
  }

  /** Wipe everything. Used by /memory clear and tests. */
  clear(): void {
    this.db.exec("DELETE FROM facts");
  }
}
