/**
 * Deep coverage for the memory extension's untested dispatch/event branches.
 *
 * Two layers, deliberately disjoint from tests/memory.test.ts (which owns the
 * store layer, the /memory command routing and the curated-store round-trips):
 *
 *  1. executeMemoryToolAction (tool.ts) — every validation/ownership/write-gate
 *     branch exercised through hand-rolled fake providers, plus one integration
 *     path over the real BuiltinMemoryProvider.
 *  2. memoryExtension event handlers (index.ts) — session_start recovery/catch,
 *     switch/fork curated reload, before_agent_start catch, turn_end correction
 *     detection + skip rules + consolidation reset, agent_end fingerprint
 *     dedupe + session buffer cap + catch, session_before_compact empty input,
 *     session_shutdown per-reason behaviour, external-provider tool schema
 *     registration and the /memory command + memory tool wiring.
 *
 * Notes on branches that could not be exercised from outside:
 *  - before_agent_start's `if (!extras) return {}`: systemPromptBlock()
 *    (prompt.ts) returns non-empty for EVERY factCount, so extras can never be
 *    empty — the branch is unreachable without mocking the module namespace.
 *    The reachable catch path (provider explodes) is covered instead.
 *  - session_before_compact's catch: manager.onPreCompress wraps every provider
 *    call in try/catch and joins strings, so it cannot throw.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/extensions/memory/store.ts";
import { BuiltinMemoryProvider } from "../src/extensions/memory/builtin-provider.ts";
import { CuratedMemoryStore } from "../src/extensions/memory/curated-store.ts";
import {
  ProviderManager,
  registerMemoryProviderFactory,
} from "../src/extensions/memory/provider-manager.ts";
import { WriteQueue, type Fact, type MemoryProvider, type MemoryWriteMetadata } from "../src/extensions/memory/provider.ts";
import { executeMemoryToolAction } from "../src/extensions/memory/tool.ts";
import { memoryExtension } from "../src/extensions/memory/index.ts";
import {
  clearSessionExtensionSubscriptions,
  __resetExtensionEventsForTests,
  publishExtensionEvent,
  subscribeSessionExtensionEvent,
} from "../src/extensions/events.ts";

// ---- helpers ---------------------------------------------------------------

function makeFakeMemoryProvider(overrides: Partial<MemoryProvider> = {}): MemoryProvider {
  return {
    name: "deep-test-provider",
    isAvailable: () => true,
    initialize: () => {},
    shutdown: () => {},
    get: () => null,
    add: () => 0,
    update: () => true,
    remove: () => true,
    feedback: () => null,
    clear: () => {},
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
    queuePrefetch: () => {},
    ...overrides,
  };
}

function makeFact(id: number, scope = "global", content = `fact ${id}`): Fact {
  return {
    fact_id: id,
    content,
    category: "general",
    tags: "",
    trust_score: 0.5,
    retrieval_count: 0,
    helpful_count: 0,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    scope,
    correction_of: null,
    source: "auto",
  };
}

const OTHER_PROJECT_FACT = makeFact(7, "project:/other/proj", "belongs to another project");

/** Track every call a fake provider receives, with its options. */
function recordCalls(
  provider: MemoryProvider,
): { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const p = provider as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ["add", "search", "probe", "list", "related", "reason", "contradict", "update", "remove", "feedback"]) {
    const original = p[method]!.bind(provider);
    p[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return original(...args);
    };
  }
  return { calls };
}

/** Isolated PICO_HOME + PICO_MEMORY_DB per test; restored + wiped in afterEach. */
interface DeepEnv {
  home: string;
  db: string;
  restore(): void;
}
const activeEnvs: DeepEnv[] = [];
function makeEnv(): DeepEnv {
  const oldHome = process.env.PICO_HOME;
  const oldDb = process.env.PICO_MEMORY_DB;
  const home = mkdtempSync(join(tmpdir(), "pico-deep-"));
  const db = join(home, "memory.db");
  process.env.PICO_HOME = home;
  process.env.PICO_MEMORY_DB = db;
  const env: DeepEnv = {
    home,
    db,
    restore() {
      if (oldHome === undefined) delete process.env.PICO_HOME;
      else process.env.PICO_HOME = oldHome;
      if (oldDb === undefined) delete process.env.PICO_MEMORY_DB;
      else process.env.PICO_MEMORY_DB = oldDb;
    },
  };
  activeEnvs.push(env);
  return env;
}

afterEach(() => {
  for (const env of activeEnvs) {
    env.restore();
    try { rmSync(env.home, { recursive: true, force: true }); } catch {}
  }
  activeEnvs.length = 0;
  // index.ts subscribes into the module-level event bus per factory run.
  clearSessionExtensionSubscriptions();
  __resetExtensionEventsForTests();
});

function makeDeepFakePi() {
  const handlers: Record<string, Array<(event: any, ctx?: any) => any>> = {};
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: Array<Record<string, unknown>> = [];
  return {
    handlers,
    tools,
    commands,
    sent,
    on: (event: string, handler: (event: any, ctx?: any) => any) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, opts: any) => {
      commands.set(name, opts);
    },
    sendMessage: (msg: Record<string, unknown>) => {
      sent.push(msg);
    },
  };
}

type ToolDeps = Parameters<typeof executeMemoryToolAction>[1];

function toolDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    provider: makeFakeMemoryProvider(),
    manager: new ProviderManager({ backend: "builtin" }),
    currentCwd: "/repo",
    ...overrides,
  };
}

function resultText(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0]!.text);
}

const sessionCtx = (notify: (msg: string, level?: string) => void = () => {}) => ({
  cwd: "/tmp/x",
  sessionManager: { getSessionId: () => "deep-session" },
  ui: { notify },
});

