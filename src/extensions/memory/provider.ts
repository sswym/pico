/**
 * MemoryProvider — abstract interface for pluggable memory backends.
 *
 * Ported from hermes-agent's agent/memory_provider.py MemoryProvider ABC.
 *
 * A provider encapsulates:
 *   - Data lifecycle (add/search/probe/related/reason/contradict/update/remove/feedback/list)
 *   - Session lifecycle (initialize / shutdown)
 *   - Context injection (systemPromptBlock / prefetch)
 *
 * index.ts selects the active provider(s) and delegates to them.
 */
import type { Category, Scope } from "./schema.ts";

// ---- Data types (shared across all providers) ---------------------------

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

export interface UpdateOptions {
  content?: string;
  category?: Category;
  tags?: string;
  trustDelta?: number;
}

export interface ScoredFact extends Fact {
  score: number;
}

export interface ContradictionResult {
  fact_a: Fact;
  fact_b: Fact;
  entity_overlap: number;
  content_similarity: number;
  contradiction_score: number;
  shared_entities: string[];
}

// ---- Provider interface --------------------------------------------------

export interface MemoryProvider {
  /** Short identifier (e.g. "builtin", "holographic", "mem0"). */
  readonly name: string;

  /** Initialize for a session. Called once at startup. */
  initialize(sessionId: string): void;

  /** Clean shutdown — flush queues, close connections. */
  shutdown(): void;

  // -- Data API ----------------------------------------------------------

  get(factId: number): Fact | null;
  add(content: string, opts?: AddOptions): number;
  update(factId: number, opts: UpdateOptions): boolean;
  remove(factId: number): boolean;
  feedback(factId: number, helpful: boolean): Fact | null;
  clear(): void;
  count(): number;

  search(query: string, opts?: SearchOptions): Fact[];
  probe(entity: string, opts?: SearchOptions): Fact[];
  list(opts?: SearchOptions): Fact[];
  related(entity: string, opts?: SearchOptions): ScoredFact[];
  reason(entities: string[], opts?: SearchOptions): ScoredFact[];
  contradict(opts?: { category?: string; limit?: number }): ContradictionResult[];

  // -- Context injection -------------------------------------------------

  /** Static text for the system prompt (tool description, stats). */
  systemPromptBlock(): string;

  /** Prefetch relevant facts for an upcoming turn. */
  prefetch(query: string, cwd?: string): Fact[];
}
