/**
 * FactTermCache — per-fact canonical term cache for the substring fallback
 * retrieval paths.
 *
 * MemoryStore._fallbackSearch and FactRetriever._substringFallback both
 * re-tokenize every candidate fact's content+tags on every call. For Chinese
 * queries (FTS5's run-based tokenizer almost never matches), every search
 * pays a full 500-row regex scan (~15ms at 500 facts, linear in corpus size).
 * This cache memoizes each fact's lowercased text and normalized canonical
 * term set so repeated searches only pay the scoring loop (~0.2ms at 500
 * facts).
 *
 * Write-through: MemoryStore invalidates entries on add/update/remove/clear,
 * so a cached entry can never outlive the DB row it describes. Both the
 * store's own _fallbackSearch and the FactRetriever's _substringFallback
 * share one cache instance per store via `retriever()`.
 */

import { tokenize, filterStopwords } from "./tfidf.ts";
import { normalizeTerm } from "./synonyms.ts";

export interface FactTermEntry {
  /** Lowercased `content + tags` text — used for substring and negation checks. */
  text: string;
  /** Normalized canonical term set (aliases applied) — used for exact hits. */
  canonical: Set<string>;
}

export class FactTermCache {
  private readonly entries = new Map<number, FactTermEntry>();

  /** Compute a fact's term entry from raw content + tags. */
  compute(content: string, tags: string): FactTermEntry {
    const raw = `${content} ${tags}`;
    return {
      text: raw.toLowerCase(),
      canonical: new Set(filterStopwords(tokenize(raw)).map(normalizeTerm)),
    };
  }

  /** Memoized entry for a fact; computes and stores on first access. */
  get(factId: number, content: string, tags: string): FactTermEntry {
    let entry = this.entries.get(factId);
    if (entry === undefined) {
      entry = this.compute(content, tags);
      this.entries.set(factId, entry);
    }
    return entry;
  }

  /** Drop a single fact's entry (add/update/remove). */
  invalidate(factId: number): void {
    this.entries.delete(factId);
  }

  /** Drop every entry (clear / wholesale rewrite). */
  invalidateAll(): void {
    this.entries.clear();
  }

  /** Test-only: number of cached entries. */
  get size(): number {
    return this.entries.size;
  }
}