// ============================================================================
// tool.ts — executeMemoryToolAction dispatch layer
// ============================================================================

test("add rejects missing content", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "add" }, deps)).toThrow(/'content' is required for add/);
});

test("add rejects invalid category", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() =>
    executeMemoryToolAction({ action: "add", content: "x", category: "bogus" }, deps),
  ).toThrow(/invalid category 'bogus'/);
});

test("add rejects correction_of pointing at a missing fact", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() =>
    executeMemoryToolAction({ action: "add", content: "x", correction_of: 999 }, deps),
  ).toThrow(/correction_of #999 not found/);
});

test("add rejects correcting another project's fact (ownership gate)", () => {
  makeEnv();
  const deps = toolDeps({
    provider: makeFakeMemoryProvider({ get: () => OTHER_PROJECT_FACT }),
  });
  expect(() =>
    executeMemoryToolAction({ action: "add", content: "x", correction_of: 7 }, deps),
  ).toThrow(/another project/);
});

test("add rejects when onBeforeWrite denies the write", () => {
  makeEnv();
  const deps = toolDeps({
    provider: makeFakeMemoryProvider({
      onBeforeWrite: () => ({ ok: false, reason: "policy says no" }),
    }),
  });
  expect(() => executeMemoryToolAction({ action: "add", content: "x" }, deps))
    .toThrow(/policy says no/);
});

test("add stores the fact, returns id and notifies external providers", () => {
  makeEnv();
  const written: MemoryWriteMetadata[] = [];
  const provider = makeFakeMemoryProvider({
    add: () => 42,
    get: () => ({ ...makeFact(42), content: "prefer bun" }),
  });
  const { calls } = recordCalls(provider);
  const manager = new ProviderManager({ backend: "builtin" });
  manager.registerExternalProvider(
    makeFakeMemoryProvider({ onMemoryWrite: (meta) => written.push(meta) }),
  );
  const deps = toolDeps({ provider, manager });

  const res = executeMemoryToolAction(
    { action: "add", content: "prefer bun", category: "user_pref", tags: "a,b" },
    deps,
  );
  const parsed = resultText(res) as { status: string; fact_id: number; fact: Fact };
  expect(parsed.status).toBe("added");
  expect(parsed.fact_id).toBe(42);
  expect(parsed.fact!.content).toBe("prefer bun");
  // write defaults: no explicit scope → add writes global (isRead=false)
  expect(calls[0]).toMatchObject({
    method: "add",
    args: ["prefer bun", { category: "user_pref", tags: "a,b", scope: undefined, cwd: undefined }],
  });
  expect(written).toHaveLength(1);
  expect(written[0]!.action).toBe("add");
  expect(written[0]!.factId).toBe(42);
  expect(written[0]!.category).toBe("user_pref");
});

test("search rejects missing query", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "search" }, deps))
    .toThrow(/'query' is required for search/);
});

test("search returns results and defaults reads to the current project cwd", () => {
  makeEnv();
  const provider = makeFakeMemoryProvider({ search: () => [makeFact(1)] });
  const { calls } = recordCalls(provider);
  const deps = toolDeps({ provider });
  const parsed = resultText(executeMemoryToolAction({ action: "search", query: "bun" }, deps)) as {
    count: number;
    results: Fact[];
  };
  expect(parsed.count).toBe(1);
  expect(parsed.results[0]!.content).toBe("fact 1");
  // read with no explicit scope → cwdForScope(isRead=true) → currentCwd
  expect(calls[0]).toMatchObject({ method: "search", args: ["bun", { cwd: "/repo" }] });
});

test("probe rejects missing entity", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "probe" }, deps))
    .toThrow(/'entity' is required for probe/);
});

test("probe returns entity-linked facts", () => {
  makeEnv();
  const provider = makeFakeMemoryProvider({ probe: () => [makeFact(2, "project:/repo")] });
  const { calls } = recordCalls(provider);
  const parsed = resultText(executeMemoryToolAction({ action: "probe", entity: "Alice" }, toolDeps({ provider }))) as {
    count: number;
  };
  expect(parsed.count).toBe(1);
  expect(calls[0]!.args[1]).toMatchObject({ cwd: "/repo" });
});

test("list returns facts with global scope dropping the cwd", () => {
  makeEnv();
  const provider = makeFakeMemoryProvider({ list: () => [makeFact(3)] });
  const { calls } = recordCalls(provider);
  const parsed = resultText(
    executeMemoryToolAction({ action: "list", scope: "global" }, toolDeps({ provider })),
  ) as { count: number };
  expect(parsed.count).toBe(1);
  expect(calls[0]!.args[0]).toMatchObject({ scope: "global", cwd: undefined });
});

test("related rejects missing entity", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "related" }, deps))
    .toThrow(/'entity' is required for related/);
});

test("related returns results", () => {
  makeEnv();
  const provider = makeFakeMemoryProvider({ related: () => [makeFact(4) as never] });
  const parsed = resultText(executeMemoryToolAction({ action: "related", entity: "Alice" }, toolDeps({ provider }))) as {
    count: number;
  };
  expect(parsed.count).toBe(1);
});

test("reason rejects missing or empty entities", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "reason" }, deps))
    .toThrow(/'entities' list is required for reason/);
  expect(() => executeMemoryToolAction({ action: "reason", entities: [] }, deps))
    .toThrow(/'entities' list is required for reason/);
});

test("reason returns results", () => {
  makeEnv();
  const provider = makeFakeMemoryProvider({ reason: () => [makeFact(5) as never] });
  const { calls } = recordCalls(provider);
  const parsed = resultText(
    executeMemoryToolAction({ action: "reason", entities: ["Alice", "Auth"] }, toolDeps({ provider })),
  ) as { count: number };
  expect(parsed.count).toBe(1);
  expect(calls[0]!.args[0]).toEqual(["Alice", "Auth"]);
});

