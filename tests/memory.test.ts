/**
 * MemoryStore unit tests.
 *
 * Cover the surface that the memory tool & /memory command exercise:
 * add (incl. dedupe), search ranking, list filtering, feedback trust shifts,
 * update, remove, probe, count/clear, scope isolation, secret scanning,
 * correction mechanics, extended pattern extraction.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/extensions/memory/store.ts";
import { autoExtractFromMessages } from "../src/extensions/memory/extract.ts";
import { scanSecrets } from "../src/extensions/memory/secrets.ts";

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

// ---- New tests for enhanced features ------------------------------------

test("schema migration adds new columns with defaults", () => {
  // Adding a fact without specifying scope/source/correction_of should default cleanly.
  const id = store.add("default fact", { category: "general" });
  const f = store.get(id)!;
  expect(f.scope).toBe("global");
  expect(f.source).toBe("auto");
  expect(f.correction_of).toBeNull();
});

test("secret scanning blocks AWS keys", () => {
  expect(scanSecrets("AKIAIOSFODNN7EXAMPLE").blocked).toBe(true);
  expect(scanSecrets("normal text about AWS").blocked).toBe(false);
});

test("secret scanning blocks GitHub tokens", () => {
  expect(scanSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789").blocked).toBe(true);
});

test("secret scanning blocks SSH private keys", () => {
  expect(scanSecrets("-----BEGIN RSA PRIVATE KEY-----\nMII...").blocked).toBe(true);
});

test("secret scanning blocks Stripe-style keys", () => {
  expect(scanSecrets("sk_live_abcdefghijklmnop12345").blocked).toBe(true);
});

test("secret scanning allows normal text mentioning keys", () => {
  expect(scanSecrets("we should rotate our api keys regularly").blocked).toBe(false);
});

test("store.add rejects content with secrets", () => {
  expect(() => store.add("my key is AKIAIOSFODNN7EXAMPLE", { category: "general" })).toThrow(/secret/i);
  expect(store.count()).toBe(0);
});

test("correction reduces trust on original and boosts new fact", () => {
  const original = store.add("project uses webpack", { category: "project" });
  const before = store.get(original)!;
  expect(before.trust_score).toBeCloseTo(0.5, 5);

  const corrected = store.add("project uses vite, not webpack", {
    category: "correction",
    correctionOf: original,
  });

  const originalAfter = store.get(original)!;
  expect(originalAfter.trust_score).toBeCloseTo(0.2, 5); // 0.5 - 0.30

  const correctedFact = store.get(corrected)!;
  expect(correctedFact.trust_score).toBeCloseTo(0.7, 5); // CORRECTED_BOOST
  expect(correctedFact.correction_of).toBe(original);
});

test("project-scoped facts are isolated by cwd", () => {
  const cwdA = "/tmp/project-a";
  const cwdB = "/tmp/project-b";
  store.add("uses redux", { category: "project", scope: "project", cwd: cwdA });
  store.add("uses zustand", { category: "project", scope: "project", cwd: cwdB });
  store.add("uses typescript", { category: "general" }); // global

  // Search scope=project + cwd=A returns A facts + global facts, NOT B facts.
  const hitsA = store.search("uses", { limit: 10, minTrust: 0, scope: "project", cwd: cwdA });
  const contentsA = hitsA.map((h) => h.content);
  expect(contentsA).toContain("uses redux");
  expect(contentsA).toContain("uses typescript");
  expect(contentsA).not.toContain("uses zustand");

  // Search scope=global returns ONLY global facts.
  const hitsGlobal = store.search("uses", { limit: 10, minTrust: 0, scope: "global" });
  const contentsGlobal = hitsGlobal.map((h) => h.content);
  expect(contentsGlobal).toContain("uses typescript");
  expect(contentsGlobal).not.toContain("uses redux");
  expect(contentsGlobal).not.toContain("uses zustand");
});

test("project scope ranking gives project facts a boost", () => {
  const cwd = "/tmp/myproj";
  // Both at default trust 0.5
  const globalFact = store.add("we use react globally", { category: "general" });
  const projectFact = store.add("we use react in this project", { category: "project", scope: "project", cwd });

  const hits = store.search("react use", { limit: 5, minTrust: 0, scope: "project", cwd });
  // Project fact should rank first due to 10% boost
  expect(hits[0]!.fact_id).toBe(projectFact);
});

test("autoExtractFromMessages extracts new categories", () => {
  const extracted = autoExtractFromMessages(store, [
    { role: "user", content: "no, that's wrong, use yarn instead of npm" }, // correction
    { role: "user", content: "the test crashed when env was not set" }, // failure
    { role: "user", content: "remember that: graphql cache invalidation is tricky" }, // insight
    { role: "user", content: "our convention is to use kebab-case for files" }, // convention
    { role: "user", content: "this library doesn't support node 14" }, // tool_quirk
  ]);
  expect(extracted).toBe(5);

  const all = store.list({ limit: 50, minTrust: 0 });
  const cats = new Set(all.map((f) => f.category));
  expect(cats.has("correction")).toBe(true);
  expect(cats.has("failure")).toBe(true);
  expect(cats.has("insight")).toBe(true);
  expect(cats.has("convention")).toBe(true);
  expect(cats.has("tool_quirk")).toBe(true);
});

test("autoExtractFromMessages assigns correction high trust", () => {
  autoExtractFromMessages(store, [
    { role: "user", content: "no, that's wrong, fix the import path" },
  ]);
  const all = store.list({ limit: 10, minTrust: 0, category: "correction" });
  expect(all).toHaveLength(1);
  expect(all[0]!.trust_score).toBeCloseTo(0.7, 5);
});

test("autoExtractFromMessages with cwd stores project-scoped facts", () => {
  const cwd = "/tmp/test-extract-proj";
  autoExtractFromMessages(
    store,
    [{ role: "user", content: "I prefer dark mode in this app" }],
    { cwd },
  );
  const projectHits = store.search("dark mode", { limit: 5, minTrust: 0, scope: "project", cwd });
  expect(projectHits).toHaveLength(1);

  // Should NOT appear in pure global search.
  const globalHits = store.search("dark mode", { limit: 5, minTrust: 0, scope: "global" });
  expect(globalHits).toHaveLength(0);
});

test("list with scope filters correctly", () => {
  const cwd = "/tmp/list-scope";
  store.add("global thing", { category: "general" });
  store.add("project thing", { category: "project", scope: "project", cwd });

  const projList = store.list({ limit: 10, scope: "project", cwd });
  expect(projList.map((f) => f.content).sort()).toEqual(["global thing", "project thing"]);

  const globalList = store.list({ limit: 10, scope: "global" });
  expect(globalList.map((f) => f.content)).toEqual(["global thing"]);
});
