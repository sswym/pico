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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/extensions/memory/store.ts";
import { BuiltinMemoryProvider } from "../src/extensions/memory/builtin-provider.ts";
import { CuratedMemoryStore } from "../src/extensions/memory/curated-store.ts";
import { autoExtractFromMessages } from "../src/extensions/memory/extract.ts";
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

test("parseCommand defaults to list and splits cmd from rest", () => {
  expect(parseCommand("")).toEqual({ cmd: "list", rest: "" });
  expect(parseCommand("   ")).toEqual({ cmd: "list", rest: "" });
  expect(parseCommand("status")).toEqual({ cmd: "status", rest: "" });
  expect(parseCommand("SEARCH bun runtime")).toEqual({ cmd: "search", rest: "bun runtime" });
});

test("/memory add then list round-trips the fact", async () => {
  await withCommandDeps(async (deps) => {
    const added = await executeMemoryCommand("add user_pref I prefer bun over node", deps);
    expect(added).toContain("Added:");
    expect(added).toContain("I prefer bun over node");

    const listed = await executeMemoryCommand("", deps);
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
    expect(await executeMemoryCommand("clear", deps)).toBe("Memory cleared.");
    expect(deps.manager.count()).toBe(0);
  });
});

test("/memory count and status report store state", async () => {
  await withCommandDeps(async (deps) => {
    await executeMemoryCommand("add general something worth keeping", deps);

    expect(await executeMemoryCommand("count", deps)).toContain("Memory: 1 facts at ");

    const status = await executeMemoryCommand("status", deps);
    expect(status).toContain("Memory provider: ");
    expect(status).toContain("Facts: 1");
    expect(status).toContain("Curated notes: 0");
  });
});

test("/memory notes add, list, replace, and remove round-trip", async () => {
  await withCommandDeps(async (deps) => {
    expect(await executeMemoryCommand("notes add user works in the pico repo", deps))
      .toBe("Added user note.");

    const listed = await executeMemoryCommand("notes", deps);
    expect(listed).toContain("USER.md:");
    expect(listed).toContain("works in the pico repo");
    expect(listed).toContain("MEMORY.md:");
    expect(listed).toContain("  (empty)");

    expect(await executeMemoryCommand("notes replace user works in the pico repo => maintains pico", deps))
      .toBe("Replaced user note.");
    // Target filtering requires the explicit `list` subcommand; a bare
    // `notes user` parses `user` as the subcommand, not the target.
    expect(await executeMemoryCommand("notes list user", deps)).toContain("maintains pico");

    expect(await executeMemoryCommand("notes remove user maintains pico", deps))
      .toBe("Removed user note.");
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