test("contradict returns contradictions", () => {
  makeEnv();
  const provider = makeFakeMemoryProvider({ contradict: () => [{}] as never });
  const parsed = resultText(executeMemoryToolAction({ action: "contradict" }, toolDeps({ provider }))) as {
    count: number;
    contradictions: unknown[];
  };
  expect(parsed.count).toBe(1);
  expect(parsed.contradictions).toHaveLength(1);
});

test("update rejects missing fact_id", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "update", content: "x" }, deps))
    .toThrow(/'fact_id' is required for update/);
});

test("update rejects invalid category", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "update", fact_id: 1, category: "bogus" }, deps))
    .toThrow(/invalid category 'bogus'/);
});

test("update rejects cross-project ownership", () => {
  makeEnv();
  const deps = toolDeps({ provider: makeFakeMemoryProvider({ get: () => OTHER_PROJECT_FACT }) });
  expect(() => executeMemoryToolAction({ action: "update", fact_id: 7, content: "x" }, deps))
    .toThrow(/another project/);
});

test("update rejects when onBeforeWrite denies", () => {
  makeEnv();
  const deps = toolDeps({
    provider: makeFakeMemoryProvider({
      get: () => makeFact(1),
      onBeforeWrite: () => ({ ok: false, reason: "no updates today" }),
    }),
  });
  expect(() => executeMemoryToolAction({ action: "update", fact_id: 1, content: "x" }, deps))
    .toThrow(/no updates today/);
});

test("update reports not_found when the provider cannot update", () => {
  makeEnv();
  const deps = toolDeps({ provider: makeFakeMemoryProvider({ update: () => false }) });
  const parsed = resultText(executeMemoryToolAction({ action: "update", fact_id: 1, content: "x" }, deps)) as {
    status: string;
  };
  expect(parsed.status).toBe("not_found");
});

test("update applies changes and reports updated", () => {
  makeEnv();
  const written: MemoryWriteMetadata[] = [];
  const provider = makeFakeMemoryProvider({
    get: () => makeFact(1, "project:/repo", "old content"),
    update: () => true,
  });
  const { calls } = recordCalls(provider);
  const manager = new ProviderManager({ backend: "builtin" });
  manager.registerExternalProvider(makeFakeMemoryProvider({ onMemoryWrite: (m) => written.push(m) }));
  const parsed = resultText(
    executeMemoryToolAction({ action: "update", fact_id: 1, content: "new content", tags: "t" }, toolDeps({ provider, manager })),
  ) as { status: string; fact_id: number };
  expect(parsed).toEqual({ status: "updated", fact_id: 1 });
  expect(calls[0]!.args[1]).toMatchObject({ content: "new content", tags: "t" });
  expect(written[0]!.action).toBe("update");
  expect(written[0]!.previousContent).toBe("old content");
});

test("remove rejects missing fact_id", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "remove" }, deps))
    .toThrow(/'fact_id' is required for remove/);
});

test("remove rejects cross-project ownership", () => {
  makeEnv();
  const deps = toolDeps({ provider: makeFakeMemoryProvider({ get: () => OTHER_PROJECT_FACT }) });
  expect(() => executeMemoryToolAction({ action: "remove", fact_id: 7 }, deps))
    .toThrow(/another project/);
});

test("remove rejects when onBeforeWrite denies", () => {
  makeEnv();
  const deps = toolDeps({
    provider: makeFakeMemoryProvider({
      get: () => makeFact(1),
      onBeforeWrite: () => ({ ok: false, reason: "keep it" }),
    }),
  });
  expect(() => executeMemoryToolAction({ action: "remove", fact_id: 1 }, deps)).toThrow(/keep it/);
});

test("remove reports not_found when the provider cannot remove", () => {
  makeEnv();
  const deps = toolDeps({ provider: makeFakeMemoryProvider({ remove: () => false }) });
  const parsed = resultText(executeMemoryToolAction({ action: "remove", fact_id: 1 }, deps)) as {
    status: string;
  };
  expect(parsed.status).toBe("not_found");
});

test("remove deletes the fact and reports removed", () => {
  makeEnv();
  const provider = makeFakeMemoryProvider({ get: () => makeFact(1), remove: () => true });
  const { calls } = recordCalls(provider);
  const parsed = resultText(executeMemoryToolAction({ action: "remove", fact_id: 1 }, toolDeps({ provider }))) as {
    status: string;
    fact_id: number;
  };
  expect(parsed).toEqual({ status: "removed", fact_id: 1 });
  expect(calls[0]!.method).toBe("remove");
});

test("feedback rejects missing fact_id", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "feedback", helpful: true }, deps))
    .toThrow(/'fact_id' is required for feedback/);
});

test("feedback rejects missing helpful flag", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "feedback", fact_id: 1 }, deps))
    .toThrow(/'helpful' is required for feedback/);
});

test("feedback rejects cross-project ownership", () => {
  makeEnv();
  const deps = toolDeps({ provider: makeFakeMemoryProvider({ get: () => OTHER_PROJECT_FACT }) });
  expect(() => executeMemoryToolAction({ action: "feedback", fact_id: 7, helpful: true }, deps))
    .toThrow(/another project/);
});

test("feedback reports not_found for unknown facts", () => {
  makeEnv();
  const deps = toolDeps({ provider: makeFakeMemoryProvider({ feedback: () => null }) });
  const parsed = resultText(executeMemoryToolAction({ action: "feedback", fact_id: 1, helpful: true }, deps)) as {
    status: string;
    fact_id: number;
  };
  expect(parsed).toEqual({ status: "not_found", fact_id: 1 });
});

