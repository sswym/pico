/**
 * MemoryStore — SQLite-backed long-term memory for pico.
 *
 * Extended from hermes holographic store with:
 * - Entity extraction and linking (probe/related/reason support)
 * - TF-IDF vector computation (semantic search)
 * - Hybrid retrieval via FactRetriever
 */
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
import { extractEntities } from "./entities.ts";
import { tokenize, filterStopwords, computeTfIdf, vectorToJson } from "./tfidf.ts";
import { FactRetriever } from "./retrieval.ts";
import { normalizeTerm, expandQuery } from "./synonyms.ts";
import { projectScopeKey } from "./query-scope.ts";
import { FactTermCache } from "./term-cache.ts";
import { log } from "../logging.ts";

/**
 * Distinguish real corruption (backup-and-rebuild) from transient open
 * failures (busy/permission/disk) that must propagate to the caller instead
 * of renaming a healthy database away.
 */
function isCorruptionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /corrupt|malformed|not a database/i.test(message);
}

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
  tfidf_vector: string;
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

function clampTrust(n: number): number {
  return Math.max(TRUST_MIN, Math.min(TRUST_MAX, n));
}

/** Escape LIKE wildcards so entity names containing %/_ are matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Negation words that flip a fact's assertion about a nearby term. */
const NEGATION_RE = /(?:不|没|别|无|非|莫|never|not\b|no\b|without|instead\s+of)/i;

/** True when a negation word sits within 4 chars before / 2 chars after a match. */
function negationNear(text: string, idx: number, token: string): boolean {
  const before = text.slice(Math.max(0, idx - 4), idx);
  const after = text.slice(idx + token.length, idx + token.length + 2);
  return NEGATION_RE.test(before) || NEGATION_RE.test(after);
}

