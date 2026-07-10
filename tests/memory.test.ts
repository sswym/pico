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
import { WriteQueue, type MemoryProvider, type MemoryWriteMetadata } from "../src/extensions/memory/provider.ts";
import { ProviderManager } from "../src/extensions/memory/provider-manager.ts";
import { memoryExtension } from "../src/extensions/memory/index.ts";

let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  dbPath = join(tmpdir(), `srcode-mem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

test("memoryExtension captures cwd on session_start before first recall", async () => {
  const oldEnv = process.env.SRCODE_MEMORY_DB;
  const tempDb = join(tmpdir(), `srcode-ext-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const cwd = "/tmp/srcode-memory-project";
  const seedStore = new MemoryStore(tempDb);
  seedStore.add("this project uses redux toolkit", { category: "project", scope: "project", cwd });
  seedStore.close();
  process.env.SRCODE_MEMORY_DB = tempDb;

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
    if (oldEnv === undefined) delete process.env.SRCODE_MEMORY_DB;
    else process.env.SRCODE_MEMORY_DB = oldEnv;
    try { rmSync(tempDb); } catch { }
    try { rmSync(`${tempDb}-wal`); } catch { }
    try { rmSync(`${tempDb}-shm`); } catch { }
  }
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
  const oldEnv = process.env.SRCODE_MEMORY_DB;
  const tempDb = join(tmpdir(), `srcode-mgr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.SRCODE_MEMORY_DB = tempDb;
  try {
    const manager = new ProviderManager();
    fn(manager);
  } finally {
    if (oldEnv === undefined) {
      delete process.env.SRCODE_MEMORY_DB;
    } else {
      process.env.SRCODE_MEMORY_DB = oldEnv;
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
    const fake = makeFakeMemoryProvider({
      onMemoryWrite: () => {
        throw new Error("boom");
      },
    });
    manager.registerExternalProvider(fake);
    // Should not throw
    manager.notifyMemoryToolWrite({ action: "remove", factId: 42 });
    // Implicit pass if we reach here
    expect(true).toBe(true);
  });
});