test("feedback applies the helpful flag and returns the fact", () => {
  makeEnv();
  const provider = makeFakeMemoryProvider({
    get: () => makeFact(1),
    feedback: (_id, helpful) => ({ ...makeFact(1), trust_score: helpful ? 0.55 : 0.45 }),
  });
  const { calls } = recordCalls(provider);
  const parsed = resultText(
    executeMemoryToolAction({ action: "feedback", fact_id: 1, helpful: false }, toolDeps({ provider })),
  ) as { status: string; fact: Fact };
  expect(parsed.status).toBe("ok");
  expect(parsed.fact!.trust_score).toBe(0.45);
  expect(calls[0]!.args).toEqual([1, false]);
});

test("note_add requires a curated store", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "note_add", content: "x" }, deps))
    .toThrow(/curated memory is not available/);
});

test("note_add requires content", () => {
  const env = makeEnv();
  const curated = new CuratedMemoryStore({ dir: join(env.home, "memories") });
  curated.loadFromDisk();
  const deps = toolDeps({ curated });
  expect(() => executeMemoryToolAction({ action: "note_add" }, deps))
    .toThrow(/'content' is required for note_add/);
});

test("note_add rejects task directives", () => {
  const env = makeEnv();
  const curated = new CuratedMemoryStore({ dir: join(env.home, "memories") });
  curated.loadFromDisk();
  const deps = toolDeps({ curated });
  expect(() =>
    executeMemoryToolAction(
      { action: "note_add", content: "请为 demo-app 新增一个 todo stats 子命令，注意先看现有代码" },
      deps,
    ),
  ).toThrow(/note_add 拒绝/);
  expect(curated.list("memory").memory).toHaveLength(0);
});

test("note_add stores a curated note", () => {
  const env = makeEnv();
  const curated = new CuratedMemoryStore({ dir: join(env.home, "memories") });
  curated.loadFromDisk();
  const parsed = resultText(
    executeMemoryToolAction(
      { action: "note_add", target: "user", content: "prefers terse output" },
      toolDeps({ curated }),
    ),
  ) as { success: boolean };
  expect(parsed.success).toBe(true);
  expect(curated.list("user").user).toContain("prefers terse output");
});

test("note_list requires a curated store", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "note_list" }, deps))
    .toThrow(/curated memory is not available/);
});

test("note_list without a target lists both targets", () => {
  const env = makeEnv();
  const curated = new CuratedMemoryStore({ dir: join(env.home, "memories") });
  curated.loadFromDisk();
  curated.add("memory", "note a");
  curated.add("user", "note b");
  const parsed = resultText(executeMemoryToolAction({ action: "note_list" }, toolDeps({ curated }))) as {
    target: string;
    count: number;
  };
  expect(parsed.target).toBe("all");
  expect(parsed.count).toBe(2);
});

test("note_list with an explicit target filters", () => {
  const env = makeEnv();
  const curated = new CuratedMemoryStore({ dir: join(env.home, "memories") });
  curated.loadFromDisk();
  curated.add("memory", "note a");
  curated.add("user", "note b");
  const parsed = resultText(
    executeMemoryToolAction({ action: "note_list", target: "memory" }, toolDeps({ curated })),
  ) as { target: string; entries: Record<string, string[]>; count: number };
  expect(parsed.target).toBe("memory");
  expect(parsed.entries.user).toHaveLength(0);
  expect(parsed.entries.memory).toEqual(["note a"]);
  expect(parsed.count).toBe(1);
});

test("note_replace requires a curated store", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "note_replace", content: "x" }, deps))
    .toThrow(/curated memory is not available/);
});

test("note_replace requires content", () => {
  const env = makeEnv();
  const curated = new CuratedMemoryStore({ dir: join(env.home, "memories") });
  curated.loadFromDisk();
  const deps = toolDeps({ curated });
  expect(() => executeMemoryToolAction({ action: "note_replace", old_text: "a" }, deps))
    .toThrow(/'content' is required for note_replace/);
});

test("note_replace requires old_text", () => {
  const env = makeEnv();
  const curated = new CuratedMemoryStore({ dir: join(env.home, "memories") });
  curated.loadFromDisk();
  const deps = toolDeps({ curated });
  expect(() => executeMemoryToolAction({ action: "note_replace", content: "new" }, deps))
    .toThrow(/'old_text' is required for note_replace/);
});

test("note_replace replaces a matching entry", () => {
  const env = makeEnv();
  const curated = new CuratedMemoryStore({ dir: join(env.home, "memories") });
  curated.loadFromDisk();
  curated.add("memory", "original entry");
  const parsed = resultText(
    executeMemoryToolAction(
      { action: "note_replace", old_text: "original", content: "replaced entry" },
      toolDeps({ curated }),
    ),
  ) as { success: boolean };
  expect(parsed.success).toBe(true);
  expect(curated.list("memory").memory).toEqual(["replaced entry"]);
});

test("note_remove requires a curated store", () => {
  makeEnv();
  const deps = toolDeps();
  expect(() => executeMemoryToolAction({ action: "note_remove" }, deps))
    .toThrow(/curated memory is not available/);
});

test("note_remove requires old_text", () => {
  const env = makeEnv();
  const curated = new CuratedMemoryStore({ dir: join(env.home, "memories") });
  curated.loadFromDisk();
  const deps = toolDeps({ curated });
  expect(() => executeMemoryToolAction({ action: "note_remove" }, deps))
    .toThrow(/'old_text' is required for note_remove/);
});

