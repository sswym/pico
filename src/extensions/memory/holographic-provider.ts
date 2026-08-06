/**
 * HolographicMemoryProvider — example external provider stub.
 *
 * Demonstrates the MemoryProvider contract for a plugin-backed provider.
 * In production, this would use HRR (Holographic Reduced Representations)
 * via numpy for associative retrieval (see hermes-agent).
 *
 * To activate, set `memory.backend: "holographic"` in settings.
 * ProviderManager falls back to builtin if this module is unavailable.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import {
  type Fact,
  type ScoredFact,
  type ContradictionResult,
  type AddOptions,
  type SearchOptions,
  type UpdateOptions,
  type MemoryProvider,
  WriteQueue,
} from "./provider.ts";
import type { Category, Scope } from "./schema.ts";
import { HELPFUL_DELTA, UNHELPFUL_DELTA } from "./schema.ts";
import { picoHolographicMemoryPath } from "../paths.ts";
import { scanSecrets } from "./secrets.ts";

function defaultDbPath(): string {
  return picoHolographicMemoryPath();
}

interface StoredFact {
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

function toFact(s: StoredFact): Fact {
  return {
    fact_id: s.fact_id,
    content: s.content,
    category: s.category,
    tags: s.tags,
    trust_score: s.trust_score,
    retrieval_count: s.retrieval_count,
    helpful_count: s.helpful_count,
    created_at: s.created_at,
    updated_at: s.updated_at,
    scope: s.scope,
    correction_of: s.correction_of,
    source: s.source,
  };
}

export class HolographicMemoryProvider implements MemoryProvider {
  readonly name = "holographic";
  readonly queue = new WriteQueue();

  private dbPath: string;
  private rows: StoredFact[] = [];
  private nextId = 1;
  private _sessionId = "";

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? defaultDbPath();
    this._load();
  }

  isAvailable(): boolean {
    return true;
  }

  initialize(sessionId: string): void {
    this._sessionId = sessionId;
  }

  shutdown(): void {
    this.queue.drain();
    this._save();
  }

  // ---- Data API ----------------------------------------------------------

  count(): number {
    return this.rows.length;
  }

  get(factId: number): Fact | null {
    const row = this.rows.find((r) => r.fact_id === factId);
    return row ? toFact(row) : null;
  }

  add(content: string, opts?: AddOptions): number {
    // Same secret gate as the builtin store: the demo backend must not be a
    // bypass for persisting credentials.
    const scan = scanSecrets(content);
    if (scan.blocked) throw new Error(`memory.add: ${scan.reason}`);
    const now = new Date().toISOString();
    const row: StoredFact = {
      fact_id: this.nextId++,
      content,
      category: opts?.category ?? "general",
      tags: opts?.tags ?? "",
      trust_score: opts?.trust ?? 1,
      retrieval_count: 0,
      helpful_count: 0,
      created_at: now,
      updated_at: now,
      scope: opts?.scope ?? "global",
      correction_of: opts?.correctionOf ?? null,
      source: opts?.source ?? "user",
    };
    this.rows.push(row);
    this.queue.push("save", () => this._save());
    return row.fact_id;
  }

  update(factId: number, opts: UpdateOptions): boolean {
    const row = this.rows.find((r) => r.fact_id === factId);
    if (!row) return false;
    if (opts.content !== undefined) row.content = opts.content;
    if (opts.category !== undefined) row.category = opts.category;
    if (opts.tags !== undefined) row.tags = opts.tags;
    if (opts.trustDelta !== undefined) row.trust_score = Math.max(0, row.trust_score + opts.trustDelta);
    row.updated_at = new Date().toISOString();
    this.queue.push("save", () => this._save());
    return true;
  }

  remove(factId: number): boolean {
    const idx = this.rows.findIndex((r) => r.fact_id === factId);
    if (idx === -1) return false;
    this.rows.splice(idx, 1);
    this.queue.push("save", () => this._save());
    return true;
  }

  feedback(factId: number, helpful: boolean): Fact | null {
    const row = this.rows.find((r) => r.fact_id === factId);
    if (!row) return null;
    if (helpful) row.helpful_count++;
    // Mirror the builtin backend's trust deltas so both providers behave
    // identically for the same feedback input.
    const delta = helpful ? HELPFUL_DELTA : UNHELPFUL_DELTA;
    row.trust_score = Math.max(0, Math.min(1, row.trust_score + delta));
    row.updated_at = new Date().toISOString();
    this.queue.push("save", () => this._save());
    return toFact(row);
  }

  clear(): void {
    this.rows = [];
    this.nextId = 1;
    this._save();
  }

  search(_query: string, opts?: SearchOptions): Fact[] {
    // Simple substring fallback (production would use FTS5 or HRR probe).
    const q = (_query ?? "").toLowerCase();
    const minTrust = opts?.minTrust ?? 0;
    const limit = opts?.limit ?? 10;
    const results: Fact[] = [];
    for (const row of this.rows) {
      if (row.trust_score < minTrust) continue;
      if (opts?.category && row.category !== opts.category) continue;
      if (opts?.scope && row.scope !== opts.scope) continue;
      if (q && !row.content.toLowerCase().includes(q)) continue;
      results.push(toFact(row));
      if (results.length >= limit) break;
    }
    return results;
  }

  probe(entity: string, opts?: SearchOptions): Fact[] {
    return this.search(entity, opts);
  }

  list(opts?: SearchOptions): Fact[] {
    return this.search("", opts);
  }

  related(_entity: string, _opts?: SearchOptions): ScoredFact[] {
    // Stub: in production, compute entity vector similarity.
    return [];
  }

  reason(_entities: string[], _opts?: SearchOptions): ScoredFact[] {
    // Stub: in production, bundle overlapping entities.
    return [];
  }

  contradict(_opts?: { category?: string; limit?: number; scope?: Scope; cwd?: string }): ContradictionResult[] {
    // Stub: compare all fact pairs for contradiction signals.
    return [];
  }

  // ---- Raw store ---------------------------------------------------------

  getRawStore(): unknown {
    return this.rows;
  }

  // ---- Context injection -------------------------------------------------

  systemPromptBlock(): string {
    const count = this.rows.length;
    if (count === 0) return "";
    return [
      "<memory-overview>",
      `Backend: holographic (demo — related/reason/contradict disabled) | Facts: ${count}`,
      "</memory-overview>",
    ].join("\n");
  }

  prefetch(query: string, _cwd?: string): Fact[] {
    if (!query) return [];
    // Substring search across all scopes — the demo store's search() treats
    // scope as an exact filter, so passing "project" would hide global facts.
    return this.search(query, { limit: 5, minTrust: 0.3 });
  }

  queuePrefetch(_query: string, _cwd?: string): void {
    // Synchronous substring search is cheap; nothing to precompute.
  }

  // ---- Persistence -------------------------------------------------------

  private _load(): void {
    try {
      const raw = readFileSync(this.dbPath, "utf-8");
      const parsed = JSON.parse(raw) as { rows: StoredFact[]; nextId: number };
      this.rows = parsed.rows ?? [];
      // rows.length + 1 can COLLIDE with an existing fact_id when the file
      // has deleted rows (id holes) — the next add would then update/remove
      // the wrong fact. Always pick max+1.
      this.nextId = parsed.nextId ?? Math.max(0, ...this.rows.map((r) => r.fact_id)) + 1;
    } catch {
      // Corrupt JSON must not be silently reset (that would destroy the
      // stored memory): back the file up before falling back to empty state.
      try {
        const backup = `${this.dbPath}.corrupt-${Date.now()}`;
        renameSync(this.dbPath, backup);
        console.warn(`[pico memory] holographic store unreadable; backed up to ${backup}`);
      } catch {
        // No file at all (first run) or backup failed — nothing to preserve.
      }
      this.rows = [];
      this.nextId = 1;
    }
  }

  private _save(): void {
    try {
      const dir = this.dbPath.slice(0, this.dbPath.lastIndexOf("/"));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // tmp + rename: a crash mid-write must not truncate the store.
      const tmp = `${this.dbPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ rows: this.rows, nextId: this.nextId }, null, 2));
      renameSync(tmp, this.dbPath);
    } catch {
      // best-effort
    }
  }
}
