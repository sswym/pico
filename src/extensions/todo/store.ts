/**
 * In-process todo store.
 *
 * Single map keyed by session id. We don't persist to disk — the todo list is
 * a within-session bookkeeping aid; if the user resumes a session and wants
 * the list back, they should re-state the work, which is a feature, not a
 * bug (forces re-prioritisation).
 *
 * Behaviour cribbed from claude-code's TodoWriteTool.call:
 * - if every item is `completed`, the list collapses to empty (the loop
 *   exited; no point keeping the carcass).
 * - duplicate ids are not deduped here — the LLM owns the list shape; we
 *   just store what it gives us, with light invariant checks surfaced to
 *   the model via the tool result.
 */
import type { Todo } from "./schema.ts";

export interface CommitResult {
  oldTodos: Todo[];
  writtenTodos: Todo[];
  storedTodos: Todo[];
  /** > 1 in_progress at once — model violates the "exactly one active" rule. */
  multipleInProgress: boolean;
  /** Caller supplied duplicate ids; later duplicates were reassigned. */
  duplicateIds: string[];
  /** Final list collapsed to empty because every task is done. */
  collapsed: boolean;
}

export class TodoStore {
  private bySession = new Map<string, Todo[]>();

  get(sessionKey: string): Todo[] {
    return this.bySession.get(sessionKey) ?? [];
  }

  /**
   * Replace the list for `sessionKey` with `todos`. Returns before/after for
   * UI rendering and a couple of invariant flags for the LLM to react to.
   */
  commit(sessionKey: string, todos: Todo[]): CommitResult {
    const oldTodos = this.get(sessionKey);
    const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
    const allDone = todos.length > 0 && todos.every((t) => t.status === "completed");

    // Auto-assign ids for missing and repeated ids so future updates stay stable.
    let nextId = todos.reduce((max, t) => {
      const n = t.id ? Number(t.id) : NaN;
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0);
    const seenIds = new Set<string>();
    const duplicateIds: string[] = [];
    const stamped: Todo[] = todos.map((t) => {
      if (!t.id) return { ...t, id: String(++nextId) };
      if (!seenIds.has(t.id)) {
        seenIds.add(t.id);
        return t;
      }
      duplicateIds.push(t.id);
      return { ...t, id: String(++nextId) };
    });

    const finalList = allDone ? [] : stamped;
    if (finalList.length === 0) this.bySession.delete(sessionKey);
    else this.bySession.set(sessionKey, finalList);

    return {
      oldTodos,
      writtenTodos: stamped,
      storedTodos: finalList,
      multipleInProgress: inProgressCount > 1,
      duplicateIds,
      collapsed: allDone,
    };
  }

  reset(sessionKey: string): void {
    this.bySession.delete(sessionKey);
  }

  resetAll(): void {
    this.bySession.clear();
  }

  /** All tracked lists (one per session). Order is not stable. */
  allLists(): Todo[][] {
    return Array.from(this.bySession.values());
  }
}