test("note_remove removes a matching entry", () => {
  const env = makeEnv();
  const curated = new CuratedMemoryStore({ dir: join(env.home, "memories") });
  curated.loadFromDisk();
  curated.add("memory", "entry to drop");
  const parsed = resultText(
    executeMemoryToolAction({ action: "note_remove", old_text: "to drop" }, toolDeps({ curated })),
  ) as { success: boolean };
  expect(parsed.success).toBe(true);
  expect(curated.list("memory").memory).toHaveLength(0);
});

test("provider exceptions surface as tool errors instead of crashing", () => {
  makeEnv();
  const deps = toolDeps({
    provider: makeFakeMemoryProvider({
      add: () => {
        throw new Error("db is on fire");
      },
    }),
  });
  expect(() => executeMemoryToolAction({ action: "add", content: "x" }, deps))
    .toThrow(/db is on fire/);
});

test("cwdForScope: explicit project scope uses the session cwd", () => {
  makeEnv();
  const provider = makeFakeMemoryProvider({ search: () => [] });
  const { calls } = recordCalls(provider);
  executeMemoryToolAction(
    { action: "search", query: "x", scope: "project" },
    toolDeps({ provider, currentCwd: "/repo" }),
  );
  expect(calls[0]!.args[1]).toMatchObject({ scope: "project", cwd: "/repo" });
});

test("cwdForScope: global scope drops the cwd even for reads", () => {
  makeEnv();
  const provider = makeFakeMemoryProvider({ search: () => [] });
  const { calls } = recordCalls(provider);
  executeMemoryToolAction(
    { action: "search", query: "x", scope: "global" },
    toolDeps({ provider, currentCwd: "/repo" }),
  );
  expect(calls[0]!.args[1]).toMatchObject({ scope: "global", cwd: undefined });
});

test("real builtin provider round-trips add → search → update → remove through the dispatch layer", () => {
  makeEnv();
  const provider = new BuiltinMemoryProvider(":memory:");
  try {
    const deps = toolDeps({ provider, currentCwd: "/proj/x" });

    const added = resultText(
      executeMemoryToolAction(
        { action: "add", content: 'the "Bun" runtime is preferred for builds', scope: "project" },
        deps,
      ),
    ) as { status: string; fact_id: number };
    expect(added.status).toBe("added");

    const searched = resultText(
      executeMemoryToolAction({ action: "search", query: "Bun", scope: "project" }, deps),
    ) as { count: number; results: Fact[] };
    expect(searched.count).toBe(1);
    expect(searched.results[0]!.fact_id).toBe(added.fact_id);

    const probed = resultText(
      executeMemoryToolAction({ action: "probe", entity: "Bun", scope: "project" }, deps),
    ) as { count: number };
    expect(probed.count).toBeGreaterThanOrEqual(1);

    const updated = resultText(
      executeMemoryToolAction({ action: "update", fact_id: added.fact_id, content: "the project uses bun for scripts" }, deps),
    ) as { status: string };
    expect(updated.status).toBe("updated");

    const removed = resultText(
      executeMemoryToolAction({ action: "remove", fact_id: added.fact_id }, deps),
    ) as { status: string };
    expect(removed.status).toBe("removed");
  } finally {
    provider.shutdown();
  }
});

// ============================================================================
// index.ts — memoryExtension event handlers
// ============================================================================

test("session_start surfaces a corrupt-DB recovery notice exactly once", async () => {
  const env = makeEnv();
  // Corrupt the DB before the factory runs: the provider must rebuild the
  // store and remember a recovery notice.
  writeFileSync(env.db, "this is not a sqlite database at all");

  const notices: Array<{ msg: string; level?: string }> = [];
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);

  const notify = (msg: string, level?: string) => notices.push({ msg, level });
  const ctx = sessionCtx(notify);
  await pi.handlers["session_start"]![0]!({}, ctx);
  await pi.handlers["session_start"]![0]!({}, ctx);

  expect(notices).toHaveLength(1);
  expect(notices[0]!.msg).toContain("[memory]");
  expect(notices[0]!.msg).toContain("corrupt");
  expect(notices[0]!.level).toBe("warning");

  // The rebuilt store is fully usable.
  const raw = new MemoryStore(env.db);
  raw.add("fresh start", { category: "general" });
  expect(raw.count()).toBe(1);
  raw.close();

  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});
});

test("session_start and agent_end keep running when the curated dir cannot be created", async () => {
  const env = makeEnv();
  // Point PICO_HOME at a regular FILE: curated.loadFromDisk() (mkdir) throws,
  // and so does every curated write. The extension must swallow both.
  const homeFile = join(env.home, "home-as-file");
  writeFileSync(homeFile, "");
  process.env.PICO_HOME = homeFile;

  const pi = makeDeepFakePi();
  memoryExtension(pi as any);

  await pi.handlers["session_start"]![0]!({}, sessionCtx());
  // before_agent_start still works off the builtin store.
  const result = await pi.handlers["before_agent_start"]![0]!(
    { prompt: "hi", systemPrompt: "BASE" },
    { cwd: "/tmp/x" },
  );
  expect(result.systemPrompt).toContain("## Long-term memory");

  // agent_end: the curated.autoExtract write explodes inside → handler must
  // not throw (best-effort contract).
  expect(() =>
    pi.handlers["agent_end"]![0]!(
      { messages: [{ role: "user", content: "I prefer using bun for scripts" }] },
      { cwd: "/tmp/x" },
    ),
  ).not.toThrow();

  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});
});