/** PICO_MEMORY_DENY keywords (comma-separated env). */
function denyKeywords(): string[] {
  const raw = process.env.PICO_MEMORY_DENY ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Gate shared by add/update: refuses content (or tags) that matches the
 * PICO_MEMORY_DENY keyword list. Enforced here at the store layer so every
 * write path (tool, auto-extract, turn_end correction, providers) hits it —
 * the tool-level check alone was a bypass for automatic writes.
 */
function denyBlocked(content: string): string | null {
  const denies = denyKeywords();
  if (denies.length === 0) return null;
  const haystack = content.toLowerCase();
  const hit = denies.find((kw) => haystack.includes(kw));
  return hit ?? null;
}

function normaliseFtsQuery(raw: string): string {
  const cleaned = raw
    .replace(/["'()*:^-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
  if (cleaned.length === 0) return "";
  return cleaned.map((t) => `"${t}"`).join(" OR ");
}

export class MemoryStore {
  readonly dbPath: string;
  readonly db: Database;
  private readonly defaultTrust: number;
  /** Temporal decay half-life in days applied to search ranking. 0 disables.
   *  Default 180: stale facts rank lower without ever being hidden. */
  readonly temporalDecayHalfLifeDays: number;
  /**
   * Retrieval-frequency boost weight (spaced-repetition signal). Ranked score
   * is multiplied by `1 + weight * min(retrieval_count, 10)`, so facts the
   * agent actually re-used rank above equally-relevant ones that never were.
   * 0 disables. Default 0.05 (boost 1.0–1.5 at the cap).
   */
  readonly retrievalFrequencyWeight: number;
  /** Set when the DB was corrupt and had to be rebuilt from a backup. */
  recoveryNotice: string | null = null;
  /** Throttle map for retrieval_count bumps: fact_id -> last bump epoch ms. */
  private readonly _lastBump = new Map<number, number>();
  /**
   * Shared canonical-term cache for the substring fallback retrieval paths.
   * Write-through invalidated on add/update/remove/clear; shared with every
   * FactRetriever created via retriever() so fallback searches stop paying
   * the full 500-row regex re-tokenization per call.
   */
  readonly termCache = new FactTermCache();

  constructor(dbPath: string, opts: { defaultTrust?: number; temporalDecayHalfLifeDays?: number; retrievalFrequencyWeight?: number } = {}) {
    this.dbPath = dbPath;
    this.defaultTrust = clampTrust(opts.defaultTrust ?? 0.5);
    this.temporalDecayHalfLifeDays = opts.temporalDecayHalfLifeDays ?? 180;
    this.retrievalFrequencyWeight = opts.retrievalFrequencyWeight ?? 0.05;
    mkdirSync(dirname(dbPath), { recursive: true });
    try {
      this.db = new Database(dbPath);
      this._configureDb();
    } catch (err) {
      // Only actual corruption gets the backup-and-rebuild treatment. Any
      // other open/init failure (SQLITE_BUSY on a concurrently-held DB,
      // permissions, disk errors) must propagate instead of renaming a
      // healthy file out from under another process (split-brain).
      if (!isCorruptionError(err)) throw err;
      // SQLITE_CORRUPT must never block startup: back the damaged file up,
      // rebuild an empty store, and surface a visible notice (2.3.3).
      this.recoveryNotice = this._backupCorrupt(err);
      this.db = new Database(dbPath);
      this._configureDb();
    }
    this.migrate();
  }

  private _configureDb(): void {
    // busy_timeout must come FIRST: switching to WAL needs a write lock, and
    // with the default busy timeout that lock contention would raise
    // SQLITE_BUSY immediately instead of waiting.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  private _backupCorrupt(err: unknown): string {
    const backup = `${this.dbPath}.corrupt-${Date.now()}`;
    let notice = `Memory database is corrupt (${err instanceof Error ? err.message : String(err)}). `;
    try {
      renameSync(this.dbPath, backup);
      // The WAL/SHM sidecar files can carry the corruption too.
      for (const sidecar of ["-wal", "-shm"]) {
        try {
          renameSync(`${this.dbPath}${sidecar}`, `${backup}${sidecar}`);
        } catch {
          // no sidecar file — fine
        }
      }
      notice += `Backed up to ${backup} and started with an empty memory.`;
    } catch {
      notice += "Backup failed; started with an empty memory.";
    }
    this._pruneCorruptBackups();
    log.warn("memory", notice);
    return notice;
  }

  /** Stale-bak cleanup window: corrupt backups older than 7 days are dropped. */
  private static readonly BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  /** Delete corrupt backups (db + WAL/SHM sidecars) older than the retention window. */
  private _pruneCorruptBackups(): void {
    try {
      const cutoff = Date.now() - MemoryStore.BACKUP_RETENTION_MS;
      const dir = dirname(this.dbPath);
      const prefix = `${basename(this.dbPath)}.corrupt-`;
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(prefix)) continue;
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.mtimeMs < cutoff) rmSync(full, { force: true });
      }
    } catch {
      // best-effort cleanup
    }
  }

  private migrate(): void {
    for (const sql of MIGRATIONS) {
      try {
        this.db.exec(sql);
      } catch (err) {
        // ALTER TABLE fails idempotently when the column already exists —
        // that's expected on re-opened stores and must stay silent. Anything
        // else is a real migration failure worth surfacing.
        const message = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(message)) {
          log.warn("memory", `migration failed (${sql}): ${message}`);
        }
      }
    }
    this._migrateScopeUnique();
  }

  /**
   * Scope-aware uniqueness (2026-08): the original schema declared
   * `content TEXT NOT NULL UNIQUE` — a global singleton that silently
   * swallowed the same content written under a different project scope.
   * Rebuild the facts table once with UNIQUE(scope, content).
   *
   * Idempotency: the legacy column constraint shows up as the single-column
   * autoindex `sqlite_autoindex_facts_1`; the rebuilt table's autoindex has
   * two columns, so re-opens skip the rebuild.
   */
  private _migrateScopeUnique(): void {
    try {
      const cols = this.db
        .query<{ name: string | null }, []>("PRAGMA index_info('sqlite_autoindex_facts_1')")
        .all();
      if (cols.length !== 1) return; // already scope-unique (or no autoindex)
      const fk = this.db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
      this.db.exec("PRAGMA foreign_keys = OFF");
      try {
        this.db.exec("BEGIN");
        try {
          this.db.exec(`
            CREATE TABLE facts_migrated (
              fact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
              content         TEXT NOT NULL,
              category        TEXT NOT NULL DEFAULT 'general',
              tags            TEXT NOT NULL DEFAULT '',
              trust_score     REAL NOT NULL DEFAULT 0.5,
              retrieval_count INTEGER NOT NULL DEFAULT 0,
              helpful_count   INTEGER NOT NULL DEFAULT 0,
              created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              scope           TEXT NOT NULL DEFAULT 'global',
              correction_of   INTEGER REFERENCES facts_migrated(fact_id),
              source          TEXT NOT NULL DEFAULT 'auto',
              tfidf_vector    TEXT NOT NULL DEFAULT '{}',
              UNIQUE(scope, content)
            )
          `);
          this.db.exec(`
            INSERT INTO facts_migrated (fact_id, content, category, tags, trust_score,
              retrieval_count, helpful_count, created_at, updated_at, scope,
              correction_of, source, tfidf_vector)
            SELECT fact_id, content, category, tags, trust_score,
              retrieval_count, helpful_count, created_at, updated_at, scope,
              correction_of, source, tfidf_vector FROM facts
          `);
          this.db.exec("DROP TABLE facts");
          this.db.exec("ALTER TABLE facts_migrated RENAME TO facts");
          this.db.exec("COMMIT");
        } catch (err) {
          this.db.exec("ROLLBACK");
          throw err;
        }
      } finally {
        // The old table's triggers/FTS shadow died with it — recreate them
        // and resync the FTS index from the rebuilt table.
        this.db.exec(SCHEMA);
        this.db.exec("INSERT INTO facts_fts(facts_fts) VALUES('rebuild')");
        this.db.exec(`PRAGMA foreign_keys = ${fk?.foreign_keys ? "ON" : "OFF"}`);
      }
    } catch (err) {
      // A failed rebuild must not brick the store: keep the legacy schema
      // (add() dedup is still scope-aware) and surface the reason.
      log.warn("memory", `scope-unique migration failed: ${err instanceof Error ? err.message : String(err)}`);
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
   * Post-insert: extracts entities and computes TF-IDF vector.
   */
  add(content: string, opts: AddOptions = {}): number {
    const trimmed = content.trim();
    if (!trimmed) throw new Error("memory.add: content is empty");

    const tags = (opts.tags ?? "").trim();

    // Deny-list gate (PICO_MEMORY_DENY) — enforced at the store layer so
    // auto-extract / turn_end paths cannot bypass it.
    const denied = denyBlocked(trimmed) ?? denyBlocked(tags);
    if (denied) throw new Error(`memory.add: write denied: contains blocked keyword '${denied}'`);

    // Secret scanning — covers content AND tags (a key smuggled into tags
    // must not bypass the scan); block before any DB interaction.
    const scan = scanSecrets(`${trimmed} ${tags}`);
    if (scan.blocked) throw new Error(`memory.add: ${scan.reason}`);

    const category: Category = opts.category ?? "general";
    if (!VALID_CATEGORIES.includes(category)) {
      throw new Error(`memory.add: invalid category '${category}'`);
    }

    // Resolve scope: project-scoped if scope="project" and cwd provided.
    // A bare "project" scope would be invisible to every read path (they all
    // query project:<cwd>) — refuse instead of silently losing the fact.
    if (opts.scope === SCOPE_PROJECT && !opts.cwd) {
      throw new Error("memory.add: scope 'project' requires a cwd (missing session project context)");
    }
    const scopeKey = opts.scope === SCOPE_PROJECT && opts.cwd
      ? projectScopeKey(opts.cwd)
      : opts.scope ?? SCOPE_GLOBAL;
    if (!VALID_SCOPES.includes(scopeKey as Scope) && !scopeKey.startsWith("project:")) {
      throw new Error(`memory.add: invalid scope '${scopeKey}'`);
    }

    const correctionOf = opts.correctionOf ?? null;
    const source = opts.source ?? "auto";

    // Dedup FIRST: re-adding identical content in the SAME scope returns the
    // existing fact_id without side effects. Scope-aware on purpose — the same
    // text under a different project scope is a distinct fact (UNIQUE(scope,
    // content)), otherwise project B's write would be swallowed and invisible
    // to B's read paths. Runs before any correction penalty — a correction
    // whose content already exists must not dock the original's trust while
    // inserting nothing new.
    const existing = this.db
      .query<{ fact_id: number }, [string, string]>("SELECT fact_id FROM facts WHERE content = ? AND scope = ?")
      .get(trimmed, scopeKey);
    if (existing) return existing.fact_id;

    // Correction penalty + insert + entity/TF-IDF post-processing must be
    // atomic: a failure mid-way must not leave an orphan fact committed
    // without its derived rows (or the original fact penalised without a
    // replacement).
    const runAdd = this.db.transaction((): number => {
      let trust = clampTrust(opts.trust ?? this.defaultTrust);
      if (correctionOf !== null) {
        const original = this.get(correctionOf);
        if (!original) throw new Error(`memory.add: correction_of #${correctionOf} not found`);
        this.update(correctionOf, { trustDelta: CORRECTION_DELTA });
        trust = CORRECTED_BOOST;
      }
      const row = this.db
        .query<{ fact_id: number }, [string, string, string, number, string, number | null, string]>(
          `INSERT INTO facts (content, category, tags, trust_score, scope, correction_of, source)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING fact_id`,
        )
        .get(trimmed, category, tags, trust, scopeKey, correctionOf, source);
      if (!row) throw new Error("memory.add: insert returned no row");
      const factId = row.fact_id;

      // Post-insert: extract entities and link
      this._linkEntities(factId, trimmed);

      // Post-insert: compute TF-IDF vector
      this._computeTfIdf(factId, trimmed);

      // New row has no cached term entry, but invalidating keeps the
      // write-through invariant unconditional.
      this.termCache.invalidate(factId);

      return factId;
    });
    return runAdd();
  }

  update(fact_id: number, opts: UpdateOptions): boolean {
    const fact = this.get(fact_id);
    if (!fact) return false;

    const nextContent = opts.content?.trim() ?? fact.content;
    if (opts.content !== undefined) {
      const denied = denyBlocked(nextContent) ?? denyBlocked(opts.tags?.trim() ?? "");
      if (denied) throw new Error(`memory.update: write denied: contains blocked keyword '${denied}'`);
      const scan = scanSecrets(`${nextContent} ${opts.tags?.trim() ?? ""}`);
      if (scan.blocked) throw new Error(`memory.update: ${scan.reason}`);
    }

    const next = {
      content: nextContent,
      category: opts.category ?? fact.category,
      tags: opts.tags?.trim() ?? fact.tags,
      trust_score:
        opts.trustDelta !== undefined ? clampTrust(fact.trust_score + opts.trustDelta) : fact.trust_score,
    };

    if (opts.category && !VALID_CATEGORIES.includes(opts.category)) {
      throw new Error(`memory.update: invalid category '${opts.category}'`);
    }

    // UPDATE + entity/TF-IDF recompute must be atomic (mirrors add()'s
    // runAdd transaction): a failure mid-way must not leave the content
    // updated while the derived rows still describe the old text.
    const runUpdate = this.db.transaction(() => {
      this.db
        .query(
          `UPDATE facts
              SET content = ?, category = ?, tags = ?, trust_score = ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE fact_id = ?`,
        )
        .run(next.content, next.category, next.tags, next.trust_score, fact_id);

      // If content changed, re-extract entities and recompute TF-IDF
      if (opts.content !== undefined) {
        this._linkEntities(fact_id, next.content);
        this._computeTfIdf(fact_id, next.content);
      }
    });
    runUpdate();

    // Content, tags, or trust changed — drop the cached term entry so the
    // next fallback search recomputes against the updated row.
    this.termCache.invalidate(fact_id);

    return true;
  }

  remove(fact_id: number): boolean {
    // fact_entities has ON DELETE CASCADE, so this cleans up automatically
    const res = this.db.query("DELETE FROM facts WHERE fact_id = ?").run(fact_id);
    if (res.changes > 0) this.termCache.invalidate(fact_id);
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

    if (opts.scope === SCOPE_PROJECT && opts.cwd) {
      const pKey = projectScopeKey(opts.cwd);
      if (opts.category) {
        return this.db
          .query<Fact, [string, number, string, string, number]>(
            `SELECT * FROM facts
              WHERE category = ? AND trust_score >= ?
              AND (scope = ? OR scope = ?)
              ORDER BY trust_score DESC, fact_id DESC
              LIMIT ?`,
          )
          .all(opts.category, minTrust, SCOPE_GLOBAL, pKey, limit);
      }
      return this.db
        .query<Fact, [number, string, string, number]>(
          `SELECT * FROM facts
            WHERE trust_score >= ?
            AND (scope = ? OR scope = ?)
            ORDER BY trust_score DESC, fact_id DESC
            LIMIT ?`,
        )
        .all(minTrust, SCOPE_GLOBAL, pKey, limit);
    }

    // Default: global scope
    const scopeVal = opts.scope ?? SCOPE_GLOBAL;
    if (opts.category) {
      return this.db
        .query<Fact, [string, number, string, number]>(
          `SELECT * FROM facts
            WHERE category = ? AND trust_score >= ?
            AND scope = ?
            ORDER BY trust_score DESC, fact_id DESC
            LIMIT ?`,
        )
        .all(opts.category, minTrust, scopeVal, limit);
    }
    return this.db
      .query<Fact, [number, string, number]>(
        `SELECT * FROM facts
          WHERE trust_score >= ?
          AND scope = ?
          ORDER BY trust_score DESC, fact_id DESC
          LIMIT ?`,
      )
      .all(minTrust, scopeVal, limit);
  }

  /**
   * Full-text search with scope-aware ranking.
   * Bumps retrieval_count for every returned row.
   */
  search(query: string, opts: SearchOptions = {}): Fact[] {
    // Expand query with synonyms/aliases so paraphrases (TS vs TypeScript)
    // still match at the FTS5 layer. Computed once — both the FTS5 query and
    // the negation-penalty term list derive from the same expansion.
    const expanded = expandQuery(filterStopwords(tokenize(query)));
    const expandedQuery = expanded.map((e) => e.term).join(" ");
    const fts = normaliseFtsQuery(expandedQuery);
    const minTrust = opts.minTrust ?? 0.3;
    const limit = Math.max(1, opts.limit ?? 10);
    if (!fts) return this._fallbackSearch(query, opts, minTrust, limit);

    const rows = this._ftsRows(fts, opts, minTrust, limit);
    if (rows.length === 0) return this._fallbackSearch(query, opts, minTrust, limit);

    // Negation re-rank: "我不用 bun" must not outrank "we use bun" for a
    // "bun" query just because its trust is higher (2.3.2).
    const terms = expanded.map((e) => normalizeTerm(e.term));
    const ranked = this._applyNegationPenalty(rows, terms, opts);
    this._bumpRetrieval(ranked);
    return ranked;
  }

  private _ftsRows(fts: string, opts: SearchOptions, minTrust: number, limit: number): Array<Fact & { _rank: number; _decay?: number }> {
    const projectKey = opts.scope === SCOPE_PROJECT && opts.cwd ? projectScopeKey(opts.cwd) : null;
    const scopeClause = projectKey ? `(f.scope = ? OR f.scope = ?)` : `f.scope = ?`;
    const scopeParams: string[] = projectKey ? [SCOPE_GLOBAL, projectKey] : [opts.scope ?? SCOPE_GLOBAL];
    const scopeBoost = projectKey ? `(CASE WHEN f.scope = ? THEN 1.5 ELSE 1.0 END)` : "1.0";
    const boostParams: string[] = projectKey ? [projectKey] : [];
    const catClause = opts.category ? `AND f.category = ?` : "";
    const catParams: string[] = opts.category ? [opts.category] : [];
    // Temporal decay: computed once in SQL, referenced by alias in ORDER BY
    // (SQLite allows ORDER BY to reference SELECT aliases), so the decay
    // parameter binds exactly once.
    const decaySelect = this.temporalDecayHalfLifeDays > 0
      ? `, exp(-(julianday('now') - julianday(f.updated_at)) * ?) AS _decay`
      : "";
    const decayOrder = this.temporalDecayHalfLifeDays > 0 ? " * _decay" : "";
    const decayParam = this.temporalDecayHalfLifeDays > 0 ? [Math.LN2 / this.temporalDecayHalfLifeDays] : [];
    // Retrieval-frequency boost (spaced-repetition signal): `1 + weight *
    // min(retrieval_count, 10)` in ORDER BY. MIN is a core SQLite scalar
    // function — safe without SQLITE_ENABLE_MATH_FUNCTIONS. Mirrored in
    // _applyNegationPenalty and _fallbackSearch so all ranking paths agree.
    const freqOrder = this.retrievalFrequencyWeight > 0
      ? ` * (1 + ? * MIN(f.retrieval_count, 10))`
      : "";
    const freqParam = this.retrievalFrequencyWeight > 0 ? [this.retrievalFrequencyWeight] : [];

    const rows = this.db
      .query<Fact & { _rank: number; _decay?: number }, Array<string | number>>(
        `SELECT f.*, (-bm25(facts_fts)) AS _rank${decaySelect} FROM facts_fts m JOIN facts f ON f.fact_id = m.rowid
         WHERE facts_fts MATCH ? AND f.trust_score >= ?
         AND ${scopeClause} ${catClause}
         ORDER BY ${scopeBoost} * (-bm25(facts_fts)) * f.trust_score${decayOrder}${freqOrder} DESC, f.fact_id DESC
         LIMIT ?`,
      )
      // Decay's ? binds first — it appears in the SELECT list, before the
      // MATCH ? in WHERE. Binding order must follow SQL text order.
      .all(...decayParam, fts, minTrust, ...scopeParams, ...catParams, ...boostParams, ...freqParam, limit) as Array<Fact & { _rank: number; _decay?: number }>;
    return rows;
  }

  /** Apply the negation penalty to FTS-ranked rows and re-sort. */
  private _applyNegationPenalty(
    rows: Array<Fact & { _rank: number; _decay?: number }>,
    terms: string[],
    opts: SearchOptions,
  ): Fact[] {
    const projectKey = opts.scope === SCOPE_PROJECT && opts.cwd ? projectScopeKey(opts.cwd) : null;
    const scored = rows
      .map((row) => {
        const content = `${row.content} ${row.tags}`.toLowerCase();
        let negated = false;
        for (const term of terms) {
          if (!term) continue;
          let idx = content.indexOf(term);
          while (idx >= 0) {
            if (negationNear(content, idx, term)) { negated = true; break; }
            idx = content.indexOf(term, idx + Math.max(1, term.length));
          }
          if (negated) break;
        }
        const boost = projectKey && row.scope === projectKey ? 1.5 : 1.0;
        const decay = row._decay ?? 1;
        // Same retrieval-frequency boost as the SQL ORDER BY — the negation
        // re-rank must not drop it.
        const freq = 1 + this.retrievalFrequencyWeight * Math.min(row.retrieval_count, 10);
        const score = row._rank * row.trust_score * boost * decay * freq * (negated ? 0.2 : 1);
        return { row, score, negated };
      })
      .sort((a, b) => b.score - a.score || b.row.fact_id - a.row.fact_id);
    return scored.map((s) => s.row);
  }

  /** Bump retrieval_count on matched rows — throttled to once per fact per
   *  5 minutes so read-heavy sessions don't turn every retrieval into a write
   *  amplification (the previous behaviour polluted retrieval_count and
   *  added per-turn write cost). */
  private _bumpRetrieval(rows: Fact[]): void {
    const now = Date.now();
    const BUMP_INTERVAL_MS = 5 * 60 * 1000;
    const due = rows.filter((r) => (this._lastBump.get(r.fact_id) ?? 0) + BUMP_INTERVAL_MS <= now);
    if (due.length === 0) return;
    for (const r of due) this._lastBump.set(r.fact_id, now);
    const ids = due.map((r) => r.fact_id);
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .query(
        `UPDATE facts
            SET retrieval_count = retrieval_count + 1
          WHERE fact_id IN (${placeholders})`,
      )
      .run(...ids);
  }

  /**
   * Probe: find facts about an entity using the entity table.
   * Falls back to FTS phrase match if entity not found.
   */
  probe(entity: string, opts: SearchOptions = {}): Fact[] {
    const trimmed = entity.trim();
    if (!trimmed) return [];
    const name = trimmed.toLowerCase();
    const projectScope = opts.scope === SCOPE_PROJECT && opts.cwd ? projectScopeKey(opts.cwd) : null;

    // Try entity table first
    const entityRow = this.db
      .query<{ entity_id: number }, [string, string]>(
        "SELECT entity_id FROM entities WHERE LOWER(name) = ? OR (',' || aliases || ',') LIKE ? ESCAPE '\\'",
      )
      .get(name, `%,${escapeLike(name)},%`);

    if (!entityRow) {
      // Fallback to FTS phrase match
      const phrase = `"${trimmed.replace(/"/g, " ")}"`;
      const minTrust = opts.minTrust ?? 0.3;
      const limit = Math.max(1, opts.limit ?? 10);

      if (projectScope) {
        if (opts.category) {
          return this.db
            .query<Fact, [string, number, string, string, string, string, number]>(
              `SELECT f.* FROM facts_fts m JOIN facts f ON f.fact_id = m.rowid
               WHERE facts_fts MATCH ? AND f.trust_score >= ?
               AND (f.scope = ? OR f.scope = ?) AND f.category = ?
               ORDER BY (CASE WHEN f.scope = ? THEN 1.5 ELSE 1.0 END) * f.trust_score DESC,
                        f.fact_id DESC LIMIT ?`,
            )
            .all(phrase, minTrust, SCOPE_GLOBAL, projectScope, opts.category, projectScope, limit);
        }
        return this.db
          .query<Fact, [string, number, string, string, string, number]>(
            `SELECT f.* FROM facts_fts m JOIN facts f ON f.fact_id = m.rowid
             WHERE facts_fts MATCH ? AND f.trust_score >= ?
             AND (f.scope = ? OR f.scope = ?)
             ORDER BY (CASE WHEN f.scope = ? THEN 1.5 ELSE 1.0 END) * f.trust_score DESC,
                      f.fact_id DESC LIMIT ?`,
          )
          .all(phrase, minTrust, SCOPE_GLOBAL, projectScope, projectScope, limit);
      }

      if (opts.category) {
        return this.db
          .query<Fact, [string, number, string, string, number]>(
            `SELECT f.* FROM facts_fts m JOIN facts f ON f.fact_id = m.rowid
             WHERE facts_fts MATCH ? AND f.trust_score >= ? AND f.scope = ? AND f.category = ?
             ORDER BY f.trust_score DESC, f.fact_id DESC LIMIT ?`,
          )
          .all(phrase, minTrust, opts.scope ?? SCOPE_GLOBAL, opts.category, limit) as unknown as Fact[];
      }
      return this.db
        .query<Fact, [string, number, string, number]>(
          `SELECT f.* FROM facts_fts m JOIN facts f ON f.fact_id = m.rowid
           WHERE facts_fts MATCH ? AND f.trust_score >= ? AND f.scope = ?
           ORDER BY f.trust_score DESC, f.fact_id DESC LIMIT ?`,
        )
        .all(phrase, minTrust, opts.scope ?? SCOPE_GLOBAL, limit) as unknown as Fact[];
    }

    // Use entity table for structural lookup
    const minTrust = opts.minTrust ?? 0.3;
    const limit = Math.max(1, opts.limit ?? 10);

    if (projectScope) {
      if (opts.category) {
        return this.db
          .query<Fact, [number, number, string, string, string, string, number]>(
            `SELECT f.* FROM facts f
             JOIN fact_entities fe ON fe.fact_id = f.fact_id
             WHERE fe.entity_id = ? AND f.trust_score >= ?
             AND (f.scope = ? OR f.scope = ?) AND f.category = ?
             ORDER BY (CASE WHEN f.scope = ? THEN 1.5 ELSE 1.0 END) * f.trust_score DESC,
                      f.fact_id DESC LIMIT ?`,
          )
          .all(entityRow.entity_id, minTrust, SCOPE_GLOBAL, projectScope, opts.category, projectScope, limit) as unknown as Fact[];
      }
      return this.db
        .query<Fact, [number, number, string, string, string, number]>(
          `SELECT f.* FROM facts f
           JOIN fact_entities fe ON fe.fact_id = f.fact_id
           WHERE fe.entity_id = ? AND f.trust_score >= ?
           AND (f.scope = ? OR f.scope = ?)
           ORDER BY (CASE WHEN f.scope = ? THEN 1.5 ELSE 1.0 END) * f.trust_score DESC,
                    f.fact_id DESC LIMIT ?`,
        )
        .all(entityRow.entity_id, minTrust, SCOPE_GLOBAL, projectScope, projectScope, limit) as unknown as Fact[];
    }

    if (opts.category) {
      return this.db
        .query<Fact, [number, number, string, string, number]>(
          `SELECT f.* FROM facts f
           JOIN fact_entities fe ON fe.fact_id = f.fact_id
           WHERE fe.entity_id = ? AND f.trust_score >= ? AND f.scope = ? AND f.category = ?
           ORDER BY f.trust_score DESC, f.fact_id DESC LIMIT ?`,
        )
        .all(entityRow.entity_id, minTrust, opts.scope ?? SCOPE_GLOBAL, opts.category, limit) as unknown as Fact[];
    }
    return this.db
      .query<Fact, [number, number, string, number]>(
        `SELECT f.* FROM facts f
         JOIN fact_entities fe ON fe.fact_id = f.fact_id
         WHERE fe.entity_id = ? AND f.trust_score >= ? AND f.scope = ?
         ORDER BY f.trust_score DESC, f.fact_id DESC LIMIT ?`,
      )
      .all(entityRow.entity_id, minTrust, opts.scope ?? SCOPE_GLOBAL, limit) as unknown as Fact[];
  }

  count(): number {
    const row = this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM facts")
      .get();
    return row?.n ?? 0;
  }

  /** Facts per category, for /memory status. */
  countByCategory(): Array<{ category: string; n: number }> {
    return this.db
      .query<{ category: string; n: number }, []>(
        "SELECT category, COUNT(*) AS n FROM facts GROUP BY category ORDER BY n DESC, category ASC",
      )
      .all();
  }

  /** Wipe everything. Used by /memory clear and tests. */
  clear(): void {
    this.db.exec("DELETE FROM fact_entities");
    this.db.exec("DELETE FROM entities");
    this.db.exec("DELETE FROM facts");
    this.termCache.invalidateAll();
  }

  /** Create a FactRetriever bound to this store's database. */
  retriever(opts?: { ftsWeight?: number; jaccardWeight?: number; tfidfWeight?: number }): FactRetriever {
    // Keep the hybrid retriever on the same temporal-decay schedule as the
    // FTS5 main path — otherwise related/reason/contradict would resurrect
    // stale facts the search path ranks down. Shares this store's term cache
    // so the retriever's fallback path stops re-tokenizing per call.
    return new FactRetriever(this.db, {
      ...opts,
      temporalDecayHalfLife: this.temporalDecayHalfLifeDays,
      retrievalFrequencyWeight: this.retrievalFrequencyWeight,
      termCache: this.termCache,
    });
  }

  /** Decay factor for a fact's updated_at (UTC-normalised), JS mirror of the
   *  SQL exp() used by _ftsRows. Half-life <= 0 means no decay. */
  private _decayFactor(timestampStr: string): number {
    if (this.temporalDecayHalfLifeDays <= 0) return 1;
    const ms = Date.now() - Date.parse(`${timestampStr.replace(" ", "T")}Z`);
    if (Number.isNaN(ms) || ms <= 0) return 1;
    return Math.pow(0.5, ms / (this.temporalDecayHalfLifeDays * 86_400_000));
  }

  // ---- entity helpers ----------------------------------------------------

  /** Extract entities from text, resolve/create in DB, link to fact. */
  private _linkEntities(factId: number, content: string): void {
    // Remove existing links for this fact
    this.db.query("DELETE FROM fact_entities WHERE fact_id = ?").run(factId);

    const entityNames = extractEntities(content);
    for (const name of entityNames) {
      const entityId = this._resolveEntity(name);
      this.db
        .query("INSERT OR IGNORE INTO fact_entities (fact_id, entity_id) VALUES (?, ?)")
        .run(factId, entityId);
    }
  }

  /** Find or create an entity by name (case-insensitive), with alias check. */
  private _resolveEntity(name: string): number {
    const lower = name.toLowerCase();

    // Exact name match (case-insensitive)
    const exact = this.db
      .query<{ entity_id: number }, [string]>("SELECT entity_id FROM entities WHERE LOWER(name) = ?")
      .get(lower);
    if (exact) return exact.entity_id;

    // Alias match (LIKE wildcards escaped — entity names may contain _/%)
    const alias = this.db
      .query<{ entity_id: number }, [string]>(
        "SELECT entity_id FROM entities WHERE (',' || aliases || ',') LIKE ? ESCAPE '\\'",
      )
      .get(`%,${escapeLike(lower)},%`);
    if (alias) return alias.entity_id;

    // Create new entity
    const row = this.db
      .query<{ entity_id: number }, [string]>("INSERT INTO entities (name) VALUES (?) RETURNING entity_id")
      .get(name);
    return row!.entity_id;
  }

  // ---- TF-IDF helpers ----------------------------------------------------

  /**
   * Compute and store the term vector for a fact.
   *
   * We store a normalized term-frequency vector derived from the fact's own
   * content (O(content length)), NOT a corpus-wide TF-IDF. The previous
   * implementation rebuilt the IDF map from a full-table scan on every write
   * (O(N) per write, O(N^2) overall) yet only refreshed the current fact's
   * vector — so every other fact kept the IDF from its own insertion moment
   * and grew stale as the corpus changed. Since the retriever's query vector
   * is also IDF-free and the FTS5 bm25 signal already supplies IDF-like
   * weighting, storing self-contained TF vectors keeps both sides of the
   * cosine on the same scale while removing the quadratic write cost and the
   * staleness.
   */
  private _computeTfIdf(factId: number, content: string): void {
    const tokens = filterStopwords(tokenize(content)).map(normalizeTerm);
    const vec = computeTfIdf(tokens, new Map());

    this.db
      .query("UPDATE facts SET tfidf_vector = ? WHERE fact_id = ?")
      .run(vectorToJson(vec), factId);
  }

  private _fallbackSearch(query: string, opts: SearchOptions, minTrust: number, limit: number): Fact[] {
    const tokens = expandQuery(filterStopwords(tokenize(query))).map((e) => normalizeTerm(e.term));
    if (tokens.length === 0) return [];

    const candidates = this.list({
      category: opts.category,
      minTrust,
      limit: 500,
      scope: opts.scope,
      cwd: opts.cwd,
    });

    const scored = candidates
      .map((fact) => {
        // Cached canonical terms + lowercased text (content+tags): the
        // tokenize/normalize pass is the dominant fallback cost and is
        // fact-independent of the query — memoize it per fact (see
        // FactTermCache). Scoring semantics are unchanged: exact canonical
        // hit OR substring inclusion, negation guard, decay, trust.
        const { text: content, canonical } = this.termCache.get(fact.fact_id, fact.content, fact.tags);
        let score = 0;
        let negatedHit = false;
        for (const token of tokens) {
          if (!token) continue;
          if (canonical.has(token) || content.includes(token)) {
            score += token.length >= 4 ? 2 : 1;
          }
          // Negation guard: a fact asserting "我不用 bun" / "never use bun"
          // must not rank as positive recall for a "bun" query.
          if (!negatedHit) {
            let idx = content.indexOf(token);
            while (idx >= 0) {
              if (negationNear(content, idx, token)) {
                negatedHit = true;
                break;
              }
              idx = content.indexOf(token, idx + Math.max(1, token.length));
            }
          }
        }
        if (score === 0) return null;
        if (negatedHit) score *= 0.2;
        score *= this._decayFactor(fact.updated_at);
        // Retrieval-frequency boost — same formula as the FTS path.
        score *= 1 + this.retrievalFrequencyWeight * Math.min(fact.retrieval_count, 10);
        return { fact, score: score * fact.trust_score };
      })
      .filter((row): row is { fact: Fact; score: number } => row !== null)
      .sort((a, b) => b.score - a.score || b.fact.fact_id - a.fact.fact_id)
      .slice(0, limit)
      .map((row) => row.fact);

    this._bumpRetrieval(scored);
    return scored;
  }
}
