/**
 * BuiltinMemoryProvider — the default pico memory backend.
 *
 * Wraps MemoryStore (SQLite + FTS5 + TF-IDF) and FactRetriever into the
 * MemoryProvider interface. This is the only provider shipped with pico;
 * external providers (honcho, mem0, hindsight, etc.) can be added by
 * implementing the MemoryProvider interface.
 */
import { MemoryStore, type Fact as StoreFact } from "./store.ts";
import { type FactRetriever, type ScoredFact as RetrieverScoredFact, type ContradictionResult as RetrieverContradiction } from "./retrieval.ts";
import {
  type MemoryProvider,
  type Fact,
  type AddOptions,
  type SearchOptions,
  type UpdateOptions,
  type ScoredFact,
  type ContradictionResult,
  type MemoryWriteMetadata,
  WriteQueue,
} from "./provider.ts";

/** Keywords that must never be persisted to memory (comma-separated env). */
function denyKeywords(): string[] {
  const raw = process.env.PICO_MEMORY_DENY ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function toFact(sf: StoreFact): Fact {
  return sf as unknown as Fact;
}

function toScoredFact(sf: RetrieverScoredFact): ScoredFact {
  return sf as unknown as ScoredFact;
}

function toContradiction(c: RetrieverContradiction): ContradictionResult {
  return {
    fact_a: c.fact_a as unknown as Fact,
    fact_b: c.fact_b as unknown as Fact,
    entity_overlap: c.entity_overlap,
    content_similarity: c.content_similarity,
    contradiction_score: c.contradiction_score,
    shared_entities: c.shared_entities,
  };
}

export class BuiltinMemoryProvider implements MemoryProvider {
  readonly name = "builtin";
  readonly queue = new WriteQueue();

  private store: MemoryStore;
  private retriever: FactRetriever;
  /** Cached prefetch result, set by queuePrefetch, consumed by prefetch. */
  private cachedPrefetch: { query: string; results: Fact[] } | null = null;

  constructor(dbPath: string) {
    this.store = new MemoryStore(dbPath);
    this.retriever = this.store.retriever();
  }

  isAvailable(): boolean {
    return true; // builtin is always available
  }

  initialize(_sessionId: string): void {
    // MemoryStore is initialized in the constructor; nothing extra needed.
  }

  shutdown(): void {
    this.queue.drain();
    this.store.close();
  }

  // -- Fact conversion helpers -------------------------------------------

  private _renewRetriever(): void {
    this.retriever = this.store.retriever();
  }

  // -- Data API ----------------------------------------------------------

  get(factId: number): Fact | null {
    const f = this.store.get(factId);
    return f ? toFact(f) : null;
  }

  add(content: string, opts: AddOptions = {}): number {
    return this.store.add(content, {
      category: opts.category,
      tags: opts.tags,
      trust: opts.trust,
      scope: opts.scope,
      correctionOf: opts.correctionOf,
      source: opts.source,
      cwd: opts.cwd,
    });
  }

  getRawStore(): unknown {
    return this.store;
  }

  update(factId: number, opts: UpdateOptions): boolean {
    return this.store.update(factId, {
      content: opts.content,
      category: opts.category,
      tags: opts.tags,
      trustDelta: opts.trustDelta,
    });
  }

  remove(factId: number): boolean {
    return this.store.remove(factId);
  }

  /**
   * Write gate: refuses to persist content matching PICO_MEMORY_DENY
   * keywords. External providers can override this for richer policy.
   * Returns void (allow) when no deny list is configured.
   */
  onBeforeWrite(metadata: MemoryWriteMetadata): { ok: boolean; reason?: string } | void {
    const deny = denyKeywords();
    if (deny.length === 0) return;
    const text = (metadata.content ?? "").toLowerCase();
    const hit = deny.find((kw) => text.includes(kw));
    if (hit) {
      return { ok: false, reason: `memory write denied: contains blocked keyword '${hit}'` };
    }
    return;
  }

  feedback(factId: number, helpful: boolean): Fact | null {
    const f = this.store.feedback(factId, helpful);
    return f ? toFact(f) : null;
  }

  clear(): void {
    this.store.clear();
  }

  count(): number {
    return this.store.count();
  }

  search(query: string, opts: SearchOptions = {}): Fact[] {
    return this.store.search(query, {
      category: opts.category,
      minTrust: opts.minTrust,
      limit: opts.limit,
      scope: opts.scope,
      cwd: opts.cwd,
    }).map(toFact);
  }

  probe(entity: string, opts: SearchOptions = {}): Fact[] {
    return this.store.probe(entity, {
      category: opts.category,
      minTrust: opts.minTrust,
      limit: opts.limit,
      scope: opts.scope,
      cwd: opts.cwd,
    }).map(toFact);
  }

  list(opts: SearchOptions = {}): Fact[] {
    return this.store.list({
      category: opts.category,
      minTrust: opts.minTrust,
      limit: opts.limit,
      scope: opts.scope,
      cwd: opts.cwd,
    }).map(toFact);
  }

  related(entity: string, opts: SearchOptions = {}): ScoredFact[] {
    this._renewRetriever();
    return this.retriever.related(entity, {
      category: opts.category,
      minTrust: opts.minTrust,
      limit: opts.limit,
      scope: opts.scope,
      cwd: opts.cwd,
    }).map(toScoredFact);
  }

  reason(entities: string[], opts: SearchOptions = {}): ScoredFact[] {
    this._renewRetriever();
    return this.retriever.reason(entities, {
      category: opts.category,
      minTrust: opts.minTrust,
      limit: opts.limit,
      scope: opts.scope,
      cwd: opts.cwd,
    }).map(toScoredFact);
  }
  
  contradict(opts: { category?: string; limit?: number } = {}): ContradictionResult[] {
    this._renewRetriever();
    return this.retriever.contradict({
      category: opts.category,
      limit: opts.limit,
    }).map(toContradiction);
  }

  // -- Context injection -------------------------------------------------

  systemPromptBlock(): string {
    const count = this.store.count();
    return `Memory: ${count} facts stored. Use memory(action=...) to access them.`;
  }

  /**
   * Consume the cached prefetch result set by queuePrefetch().
   * Returns the cached results matching the query, or falls back to
   * a synchronous search if no cache hit.
   */
  prefetch(query: string, cwd?: string): Fact[] {
    if (this.cachedPrefetch && this.cachedPrefetch.query === query) {
      const results = this.cachedPrefetch.results;
      this.cachedPrefetch = null;
      return results;
    }
    if (!query) return [];
    // Cache miss — drop the stale entry so a later re-ask of the old query
    // can't surface results computed for an earlier turn.
    this.cachedPrefetch = null;
    return this.store.search(query, {
      limit: 5,
      minTrust: 0.3,
      scope: cwd ? ("project" as const) : undefined,
      cwd,
    }).map(toFact);
  }

  /**
   * Queue a background prefetch for the NEXT turn.
   * Executes on the next microtask via the WriteQueue.
   */
  queuePrefetch(query: string, cwd?: string): void {
    if (!query) return;
    this.queue.push(`prefetch:${query.slice(0, 60)}`, () => {
      this.cachedPrefetch = {
        query,
        results: this.store.search(query, {
          limit: 5,
          minTrust: 0.3,
          scope: cwd ? ("project" as const) : undefined,
          cwd,
        }).map(toFact),
      };
    });
  }
}