test("session_before_switch reloads curated notes from disk; fork does not throw", async () => {
  const env = makeEnv();
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);
  await pi.handlers["session_start"]![0]!({}, sessionCtx());

  // An external writer lands a note; the switch must re-read it into the
  // prompt snapshot.
  const memoriesDir = join(env.home, "memories");
  mkdirSync(memoriesDir, { recursive: true });
  writeFileSync(join(memoriesDir, "MEMORY.md"), "we decided to always run bun run verify");

  await pi.handlers["session_before_switch"]![0]!({}, {});
  const result = await pi.handlers["before_agent_start"]![0]!(
    { prompt: "x", systemPrompt: "BASE" },
    { cwd: "/tmp/x" },
  );
  expect(result.systemPrompt).toContain("we decided to always run bun run verify");

  expect(() => pi.handlers["session_before_fork"]![0]!({}, {})).not.toThrow();
  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});
});

test("before_agent_start falls back to {} when the provider explodes", async () => {
  const env = makeEnv();
  mkdirSync(join(env.home, "agent"), { recursive: true });
  writeFileSync(
    join(env.home, "agent", "settings.json"),
    JSON.stringify({ memory: { backend: "deep-boom" } }),
  );
  registerMemoryProviderFactory(
    "deep-boom",
    () =>
      makeFakeMemoryProvider({
        count: () => {
          throw new Error("count boom");
        },
        add: () => {
          throw new Error("add boom");
        },
      }),
  );

  const pi = makeDeepFakePi();
  memoryExtension(pi as any);
  await pi.handlers["session_start"]![0]!({}, sessionCtx());

  // cachedFactCount → manager.count() → provider.count() throws → catch.
  const result = await pi.handlers["before_agent_start"]![0]!(
    { prompt: "hi", systemPrompt: "BASE" },
    { cwd: "/tmp/x" },
  );
  expect(result).toEqual({});

  // turn_end: manager.add throws on the correction path → caught.
  expect(() =>
    pi.handlers["turn_end"]![0]!(
      { message: { role: "user", content: "Actually, I want the dark theme instead." } },
      {},
    ),
  ).not.toThrow();

  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});
});

test("turn_end stores strong corrections, skips short/assistant messages and never throws", async () => {
  const env = makeEnv();
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);
  await pi.handlers["session_start"]![0]!({}, sessionCtx());

  // Correction → stored with the 0.7 boost, project-scoped to the session cwd.
  pi.handlers["turn_end"]![0]!(
    { message: { role: "user", content: "Actually, I want the dark theme instead." } },
    {},
  );
  // Second correction, different content.
  pi.handlers["turn_end"]![0]!(
    { message: { role: "user", content: "Actually, I want the light theme instead." } },
    {},
  );
  // Too short → skipped before the correction gate.
  pi.handlers["turn_end"]![0]!({ message: { role: "user", content: "abc" } }, {});
  // Assistant role → skipped.
  pi.handlers["turn_end"]![0]!(
    { message: { role: "assistant", content: "Actually, I want the dark theme instead." } },
    {},
  );
  // ≥4 chars but not a correction → no fact, but queuePrefetch must not throw.
  pi.handlers["turn_end"]![0]!({ message: { role: "user", content: "short" } }, {});

  const raw = new MemoryStore(env.db);
  const corrections = raw.db
    .query<{ content: string; trust_score: number; scope: string }, []>(
      "SELECT content, trust_score, scope FROM facts WHERE category = 'correction'",
    )
    .all();
  expect(corrections).toHaveLength(2);
  const contents = corrections.map((c) => c.content).sort();
  expect(contents).toEqual([
    "Actually, I want the dark theme instead.",
    "Actually, I want the light theme instead.",
  ]);
  for (const c of corrections) {
    expect(c.trust_score).toBeCloseTo(0.7, 5);
    expect(c.scope).toBe("project:/tmp/x");
  }
  raw.close();

  // Drain the background prefetch queue without throwing.
  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});
});

test("consolidation retry cap persists across turn_end and resets at agent_start", async () => {
  const env = makeEnv();
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);
  await pi.handlers["session_start"]![0]!({}, sessionCtx());

  const tool = pi.tools.get("memory")!;
  const noteAdd = async (content: string): Promise<{ done?: boolean }> => {
    const res = await tool.execute(
      "id",
      { action: "note_add", content },
      new AbortController().signal,
      () => {},
      { cwd: "/tmp/x", sessionManager: { getSessionId: () => "deep-session" } },
    );
    return JSON.parse(res.content[0]!.text) as { done?: boolean };
  };

  // Fill the 2200-char memory budget with five ~400-char entries.
  for (let i = 1; i <= 5; i++) {
    const ok = await noteAdd(`entry ${i} ${"x".repeat(390)}`);
    expect(ok.done).toBeUndefined();
  }
  // Each subsequent add is ~400 chars and cannot fit: failures 1..3 carry no
  // done flag…
  const over = (n: number) => `still over capacity ${n} ${"x".repeat(370)}`;
  expect((await noteAdd(over(1))).done).toBeUndefined();
  expect((await noteAdd(over(2))).done).toBeUndefined();
  expect((await noteAdd(over(3))).done).toBeUndefined();
  // …failure 4 trips the cap.
  expect((await noteAdd(over(4))).done).toBe(true);

  // A turn_end (the upstream agent loop emits one after EVERY assistant
  // message, including tool-call batches) must NOT reset the counter — the
  // cap is per user turn, so the 5th failure still terminates.
  pi.handlers["turn_end"]![0]!({ message: { role: "assistant", content: "ok" } }, {});
  expect((await noteAdd(over(5))).done).toBe(true);

  // agent_start fires once per user turn and resets the budget.
  pi.handlers["agent_start"]![0]!({}, {});
  expect((await noteAdd(over(6))).done).toBeUndefined();

  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});
});

