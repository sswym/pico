/**
 * SQLite schema for the srcode memory store.
 *
 * Ported from hermes-agent's holographic memory plugin
 * (~/hermes-agent/plugins/memory/holographic/store.py:_SCHEMA):
 * - facts with category/tags/trust/retrieval bookkeeping
 * - FTS5 mirror with INSERT/DELETE/UPDATE triggers
 * - entities + fact_entities for entity resolution (probe/related/reason)
 * - TF-IDF vectors stored as JSON (replaces HRR numpy dependency)
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  fact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content         TEXT NOT NULL UNIQUE,
  category        TEXT NOT NULL DEFAULT 'general',
  tags            TEXT NOT NULL DEFAULT '',
  trust_score     REAL NOT NULL DEFAULT 0.5,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  helpful_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entities (
  entity_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'unknown',
  aliases     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fact_entities (
  fact_id   INTEGER REFERENCES facts(fact_id) ON DELETE CASCADE,
  entity_id INTEGER REFERENCES entities(entity_id) ON DELETE CASCADE,
  PRIMARY KEY (fact_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_facts_trust    ON facts(trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_entities_name  ON entities(name);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
  USING fts5(content, tags, content=facts, content_rowid=fact_id);

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, content, tags)
    VALUES (new.fact_id, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content, tags)
    VALUES ('delete', old.fact_id, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content, tags)
    VALUES ('delete', old.fact_id, old.content, old.tags);
  INSERT INTO facts_fts(rowid, content, tags)
    VALUES (new.fact_id, new.content, new.tags);
END;
`;

export const VALID_CATEGORIES = [
  "user_pref",
  "project",
  "tool",
  "general",
  "failure",
  "correction",
  "insight",
  "convention",
  "tool_quirk",
] as const;
export type Category = (typeof VALID_CATEGORIES)[number];
/** Human-readable category list used in tool descriptions and `/memory` help. */
export const CATEGORY_LIST = VALID_CATEGORIES.join(" | ");

/** Trust adjustment per feedback action — mirrors holographic store. */
export const HELPFUL_DELTA = 0.05;
export const UNHELPFUL_DELTA = -0.10;
export const TRUST_MIN = 0.0;
export const TRUST_MAX = 1.0;

/** Trust penalty applied to a fact when it is corrected by a new one. */
export const CORRECTION_DELTA = -0.30;
/** Initial trust for a correction fact (high so it surfaces above the original). */
export const CORRECTED_BOOST = 0.70;

/** Scope constants — global facts apply everywhere; project facts are cwd-scoped. */
export const SCOPE_GLOBAL = "global";
export const SCOPE_PROJECT = "project";
export const VALID_SCOPES = [SCOPE_GLOBAL, SCOPE_PROJECT] as const;
export type Scope = (typeof VALID_SCOPES)[number];

/**
 * Migration SQL — adds columns introduced after the initial schema.
 * Each statement is idempotent (wrapped in try/catch at call-site for
 * ALTER TABLE, which fails if the column already exists).
 */
export const MIGRATIONS = [
  "ALTER TABLE facts ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'",
  "ALTER TABLE facts ADD COLUMN correction_of INTEGER REFERENCES facts(fact_id)",
  "ALTER TABLE facts ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'",
  "CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope)",
  "CREATE INDEX IF NOT EXISTS idx_facts_correction ON facts(correction_of)",
  "ALTER TABLE facts ADD COLUMN tfidf_vector TEXT NOT NULL DEFAULT '{}'",
];
