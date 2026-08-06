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
import type { Scope } from "./schema.ts";
import { autoExtractFromMessages, extractText, type ExtractableMessage } from "./extract.ts";
import { SCOPE_GLOBAL, SCOPE_PROJECT } from "./schema.ts";
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
  /** Project cwd of the current session — project-scopes onSessionEnd/onPreCompress writes. */
  private sessionCwd: string | undefined;

  constructor(dbPath: string, opts: { temporalDecayHalfLifeDays?: number } = {}) {
    this.store = new MemoryStore(dbPath, { temporalDecayHalfLifeDays: opts.temporalDecayHalfLifeDays });
    this.retriever = this.store.retriever();
  }

  isAvailable(): boolean {
    return true; // builtin is always available
  }

  initialize(_sessionId: string, context?: { cwd?: string }): void {
    this.sessionCwd = context?.cwd;
    // MemoryStore is initialized in the constructor; nothing extra needed.
  }

  shutdown(closeStore = true): void {
    this.queue.drain();
    // Session switch (resume/fork/new) must NOT close the store — the same
    // provider instance keeps serving the new session in this process.
    if (closeStore) this.store.close();
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

  /** Facts per category (builtin backend only). */
  countByCategory(): Array<{ category: string; n: number }> {
    return this.store.countByCategory();
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
  
  contradict(opts: { category?: string; limit?: number; threshold?: number; scope?: Scope; cwd?: string } = {}): ContradictionResult[] {
    this._renewRetriever();
    // Forward scope/cwd/threshold: the retriever's scopeFilter is the only
    // thing that keeps contradict from mixing global and project facts.
    // Dropping scope/cwd here silently degraded project-scoped calls to
    // global-only results.
    return this.retriever.contradict({
      category: opts.category,
      limit: opts.limit,
      threshold: opts.threshold,
      scope: opts.scope,
      cwd: opts.cwd,
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
    // Cache-hit rule (2.3.10): the queued key is the previous full user
    // message, so exact equality almost never hits. Accept any direction of
    // prefix overlap, or a shared significant token (>= 4 chars, not a
    // stopword) — enough signal that the new turn continues the same topic.
    const cached = this.cachedPrefetch;
    if (cached && this._prefetchHit(cached.query, query)) {
      this.cachedPrefetch = null;
      return cached.results;
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

  private _prefetchHit(cached: string, current: string): boolean {
    const a = cached.toLowerCase();
    const b = current.toLowerCase();
    if (!a || !b) return false;
    if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
    const tokensA = new Set(a.split(/\s+/).filter((t) => t.length >= 4));
    const tokensB = new Set(b.split(/\s+/).filter((t) => t.length >= 4));
    for (const t of tokensA) {
      if (tokensB.has(t)) return true;
    }
    return false;
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

  // -- Session lifecycle hooks -------------------------------------------

  /**
   * Persist a single session-summary fact at session end so the next session
   * can recall "the previous session was about X". Purely additive: the
   * per-turn extraction already ran at every agent_end, so this only writes
   * the topic line (deduped by UNIQUE(scope, content)).
   */
  onSessionEnd(messages: unknown[]): void {
    if (!messages || messages.length === 0) return;
    const userTexts = messages
      .filter((m): m is ExtractableMessage => !!m && typeof m === "object" && (m as { role?: unknown }).role === "user")
      .map((m) => extractText(m.content).trim())
      .filter((t) => t.length >= 4);
    if (userTexts.length === 0) return;
    const topic = userTexts.find((t) => !SESSION_INSTRUCTION_RE.test(t));
    if (!topic) return; // a session of pure meta-instructions has no durable topic
    const tail = userTexts.length > 1 ? ` (+${userTexts.length - 1} more)` : "";
    const summary = `Session: ${topic.slice(0, 120)}${tail}`;
    try {
      this.store.add(summary, {
        category: "insight",
        scope: this.sessionCwd ? SCOPE_PROJECT : SCOPE_GLOBAL,
        cwd: this.sessionCwd,
        source: "session-summary",
      });
    } catch {
      // best-effort — a failed summary must never break session shutdown
    }
  }

  /**
   * Archive messages about to be discarded by context compression. Runs the
   * same pattern extraction as agent_end (idempotent — already-stored facts
   * are deduped), and returns a line for the compression summary.
   */
  onPreCompress(messages: unknown[]): string {
    const scan = (messages ?? []) as ExtractableMessage[];
    try {
      autoExtractFromMessages(this.store, scan, { cwd: this.sessionCwd });
    } catch {
      // best-effort
    }
    const userCount = scan.filter((m) => m?.role === "user").length;
    if (userCount === 0) return "";
    return `[memory] ${userCount} user message(s) from the compressed range were scanned into long-term memory before discard.`;
  }
}

/** Meta-instruction prefixes that must not become a session topic. */
const SESSION_INSTRUCTION_RE = /用\s*memory\s*工具|调用\s*memory|action\s*=|^\s*请\s*(?:用|调用|执行)/;