test("agent_end fingerprints messages so duplicates are never re-extracted", async () => {
  const env = makeEnv();
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);
  await pi.handlers["session_start"]![0]!({}, sessionCtx());

  const agentEnd = (messages: unknown[]) =>
    pi.handlers["agent_end"]![0]!({ messages }, { cwd: "/tmp/x" });

  const msg1 = { role: "user", content: "I prefer using bun for scripts" };
  agentEnd([msg1]);
  agentEnd([msg1]); // identical → fingerprint skip
  agentEnd([{ role: "user", content: "we decided to use bun as the package manager" }]);

  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});

  const raw = new MemoryStore(env.db);
  // The summary and the auto-extracted facts are project-scoped (session cwd).
  const facts = raw.list({ minTrust: 0, limit: 50, scope: "project", cwd: "/tmp/x" });
  // 2 auto-extracted facts + 1 session summary; the summary's "(+1 more)"
  // proves msg1 entered the session buffer exactly once.
  expect(facts.length).toBe(3);
  const summary = facts.find((f) => f.content.startsWith("Session:"));
  expect(summary).toBeDefined();
  expect(summary!.content).toBe("Session: I prefer using bun for scripts (+1 more)");
  raw.close();
});

test("agent_end caps the session message buffer at 200", async () => {
  const env = makeEnv();
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);
  await pi.handlers["session_start"]![0]!({}, sessionCtx());

  for (let i = 1; i <= 205; i++) {
    pi.handlers["agent_end"]![0]!(
      { messages: [{ role: "user", content: `I prefer option ${i}` }] },
      { cwd: "/tmp/x" },
    );
  }

  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});

  const raw = new MemoryStore(env.db);
  const summary = raw
    .list({ minTrust: 0, limit: 300, scope: "project", cwd: "/tmp/x" })
    .find((f) => f.content.startsWith("Session:"));
  expect(summary).toBeDefined();
  // 205 messages in, only the LAST 200 survive the splice → the first five
  // options are gone and the topic is option 6 with "(+199 more)".
  expect(summary!.content).toBe("Session: I prefer option 6 (+199 more)");
  raw.close();
});

test("session_before_compact with no branch entries contributes nothing", async () => {
  const env = makeEnv();
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);
  await pi.handlers["session_start"]![0]!({}, sessionCtx());

  const result = await pi.handlers["session_before_compact"]![0]!({});
  expect(result).toEqual({});
  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});
});

test("session_before_compact archives session entries into memory before discard", async () => {
  const env = makeEnv();
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);
  await pi.handlers["session_start"]![0]!({}, sessionCtx());

  // branchEntries are SESSION entries ({type:'message', message:{role,
  // content}}) — the handler must unwrap them into plain messages for
  // onPreCompress, otherwise the role filter matches nothing (D2-M3).
  const branchEntries = [
    { type: "message", message: { role: "user", content: "we agreed to use bun for scripts" } },
    { type: "message", message: { role: "assistant", content: "sounds good" } },
    { type: "custom", message: { role: "user", content: "not a message entry — ignored" } },
  ];
  const result = await pi.handlers["session_before_compact"]![0]!({
    branchEntries,
    preparation: { firstKeptEntryId: "entry-9", tokensBefore: 12345 },
  });

  expect(result).toMatchObject({
    compaction: {
      summary: expect.stringContaining("[memory] 1 user message"),
      firstKeptEntryId: "entry-9",
      tokensBefore: 12345,
    },
  });

  const raw = new MemoryStore(env.db);
  const archived = raw
    .list({ minTrust: 0, limit: 50, scope: "project", cwd: "/tmp/x" })
    .find((f) => f.content.includes("bun for scripts"));
  expect(archived).toBeDefined();
  expect(archived!.scope).toContain("project:");
  raw.close();

  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});
});

test("turn_end automatic corrections link correction_of and dock the original's trust", async () => {
  const env = makeEnv();
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);
  await pi.handlers["session_start"]![0]!({}, sessionCtx());

  // Session A wrote a project fact; session B corrects it without the model
  // touching the memory tool — the automatic correction path must link to the
  // original (correction_of) and dock its trust, like the explicit path.
  const tool = pi.tools.get("memory")!;
  await tool.execute(
    "id",
    { action: "add", content: "团队使用 PostgreSQL 15 作为数据库", scope: "project" },
    new AbortController().signal,
    () => {},
    { cwd: "/tmp/x", sessionManager: { getSessionId: () => "deep-session" } },
  );

  pi.handlers["turn_end"]![0]!({ message: { role: "user", content: "错了，其实是 MySQL，不是 PostgreSQL。" } }, {});

  const raw = new MemoryStore(env.db);
  const facts = raw.list({ minTrust: 0, limit: 50, scope: "project", cwd: "/tmp/x" });
  const original = facts.find((f) => f.content.includes("PostgreSQL 15"));
  const correction = facts.find((f) => f.category === "correction");
  expect(original).toBeDefined();
  expect(correction).toBeDefined();
  expect(correction!.correction_of).toBe(original!.fact_id);
  expect(correction!.trust_score).toBeCloseTo(0.7, 5);
  expect(raw.get(original!.fact_id)!.trust_score).toBeCloseTo(0.5 - 0.3, 5);
  raw.close();

  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});
});

test("session_shutdown with reload reason clears session-scoped subscriptions", async () => {
  const env = makeEnv();
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);

  const spy = { called: 0 };
  subscribeSessionExtensionEvent("subagent_completed", () => {
    spy.called++;
  });
  publishExtensionEvent("subagent_completed", { task: "t", result: "r" });
  expect(spy.called).toBe(1);

  await pi.handlers["session_shutdown"]![0]!({ reason: "reload" }, {});
  publishExtensionEvent("subagent_completed", { task: "t2", result: "r2" });
  publishExtensionEvent("subagent_completed", { task: "t3", result: "r3" });
  expect(spy.called).toBe(1);
  expect(env.home).toBeDefined();
});

