/**
 * SQLite schema for the srcode memory store.
 *
 * Simplified port of hermes-agent's holographic memory plugin
 * (~/hermes-agent/plugins/memory/holographic/store.py:_SCHEMA):
 * - keep `facts` (with category/tags/trust/retrieval bookkeeping)
 * - keep FTS5 mirror with INSERT/DELETE/UPDATE triggers
 * - drop HRR vector + memory_banks (numpy-only path)
 * - drop entities/fact_entities (FTS5 covers entity-as-keyword for v1;
 *   re-add when we need entity disambiguation)
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

CREATE INDEX IF NOT EXISTS idx_facts_trust    ON facts(trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);

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

export const VALID_CATEGORIES = ["user_pref", "project", "tool", "general"] as const;
export type Category = (typeof VALID_CATEGORIES)[number];

/** Trust adjustment per feedback action — mirrors holographic store. */
export const HELPFUL_DELTA = 0.05;
export const UNHELPFUL_DELTA = -0.10;
export const TRUST_MIN = 0.0;
export const TRUST_MAX = 1.0;
