/**
 * MemoryProvider — abstract interface for pluggable memory backends.
 *
 * Ported from hermes-agent's agent/memory_provider.py MemoryProvider ABC.
 *
 * A provider encapsulates:
 *   - Data lifecycle (add/search/probe/related/reason/contradict/update/remove/feedback/list)
 *   - Session lifecycle (initialize / shutdown)
 *   - Context injection (systemPromptBlock / prefetch / queuePrefetch)
 *   - Optional lifecycle hooks (onSessionEnd / onDelegation / onMemoryWrite / onPreCompress)
 */
import type { Category, Scope } from "./schema.ts";

// ---- Data types (shared across all providers) ---------------------------

export interface MemoryInitializeContext {
  cwd?: string;
  sessionReason?: string;
  parentSessionId?: string;
  platform?: string;
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

// ---- MemoryWriteMetadata -------------------------------------------------

export interface MemoryWriteMetadata {
  /** Tool action that triggered the write ("add" | "update" | "remove"). */
  action: "add" | "update" | "remove";
  /** The content being written (for add/update). */
  content?: string;
  /** The fact id of the written entry. */
  factId?: number;
  /** Previous content for updates. */
  previousContent?: string;
  /** Tags attached to the write. */
  tags?: string;
  /** Category of the written fact. */
  category?: Category;
  /** Scope of the written fact. */
  scope?: Scope;
  /** Source identifier (e.g. "manual", "auto", "correction"). */
  source?: string;
}

// ---- WriteQueue — non-blocking background execution ----------------------
//
// Defers synchronous side-effect work (extraction, background prefetch,
// post-turn housekeeping) to a microtask so the agent response path is
// never blocked. Analogous to hermes-agent's background sync_turn threads.
//
// Operations within the queue execute in FIFO order. flush() drains all
// pending work and resolves.

export interface QueuedOp {
  description: string;
  run: () => void;
}

export class WriteQueue {
  private queue: QueuedOp[] = [];
  private draining = false;
  /** Enqueue a background operation. Starts draining on the next microtask. */
  push(description: string, run: () => void): void {
    this.queue.push({ description, run });
    if (!this.draining) {
      this.draining = true;
      queueMicrotask(() => this.drain());
    }
  }


  /** Return the number of pending operations. */
  get pending(): number {
    return this.queue.length;
  }

  /** Drain all pending operations synchronously. */
  drain(): void {
    while (this.queue.length > 0) {
      const op = this.queue.shift()!;
      try {
        op.run();
      } catch {
        // background ops must never throw
      }
    }
    this.draining = false;
  }

  /**
   * Flush all pending operations and resolve when the queue is empty.
   * If already empty, resolves immediately.
   */
  flush(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.push("flush", resolve as () => void);
    return promise;
  }
}

// ---- Provider interface --------------------------------------------------

export interface MemoryProvider {
  /** Short identifier (e.g. "builtin", "holographic", "mem0"). */
  readonly name: string;

  /**
   * Return true if this provider is configured, has credentials, and is
   * ready to activate. Called during agent init to decide whether to
   * use this provider. Should not make network calls.
   */
  isAvailable(): boolean;

  /** Initialize for a session. Called once at startup. */
  initialize(sessionId: string, context?: MemoryInitializeContext): void;

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

  // -- Write queue -------------------------------------------------------

  /** The provider's background write queue. */
  readonly queue: WriteQueue;

  /**
   * Optional access to the underlying store implementation.
   * Returns null if the provider doesn't expose a raw store.
   * Used by autoExtractFromMessages for low-level operations.
   */
  getRawStore(): unknown;

  // -- Context injection -------------------------------------------------

  /** Static text for the system prompt (tool description, stats). */
  systemPromptBlock(): string;

  /**
   * Prefetch relevant facts for an upcoming turn.
   * Returns data previously queued by queuePrefetch().
   */
  prefetch(query: string, cwd?: string): Fact[];

  /**
   * Queue a background prefetch for the NEXT turn.
   * Called after each turn completes. The result is consumed by
   * prefetch() on the following turn. Default is no-op.
   */
  queuePrefetch(query: string, cwd?: string): void;

  /**
   * Optional extra tool schemas exposed by an external provider.
   * Each schema is the bare function schema shape:
   * { name, description, parameters }.
   */
  getToolSchemas?(): Array<Record<string, unknown>>;

  /** Handle a provider-owned tool call. */
  handleToolCall?(toolName: string, args: Record<string, unknown>, context?: Record<string, unknown>): string;

  /** Persist a completed turn to a provider backend. Should be non-blocking from callers. */
  syncTurn?(
    userContent: string,
    assistantContent: string,
    opts?: { sessionId?: string; messages?: unknown[]; [key: string]: unknown },
  ): void;

  // -- Optional lifecycle hooks ------------------------------------------

  /**
   * Called at the start of each turn with the user message.
   * Use for turn-counting, scope management, periodic maintenance.
   */
  onTurnStart?(turnNumber: number, message: string): void;

  /**
   * Called when a session ends (explicit exit or timeout).
   * Use for end-of-session fact extraction, summarization.
   * NOT called after every turn — only at actual session boundaries.
   */
  onSessionEnd?(messages: unknown[]): void;

  /**
   * Called when the agent switches/resets/forks sessions without process exit.
   */
  onSessionSwitch?(
    newSessionId: string,
    opts?: { parentSessionId?: string; reset?: boolean; rewound?: boolean; [key: string]: unknown },
  ): void;

  /**
   * Called before context compression discards old messages.
   * Return text to include in the compression summary prompt.
   * Return empty string for no contribution.
   */
  onPreCompress?(messages: unknown[]): string;

  /**
   * Called on the PARENT agent when a subagent completes.
   * The parent's provider gets the task+result pair as an observation.
   */
  onDelegation?(task: string, result: string, childSessionId?: string): void;

  /**
   * Called BEFORE the built-in memory tool writes an entry.
   * Return { ok: false, reason: "..." } to deny the write.
   * Return void or { ok: true } to allow it.
   */
  onBeforeWrite?(metadata: MemoryWriteMetadata): { ok: boolean; reason?: string } | void;

  /**
   * Called when the built-in memory tool writes an entry.
   * Use to mirror built-in writes to an external backend.
   */
  onMemoryWrite?(metadata: MemoryWriteMetadata): void;
}