test("session_shutdown with quit reason closes the store for good", async () => {
  const env = makeEnv();
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);
  await pi.handlers["session_start"]![0]!({}, sessionCtx());

  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});

  // The store is closed: count() throws → before_agent_start lands in its
  // catch and returns {} instead of the memory header.
  const result = await pi.handlers["before_agent_start"]![0]!(
    { prompt: "x", systemPrompt: "BASE" },
    { cwd: "/tmp/x" },
  );
  expect(result).toEqual({});

  // The on-disk data itself survives.
  const raw = new MemoryStore(env.db);
  expect(raw.count()).toBe(0);
  raw.close();
});

test("session_shutdown with a non-quit reason keeps the store alive", async () => {
  const env = makeEnv();
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);
  await pi.handlers["session_start"]![0]!({}, sessionCtx());

  await pi.handlers["session_shutdown"]![0]!({ reason: "resume" }, {});
  // flushPending(closeQueue: false) + shutdown(false): the store stays usable
  // for the next session in this process.
  const result = await pi.handlers["before_agent_start"]![0]!(
    { prompt: "x", systemPrompt: "BASE" },
    { cwd: "/tmp/x" },
  );
  expect(result.systemPrompt).toContain("## Long-term memory");

  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});
});

test("external memory provider backend registers its own tools", async () => {
  const env = makeEnv();
  mkdirSync(join(env.home, "agent"), { recursive: true });
  writeFileSync(
    join(env.home, "agent", "settings.json"),
    JSON.stringify({ memory: { backend: "deep-ext-provider" } }),
  );
  registerMemoryProviderFactory(
    "deep-ext-provider",
    () =>
      makeFakeMemoryProvider({
        systemPromptBlock: () => "",
        getToolSchemas: () => [
          {
            name: "deep_probe",
            description: "external entity probe",
            parameters: { type: "object", properties: {} },
          },
        ],
        handleToolCall: (name, args) => JSON.stringify({ handled: name, args }),
      }),
  );

  const pi = makeDeepFakePi();
  memoryExtension(pi as any);

  // Built-in tool + the external provider's schema tool both registered.
  expect(pi.tools.has("memory")).toBe(true);
  const extTool = pi.tools.get("deep_probe");
  expect(extTool).toBeDefined();

  // The external tool routes through manager.handleToolCall.
  const res = await extTool.execute(
    "id",
    { entity: "Alice" },
    new AbortController().signal,
    () => {},
    { cwd: "/tmp/x", sessionManager: { getSessionId: () => "deep-session" } },
  );
  expect(JSON.parse(res.content[0]!.text)).toMatchObject({
    handled: "deep_probe",
    args: { entity: "Alice" },
  });

  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});
});

test("memory tool execute wires the dispatch layer end-to-end", async () => {
  const env = makeEnv();
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);

  const tool = pi.tools.get("memory");
  expect(tool).toBeDefined();
  const res = await tool.execute(
    "mem-1",
    { action: "add", content: "deep e2e fact" },
    new AbortController().signal,
    () => {},
    { cwd: "/tmp/x", sessionManager: { getSessionId: () => "deep-session" } },
  );
  expect((JSON.parse(res.content[0]!.text) as { status: string }).status).toBe("added");

  const raw = new MemoryStore(env.db);
  expect(raw.search("deep e2e", { minTrust: 0 })).toHaveLength(1);
  raw.close();

  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});
});

test("/memory command handler surfaces a pico.memory custom message", async () => {
  const env = makeEnv();
  const pi = makeDeepFakePi();
  memoryExtension(pi as any);
  await pi.handlers["session_start"]![0]!({}, sessionCtx());

  const cmd = pi.commands.get("memory");
  expect(cmd).toBeDefined();
  await cmd.handler("list", {
    cwd: "/tmp/x",
    ui: { notify: () => {}, confirm: async () => true },
  });

  expect(pi.sent).toHaveLength(1);
  expect(pi.sent[0]!.customType).toBe("pico.memory");
  expect(pi.sent[0]!.display).toBe(true);
  expect(String(pi.sent[0]!.content)).toContain("Memory — 0 facts");

  await pi.handlers["session_shutdown"]![0]!({ reason: "quit" }, {});
});

test("memory.retrievalFrequencyWeight setting flows to the builtin store", () => {
  const env = makeEnv();
  try {
    mkdirSync(join(env.home, "agent"), { recursive: true });
    writeFileSync(
      join(env.home, "agent", "settings.json"),
      JSON.stringify({ memory: { retrievalFrequencyWeight: 0.2 } }),
    );
    const manager = new ProviderManager({ backend: "builtin" });
    const provider = manager.provider as BuiltinMemoryProvider;
    expect((provider.getRawStore() as MemoryStore).retrievalFrequencyWeight).toBe(0.2);
  } finally {
    env.restore();
  }
});

test("builtin store defaults retrieval-frequency weight to 0.05", () => {
  const env = makeEnv();
  try {
    mkdirSync(join(env.home, "agent"), { recursive: true });
    // No memory section: the factory falls back to the store default.
    writeFileSync(join(env.home, "agent", "settings.json"), JSON.stringify({}));
    const manager = new ProviderManager({ backend: "builtin" });
    const provider = manager.provider as BuiltinMemoryProvider;
    expect((provider.getRawStore() as MemoryStore).retrievalFrequencyWeight).toBe(0.05);
  } finally {
    env.restore();
  }
});
