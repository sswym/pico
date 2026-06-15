/**
 * Tiny in-memory LRU cache for web extension.
 *
 * Pure TS — no `lru-cache` dependency. We need only the basics: TTL-per-entry,
 * size cap by entry count, and the LRU eviction order. Map preserves insertion
 * order, so re-inserting on every `get` keeps the most-recently-used at the
 * tail and the head is the eviction candidate.
 */
export interface LRUOptions {
  max: number;
  ttlMs: number;
  /** Optional clock injection for tests. */
  now?: () => number;
}

export class LRU<K, V> {
  private readonly map: Map<K, { value: V; expiresAt: number }> = new Map();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: LRUOptions) {
    this.max = Math.max(1, opts.max);
    this.ttlMs = Math.max(0, opts.ttlMs);
    this.now = opts.now ?? Date.now;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
