/**
 * MemoryStore unit tests.
 *
 * Cover the surface that the memory tool & /memory command exercise:
 * add (incl. dedupe), search ranking, list filtering, feedback trust shifts,
 * update, remove, probe, count/clear.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/extensions/memory/store.ts";
import { autoExtractFromMessages } from "../src/extensions/memory/extract.ts";

let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  dbPath = join(tmpdir(), `srcode-mem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  store = new MemoryStore(dbPath);
});

afterEach(() => {
  store.close();
  try { rmSync(dbPath); } catch {}
  try { rmSync(`${dbPath}-wal`); } catch {}
  try { rmSync(`${dbPath}-shm`); } catch {}
});

test("add returns id and is idempotent on duplicate content", () => {
  const id1 = store.add("I prefer using bun, never node.js", { category: "user_pref" });
  const id2 = store.add("I prefer using bun, never node.js", { category: "user_pref" });
  expect(id1).toBe(id2);
  expect(store.count()).toBe(1);
});

test("search returns FTS hits weighted by trust score", () => {
  const a = store.add("we use Postgres for production storage", { category: "project" });
  const b = store.add("the repo is on github.com/example/web", { category: "project" });
  // boost trust on b — it should outrank a even if both match
  store.feedback(b, true);
  store.feedback(b, true);
  const hits = store.search("postgres OR github", { limit: 5, minTrust: 0 });
  expect(hits.map((h) => h.fact_id)).toContain(a);
  expect(hits.map((h) => h.fact_id)).toContain(b);
});

test("list filters by category and trust threshold", () => {
  store.add("user wants concise replies", { category: "user_pref" });
  store.add("project uses bun", { category: "project" });
  const prefs = store.list({ category: "user_pref" });
  expect(prefs).toHaveLength(1);
  expect(prefs[0]!.category).toBe("user_pref");

  // raise threshold above default 0.5 -> nothing matches
  expect(store.list({ minTrust: 0.99 })).toHaveLength(0);
});

test("feedback shifts trust score and persists", () => {
  const id = store.add("user prefers terse output", { category: "user_pref" });
  const before = store.get(id)!;
  expect(before.trust_score).toBeCloseTo(0.5, 5);

  const after = store.feedback(id, true)!;
  expect(after.trust_score).toBeCloseTo(0.55, 5);
  expect(after.helpful_count).toBe(1);

  const punished = store.feedback(id, false)!;
  expect(punished.trust_score).toBeCloseTo(0.45, 5);
});

test("update replaces fields without resetting unspecified ones", () => {
  const id = store.add("old content", { category: "general", tags: "x" });
  const ok = store.update(id, { content: "new content", tags: "y,z" });
  expect(ok).toBe(true);
  const updated = store.get(id)!;
  expect(updated.content).toBe("new content");
  expect(updated.tags).toBe("y,z");
  expect(updated.category).toBe("general");
});

test("remove deletes the row and its FTS shadow", () => {
  const id = store.add("ephemeral fact", { category: "general" });
  expect(store.remove(id)).toBe(true);
  expect(store.get(id)).toBeNull();
  expect(store.search("ephemeral", { minTrust: 0 })).toHaveLength(0);
  expect(store.remove(id)).toBe(false);
});

test("probe accepts entity-style queries", () => {
  store.add("Alice Wong manages auth service", { category: "project" });
  store.add("the project is named Phoenix", { category: "project" });
  const hits = store.probe("Alice Wong", { minTrust: 0 });
  expect(hits).toHaveLength(1);
  expect(hits[0]!.content).toContain("Alice Wong");
});

test("clear empties the store including FTS", () => {
  store.add("foo bar baz", { category: "general" });
  store.clear();
  expect(store.count()).toBe(0);
  expect(store.search("foo", { minTrust: 0 })).toHaveLength(0);
});

test("autoExtractFromMessages picks up preferences and decisions", () => {
  const before = store.count();
  const extracted = autoExtractFromMessages(store, [
    { role: "user", content: "I prefer using bun for all scripts." },
    { role: "user", content: "We decided to migrate to Postgres next sprint." },
    { role: "user", content: "Hello there!" }, // ignored — too short / no pattern
    { role: "assistant", content: "noted" },
  ]);
  expect(extracted).toBe(2);
  expect(store.count()).toBe(before + 2);
});
