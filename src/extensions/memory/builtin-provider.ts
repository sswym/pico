/**
 * BuiltinMemoryProvider — the default srcode memory backend.
 *
 * Wraps MemoryStore (SQLite + FTS5 + TF-IDF) and FactRetriever into the
 * MemoryProvider interface. This is the only provider shipped with srcode;
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
} from "./provider.ts";

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
  private store: MemoryStore;
  private retriever: FactRetriever;

  constructor(dbPath: string) {
    this.store = new MemoryStore(dbPath);
    this.retriever = this.store.retriever();
  }

  initialize(_sessionId: string): void {
    // MemoryStore is initialized in the constructor; nothing extra needed.
  }

  shutdown(): void {
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
    }).map(toScoredFact);
  }

  reason(entities: string[], opts: SearchOptions = {}): ScoredFact[] {
    this._renewRetriever();
    return this.retriever.reason(entities, {
      category: opts.category,
      minTrust: opts.minTrust,
      limit: opts.limit,
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
    // index.ts handles prompt formatting via prompt.ts helpers.
    // Return the raw fact count so the caller can format.
    const count = this.store.count();
    return `Memory: ${count} facts stored. Use memory(action=...) to access them.`;
  }

  prefetch(query: string, cwd?: string): Fact[] {
    if (!query) return [];
    return this.store.search(query, {
      limit: 5,
      minTrust: 0.3,
      scope: cwd ? "project" as any : undefined,
      cwd,
    }).map(toFact);
  }
}
