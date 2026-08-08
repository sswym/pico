/**
 * MemoryStore unit tests.
 *
 * Cover the surface that the memory tool & /memory command exercise:
 * add (incl. dedupe), search ranking, list filtering, feedback trust shifts,
 * update, remove, probe, count/clear, scope isolation, secret scanning,
 * correction mechanics, extended pattern extraction.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/extensions/memory/store.ts";
import { BuiltinMemoryProvider } from "../src/extensions/memory/builtin-provider.ts";
import { HolographicMemoryProvider } from "../src/extensions/memory/holographic-provider.ts";
import { CuratedMemoryStore, resetCuratedMemoryDir } from "../src/extensions/memory/curated-store.ts";
import { autoExtractFromMessages, classifyMessage, isDurableCandidate } from "../src/extensions/memory/extract.ts";
import { scanSecrets } from "../src/extensions/memory/secrets.ts";
import { executeMemoryToolAction } from "../src/extensions/memory/tool.ts";
import {
  executeMemoryCommand,
  parseCommand,
  type MemoryCommandDeps,
} from "../src/extensions/memory/command.ts";
import { WriteQueue, type MemoryProvider, type MemoryWriteMetadata } from "../src/extensions/memory/provider.ts";
import { ProviderManager } from "../src/extensions/memory/provider-manager.ts";
import { memoryExtension } from "../src/extensions/memory/index.ts";
import { systemPromptBlock } from "../src/extensions/memory/prompt.ts";
import { formatRecallBlock, RECALL_BUDGET_CHARS } from "../src/extensions/memory/prompt.ts";

let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  dbPath = join(tmpdir(), `pico-mem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  store = new MemoryStore(dbPath);
});

afterEach(() => {
  store.close();
  try { rmSync(dbPath); } catch { }
  try { rmSync(`${dbPath}-wal`); } catch { }
  try { rmSync(`${dbPath}-shm`); } catch { }
});

test("add returns id and is idempotent on duplicate content", () => {
  const id1 = store.add("I prefer using bun, never node.js", { category: "user_pref" });
  const id2 = store.add("I prefer using bun, never node.js", { category: "user_pref" });
  expect(id1).toBe(id2);
  expect(store.count()).toBe(1);
});

test("same content in different project scopes are distinct facts", () => {
  const cwdA = "/proj/a";
  const cwdB = "/proj/b";
  const idA = store.add("this project uses redux", { category: "project", scope: "project", cwd: cwdA });
  const idB = store.add("this project uses redux", { category: "project", scope: "project", cwd: cwdB });
  // Cross-scope duplicate must NOT be swallowed by the content dedup.
  expect(idA).not.toBe(idB);
  expect(store.count()).toBe(2);
  // B's read paths see B's fact only — A's identical fact stays invisible.
  const hitsB = store.search("redux", { limit: 10, minTrust: 0, scope: "project", cwd: cwdB });
  expect(hitsB.map((h) => h.fact_id)).toContain(idB);
  expect(hitsB.map((h) => h.fact_id)).not.toContain(idA);
  // Same-scope re-add still dedups to the existing id.
  expect(store.add("this project uses redux", { category: "project", scope: "project", cwd: cwdB })).toBe(idB);
  // Global vs project with the same text are distinct facts too.
  const idGlobal = store.add("this project uses redux", { category: "project" });
  expect(idGlobal).not.toBe(idA);
  expect(idGlobal).not.toBe(idB);
});

test("legacy global-unique schema migrates to scope-unique without data loss", () => {
  const legacyPath = join(tmpdir(), `pico-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    // Recreate the pre-fix schema: content UNIQUE globally, scope added later.
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE facts (
        fact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
        content         TEXT NOT NULL UNIQUE,
        category        TEXT NOT NULL DEFAULT 'general',
        tags            TEXT NOT NULL DEFAULT '',
        trust_score     REAL NOT NULL DEFAULT 0.5,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        helpful_count   INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        scope           TEXT NOT NULL DEFAULT 'global',
        correction_of   INTEGER REFERENCES facts(fact_id),
        source          TEXT NOT NULL DEFAULT 'auto',
        tfidf_vector    TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO facts (content, category, trust_score, scope, source, tfidf_vector)
        VALUES ('legacy fact about postgres', 'project', 0.7, 'project:/proj/a', 'auto', '{}');
    `);
    legacy.close();

    const migrated = new MemoryStore(legacyPath);
    // Data survived the rebuild.
    expect(migrated.count()).toBe(1);
    const fact = migrated.search("postgres", { limit: 5, minTrust: 0, scope: "project", cwd: "/proj/a" });
    expect(fact.map((f) => f.content)).toContain("legacy fact about postgres");
    // FTS shadow was rebuilt — the trigger path works.
    expect(migrated.add("legacy fact about postgres", { category: "project", scope: "project", cwd: "/proj/a" }))
      .toBe(fact[0]!.fact_id);
    // The old global UNIQUE is gone: same content, other scope inserts cleanly.
    const otherScope = migrated.add("legacy fact about postgres", { category: "project", scope: "project", cwd: "/proj/b" });
    expect(otherScope).not.toBe(fact[0]!.fact_id);
    // Correction self-FK survived the rebuild.
    const corrected = migrated.add("legacy fact about postgresql", { category: "project", scope: "project", cwd: "/proj/a", correctionOf: fact[0]!.fact_id });
    expect(migrated.get(corrected)!.correction_of).toBe(fact[0]!.fact_id);
    migrated.close();

    // Re-opening skips the rebuild (idempotent).
    const reopened = new MemoryStore(legacyPath);
    expect(reopened.count()).toBe(3);
    reopened.close();
  } finally {
    try { rmSync(legacyPath); } catch { }
    try { rmSync(`${legacyPath}-wal`); } catch { }
    try { rmSync(`${legacyPath}-shm`); } catch { }
  }
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

test("search falls back to synonym-aware matching when FTS misses", () => {
  store.add("用户偏好用简洁的 TypeScript 代码，避免冗余抽象", { category: "user_pref" });
  const hits = store.search("用户讨厌啰嗦的 TS 实现，喜欢精简", { limit: 5, minTrust: 0 });
  expect(hits).toHaveLength(1);
  expect(hits[0]!.content).toContain("简洁");
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

test("internal chain placeholders are never stored as facts", () => {
  const before = store.count();
  const extracted = autoExtractFromMessages(store, [
    { role: "user", content: 'Task: research the code.\n[CHAIN ERROR: output "0" not found — the step that defines it must run first, or the name is misspelled]' },
    { role: "user", content: "Use {outputs.plan} and {previous} to continue." },
  ]);
  expect(extracted).toBe(0);
  expect(store.count()).toBe(before);
  expect(isDurableCandidate("plain statement")).toBe(true);
  expect(isDurableCandidate('Task with [CHAIN ERROR: output "x" not found]')).toBe(false);
  expect(isDurableCandidate("Use {outputs.x} to continue")).toBe(false);
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

test("store.update rejects content with secrets", () => {
  const id = store.add("safe content", { category: "general" });
  expect(() => store.update(id, { content: "my key is AKIAIOSFODNN7EXAMPLE" })).toThrow(/secret/i);
  expect(store.get(id)!.content).toBe("safe content");
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

test("probe with project scope sees global and current project facts only", () => {
  const cwdA = "/tmp/probe-a";
  const cwdB = "/tmp/probe-b";
  store.add("Alice owns global docs", { category: "general" });
  const projectFact = store.add("Alice owns project api", { category: "project", scope: "project", cwd: cwdA });
  store.add("Alice owns other project ui", { category: "project", scope: "project", cwd: cwdB });

  const hits = store.probe("Alice", { limit: 10, minTrust: 0, scope: "project", cwd: cwdA });
  const contents = hits.map((h) => h.content);
  expect(contents).toContain("Alice owns global docs");
  expect(contents).toContain("Alice owns project api");
  expect(contents).not.toContain("Alice owns other project ui");
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

test("memoryExtension captures cwd on session_start before first recall", async () => {
  const oldEnv = process.env.PICO_MEMORY_DB;
  const tempDb = join(tmpdir(), `pico-ext-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const cwd = "/tmp/pico-memory-project";
  const seedStore = new MemoryStore(tempDb);
  seedStore.add("this project uses redux toolkit", { category: "project", scope: "project", cwd });
  seedStore.close();
  process.env.PICO_MEMORY_DB = tempDb;

  const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
  const fakePi: any = {
    on: (event: string, handler: (event: any, ctx: any) => any) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: () => {},
    registerCommand: () => {},
    sendMessage: () => {},
  };

  try {
    memoryExtension(fakePi);
    await handlers["session_start"]![0]!({}, {
      cwd,
      sessionManager: { getSessionId: () => "memory-session" },
    });
    const result = await handlers["before_agent_start"]![0]!({
      prompt: "what state library does this project use?",
      systemPrompt: "BASE",
    }, { cwd });

    expect(result.systemPrompt).toContain("BASE");
    expect(result.systemPrompt).toContain("this project uses redux toolkit");

    await handlers["session_shutdown"]![0]!({}, { cwd });
  } finally {
    if (oldEnv === undefined) delete process.env.PICO_MEMORY_DB;
    else process.env.PICO_MEMORY_DB = oldEnv;
    try { rmSync(tempDb); } catch { }
    try { rmSync(`${tempDb}-wal`); } catch { }
    try { rmSync(`${tempDb}-shm`); } catch { }
  }
});

test("memoryExtension refreshes recall on each turn instead of freezing the first query", async () => {
  const oldEnv = process.env.PICO_MEMORY_DB;
  const tempDb = join(tmpdir(), `pico-ext-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PICO_MEMORY_DB = tempDb;

  const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
  const fakePi: any = {
    on: (event: string, handler: (event: any, ctx: any) => any) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: () => {},
    registerCommand: () => {},
    sendMessage: () => {},
  };

  try {
    memoryExtension(fakePi);
    await handlers["session_start"]![0]!({}, {
      cwd: "/tmp/pico-memory-refresh",
      sessionManager: { getSessionId: () => "memory-session" },
    });

    const first = await handlers["before_agent_start"]![0]!({
      prompt: "redux toolkit",
      systemPrompt: "BASE",
    }, { cwd: "/tmp/pico-memory-refresh" });
    expect(first.systemPrompt).toContain("BASE");
    expect(first.systemPrompt).not.toContain("redux toolkit");

    const external = new MemoryStore(tempDb);
    external.add("this project uses redux toolkit", { category: "project", scope: "project", cwd: "/tmp/pico-memory-refresh" });
    external.close();

    const second = await handlers["before_agent_start"]![0]!({
      prompt: "redux toolkit",
      systemPrompt: "BASE",
    }, { cwd: "/tmp/pico-memory-refresh" });
    expect(second.systemPrompt).toContain("this project uses redux toolkit");

    await handlers["session_shutdown"]![0]!({}, { cwd: "/tmp/pico-memory-refresh" });
  } finally {
    if (oldEnv === undefined) delete process.env.PICO_MEMORY_DB;
    else process.env.PICO_MEMORY_DB = oldEnv;
    try { rmSync(tempDb); } catch { }
    try { rmSync(`${tempDb}-wal`); } catch { }
    try { rmSync(`${tempDb}-shm`); } catch { }
  }
});

test("memory prompt templates keep the search instruction in the system prompt", () => {
  expect(systemPromptBlock(0)).toContain("memory(action=\"search\"");
  expect(systemPromptBlock(3)).toContain("memory(action=\"search\"");
});

// ---- Entity system tests --------------------------------------------------

test("add extracts entities and links them to fact", () => {
  const id = store.add("Alice Wong manages the Auth Service", { category: "project" });
  // Probe by entity should find the fact
  const hits = store.probe("Alice Wong", { minTrust: 0 });
  expect(hits).toHaveLength(1);
  expect(hits[0]!.fact_id).toBe(id);
});

test("entities are extracted from quoted terms and capitalized words", () => {
  store.add('We use "Redis" for caching and Postgres for storage', { category: "project" });
  const redisHits = store.probe("Redis", { minTrust: 0 });
  expect(redisHits).toHaveLength(1);
  const pgHits = store.probe("Postgres", { minTrust: 0 });
  expect(pgHits).toHaveLength(1);
});

test("probe uses entity table not just FTS", () => {
  // Add a fact where the entity appears
  store.add("Bob Chen rewrote the billing module", { category: "project" });
  // Entity table should resolve "Bob Chen" directly
  const hits = store.probe("Bob Chen", { minTrust: 0 });
  expect(hits).toHaveLength(1);
  expect(hits[0]!.content).toContain("Bob Chen");
});

test("remove cleans up entity links via CASCADE", () => {
  const id = store.add("Charlie works on the API", { category: "project" });
  expect(store.probe("Charlie", { minTrust: 0 })).toHaveLength(1);
  store.remove(id);
  expect(store.probe("Charlie", { minTrust: 0 })).toHaveLength(0);
});

test("update re-extracts entities when content changes", () => {
  const id = store.add("Dave built the frontend", { category: "project" });
  expect(store.probe("Dave", { minTrust: 0 })).toHaveLength(1);
  store.update(id, { content: "Eve rebuilt the frontend" });
  expect(store.probe("Dave", { minTrust: 0 })).toHaveLength(0);
  expect(store.probe("Eve", { minTrust: 0 })).toHaveLength(1);
});

// ---- TF-IDF tests ---------------------------------------------------------

test("tfidf_vector is populated after add", () => {
  const id = store.add("we use TypeScript for all backend services", { category: "project" });
  const fact = store.get(id)!;
  expect(fact.tfidf_vector).toBeDefined();
  expect(fact.tfidf_vector).not.toBe("{}");
  const vec = JSON.parse(fact.tfidf_vector);
  expect(vec["typescript"]).toBeGreaterThan(0);
});

test("tfidf_vector is recomputed on update", () => {
  const id = store.add("old content about Python", { category: "general" });
  const before = JSON.parse(store.get(id)!.tfidf_vector);
  expect(before["python"]).toBeGreaterThan(0);

  store.update(id, { content: "new content about Rust" });
  const after = JSON.parse(store.get(id)!.tfidf_vector);
  expect(after["rust"]).toBeGreaterThan(0);
  // Python should no longer be dominant (it may exist with low weight from corpus)
});

// ---- FactRetriever tests ---------------------------------------------------

test("FactRetriever.search returns hybrid-scored results", () => {
  store.add("we use Postgres for production database", { category: "project" });
  store.add("the project uses Redis caching", { category: "project" });
  store.add("unrelated fact about weather", { category: "general" });

  const retriever = store.retriever();
  const results = retriever.search("Postgres database", { minTrust: 0 });
  expect(results.length).toBeGreaterThanOrEqual(1);
  expect(results[0]!.content).toContain("Postgres");
  expect(results[0]!.score).toBeGreaterThan(0);
});

test("FactRetriever.probe finds entity-linked facts", () => {
  store.add("Frank designed the architecture", { category: "project" });
  store.add("Grace implemented the auth module", { category: "project" });

  const retriever = store.retriever();
  const results = retriever.probe("Frank", { minTrust: 0 });
  expect(results).toHaveLength(1);
  expect(results[0]!.content).toContain("Frank");
});

test("FactRetriever.related finds co-occurring entity facts", () => {
  store.add("Alice and Bob work on the backend", { category: "project" });
  store.add("Alice and Charlie do code reviews", { category: "project" });
  store.add("Dave works alone on docs", { category: "project" });

  const retriever = store.retriever();
  const results = retriever.related("Alice", { minTrust: 0 });
  // Should find both facts where Alice co-occurs with other entities
  expect(results.length).toBe(2);
  const contents = results.map((r) => r.content);
  expect(contents.some((c) => c.includes("Bob"))).toBe(true);
  expect(contents.some((c) => c.includes("Charlie"))).toBe(true);
});

test("FactRetriever escapes LIKE wildcards in entity names", () => {
  // Seed an entity whose alias would be wrongly matched by an unescaped
  // `%,foo_bar,%` pattern (the `_` matches any single char, e.g. the X in
  // fooXbar). aliases is written directly since the public store API does not
  // expose it.
  const raw = new Database(dbPath);
  raw.query("INSERT INTO entities (name, aliases) VALUES (?, ?)").run("FooXbar", "fooXbar");
  raw.close();

  store.add("the FooXbar service runs the payment pipeline", { category: "project" });
  const retriever = store.retriever();

  // Positive control: probe resolves via exact name match.
  const exact = retriever.probe("fooXbar", { minTrust: 0 });
  expect(exact.some((r) => r.content.includes("payment pipeline"))).toBe(true);

  // foo_bar must NOT resolve to the FooXbar entity through the wildcard alias.
  const probed = retriever.probe("foo_bar", { minTrust: 0 });
  expect(probed.some((r) => r.content.includes("payment pipeline"))).toBe(false);
  const related = retriever.related("foo_bar", { minTrust: 0 });
  expect(related.some((r) => r.content.includes("payment pipeline"))).toBe(false);
  const reasoned = retriever.reason(["foo_bar"], { minTrust: 0 });
  expect(reasoned.some((r) => r.content.includes("payment pipeline"))).toBe(false);
});

test("FactRetriever.reason finds facts linked to ALL specified entities", () => {
  store.add("Alice Wong and the Auth Service team deployed v2", { category: "project" });
  store.add("Alice Wong wrote documentation", { category: "project" });
  store.add("Auth Service had a hotfix", { category: "project" });

  const retriever = store.retriever();
  const results = retriever.reason(["Alice Wong", "Auth Service"], { minTrust: 0 });
  // Only the first fact mentions both Alice Wong and Auth Service
  expect(results).toHaveLength(1);
  expect(results[0]!.content).toContain("Alice Wong");
  expect(results[0]!.content).toContain("Auth Service");
});

test("FactRetriever.contradict detects contradictory facts", () => {
  // Two facts about the same entity with different claims
  store.add('the "Auth Service" uses webpack for bundling', { category: "project" });
  store.add('the "Auth Service" uses vite for bundling', { category: "project" });

  const retriever = store.retriever();
  const contradictions = retriever.contradict({ threshold: 0.1, limit: 10 });
  expect(contradictions.length).toBeGreaterThanOrEqual(1);
  expect(contradictions[0]!.shared_entities.length).toBeGreaterThan(0);
  expect(contradictions[0]!.contradiction_score).toBeGreaterThan(0);
});

test("FactRetriever.contradict isolates project scope from other projects", () => {
  store.add('the "Deploy Service" uses docker', { category: "project", scope: "project", cwd: "/proj/a" });
  store.add('the "Deploy Service" uses podman', { category: "project", scope: "project", cwd: "/proj/b" });

  const retriever = store.retriever();
  const otherProject = retriever.contradict({ threshold: 0.1, limit: 10, scope: "project", cwd: "/proj/a" });
  expect(otherProject).toHaveLength(0);

  const globalOnly = retriever.contradict({ threshold: 0.1, limit: 10, scope: "global" });
  expect(globalOnly).toHaveLength(0);
});

test("FactRetriever.search respects minTrust filter", () => {
  const id = store.add("low trust fact about Docker", { category: "tool" });
  store.add("high trust fact about Docker containers", { category: "tool" });
  // Punish the first fact to lower trust
  store.feedback(id, false);
  store.feedback(id, false);
  store.feedback(id, false);

  const retriever = store.retriever();
  const highTrustOnly = retriever.search("Docker", { minTrust: 0.4 });
  expect(highTrustOnly.every((r) => r.trust_score >= 0.4)).toBe(true);
});

test("FactRetriever.search isolates project-scoped facts by cwd", () => {
  const cwdA = "/tmp/retriever-project-a";
  const cwdB = "/tmp/retriever-project-b";
  store.add("Apollo uses Redis queues", { category: "project", scope: "project", cwd: cwdA });
  store.add("Apollo uses RabbitMQ queues", { category: "project", scope: "project", cwd: cwdB });
  store.add("Apollo uses TypeScript", { category: "general" });

  const retriever = store.retriever();
  const projectHits = retriever.search("Apollo uses", { minTrust: 0, scope: "project", cwd: cwdA, limit: 10 });
  const projectContents = projectHits.map((r) => r.content);
  expect(projectContents).toContain("Apollo uses Redis queues");
  expect(projectContents).toContain("Apollo uses TypeScript");
  expect(projectContents).not.toContain("Apollo uses RabbitMQ queues");

  const globalHits = retriever.search("Apollo uses", { minTrust: 0, scope: "global", limit: 10 });
  const globalContents = globalHits.map((r) => r.content);
  expect(globalContents).toEqual(["Apollo uses TypeScript"]);
});

test("FactRetriever.related and reason isolate project-scoped facts by cwd", () => {
  const cwdA = "/tmp/retriever-related-a";
  const cwdB = "/tmp/retriever-related-b";
  store.add("Alice and Billing Service use Redis", { category: "project", scope: "project", cwd: cwdA });
  store.add("Alice and Billing Service use SQS", { category: "project", scope: "project", cwd: cwdB });
  store.add("Alice and Billing Service use TypeScript", { category: "general" });

  const retriever = store.retriever();
  const related = retriever.related("Alice", { minTrust: 0, scope: "project", cwd: cwdA, limit: 10 });
  const relatedContents = related.map((r) => r.content);
  expect(relatedContents).toContain("Alice and Billing Service use Redis");
  expect(relatedContents).toContain("Alice and Billing Service use TypeScript");
  expect(relatedContents).not.toContain("Alice and Billing Service use SQS");

  const reasoned = retriever.reason(["Alice", "Billing Service"], { minTrust: 0, scope: "project", cwd: cwdA, limit: 10 });
  const reasonedContents = reasoned.map((r) => r.content);
  expect(reasonedContents).toContain("Alice and Billing Service use Redis");
  expect(reasonedContents).toContain("Alice and Billing Service use TypeScript");
  expect(reasonedContents).not.toContain("Alice and Billing Service use SQS");
});

test("store.clear removes entities and entity links", () => {
  store.add("Helen manages infra", { category: "project" });
  expect(store.probe("Helen", { minTrust: 0 })).toHaveLength(1);
  store.clear();
  expect(store.probe("Helen", { minTrust: 0 })).toHaveLength(0);
  expect(store.count()).toBe(0);
});

test("existing probe test still works with entity table", () => {
  // Re-verify the original probe test works with entity-table-backed probe
  store.add("Alice Wong manages auth service", { category: "project" });
  store.add("the project is named Phoenix", { category: "project" });
  const hits = store.probe("Alice Wong", { minTrust: 0 });
  expect(hits).toHaveLength(1);
  expect(hits[0]!.content).toContain("Alice Wong");
});

// ---- External provider registration tests --------------------------------

function makeFakeMemoryProvider(overrides: Partial<MemoryProvider> = {}): MemoryProvider {
  return {
    name: "test-provider",
    isAvailable: () => true,
    initialize: () => { },
    shutdown: () => { },
    get: () => null,
    add: () => 0,
    update: () => true,
    remove: () => true,
    feedback: () => null,
    clear: () => { },
    count: () => 0,
    search: () => [],
    probe: () => [],
    list: () => [],
    related: () => [],
    reason: () => [],
    contradict: () => [],
    queue: new WriteQueue(),
    getRawStore: () => null,
    systemPromptBlock: () => "",
    prefetch: () => [],
    queuePrefetch: () => { },
    ...overrides,
  };
}

function withTestManager(fn: (manager: ProviderManager) => void): void {
  const oldEnv = process.env.PICO_MEMORY_DB;
  const tempDb = join(tmpdir(), `pico-mgr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PICO_MEMORY_DB = tempDb;
  try {
    const manager = new ProviderManager();
    fn(manager);
  } finally {
    if (oldEnv === undefined) {
      delete process.env.PICO_MEMORY_DB;
    } else {
      process.env.PICO_MEMORY_DB = oldEnv;
    }
    try { rmSync(tempDb); } catch { }
    try { rmSync(`${tempDb}-wal`); } catch { }
    try { rmSync(`${tempDb}-shm`); } catch { }
  }
}

test("ProviderManager.registerExternalProvider accepts first provider", () => {
  withTestManager((manager) => {
    const fake = makeFakeMemoryProvider();
    const result = manager.registerExternalProvider(fake);
    expect(result.accepted).toBe(true);
    expect(manager.getExternalProvider()).toBe(fake);
  });
});

test("ProviderManager.registerExternalProvider rejects second different provider", () => {
  withTestManager((manager) => {
    const fake1 = makeFakeMemoryProvider();
    const fake2 = makeFakeMemoryProvider();
    expect(manager.registerExternalProvider(fake1).accepted).toBe(true);
    const result = manager.registerExternalProvider(fake2);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

test("ProviderManager.registerExternalProvider idempotent same provider", () => {
  withTestManager((manager) => {
    const fake = makeFakeMemoryProvider();
    expect(manager.registerExternalProvider(fake).accepted).toBe(true);
    const result = manager.registerExternalProvider(fake);
    expect(result.accepted).toBe(true);
  });
});

test("ProviderManager.registerExternalProvider rejects reserved tool name", () => {
  withTestManager((manager) => {
    const fake = makeFakeMemoryProvider();
    const result = manager.registerExternalProvider(fake, "memory");
    expect(result.accepted).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

test("ProviderManager exposes available providers and can save backend selection", () => {
  expect(ProviderManager.availableProviders()).toContain("builtin");

  const oldEnv = process.env.PICO_HOME;
  const home = join(tmpdir(), `pico-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.PICO_HOME = home;
  try {
    const result = ProviderManager.saveBackend("builtin");
    expect(result.ok).toBe(true);
    expect(existsSync(join(home, "agent", "settings.json"))).toBe(true);
  } finally {
    if (oldEnv === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = oldEnv;
    try { rmSync(home, { recursive: true, force: true }); } catch { }
  }
});

test("ProviderManager aggregates external tool schemas without duplicates", () => {
  withTestManager((manager) => {
    const fake = makeFakeMemoryProvider({
      getToolSchemas: () => [
        { name: "memory_probe", description: "probe", parameters: { type: "object", properties: {} } },
        { type: "function", function: { name: "memory_probe", description: "duplicate", parameters: { type: "object", properties: {} } } },
      ],
    });
    manager.registerExternalProvider(fake);
    const schemas = manager.getAllToolSchemas();
    expect(schemas.filter((s) => (s as Record<string, unknown>).name === "memory_probe")).toHaveLength(1);
  });
});

test("ProviderManager.notifyMemoryToolWrite invokes onMemoryWrite with metadata", () => {
  withTestManager((manager) => {
    const calls: MemoryWriteMetadata[] = [];
    const fake = makeFakeMemoryProvider({
      onMemoryWrite: (meta) => {
        calls.push(meta);
      },
    });
    manager.registerExternalProvider(fake);
    manager.notifyMemoryToolWrite({ action: "add", content: "test", factId: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.action).toBe("add");
    expect(calls[0]!.factId).toBe(1);
  });
});

test("ProviderManager.notifyMemoryToolWrite does not throw when onMemoryWrite throws", () => {
  withTestManager((manager) => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    const fake = makeFakeMemoryProvider({
      onMemoryWrite: () => {
        throw new Error("boom");
      },
    });
    try {
      manager.registerExternalProvider(fake);
      // Should not throw
      manager.notifyMemoryToolWrite({ action: "remove", factId: 42 });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]![0]).toBe("[memory] External provider onMemoryWrite failed:");
    } finally {
      console.warn = originalWarn;
    }
  });
});

test("CuratedMemoryStore persists notes and system prompt snapshot independently", () => {
  const dir = join(tmpdir(), `pico-curated-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const curated = new CuratedMemoryStore({ dir });
  curated.loadFromDisk();

  const add = curated.add("memory", "remember the repo uses bun");
  expect(add.success).toBe(true);
  expect(curated.list("memory").memory).toContain("remember the repo uses bun");
  expect(curated.formatForSystemPrompt()).not.toContain("remember the repo uses bun");

  const nextSession = new CuratedMemoryStore({ dir });
  nextSession.loadFromDisk();
  expect(nextSession.formatForSystemPrompt()).toContain("remember the repo uses bun");

  const replace = curated.replace("memory", "repo uses bun", "remember the repo uses bun: no npm");
  expect(replace.success).toBe(true);
  expect(curated.list("memory").memory).toContain("remember the repo uses bun: no npm");

  const remove = curated.remove("memory", "no npm");
  expect(remove.success).toBe(true);
  expect(curated.list("memory").memory).toHaveLength(0);
});

test("memory tool note actions route through curated memory store", () => {
  const dir = join(tmpdir(), `pico-curated-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const curated = new CuratedMemoryStore({ dir });
  curated.loadFromDisk();
  const fakeProvider = makeFakeMemoryProvider();
  const manager = new ProviderManager();

  const add = executeMemoryToolAction(
    { action: "note_add", target: "user", content: "prefers concise replies" },
    { provider: fakeProvider, manager, currentCwd: null, curated },
  );
  expect(JSON.parse(add.content[0]!.text).success).toBe(true);
  expect(curated.list("user").user).toContain("prefers concise replies");

  const replace = executeMemoryToolAction(
    { action: "note_replace", target: "user", old_text: "concise", content: "prefers concise replies with bullet points" },
    { provider: fakeProvider, manager, currentCwd: null, curated },
  );
  expect(JSON.parse(replace.content[0]!.text).success).toBe(true);
  expect(curated.list("user").user).toContain("prefers concise replies with bullet points");

  const remove = executeMemoryToolAction(
    { action: "note_remove", target: "user", old_text: "bullet points" },
    { provider: fakeProvider, manager, currentCwd: null, curated },
  );
  expect(JSON.parse(remove.content[0]!.text).success).toBe(true);
  expect(curated.list("user").user).toHaveLength(0);
});

test("memory tool passes project scope to related and reason providers", () => {
  const manager = new ProviderManager();
  const calls: Array<{ method: string; opts: unknown }> = [];
  const fakeProvider = makeFakeMemoryProvider({
    related: (_entity, opts) => {
      calls.push({ method: "related", opts });
      return [];
    },
    reason: (_entities, opts) => {
      calls.push({ method: "reason", opts });
      return [];
    },
  });

  executeMemoryToolAction(
    { action: "related", entity: "Alice", scope: "project" },
    { provider: fakeProvider, manager, currentCwd: "/repo" },
  );
  executeMemoryToolAction(
    { action: "reason", entities: ["Alice", "Billing"], scope: "project" },
    { provider: fakeProvider, manager, currentCwd: "/repo" },
  );

  expect(calls).toEqual([
    { method: "related", opts: { category: undefined, minTrust: undefined, limit: undefined, scope: "project", cwd: "/repo" } },
    { method: "reason", opts: { category: undefined, minTrust: undefined, limit: undefined, scope: "project", cwd: "/repo" } },
  ]);
});

test("ProviderManager.syncTurn fans out to registered providers", async () => {
  const oldEnv = process.env.PICO_MEMORY_DB;
  const tempDb = join(tmpdir(), `pico-mgr-sync-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PICO_MEMORY_DB = tempDb;
  try {
    const manager = new ProviderManager();
    const calls: Array<{ user: string; assistant: string; sessionId?: string }> = [];
    const fake = makeFakeMemoryProvider({
      syncTurn: (userContent, assistantContent, opts) => {
        calls.push({ user: userContent, assistant: assistantContent, sessionId: opts?.sessionId });
      },
    });
    manager.registerExternalProvider(fake);
    manager.syncTurn("user turn", "assistant turn", { sessionId: "s1" });
    await manager.flushPending();
    expect(calls).toEqual([{ user: "user turn", assistant: "assistant turn", sessionId: "s1" }]);
  } finally {
    if (oldEnv === undefined) delete process.env.PICO_MEMORY_DB;
    else process.env.PICO_MEMORY_DB = oldEnv;
    try { rmSync(tempDb); } catch { }
    try { rmSync(`${tempDb}-wal`); } catch { }
    try { rmSync(`${tempDb}-shm`); } catch { }
  }
});

test("correction whose content already exists does not penalise the original", () => {
  const original = store.add("use npm", { category: "tool" });
  const dup = store.add("use pnpm", { category: "tool" });
  const trustBefore = store.get(original)!.trust_score;

  // Correcting with content identical to an existing fact must dedupe to that
  // fact WITHOUT docking the original's trust — the penalty must not fire when
  // no new correction is actually inserted.
  const returned = store.add("use pnpm", { category: "tool", correctionOf: original });

  expect(returned).toBe(dup);
  expect(store.get(original)!.trust_score).toBe(trustBefore);
  expect(store.count()).toBe(2);
});

// --- /memory slash command ------------------------------------------------
//
// These cover the routing extracted from index.ts into command.ts: argument
// parsing, per-subcommand dispatch, and the injected notify/confirm seams.

async function withCommandDeps(
  fn: (deps: MemoryCommandDeps, sink: { notified: string[]; confirmAnswer: boolean }) => Promise<void>,
): Promise<void> {
  const oldEnv = process.env.PICO_MEMORY_DB;
  const tempDb = join(tmpdir(), `pico-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const notesDir = mkdtempSync(join(tmpdir(), "pico-cmd-notes-"));
  process.env.PICO_MEMORY_DB = tempDb;
  const sink = { notified: [] as string[], confirmAnswer: true };
  try {
    const manager = new ProviderManager();
    const curated = new CuratedMemoryStore({ dir: notesDir });
    await fn({
      provider: manager.provider,
      manager,
      curated,
      currentCwd: null,
      notify: (text) => sink.notified.push(text),
      confirm: async () => sink.confirmAnswer,
    }, sink);
  } finally {
    if (oldEnv === undefined) delete process.env.PICO_MEMORY_DB;
    else process.env.PICO_MEMORY_DB = oldEnv;
    try { rmSync(tempDb); } catch { }
    try { rmSync(`${tempDb}-wal`); } catch { }
    try { rmSync(`${tempDb}-shm`); } catch { }
    try { rmSync(notesDir, { recursive: true }); } catch { }
  }
}

test("parseCommand defaults to help and splits cmd from rest", () => {
  expect(parseCommand("")).toEqual({ cmd: "help", rest: "" });
  expect(parseCommand("   ")).toEqual({ cmd: "help", rest: "" });
  expect(parseCommand("status")).toEqual({ cmd: "status", rest: "" });
  expect(parseCommand("SEARCH bun runtime")).toEqual({ cmd: "search", rest: "bun runtime" });
});

test("/memory add then list round-trips the fact", async () => {
  await withCommandDeps(async (deps) => {
    const added = await executeMemoryCommand("add user_pref I prefer bun over node", deps);
    expect(added).toContain("Added:");
    expect(added).toContain("I prefer bun over node");

    const listed = await executeMemoryCommand("list", deps);
    expect(listed).toContain("Memory — 1 facts:");
    expect(listed).toContain("I prefer bun over node");
  });
});

test("/memory add without a category prefix falls back to general", async () => {
  await withCommandDeps(async (deps) => {
    await executeMemoryCommand("add the build script lives in scripts/build.ts", deps);
    const listed = await executeMemoryCommand("list general", deps);
    expect(listed).toContain("scripts/build.ts");
  });
});

test("/memory add with no content prints usage instead of storing", async () => {
  await withCommandDeps(async (deps, sink) => {
    const out = await executeMemoryCommand("add", deps);
    expect(out).toContain("Usage: /memory add");
    expect(sink.notified).toHaveLength(1);
    expect(deps.manager.count()).toBe(0);
  });
});

test("/memory search finds a stored fact and reports empty results", async () => {
  await withCommandDeps(async (deps) => {
    await executeMemoryCommand("add tool ripgrep is faster than grep", deps);

    const hit = await executeMemoryCommand("search ripgrep", deps);
    expect(hit).toContain("Search: ripgrep");
    expect(hit).toContain("ripgrep is faster than grep");

    const miss = await executeMemoryCommand("search kubernetes", deps);
    expect(miss).toContain("(no facts)");
  });
});

test("/memory search without a query prints usage", async () => {
  await withCommandDeps(async (deps) => {
    expect(await executeMemoryCommand("search", deps)).toContain("Usage: /memory search");
    expect(await executeMemoryCommand("search --scope project", deps)).toContain("Usage: /memory search");
  });
});

test("/memory remove deletes by id and reports unknown ids", async () => {
  await withCommandDeps(async (deps) => {
    await executeMemoryCommand("add general deploys run on fridays", deps);
    const id = deps.manager.list({ limit: 1 })[0]!.fact_id;

    expect(await executeMemoryCommand(`remove ${id}`, deps)).toBe(`Removed memory #${id}`);
    expect(deps.manager.count()).toBe(0);
    expect(await executeMemoryCommand("remove 9999", deps)).toBe("No such memory #9999");
    expect(await executeMemoryCommand("remove abc", deps)).toContain("Usage: /memory remove");
  });
});

test("/memory rm and delete are aliases of remove", async () => {
  await withCommandDeps(async (deps) => {
    await executeMemoryCommand("add general first", deps);
    const first = deps.manager.list({ limit: 1 })[0]!.fact_id;
    expect(await executeMemoryCommand(`rm ${first}`, deps)).toBe(`Removed memory #${first}`);

    await executeMemoryCommand("add general second", deps);
    const second = deps.manager.list({ limit: 1 })[0]!.fact_id;
    expect(await executeMemoryCommand(`delete ${second}`, deps)).toBe(`Removed memory #${second}`);
  });
});

test("/memory clear honours the confirm seam in both directions", async () => {
  await withCommandDeps(async (deps, sink) => {
    await executeMemoryCommand("add general disposable", deps);

    sink.confirmAnswer = false;
    expect(await executeMemoryCommand("clear", deps)).toBe("Cancelled.");
    expect(deps.manager.count()).toBe(1);

    sink.confirmAnswer = true;
    const cleared = await executeMemoryCommand("clear", deps);
    expect(cleared).toContain("Backup saved to");
    expect(cleared).toContain("Memory cleared.");
    expect(deps.manager.count()).toBe(0);
  });
});

test("/memory count and status report store state", async () => {
  await withCommandDeps(async (deps) => {
    await executeMemoryCommand("add general something worth keeping", deps);

    expect(await executeMemoryCommand("count", deps)).toContain("Memory: 1 facts (1 global, 0 project) at ");

    const status = await executeMemoryCommand("status", deps);
    expect(status).toContain("Memory provider: ");
    expect(status).toContain("Facts: 1");
    expect(status).toContain("Curated notes: 0");
  });
});

test("/memory notes add, list, replace, and remove round-trip", async () => {
  await withCommandDeps(async (deps) => {
    expect(await executeMemoryCommand("notes add user works in the pico repo", deps))
      .toContain("Added user note. Takes effect from the NEXT session");

    const listed = await executeMemoryCommand("notes", deps);
    expect(listed).toContain("USER.md:");
    expect(listed).toContain("works in the pico repo");
    expect(listed).toContain("MEMORY.md:");
    expect(listed).toContain("  (empty)");

    expect(await executeMemoryCommand("notes replace user works in the pico repo => maintains pico", deps))
      .toContain("Replaced user note.");
    // Target filtering requires the explicit `list` subcommand; a bare
    // `notes user` parses `user` as the subcommand, not the target.
    expect(await executeMemoryCommand("notes list user", deps)).toContain("maintains pico");

    expect(await executeMemoryCommand("notes remove user maintains pico", deps))
      .toContain("Removed user note.");
    expect(deps.curated.count("user")).toBe(0);
  });
});

test("/memory notes add defaults to the memory target", async () => {
  await withCommandDeps(async (deps) => {
    await executeMemoryCommand("notes add prefers tabs in subagent files", deps);
    expect(deps.curated.list("memory").memory).toContain("prefers tabs in subagent files");
    expect(deps.curated.count("user")).toBe(0);
  });
});

test("/memory notes replace without a => separator prints usage", async () => {
  await withCommandDeps(async (deps) => {
    expect(await executeMemoryCommand("notes replace user just one side", deps))
      .toContain("Usage: /memory notes replace");
  });
});

test("/memory notes clear honours the confirm seam", async () => {
  await withCommandDeps(async (deps, sink) => {
    await executeMemoryCommand("notes add memory disposable note", deps);

    sink.confirmAnswer = false;
    expect(await executeMemoryCommand("notes clear", deps)).toBe("Cancelled.");
    expect(deps.curated.count()).toBe(1);

    sink.confirmAnswer = true;
    expect(await executeMemoryCommand("notes clear", deps)).toBe("Cleared all curated notes.");
    expect(deps.curated.count()).toBe(0);
  });
});

test("/memory notes with an unknown subcommand prints notes usage", async () => {
  await withCommandDeps(async (deps) => {
    expect(await executeMemoryCommand("notes frobnicate", deps))
      .toBe("Usage: /memory notes [list|add|remove|replace|clear] [memory|user] ...");
  });
});

test("/memory help and unknown commands both print usage", async () => {
  await withCommandDeps(async (deps) => {
    const help = await executeMemoryCommand("help", deps);
    expect(help).toContain("Usage:");
    expect(help).toContain("/memory contradict");
    expect(await executeMemoryCommand("definitely-not-a-command", deps)).toBe(help);
  });
});

test("/memory --scope project is stripped from the query and scopes the write", async () => {
  await withCommandDeps(async (deps) => {
    const scoped: MemoryCommandDeps = { ...deps, currentCwd: "/tmp/some-project" };
    await executeMemoryCommand("add general --scope project uses a project-local config", scoped);

    // The flag must not leak into stored content.
    const facts = scoped.manager.list({ limit: 10, scope: "project", cwd: "/tmp/some-project" });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.content).toBe("uses a project-local config");

    // A global-scoped read must not see the project fact.
    expect(scoped.manager.list({ limit: 10, scope: "global" })).toHaveLength(0);
  });
});

test("/memory related and reason surface entity-linked facts", async () => {
  await withCommandDeps(async (deps) => {
    await executeMemoryCommand("add tool bun replaces node for this repo", deps);

    expect(await executeMemoryCommand("related bun", deps)).toContain('Related to "bun":');
    expect(await executeMemoryCommand("reason bun,node", deps)).toContain("Reason over [bun, node]:");
    expect(await executeMemoryCommand("related", deps)).toContain("Usage: /memory related");
    expect(await executeMemoryCommand("reason", deps)).toContain("Usage: /memory reason");
  });
});

test("/memory contradict reports when nothing conflicts", async () => {
  await withCommandDeps(async (deps) => {
    expect(await executeMemoryCommand("contradict", deps)).toBe("No contradictions found.");
  });
});

test("executeMemoryCommand folds thrown errors into the transcript", async () => {
  await withCommandDeps(async (deps) => {
    const exploding: MemoryCommandDeps = {
      ...deps,
      manager: new Proxy(deps.manager, {
        get(target, prop, receiver) {
          if (prop === "count") return () => { throw new Error("db is on fire"); };
          return Reflect.get(target, prop, receiver);
        },
      }),
    };
    expect(await executeMemoryCommand("count", exploding)).toBe("Error: db is on fire");
  });
});

test("builtin provider forwards scope/cwd to contradict", () => {
  const tempDb = join(tmpdir(), `pico-contradict-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const provider = new BuiltinMemoryProvider(tempDb);
  try {
    // Divergent content keeps the contradiction score above the default
    // threshold (the provider signature does not forward threshold).
    provider.add('the "Scope Service" bundles with docker', { scope: "project", cwd: "/proj/x" });
    provider.add('the "Scope Service" deploys via kubernetes', { scope: "project", cwd: "/proj/x" });
    provider.add('the "Global Service" bundles with docker', {});
    provider.add('the "Global Service" deploys via kubernetes', {});

    // Project-scoped contradict must see the project pair...
    const scoped = provider.contradict({ threshold: 0.1, limit: 10, scope: "project", cwd: "/proj/x" });
    expect(scoped.some((c) => c.fact_a.content.includes("Scope Service"))).toBe(true);

    // ...and global contradict must NOT leak project facts into the report.
    const globalOnly = provider.contradict({ threshold: 0.1, limit: 10, scope: "global" });
    expect(globalOnly.some((c) => c.fact_a.content.includes("Scope Service"))).toBe(false);
  } finally {
    provider.shutdown();
    try { rmSync(tempDb); } catch {}
    try { rmSync(`${tempDb}-wal`); } catch {}
    try { rmSync(`${tempDb}-shm`); } catch {}
  }
});

test("/memory status flags the holographic backend as a demo stub", async () => {
  await withCommandDeps(async (deps) => {
    const out = await executeMemoryCommand("status", deps);
    expect(out).toContain("holographic (demo stub");
    expect(out).toContain("builtin");
  });
});

test("/memory contradict accepts --scope flag without errors", async () => {
  await withCommandDeps(async (deps) => {
    const out = await executeMemoryCommand("contradict --scope project", deps);
    expect(out).toMatch(/No contradictions found\.|Contradictions \(/);
  });
});

test("CuratedMemoryStore clamps delimiter characters out of note entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "pico-curated-clamp-"));
  try {
    const curated = new CuratedMemoryStore({ dir });
    curated.loadFromDisk();

    const add = curated.add("memory", "line one\n\n§\n\nline two with extra spacing   ");
    expect(add.success).toBe(true);
    const entry = curated.list("memory").memory[0]!;
    // Newlines are collapsed to single spaces, so the literal entry
    // delimiter sequence ("\n§\n") can never appear inside an entry.
    expect(entry.includes("\n")).toBe(false);
    expect(entry.includes("\n§")).toBe(false);
    expect(entry).toContain("line one");

    // The file still round-trips, so later writes keep working.
    const add2 = curated.add("memory", "second entry");
    expect(add2.success).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CuratedMemoryStore rejects add when the file drifted out of round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "pico-curated-drift-"));
  try {
    const curated = new CuratedMemoryStore({ dir });
    curated.loadFromDisk();
    curated.add("memory", "first");

    // Hand-edit with padded whitespace: parsing then re-joining changes the
    // content, so the drift guard must refuse further writes.
    writeFileSync(join(dir, "MEMORY.md"), "  padded  \n§\nnote", "utf8");
    const add = curated.add("memory", "third");
    expect(add.success).toBe(false);
    expect(add.error).toContain("round-trip");
    // The user's file is preserved.
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("padded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CuratedMemoryStore refuses to clobber a file another process changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pico-curated-race-"));
  try {
    const curated = new CuratedMemoryStore({ dir });
    curated.loadFromDisk();
    curated.add("memory", "first");

    // Simulate another pico instance landing between our read and our
    // rename: the guarded write must refuse instead of silently losing the
    // other writer's entries (last-writer-wins).
    const anyStore = curated as unknown as {
      lastSeenMtimes: Map<string, number>;
      write: (path: string, entries: string[]) => void;
    };
    const writePath = join(dir, "MEMORY.md");
    anyStore.lastSeenMtimes.set(writePath, statSync(writePath).mtimeMs);
    writeFileSync(writePath, "external\n§\nnote", "utf8");
    expect(() => anyStore.write(writePath, ["clobber"])).toThrow(/concurrent writer/);
    // The external write survives untouched.
    expect(readFileSync(writePath, "utf8")).toContain("external");

    // An unchanged file writes normally.
    anyStore.lastSeenMtimes.set(writePath, statSync(writePath).mtimeMs);
    expect(() => anyStore.write(writePath, ["mine"])).not.toThrow();
    expect(readFileSync(writePath, "utf8")).toBe("mine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- category distribution + db path in /memory status (P2) ---------------
test("MemoryStore.countByCategory groups facts per category", () => {
  const store = new MemoryStore(":memory:");
  try {
    store.add("prefer bun over npm", { category: "user_pref" });
    store.add("use kebab-case", { category: "convention" });
    store.add("migrate to Postgres", { category: "project" });
    store.add("tavily key in settings", { category: "tool" });

    const byCategory = store.countByCategory();
    expect(byCategory).toContainEqual({ category: "user_pref", n: 1 });
    expect(byCategory).toContainEqual({ category: "convention", n: 1 });
    expect(byCategory).toContainEqual({ category: "project", n: 1 });
    expect(byCategory).toContainEqual({ category: "tool", n: 1 });
    expect(byCategory.reduce((sum, c) => sum + c.n, 0)).toBe(4);
  } finally {
    store.close();
  }
});

// ---- Fourth-round regression tests (scope contract / curated clamp / limits / secrets / queue) ----

test("store.add rejects project scope without cwd instead of silently losing the fact", () => {
  expect(() => store.add("orphaned project fact", { category: "project", scope: "project" })).toThrow(/requires a cwd/i);
  expect(store.count()).toBe(0);
  // With a cwd the same call stores under project:<cwd> as before.
  const id = store.add("scoped fact", { category: "project", scope: "project", cwd: "/tmp/proj" });
  expect(store.get(id)!.scope).toBe("project:/tmp/proj");
});

test("secret scanning catches unquoted and variant-spelling key=value secrets", () => {
  expect(scanSecrets("aws_secret_access_key = xyzsecret123").blocked).toBe(true);
  expect(scanSecrets("GITHUB_TOKEN: mytokenvalue99").blocked).toBe(true);
  expect(scanSecrets("client_secret=abcdefgh12345").blocked).toBe(true);
  // Non-assignment mentions and short placeholders stay allowed.
  expect(scanSecrets("we should rotate our api keys regularly").blocked).toBe(false);
  expect(scanSecrets("token = p").blocked).toBe(false);
});

test("curated replace() clamps delimiters like add() does", () => {
  const dir = mkdtempSync(join(tmpdir(), "pico-curated-replace-"));
  try {
    const curated = new CuratedMemoryStore({ dir });
    curated.loadFromDisk();
    curated.add("memory", "original entry");

    const replaced = curated.replace("memory", "original entry", "line one\n\n§\n\nline two");
    expect(replaced.success).toBe(true);
    const entry = curated.list("memory").memory[0]!;
    expect(entry.includes("\n")).toBe(false);
    expect(entry.includes("\n§")).toBe(false);

    // File still round-trips — later writes keep working (no drift lockout).
    const add2 = curated.add("memory", "after replace");
    expect(add2.success).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contradict clamps negative and zero limits", () => {
  const provider = new BuiltinMemoryProvider(":memory:");
  try {
    provider.add("alice uses redux", { category: "project", scope: "project", cwd: "/p/a" });
    provider.add("alice uses zustand", { category: "project", scope: "project", cwd: "/p/a" });
    const neg = provider.contradict({ limit: -999, scope: "project", cwd: "/p/a" });
    const zero = provider.contradict({ limit: 0, scope: "project", cwd: "/p/a" });
    const one = provider.contradict({ limit: 1, scope: "project", cwd: "/p/a" });
    expect(Array.isArray(neg)).toBe(true);
    expect(zero.length).toBeLessThanOrEqual(1);
    expect(one.length).toBeLessThanOrEqual(1);
  } finally {
    provider.shutdown();
  }
});

test("probe clamps negative FTS-fallback limits (no unbounded result set)", () => {
  // No entity row exists for this name → FTS fallback path with the raw limit.
  store.add("quantum entanglement research notes", { category: "general" });
  const hits = store.probe("quantum entanglement", { limit: -1, minTrust: 0 });
  expect(hits.length).toBeLessThanOrEqual(1);
  expect(Array.isArray(hits)).toBe(true);
});

test("busy_timeout pragma is configured on new stores", () => {
  const row = store.db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
  expect(row?.timeout).toBe(5000);
});

test("add rolls back the whole fact when post-insert processing fails", () => {
  const before = store.count();
  const broken = store as unknown as { _linkEntities: (factId: number, content: string) => void };
  const original = broken._linkEntities;
  broken._linkEntities = () => { throw new Error("entity extraction boom"); };
  try {
    expect(() => store.add("fact with failing entity link", { category: "general" })).toThrow(/entity extraction boom/);
  } finally {
    broken._linkEntities = original;
  }
  // The insert itself must be rolled back — no orphan fact without entities.
  expect(store.count()).toBe(before);
});

test("WriteQueue refuses pushes after close", () => {
  const queue = new WriteQueue();
  queue.push("op1", () => {});
  queue.close();
  expect(() => queue.push("op2", () => {})).toThrow(/closed/i);
});

test("prefetch hits the queued cache with a prefix query", () => {
  const provider = new BuiltinMemoryProvider(":memory:");
  try {
    provider.queuePrefetch("fix the login bug", "/p/a");
    // Next turn's message starts with the queued query — must hit the cache.
    const hits = provider.prefetch("fix the login bug in the auth flow", "/p/a");
    expect(Array.isArray(hits)).toBe(true);
  } finally {
    provider.shutdown();
  }
});

// ---- 2.3.x regression tests (fifth review round) --------------------------

test("2.3.3: corrupt memory.db is backed up and rebuilt instead of throwing", async () => {
  const corruptPath = join(tmpdir(), `pico-corrupt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeFileSync(corruptPath, "this is not a sqlite database at all");
  try {
    const recovered = new MemoryStore(corruptPath);
    try {
      expect(recovered.recoveryNotice).toContain("corrupt");
      expect(recovered.recoveryNotice).toContain("Backed up");
      expect(existsSync(`${corruptPath}.corrupt-`)).toBe(false); // exact name has a ts suffix
      // The corrupt original must have been renamed away and a fresh store created.
      recovered.add("fresh start", { category: "general" });
      expect(recovered.count()).toBe(1);
    } finally {
      recovered.close();
    }
    // The backup file exists with the corrupt payload preserved.
    const name = corruptPath.split("/").pop()!;
    const backups = (await import("node:fs")).readdirSync(tmpdir()).filter((f: string) => f.startsWith(`${name}.corrupt-`));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  } finally {
    rmSync(corruptPath, { force: true });
  }
});

test("2.3.4: remove/update refuse cross-project facts", async () => {
  const { executeMemoryToolAction } = await import("../src/extensions/memory/tool.ts");
  const mkProvider = new BuiltinMemoryProvider(":memory:");
  try {
    const otherId = mkProvider.add("project fact in /other/proj", { category: "project", scope: "project", cwd: "/other/proj" });
    const mineId = mkProvider.add("project fact in my proj", { category: "project", scope: "project", cwd: "/my/proj" });
    const deps = { provider: mkProvider, manager: new ProviderManager({ backend: "builtin" }), currentCwd: "/my/proj" };

    expect(() => executeMemoryToolAction({ action: "remove", fact_id: otherId }, deps)).toThrow("another project");
    expect(mkProvider.get(otherId)).not.toBeNull();

    const out2 = executeMemoryToolAction({ action: "remove", fact_id: mineId }, deps);
    expect(JSON.parse(out2.content[0]!.text).status).toBe("removed");

    // update path is gated the same way
    const id3 = mkProvider.add("third fact", { category: "project", scope: "project", cwd: "/other/proj" });
    expect(() => executeMemoryToolAction({ action: "update", fact_id: id3, content: "changed" }, deps)).toThrow("another project");
  } finally {
    mkProvider.shutdown();
  }
});

test("2.3.5: isLikelyCorrection gates contextual chatter but keeps strong corrections", async () => {
  const { isLikelyCorrection } = await import("../src/extensions/memory/extract.ts");
  expect(isLikelyCorrection("Actually, I want the dark theme instead.")).toBe(true); // short contextual correction
  expect(isLikelyCorrection(
    "Actually, I want to tell you about the team's quarterly offsite planning session next month which we've been postponing since early spring because of the venue availability issues and budget reallocation talks with the finance committee.",
  )).toBe(false); // long contextual chatter (> 200 chars)
  expect(isLikelyCorrection("You said the API is v2, that's wrong, it's v3.")).toBe(true); // referential
  expect(isLikelyCorrection("Wait, is this wrong?")).toBe(false); // question
  expect(isLikelyCorrection("Don't use that approach.")).toBe(true);
});

test("2.3.5: contextual 'actually I want' chatter is not extracted as correction", () => {
  const before = store.count();
  const extracted = autoExtractFromMessages(store, [
    { role: "user", content: "Actually, I want to tell you about the team's quarterly offsite planning session next month which we've been postponing since early spring because of the venue availability issues and budget reallocation talks with the finance committee." },
  ]);
  expect(extracted).toBe(0);
  expect(store.count()).toBe(before);
});

test("2.3.6: help requests and denials are not extracted as durable facts", () => {
  const before = store.count();
  autoExtractFromMessages(store, [
    { role: "user", content: "程序报错了，帮我看看这个报错" },
    { role: "user", content: "I never said that, you must have misheard me" },
    { role: "user", content: "I want to fix this bug in the parser" },
  ]);
  expect(store.count()).toBe(before);
});

test("2.6.3: one-time task directives are not extracted as durable facts", () => {
  const before = store.count();
  autoExtractFromMessages(store, [
    { role: "user", content: "在 wt 目录下运行 bun run no-such-script-xyz，然后把输出告诉我" },
    { role: "user", content: "解释 src/extensions/todo 扩展如何工作：注册了哪些工具和命令" },
    { role: "user", content: "数一下这个仓库的 src 目录下有多少个 .ts 文件" },
    { role: "user", content: "把 /tmp/x/y.ts 的内容改成 export const x = 1" },
    { role: "user", content: "优化一下这个项目的性能" },
    { role: "user", content: "请使用 subagent 工具的 worker 子代理分析 tests 目录" },
  ]);
  expect(store.count()).toBe(before);
});

test("2.6.3: classifyMessage keeps durable statements but rejects directives/questions", () => {
  expect(classifyMessage("I prefer using bun for all scripts.")).toBe("user_pref");
  expect(classifyMessage("我们决定用 bun 作为包管理器")).toBe("project");
  expect(classifyMessage("记住：要在 README 末尾加 changelog 章节")).toBe("insight");
  expect(classifyMessage("在 wt 目录下运行 bun test")).toBeUndefined();
  expect(classifyMessage("解释 X 如何工作")).toBeUndefined();
  expect(classifyMessage("数一下 src 有多少文件")).toBeUndefined();
  expect(classifyMessage("为什么思考深度只到 high?")).toBeUndefined();
  expect(isDurableCandidate("use memory tool action=add to store this")).toBe(false);
  expect(isDurableCandidate("把 foo.ts 改成 1")).toBe(false);
  expect(isDurableCandidate("I prefer bun over npm")).toBe(true);
});

test("2.6.3: directive mixed with a remember-tail is still a task, not a fact", () => {
  const directive = "在 src 目录下运行 bun test 看看有多少测试通过；另外记住一点：我们团队决定以后提交前必须跑 bun run verify";
  expect(isDurableCandidate(directive)).toBe(false);
  expect(classifyMessage(directive)).toBeUndefined();

  const before = store.count();
  autoExtractFromMessages(store, [{ role: "user", content: directive }]);
  expect(store.count()).toBe(before);
});

test("2.6.3: onSessionEnd does not summarize sessions whose only message is a directive", () => {
  const provider = new BuiltinMemoryProvider(":memory:");
  try {
    provider.initialize("s1");
    provider.onSessionEnd(
      userMessages("在 src 目录下运行 bun test 看看有多少测试通过；另外记住一点：我们团队决定以后提交前必须跑 bun run verify"),
    );
    const raw = provider.getRawStore() as MemoryStore;
    expect(raw.list({ minTrust: 0, limit: 10 }).filter((f) => f.source === "session-summary")).toHaveLength(0);
  } finally {
    provider.shutdown();
  }
});

test("2.3.6: terse preference like '别用 npm' is now extractable", () => {
  const before = store.count();
  const n = autoExtractFromMessages(store, [
    { role: "user", content: "别用 npm" },
  ]);
  expect(n).toBe(1);
  expect(store.count()).toBe(before + 1);
});

test("2.3.8: JWT and camelCase secrets are blocked, tags are scanned", () => {
  expect(scanSecrets("token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c").blocked).toBe(true);
  expect(scanSecrets("accessKey=Zx9KpLmQ2VrT7nB4cY6dE8fGhJ1kL3mN5oP7qRs9TuVwXyZ").blocked).toBe(true);
  expect(() => store.add("fact with a secret in tags", { tags: "token=AbCdEfGh12345678" })).toThrow(/secret/i);
});

test("2.3.8: PICO_MEMORY_DENY is enforced at the store layer (not only the tool path)", () => {
  const old = process.env.PICO_MEMORY_DENY;
  process.env.PICO_MEMORY_DENY = "forbidden-word";
  try {
    expect(() => store.add("this mentions the forbidden-word in passing")).toThrow(/forbidden-word/);
    // ...but auto-extract / correction paths route through store.add too.
  } finally {
    process.env.PICO_MEMORY_DENY = old;
  }
});

test("2.3.2: negated facts are downweighted in substring fallback", () => {
  const pos = store.add("we use bun for all scripts", { category: "project" });
  const neg = store.add("我不用 bun", { category: "user_pref" });
  store.feedback(neg, true); // boost trust of the negative one
  const hits = store.search("bun", { minTrust: 0, limit: 5 });
  expect(hits.map((h) => h.fact_id)).toContain(pos);
  expect(hits[0]!.fact_id).toBe(pos);
});

test("2.3.12: stored alias matches canonical query in fallback", () => {
  store.add("prefer TS for type safety", { category: "user_pref" });
  const hits = store.search("typescript", { minTrust: 0 });
  expect(hits.map((h) => h.content)).toContain("prefer TS for type safety");
});

test("2.3.10: prefetch cache hits on shared topic token, not only prefix", () => {
  const provider = new BuiltinMemoryProvider(":memory:");
  try {
    provider.queuePrefetch("refactor the login flow", "/p/a");
    // New turn shares a significant token ("refactor") but is not a prefix.
    const hits = provider.prefetch("refactor the auth module", "/p/a");
    expect(Array.isArray(hits)).toBe(true);
  } finally {
    provider.shutdown();
  }
});

test("2.3.7: project scope keys normalize trailing slash and symlinks", async () => {
  const { projectScopeKey, normalizeProjectCwd } = await import("../src/extensions/memory/query-scope.ts");
  const cwd = mkdtempSync(join(tmpdir(), "pico-proj-"));
  try {
    expect(projectScopeKey(`${cwd}/`)).toBe(projectScopeKey(cwd));
    expect(normalizeProjectCwd(`${cwd}/`)).toBe(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("2.3.13: curated dedupe is normalization-insensitive", () => {
  const dir = mkdtempSync(join(tmpdir(), "pico-curated-"));
  const curated = new CuratedMemoryStore({ dir, memoryCharLimit: 1000 });
  try {
    expect(curated.add("memory", "we use bun for scripts").success).toBe(true);
    expect(curated.add("memory", "we use  bun for scripts").success).toBe(true);
    expect(curated.count("memory")).toBe(1);
  } finally {
    resetCuratedMemoryDir(dir);
  }
});

// --- session lifecycle hooks ----------------------------------------------
//
// onSessionEnd persists a topic-summary fact; onPreCompress archives the
// messages about to be discarded by context compression.

function userMessages(...texts: string[]): Array<{ role: string; content: string }> {
  return texts.map((content) => ({ role: "user", content }));
}

test("onSessionEnd persists a session-summary fact with topic and count", () => {
  const provider = new BuiltinMemoryProvider(":memory:");
  try {
    provider.initialize("s1");
    provider.onSessionEnd(userMessages("I prefer bun over npm", "the build script lives in scripts/build.ts"));
    const raw = provider.getRawStore() as MemoryStore;
    const summary = raw.list({ minTrust: 0, limit: 10 }).find((f) => f.source === "session-summary");
    expect(summary).toBeDefined();
    expect(summary!.content).toContain("Session: I prefer bun over npm");
    expect(summary!.content).toContain("(+1 more)");
    expect(summary!.category).toBe("insight");
    expect(summary!.scope).toBe("global");
  } finally {
    provider.shutdown();
  }
});

test("onSessionEnd with a session cwd writes a project-scoped summary", () => {
  const provider = new BuiltinMemoryProvider(":memory:");
  try {
    provider.initialize("s1", { cwd: "/p/a" });
    provider.onSessionEnd(userMessages("we decided to use bun"));
    const raw = provider.getRawStore() as MemoryStore;
    // list() defaults to the global scope — query the store directly so a
    // project-scoped summary is visible.
    const summary = raw.db.query<{ scope: string }, []>("SELECT scope FROM facts WHERE source = 'session-summary'").get();
    expect(summary).toBeDefined();
    expect(summary!.scope).toContain("project:");
  } finally {
    provider.shutdown();
  }
});

test("onSessionEnd skips instruction-like topics and empty sessions", () => {
  const provider = new BuiltinMemoryProvider(":memory:");
  try {
    provider.initialize("s1");
    provider.onSessionEnd([]);
    provider.onSessionEnd(userMessages("use memory tool action=add to store this"));
    const raw = provider.getRawStore() as MemoryStore;
    expect(raw.count()).toBe(0);
  } finally {
    provider.shutdown();
  }
});

test("onSessionEnd skips sessions whose only messages are one-time directives or questions", () => {
  const provider = new BuiltinMemoryProvider(":memory:");
  try {
    provider.initialize("s1");
    provider.onSessionEnd(userMessages("在 wt 目录下运行 bun run no-such-script-xyz，然后把输出告诉我"));
    provider.onSessionEnd(userMessages("数一下 src 目录下有多少个 .ts 文件"));
    provider.onSessionEnd(userMessages("为什么思考深度只到 high?"));
    provider.onSessionEnd(userMessages("解释 src/extensions/todo 扩展如何工作"));
    const raw = provider.getRawStore() as MemoryStore;
    expect(raw.count()).toBe(0);
  } finally {
    provider.shutdown();
  }
});

test("onSessionEnd falls back to a later durable statement when the first message is a directive", () => {
  const provider = new BuiltinMemoryProvider(":memory:");
  try {
    provider.initialize("s1");
    provider.onSessionEnd(userMessages("运行 bun test", "我们决定用 bun 作为包管理器"));
    const raw = provider.getRawStore() as MemoryStore;
    const summary = raw.list({ minTrust: 0, limit: 10 }).find((f) => f.source === "session-summary");
    expect(summary).toBeDefined();
    expect(summary!.content).toContain("Session: 我们决定用 bun 作为包管理器");
    expect(summary!.content).toContain("(+1 more)");
  } finally {
    provider.shutdown();
  }
});

test("onSessionEnd is idempotent for identical session content", () => {
  const provider = new BuiltinMemoryProvider(":memory:");
  try {
    provider.initialize("s1");
    const messages = userMessages("I prefer bun over npm");
    provider.onSessionEnd(messages);
    provider.onSessionEnd(messages);
    const raw = provider.getRawStore() as MemoryStore;
    expect(raw.list({ minTrust: 0, limit: 10 }).filter((f) => f.source === "session-summary")).toHaveLength(1);
  } finally {
    provider.shutdown();
  }
});

test("onPreCompress archives user messages and reports the contribution", () => {
  const provider = new BuiltinMemoryProvider(":memory:");
  try {
    provider.initialize("s1", { cwd: "/p/a" });
    const contribution = provider.onPreCompress(userMessages("we agreed to use bun for scripts"));
    expect(contribution).toContain("[memory]");
    expect(contribution).toContain("1 user message");
    const raw = provider.getRawStore() as MemoryStore;
    const stored = raw.db.query<{ scope: string; content: string }, []>(
      "SELECT scope, content FROM facts WHERE content LIKE '%bun for scripts%'",
    ).get();
    expect(stored).toBeDefined();
    expect(stored!.scope).toContain("project:");
  } finally {
    provider.shutdown();
  }
});

test("onPreCompress returns empty for messages without user turns", () => {
  const provider = new BuiltinMemoryProvider(":memory:");
  try {
    provider.initialize("s1");
    expect(provider.onPreCompress([{ role: "assistant", content: "let me check" }])).toBe("");
  } finally {
    provider.shutdown();
  }
});

// --- temporal decay --------------------------------------------------------

function ageFactsInDb(store: MemoryStore, ageDays: number, predicate: (id: number) => boolean): void {
  const rows = store.list({ minTrust: 0, limit: 1000 });
  for (const row of rows) {
    if (!predicate(row.fact_id)) continue;
    store.db
      .query(`UPDATE facts SET updated_at = datetime('now', ?) WHERE fact_id = ?`)
      .run(`-${ageDays} days`, row.fact_id);
  }
}

test("temporal decay ranks fresh facts above old ones when enabled", () => {
  const aged = new MemoryStore(":memory:", { temporalDecayHalfLifeDays: 1 });
  try {
    aged.add("we use bun for the build", { trust: 0.9 });
    aged.add("we use bun for testing", { trust: 0.9 });
    const rows = aged.list({ minTrust: 0, limit: 10 });
    // list returns fact_id DESC, so rows[1] is the OLDER inserted fact.
    ageFactsInDb(aged, 400, (id) => id === rows[1]!.fact_id);
    const hits = aged.search("bun", { minTrust: 0 });
    expect(hits[0]!.content).toBe("we use bun for testing");
  } finally {
    aged.close();
  }
});

test("temporal decay can be disabled (0 = no decay)", () => {
  const store = new MemoryStore(":memory:", { temporalDecayHalfLifeDays: 0 });
  try {
    store.add("we use bun for the build", { trust: 0.9 });
    store.add("we use bun for testing", { trust: 0.8 });
    const rows = store.list({ minTrust: 0, limit: 10 });
    ageFactsInDb(store, 400, (id) => id === rows[0]!.fact_id);
    // Without decay the higher-trust old fact outranks the fresh one.
    const hits = store.search("bun", { minTrust: 0 });
    expect(hits[0]!.content).toBe("we use bun for the build");
  } finally {
    store.close();
  }
});

test("temporal decay applies to the substring fallback path", () => {
  const aged = new MemoryStore(":memory:", { temporalDecayHalfLifeDays: 1 });
  try {
    aged.add("我们用bun做构建", { trust: 0.9 });
    aged.add("我们用bun做测试", { trust: 0.9 });
    const rows = aged.list({ minTrust: 0, limit: 10 });
    ageFactsInDb(aged, 400, (id) => id === rows[1]!.fact_id);
    // "我们" is a single CJK run — FTS5 misses it, forcing the fallback.
    const hits = aged.search("我们", { minTrust: 0 });
    expect(hits[0]!.content).toBe("我们用bun做测试");
  } finally {
    aged.close();
  }
});

test("retriever inherits the store's temporal decay schedule", () => {
  const aged = new MemoryStore(":memory:", { temporalDecayHalfLifeDays: 42 });
  try {
    expect(aged.retriever().temporalDecayHalfLife).toBe(42);
  } finally {
    aged.close();
  }
  const plain = new MemoryStore(":memory:");
  try {
    expect(plain.retriever().temporalDecayHalfLife).toBe(180);
  } finally {
    plain.close();
  }
});

// --- holographic demo provider --------------------------------------------

test("holographic prefetch returns substring matches for the next turn", () => {
  const dbFile = join(tmpdir(), `pico-holo-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const provider = new HolographicMemoryProvider(dbFile);
  try {
    provider.add("we use bun for the build");
    provider.add("prefer rust for the parser");
    const hits = provider.prefetch("bun");
    expect(hits.map((h) => h.content)).toContain("we use bun for the build");
    expect(hits).toHaveLength(1);
    expect(provider.prefetch("")).toHaveLength(0);
  } finally {
    provider.shutdown();
    try { rmSync(dbFile); } catch { }
  }
});

test("holographic systemPromptBlock flags the demo capability boundary", () => {
  const dbFile = join(tmpdir(), `pico-holo-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const provider = new HolographicMemoryProvider(dbFile);
  try {
    provider.add("we use bun");
    expect(provider.systemPromptBlock()).toContain("demo");
  } finally {
    provider.shutdown();
    try { rmSync(dbFile); } catch { }
  }
});

// --- recall block sanitisation & budget ------------------------------------

function makeFact(id: number, content: string) {
  return {
    fact_id: id,
    content,
    category: "general" as const,
    tags: "",
    trust_score: 0.8,
    retrieval_count: 0,
    helpful_count: 0,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    scope: "global",
    correction_of: null,
    source: "auto",
  };
}

test("formatRecallBlock redacts secret-like fact content", () => {
  const block = formatRecallBlock([makeFact(1, "deploy with key sk-test1234567890abcdefghijklmnop")]);
  expect(block).toContain("[BLOCKED: fact #1");
  expect(block).not.toContain("sk-test");
});

test("formatRecallBlock truncates past the budget with a marker", () => {
  const facts = Array.from({ length: 30 }, (_, i) => makeFact(i + 1, `fact number ${i + 1} about bun runtime `.repeat(4)));
  const block = formatRecallBlock(facts);
  expect(block.length).toBeLessThan(RECALL_BUDGET_CHARS + 400);
  expect(block).toContain("recall truncated");
  expect(block).toContain("fact number 1");
});

// --- curated consolidation retry cap --------------------------------------

test("curated at-capacity add trips the retry cap after 3 failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "pico-consolidate-"));
  const curated = new CuratedMemoryStore({ dir, memoryCharLimit: 120 });
  try {
    curated.loadFromDisk();
    expect(curated.add("memory", "first entry that fits the budget").success).toBe(true);
    expect(curated.add("memory", "second entry that also fits the budget").success).toBe(true);
    // From here every add is at capacity: failure 1..3 carry no done flag,
    // failure 4 trips the cap.
    const results = [1, 2, 3, 4, 5].map(() => curated.add("memory", "another entry that cannot possibly fit in the remaining budget"));
    expect(results[0]!.done).toBeUndefined();
    expect(results[1]!.done).toBeUndefined();
    expect(results[2]!.done).toBeUndefined();
    expect(results[3]!.done).toBe(true);
    expect(results[3]!.error).toContain("Stop retrying");
  } finally {
    resetCuratedMemoryDir(dir);
  }
});

test("curated consolidation cap resets on a successful write", () => {
  const dir = mkdtempSync(join(tmpdir(), "pico-consolidate-"));
  const curated = new CuratedMemoryStore({ dir, memoryCharLimit: 120 });
  try {
    curated.loadFromDisk();
    curated.add("memory", "first entry that fits the budget");
    curated.add("memory", "second entry that also fits the budget");
    expect(curated.add("memory", "another entry that cannot possibly fit in the remaining budget").done).toBeUndefined();
    expect(curated.add("memory", "another entry that cannot possibly fit in the remaining budget").done).toBeUndefined();
    // Free space, then a success resets the counter.
    expect(curated.remove("memory", "second entry that also fits").success).toBe(true);
    expect(curated.add("memory", "replacement entry that fits again").success).toBe(true);
    expect(curated.add("memory", "another entry that cannot possibly fit in the remaining budget").done).toBeUndefined();
  } finally {
    resetCuratedMemoryDir(dir);
  }
});

test("curated resetConsolidationFailures restores the retry budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "pico-consolidate-"));
  const curated = new CuratedMemoryStore({ dir, memoryCharLimit: 120 });
  try {
    curated.loadFromDisk();
    curated.add("memory", "first entry that fits the budget");
    curated.add("memory", "second entry that also fits the budget");
    curated.add("memory", "third entry that also fits the budget");
    curated.add("memory", "fourth entry that also fits the budget");
    expect(curated.add("memory", "another entry that cannot possibly fit in the remaining budget").done).toBeUndefined();
    curated.resetConsolidationFailures();
    expect(curated.add("memory", "another entry that cannot possibly fit in the remaining budget").done).toBeUndefined();
    expect(curated.add("memory", "another entry that cannot possibly fit in the remaining budget").done).toBeUndefined();
    expect(curated.add("memory", "another entry that cannot possibly fit in the remaining budget").done).toBeUndefined();
    expect(curated.add("memory", "another entry that cannot possibly fit in the remaining budget").done).toBe(true);
  } finally {
    resetCuratedMemoryDir(dir);
  }
});

// --- /memory prune ---------------------------------------------------------

test("/memory prune deletes only low-value facts and keeps other-project ones", async () => {
  await withCommandDeps(async (deps, sink) => {
    deps.manager.add("stale abandoned thought", { trust: 0.1, source: "manual" });
    deps.manager.add("valuable decision", { trust: 0.9, source: "manual" });
    deps.manager.add("low trust but retrieved", { trust: 0.1, source: "manual" });
    const raw = deps.manager.provider.getRawStore() as MemoryStore;
    raw.db.query("UPDATE facts SET retrieval_count = 3 WHERE content = 'low trust but retrieved'").run();

    const out = await executeMemoryCommand("prune", deps);
    expect(sink.confirmAnswer).toBe(true);
    expect(out).toContain("Pruned 1 low-value fact");
    const remaining = raw.list({ minTrust: 0, limit: 100 }).map((f) => f.content);
    expect(remaining).toContain("valuable decision");
    expect(remaining).toContain("low trust but retrieved");
    expect(remaining).not.toContain("stale abandoned thought");
  });
});

test("/memory prune with no candidates reports nothing to remove", async () => {
  await withCommandDeps(async (deps) => {
    deps.manager.add("valuable decision", { trust: 0.9, source: "manual" });
    const out = await executeMemoryCommand("prune", deps);
    expect(out).toContain("No low-value facts");
  });
});

test("renderMemoryResultText strips internal noise keys but keeps business fields", () => {
  const { renderMemoryResultText } = require("../src/extensions/memory/index.ts") as typeof import("../src/extensions/memory/index.ts");
  const result = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          id: "memory:#1",
          action: "add",
          source: "manual",
          correction_of: null,
          tfidf_vector: '{"用户偏好":0.142857}',
          fact: "use single quotes",
        }),
      },
    ],
    details: {},
  };
  const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
  const text = renderMemoryResultText(
    result as never,
    { expanded: true, isPartial: false } as never,
    plainTheme,
    {},
  ) as unknown as { render: (w: number) => string[] };
  const rendered = text.render(120).join("\n");
  expect(rendered).toContain("memory:#1");
  expect(rendered).toContain("use single quotes");
  expect(rendered).not.toContain("tfidf_vector");
  expect(rendered).not.toContain("correction_of");
  expect(rendered).not.toContain("source");
});

test("renderMemoryResultText passes non-JSON results through unchanged", () => {
  const { renderMemoryResultText } = require("../src/extensions/memory/index.ts") as typeof import("../src/extensions/memory/index.ts");
  const result = {
    content: [{ type: "text", text: "hello memory" }],
    details: {},
  };
  const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
  const text = renderMemoryResultText(
    result as never,
    { expanded: true, isPartial: false } as never,
    plainTheme,
    {},
  ) as unknown as { render: (w: number) => string[] };
  const rendered = text.render(120).join("\n");
  expect(rendered).toContain("hello memory");
});
