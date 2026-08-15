/**
 * Deep coverage for the undo-redo extension: diff-stack formatting/selection,
 * the buffered sandbox tool execution chain, and the command/tool/event
 * branches of index.ts that need a real initialized sandbox.
 *
 * Env isolation: PICO_HOME is redirected to a temp dir; every project file is
 * written under a fresh mkdtemp project root.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCache, hashBuffer } from "../src/extensions/undo-redo/cache.ts";
import {
  formatDiffText,
  listDiffItems,
  showDiffStack,
} from "../src/extensions/undo-redo/diff-stack.ts";
import undoRedoExtension from "../src/extensions/undo-redo/index.ts";
import { SandboxState } from "../src/extensions/undo-redo/sandbox.ts";
import { createBufferedToolSet } from "../src/extensions/undo-redo/tools.ts";
import { SnapshotTracker } from "../src/extensions/undo-redo/tracker.ts";

const ORIG_PICO_HOME = process.env.PICO_HOME;
let testHome: string;
let projDir: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "pico-undo-deep-home-"));
  projDir = mkdtempSync(join(tmpdir(), "pico-undo-deep-proj-"));
  process.env.PICO_HOME = testHome;
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  if (ORIG_PICO_HOME === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = ORIG_PICO_HOME;
});

// ════ diff-stack.ts: formatDiffText / generateDiffString ─────────────────

describe("formatDiffText — generateDiffString context handling", () => {
  async function diffViaBlobs(base: string, leaf: string): Promise<string> {
    const cache = createCache("session-b");
    await cache.ensure();
    const hBase = hashBuffer(Buffer.from(base));
    const hLeaf = hashBuffer(Buffer.from(leaf));
    await cache.writeBlob(hBase, Buffer.from(base));
    await cache.writeBlob(hLeaf, Buffer.from(leaf));
    return formatDiffText(
      cache,
      { exists: true, hash: hBase },
      { exists: true, hash: hLeaf },
    );
  }

  test("long unchanged head before a change is elided with a leading ellipsis", async () => {
    const base = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\nX\n";
    const leaf = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\nY\n";
    const diff = await diffViaBlobs(base, leaf);
    // skipStart = 10 - 4 = 6 → ellipsis, then lines 7..10 as context.
    expect(diff).toBe(
      "    ...\n  7 7\n  8 8\n  9 9\n 10 10\n-11 X\n+11 Y",
    );
  });

  test("long unchanged tail after a change is elided with a trailing ellipsis", async () => {
    const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o"];
    const base = `${lines.join("\n")}\n`;
    const leaf = base.replace("a\n", "A\n");
    const diff = await diffViaBlobs(base, leaf);
    // First-line change: - 1/+ 1 (padded to width 2), then 4 context lines
    // + trailing ellipsis.
    expect(diff).toBe("- 1 a\n+ 1 A\n  2 b\n  3 c\n  4 d\n  5 e\n    ...");
  });

  test("middle unchanged block longer than context between two changes is fully shown", async () => {
    const base = [
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "X",
      "11", "12", "13", "14", "15", "16", "17", "18", "19", "X2",
      "21", "22", "23", "24", "25", "26", "27", "28", "29", "30",
    ].join("\n") + "\n";
    const leaf = base.replace("\nX\n", "\nY\n").replace("\nX2\n", "\nY2\n");
    const diff = await diffViaBlobs(base, leaf);
    expect(diff).toBe(
      "    ...\n  6 6\n  7 7\n  8 8\n  9 9\n" +
        "-10 X\n+10 Y\n" +
        " 11 11\n 12 12\n 13 13\n 14 14\n 15 15\n 16 16\n 17 17\n 18 18\n 19 19\n" +
        "-20 X2\n+20 Y2\n" +
        " 21 21\n 22 22\n 23 23\n 24 24\n    ...",
    );
  });
});

describe("formatDiffText — presence/binary branches", () => {
  async function makeCache() {
    const cache = createCache("session-b2");
    await cache.ensure();
    return cache;
  }

  test("neither entry exists → No changes recorded", async () => {
    const cache = await makeCache();
    expect(await formatDiffText(cache, undefined, undefined)).toBe(
      "No changes recorded.",
    );
  });

  test("binary file added / deleted / modified", async () => {
    const cache = await makeCache();
    expect(
      await formatDiffText(
        cache,
        undefined,
        { exists: true, hash: "x", binary: true },
      ),
    ).toBe("Binary file added.");
    expect(
      await formatDiffText(
        cache,
        { exists: true, hash: "x", binary: true },
        { exists: false },
      ),
    ).toBe("Binary file deleted.");
    expect(
      await formatDiffText(
        cache,
        { exists: true, hash: "x", binary: true },
        { exists: true, hash: "y", binary: true },
      ),
    ).toBe("Binary file modified.");
  });

  test("identical content produces an empty diff → No changes recorded", async () => {
    const cache = await makeCache();
    const h = hashBuffer(Buffer.from("same"));
    await cache.writeBlob(h, Buffer.from("same"));
    expect(
      await formatDiffText(cache, { exists: true, hash: h }, { exists: true, hash: h }),
    ).toBe("No changes recorded.");
  });

  test("deleted text file diffs against empty content", async () => {
    const cache = await makeCache();
    const h = hashBuffer(Buffer.from("old lines"));
    await cache.writeBlob(h, Buffer.from("old lines"));
    const diff = await formatDiffText(
      cache,
      { exists: true, hash: h },
      { exists: false },
    );
    expect(diff).toContain("-1 old lines");
  });
});

describe("listDiffItems — cross-leaf aggregation", () => {
  test("aggregates A/M/D across two leaves and skips corrupt manifests", async () => {
    const cache = createCache("session-b3");
    await cache.ensure();
    const hA = hashBuffer(Buffer.from("base"));
    const hB = hashBuffer(Buffer.from("changed"));
    await cache.writeBlob(hA, Buffer.from("base"));
    await cache.writeBlob(hB, Buffer.from("changed"));
    await cache.writeBase(
      new Map([
        ["a.txt", { exists: true, hash: hA }],
        ["b.txt", { exists: true, hash: hA }],
      ]),
    );
    const tracker = new SnapshotTracker(cache, projDir, join(testHome, "sb"), () => {});
    await tracker.loadBase();
    await cache.writeLeaf(
      "leaf-1",
      new Map([
        ["a.txt", { exists: true, hash: hB }],
        ["c.txt", { exists: true, hash: hA }],
      ]),
    );
    await cache.writeLeaf(
      "leaf-2",
      new Map([
        ["b.txt", { exists: false }],
        ["d.txt", { exists: true, hash: hA }],
      ]),
    );
    // A leaf manifest without a files record parses to undefined → skipped.
    await cache.writeLeaf("corrupt", new Map());
    // Rewrite leaf-1's JSON without the files key to exercise the readLeaf
    // undefined path inside listDiffItems.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(cache.root, "leaves", "corrupt.json"),
      JSON.stringify({ version: 1 }),
      "utf-8",
    );

    const items = await listDiffItems(tracker, cache);
    expect(items).toEqual([
      { leafId: "leaf-1", path: "a.txt", change: "modified" },
      { leafId: "leaf-1", path: "c.txt", change: "added" },
      { leafId: "leaf-2", path: "b.txt", change: "deleted" },
      { leafId: "leaf-2", path: "d.txt", change: "added" },
    ]);
  });
});

describe("showDiffStack — selection flow", () => {
  function makePi() {
    const messages: Array<Record<string, unknown>> = [];
    return { sendMessage: (m: Record<string, unknown>) => messages.push(m), messages };
  }

  async function seedDiffs(cache: ReturnType<typeof createCache>) {
    const hA = hashBuffer(Buffer.from("base content"));
    const hB = hashBuffer(Buffer.from("changed content"));
    await cache.writeBlob(hA, Buffer.from("base content"));
    await cache.writeBlob(hB, Buffer.from("changed content"));
    await cache.writeBase(
      new Map([
        ["a.txt", { exists: true, hash: hA }],
        ["b.txt", { exists: true, hash: hA }],
        ["same.txt", { exists: true, hash: hA }],
      ]),
    );
    await cache.writeLeaf(
      "leaf-1",
      new Map([
        ["a.txt", { exists: true, hash: hB }],
        ["b.txt", { exists: false }],
        ["c.txt", { exists: true, hash: hA }],
        // same hash as base → describeChange returns null → not listed.
        ["same.txt", { exists: true, hash: hA }],
      ]),
    );
  }

  test("selecting an item sends undo-redo.diff with the rendered diff", async () => {
    const cache = createCache("session-b4");
    await cache.ensure();
    await seedDiffs(cache);
    const tracker = new SnapshotTracker(cache, projDir, join(testHome, "sb"), () => {});
    await tracker.loadBase();

    const pi = makePi();
    const selectCalls: string[][] = [];
    const notices: Array<[string, string]> = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: (m: string, t: string) => notices.push([m, t]),
        select: async (_title: string, labels: string[]) => {
          selectCalls.push(labels);
          return labels[0];
        },
      },
    } as never;
    await showDiffStack(pi as never, ctx as never, tracker, cache);

    // same.txt has no change → only 3 labels.
    expect(selectCalls[0]).toEqual([
      "[leaf-1] M a.txt",
      "[leaf-1] D b.txt",
      "[leaf-1] A c.txt",
    ]);
    expect(pi.messages).toHaveLength(1);
    const msg = pi.messages[0]!;
    expect(msg.customType).toBe("undo-redo.diff");
    expect(msg.content).toContain("Diff for a.txt (leaf leaf-1)");
    expect(msg.content).toContain("-1 base content");
    expect(msg.content).toContain("+1 changed content");
    expect(msg.details).toEqual({ leafId: "leaf-1", path: "a.txt" });
  });

  test("cancelled selection sends no message", async () => {
    const cache = createCache("session-b5");
    await cache.ensure();
    await seedDiffs(cache);
    const tracker = new SnapshotTracker(cache, projDir, join(testHome, "sb"), () => {});
    await tracker.loadBase();
    const pi = makePi();
    const ctx = {
      hasUI: true,
      ui: { notify: () => {}, select: async () => null },
    } as never;
    await showDiffStack(pi as never, ctx as never, tracker, cache);
    expect(pi.messages).toHaveLength(0);
  });

  test("leaf-pair items diff adjacent leaves directly (v1 vs v2)", async () => {
    const cache = createCache("session-b7");
    await cache.ensure();
    const hV0 = hashBuffer(Buffer.from("v0 base"));
    const hV1 = hashBuffer(Buffer.from("v1 content"));
    const hV2 = hashBuffer(Buffer.from("v2 content"));
    await cache.writeBlob(hV0, Buffer.from("v0 base"));
    await cache.writeBlob(hV1, Buffer.from("v1 content"));
    await cache.writeBlob(hV2, Buffer.from("v2 content"));
    await cache.writeBase(new Map([["a.txt", { exists: true, hash: hV0 }]]));
    await cache.writeLeaf(
      "leaf-1",
      new Map([["a.txt", { exists: true, hash: hV1 }]]),
    );
    await cache.writeLeaf(
      "leaf-2",
      new Map([["a.txt", { exists: true, hash: hV2 }]]),
    );
    const tracker = new SnapshotTracker(
      cache,
      projDir,
      join(testHome, "sb"),
      () => {},
    );
    await tracker.loadBase();

    const pi = makePi();
    const selectCalls: string[][] = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {},
        select: async (_title: string, labels: string[]) => {
          selectCalls.push(labels);
          const pair = labels.find((label: string) =>
            label.includes("(vs leaf-1)"),
          );
          return pair ?? null;
        },
      },
    } as never;

    await showDiffStack(pi as never, ctx as never, tracker, cache, [
      "leaf-1",
      "leaf-2",
    ]);

    // Both leaf-vs-base and leaf-to-leaf entries are offered.
    const labels = selectCalls[0]!;
    expect(labels).toContain("[leaf-1] M a.txt");
    expect(labels).toContain("[leaf-2] M a.txt");
    expect(labels).toContain("[leaf-2] M a.txt (vs leaf-1)");

    expect(pi.messages).toHaveLength(1);
    const msg = pi.messages[0]!;
    expect(msg.customType).toBe("undo-redo.diff");
    expect(msg.content).toContain("Diff for a.txt (leaf leaf-1 \u2192 leaf-2)");
    expect(msg.content).toContain("-1 v1 content");
    expect(msg.content).toContain("+1 v2 content");
    expect(msg.details).toEqual({
      leafId: "leaf-2",
      path: "a.txt",
      previousLeafId: "leaf-1",
    });
  });

  test("leaf deleted between listing and selection → Diff no longer available", async () => {
    const cache = createCache("session-b6");
    await cache.ensure();
    await seedDiffs(cache);
    const tracker = new SnapshotTracker(cache, projDir, join(testHome, "sb"), () => {});
    await tracker.loadBase();
    const pi = makePi();
    const notices: Array<[string, string]> = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: (m: string, t: string) => notices.push([m, t]),
        select: async (_title: string, labels: string[]) => {
          rmSync(join(cache.root, "leaves", "leaf-1.json"), { force: true });
          return labels[0];
        },
      },
    } as never;
    await showDiffStack(pi as never, ctx as never, tracker, cache);
    expect(pi.messages).toHaveLength(0);
    expect(notices[0]).toEqual(["Diff no longer available", "warning"]);
  });
});

// ════ tools.ts: buffered sandbox tool execution chain ────────────────────

describe("createBufferedToolSet — sandbox execution chain", () => {
  async function makeToolset() {
    writeFileSync(join(projDir, "a.txt"), "hello world\n", "utf8");
    const cache = createCache("session-c");
    await cache.ensure();
    const sandboxRoot = join(testHome, "sandbox");
    const sandboxState = new SandboxState(projDir, sandboxRoot, () => {});
    await sandboxState.initialize();
    const tracker = new SnapshotTracker(cache, projDir, sandboxRoot, () => {});
    await tracker.loadBase();
    const set = createBufferedToolSet({
      realRoot: projDir,
      sandboxRoot,
      tracker,
      sandboxState,
      updateStatus: () => {},
    });
    return { set, cache, tracker, sandboxRoot };
  }

  function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content.find((c) => c.type === "text")?.text ?? "";
  }

  test("editTool edits through the sandbox and syncs back to the real file", async () => {
    const { set, tracker, sandboxRoot } = await makeToolset();
    const result = await set.editTool.execute(
      "e1",
      {
        path: join(projDir, "a.txt"),
        edits: [{ oldText: "hello world", newText: "HELLO WORLD" }],
      },
      undefined,
      () => {},
      {} as never,
    );
    expect(textOf(result)).toContain("Successfully replaced 1 block(s)");
    expect((result.details as { diff: string }).diff).toContain("+1 HELLO WORLD");
    expect(readFileSync(join(projDir, "a.txt"), "utf8")).toBe("HELLO WORLD\n");
    expect(readFileSync(join(sandboxRoot, "a.txt"), "utf8")).toBe("HELLO WORLD\n");
    const tracked = tracker.getTrackedManifest().get("a.txt");
    expect(tracked?.exists).toBe(true);
  });

  test("editTool copies a post-init real file into the sandbox first (ensureSandboxCopy)", async () => {
    const { set } = await makeToolset();
    writeFileSync(join(projDir, "late.txt"), "original\n", "utf8");
    await set.editTool.execute(
      "e2",
      {
        path: join(projDir, "late.txt"),
        edits: [{ oldText: "original", newText: "edited" }],
      },
      undefined,
      () => {},
      {} as never,
    );
    expect(readFileSync(join(projDir, "late.txt"), "utf8")).toBe("edited\n");
  });

  test("readTool also copies a post-init real file into the sandbox first", async () => {
    const { set } = await makeToolset();
    writeFileSync(join(projDir, "late-read.txt"), "late content\n", "utf8");
    const result = await set.readTool.execute(
      "r1",
      { path: join(projDir, "late-read.txt") },
      undefined,
      () => {},
      {} as never,
    );
    expect(textOf(result)).toContain("late content");
  });

  test("writeTool writes a new file into the sandbox and syncs it to the real root", async () => {
    const { set, sandboxRoot } = await makeToolset();
    await set.writeTool.execute(
      "w1",
      { path: join(projDir, "new.txt"), content: "fresh\n" },
      undefined,
      () => {},
      {} as never,
    );
    expect(readFileSync(join(projDir, "new.txt"), "utf8")).toBe("fresh\n");
    expect(readFileSync(join(sandboxRoot, "new.txt"), "utf8")).toBe("fresh\n");
  });

  test("lsTool lists the sandbox contents, not post-init real-only files", async () => {
    const { set, sandboxRoot } = await makeToolset();
    writeFileSync(join(projDir, "real-only.txt"), "x\n", "utf8");
    writeFileSync(join(sandboxRoot, "sandbox-only.txt"), "x\n", "utf8");
    const result = await set.lsTool.execute(
      "l1",
      { path: projDir },
      undefined,
      () => {},
      {} as never,
    );
    const text = textOf(result);
    expect(text).toContain("sandbox-only.txt");
    expect(text).not.toContain("real-only.txt");
  });

  test("grepTool searches the sandbox and maps results back to real paths", async () => {
    const { set, sandboxRoot } = await makeToolset();
    writeFileSync(join(projDir, "real-only.txt"), "real needle\n", "utf8");
    writeFileSync(join(sandboxRoot, "sandbox-only.txt"), "sandbox needle\n", "utf8");
    const result = await set.grepTool.execute(
      "g1",
      { path: projDir, pattern: "needle" },
      undefined,
      () => {},
      {} as never,
    );
    const text = textOf(result);
    expect(text).toContain("sandbox-only.txt");
    expect(text).toContain("sandbox needle");
    expect(text).not.toContain("real-only.txt");
  });

  test("grepTool on a missing directory throws a rewritten error", async () => {
    const { set } = await makeToolset();
    await expect(
      set.grepTool.execute(
        "g2",
        { path: join(projDir, "no-such-dir"), pattern: "x" },
        undefined,
        () => {},
        {} as never,
      ),
    ).rejects.toThrow();
  });

  test("bashTool creating a file syncs it to the real root", async () => {
    const { set, sandboxRoot } = await makeToolset();
    await set.bashTool.execute("b1", { command: "echo hi > gen.txt" }, undefined, () => {}, {} as never);
    expect(readFileSync(join(projDir, "gen.txt"), "utf8")).toBe("hi\n");
    expect(readFileSync(join(sandboxRoot, "gen.txt"), "utf8")).toBe("hi\n");
  });

  test("bashTool modifying a file syncs the change back", async () => {
    const { set } = await makeToolset();
    await set.bashTool.execute("b2", { command: "echo changed > a.txt" }, undefined, () => {}, {} as never);
    expect(readFileSync(join(projDir, "a.txt"), "utf8")).toBe("changed\n");
  });

  test("bashTool deleting a file removes it from the real root", async () => {
    const { set } = await makeToolset();
    await set.bashTool.execute("b3", { command: "rm a.txt" }, undefined, () => {}, {} as never);
    expect(existsSync(join(projDir, "a.txt"))).toBe(false);
    expect(existsSync(join(testHome, "sandbox", "a.txt"))).toBe(false);
  });

  test("bashTool command failure (exit 1) throws", async () => {
    const { set } = await makeToolset();
    await expect(
      set.bashTool.execute("b4", { command: "exit 1" }, undefined, () => {}, {} as never),
    ).rejects.toThrow(/Command exited with code 1/);
  });

  test("bashTool onUpdate receives path-rewritten updates", async () => {
    const { set, sandboxRoot } = await makeToolset();
    const updates: Array<{ content: Array<{ type: string; text?: string }> }> = [];
    // The spawnHook rewrites the command's real root → sandbox root, so the
    // echoed path IS the sandbox path; the wrapper must rewrite it back.
    const result = await set.bashTool.execute(
      "b5",
      { command: `echo ${projDir}` },
      undefined,
      (u) => updates.push(u),
      {} as never,
    );
    const resultText = textOf(result);
    expect(resultText).toContain(projDir);
    expect(resultText).not.toContain(sandboxRoot);
    const joinedUpdates = updates.map((u) => textOf(u)).join("\n");
    expect(joinedUpdates).toContain(projDir);
    expect(joinedUpdates).not.toContain(sandboxRoot);
  });
});

// ════ index.ts: commands / undo_redo tool / events with real sandbox ─────

function makeFakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers: Record<string, Array<(event: any, ctx?: any) => any>> = {};
  const messages: Array<Record<string, unknown>> = [];
  const pi: any = {
    tools,
    commands,
    handlers,
    messages,
    on: (event: string, handler: (event: any, ctx?: any) => unknown) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    sendMessage: (m: Record<string, unknown>) => messages.push(m),
    sendUserMessage: () => {},
    events: { emit: () => {}, subscribe: () => {}, unsubscribe: () => {} },
  };
  return pi;
}

function makeSessionManager(initialLeaf = "leaf-1") {
  let leaf = initialLeaf;
  const calls = { branch: [] as string[], resetLeaf: 0 };
  return {
    calls,
    getSessionId: () => "s1",
    getLeafId: () => leaf,
    setLeaf: (id: string) => {
      leaf = id;
    },
    branch: (id: string) => calls.branch.push(id),
    resetLeaf: () => {
      calls.resetLeaf += 1;
    },
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  const notices: Array<{ msg: string; level: string }> = [];
  const navCalls: Array<[string, unknown]> = [];
  const sessionManager = makeSessionManager();
  const ctx: any = {
    cwd: projDir,
    hasUI: true,
    notices,
    navCalls,
    sessionManager,
    ui: {
      notify: (msg: string, level = "info") => notices.push({ msg, level }),
      setStatus: () => {},
      setEditorComponent: () => {},
      setWorkingMessage: () => {},
      select: async () => null,
    },
    waitForIdle: undefined,
    navigateTree: undefined,
    ...overrides,
  };
  return ctx;
}

async function setupUndoRedo(ctx = makeCtx()) {
  const pi = makeFakePi();
  undoRedoExtension(pi);
  await pi.handlers["session_start"]![0]!({}, ctx);
  return { pi, ctx };
}

/** Seed base.json + leaf manifests + blobs into the shared session cache. */
async function seedSessionCache(
  base: Array<[string, string]>,
  leaves: Record<string, Array<[string, string]>>,
) {
  const cache = createCache("s1");
  await cache.ensure();
  const blobs = new Map<string, string>();
  const entryFor = (content: string) => {
    const h = hashBuffer(Buffer.from(content));
    blobs.set(h, content);
    return { exists: true, hash: h };
  };
  await cache.writeBase(new Map(base.map(([p, c]) => [p, entryFor(c)])));
  for (const [leafId, files] of Object.entries(leaves)) {
    await cache.writeLeaf(
      leafId,
      new Map(files.map(([p, c]) => [p, entryFor(c)])),
    );
  }
  for (const [h, content] of blobs) {
    await cache.writeBlob(h, Buffer.from(content));
  }
  return cache;
}

describe("undo/redo commands — navigateTo branches", () => {
  test("undo success path pops the stack and navigates to the target leaf", async () => {
    const ctx = makeCtx();
    ctx.waitForIdle = async () => {};
    ctx.navigateTree = async (id: string, opts: unknown) => {
      ctx.navCalls.push([id, opts]);
      return { cancelled: false };
    };
    const { pi } = await setupUndoRedo(ctx);
    await pi.handlers["session_tree"]![0]!({ oldLeafId: "leaf-1", newLeafId: "leaf-2" });

    await pi.commands.get("undo").handler("", ctx);
    expect(ctx.navCalls).toEqual([["leaf-1", { summarize: false }]]);
    // The only notice is the init "Buffered undo enabled" info.
    expect(ctx.notices.some((n: { msg: string; level: string }) => n.msg.includes("No undo history"))).toBe(false);
  });

  test("redo success path navigates to the redo target", async () => {
    const ctx = makeCtx();
    ctx.waitForIdle = async () => {};
    ctx.navigateTree = async (id: string, opts: unknown) => {
      ctx.navCalls.push([id, opts]);
      return { cancelled: false };
    };
    const { pi } = await setupUndoRedo(ctx);
    await pi.handlers["session_tree"]![0]!({ oldLeafId: "leaf-1", newLeafId: "leaf-2" });
    await pi.commands.get("undo").handler("", ctx);
    await pi.commands.get("redo").handler("", ctx);
    expect(ctx.navCalls.map((c: [string, unknown]) => c[0])).toEqual(["leaf-1", "leaf-2"]);
  });

  test("navigateTo without interactive helpers warns instead of navigating", async () => {
    const ctx = makeCtx();
    // No waitForIdle / navigateTree on purpose.
    ctx.navigateTree = async () => ({ cancelled: false });
    const { pi } = await setupUndoRedo(ctx);
    await pi.handlers["session_tree"]![0]!({ oldLeafId: "leaf-1", newLeafId: "leaf-2" });

    await pi.commands.get("undo").handler("", ctx);
    expect(ctx.navCalls).toHaveLength(0);
    expect(ctx.notices.at(-1)?.msg).toContain("requires interactive mode");
    expect(ctx.notices.at(-1)?.level).toBe("warning");
  });

  test("cancelled navigation warns and aborts the navigation", async () => {
    const ctx = makeCtx();
    ctx.waitForIdle = async () => {};
    ctx.navigateTree = async (id: string, opts: unknown) => {
      ctx.navCalls.push([id, opts]);
      return { cancelled: true };
    };
    const { pi } = await setupUndoRedo(ctx);
    await pi.handlers["session_tree"]![0]!({ oldLeafId: "leaf-1", newLeafId: "leaf-2" });

    await pi.commands.get("undo").handler("", ctx);
    expect(ctx.navCalls.map((c: [string, unknown]) => c[0])).toEqual(["leaf-1"]);
    expect(ctx.notices.at(-1)?.msg).toContain("Navigation cancelled");
    expect(ctx.notices.at(-1)?.level).toBe("warning");
  });

  test("undo with no history reports info notice", async () => {
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    await pi.commands.get("undo").handler("", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("No undo history");
  });
});

describe("undo_redo tool — deep branches", () => {
  test("undo success applies navigation and reports the target leaf", async () => {
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    await pi.handlers["session_tree"]![0]!({ oldLeafId: "leaf-1", newLeafId: "leaf-2" });

    const toolCtx = makeCtx();
    toolCtx.sessionManager.setLeaf("leaf-3");
    const result = await pi.tools.get("undo_redo").execute(
      "t1",
      { action: "undo" },
      undefined,
      undefined,
      toolCtx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Undo applied");
    expect(result.content[0].text).toContain("leaf-1");
    expect(result.details).toEqual({ action: "undo", targetId: "leaf-1" });
    expect(toolCtx.sessionManager.calls.branch).toEqual(["leaf-1"]);
  });

  test("redo action reports Redo applied", async () => {
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    await pi.handlers["session_tree"]![0]!({ oldLeafId: "leaf-1", newLeafId: "leaf-2" });
    // First undo (with the session leaf advanced) pushes leaf-2 onto the redo stack.
    const firstToolCtx = makeCtx();
    firstToolCtx.sessionManager.setLeaf("leaf-3");
    await pi.tools.get("undo_redo").execute("t0", { action: "undo" }, undefined, undefined, firstToolCtx);

    const toolCtx = makeCtx();
    const result = await pi.tools.get("undo_redo").execute(
      "t2",
      { action: "redo" },
      undefined,
      undefined,
      toolCtx,
    );
    expect(result.content[0].text).toContain("Redo applied");
    expect(result.details).toEqual({ action: "redo", targetId: "leaf-3" });
  });

  test("failed tool navigation rolls the stacks back so the undo can be retried", async () => {
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    await pi.handlers["session_tree"]![0]!({ oldLeafId: "leaf-1", newLeafId: "leaf-2" });

    // A leaf id that cannot be written as a file name makes saveLeaf throw
    // inside applyToolNavigation → the catch restores the undo stack.
    const badCtx = makeCtx();
    badCtx.sessionManager.setLeaf("x/y");
    await expect(
      pi.tools.get("undo_redo").execute("t3", { action: "undo" }, undefined, undefined, badCtx),
    ).rejects.toThrow(/Undo\/redo tool failed/);

    // Rollback restored the undo entry — a retry with a valid session leaf
    // pops leaf-1 again and succeeds.
    const goodCtx = makeCtx();
    goodCtx.sessionManager.setLeaf("leaf-3");
    const result = await pi.tools.get("undo_redo").execute(
      "t4",
      { action: "undo" },
      undefined,
      undefined,
      goodCtx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.details).toEqual({ action: "undo", targetId: "leaf-1" });
  });

  test("aborted signal responds cancelled", async () => {
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    const result = await pi.tools.get("undo_redo").execute(
      "t3",
      { action: "undo" },
      { aborted: true } as AbortSignal,
      undefined,
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Undo/redo tool cancelled.");
  });

  test("diff action renders the buffered diff for the current leaf", async () => {
    await seedSessionCache(
      [["a.txt", "old content"]],
      { "leaf-1": [["a.txt", "changed content"]] },
    );
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    const result = await pi.tools.get("undo_redo").execute(
      "t4",
      { action: "diff", path: "a.txt" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Diff for a.txt (leaf leaf-1)");
    expect(result.content[0].text).toContain("-1 old content");
    expect(result.content[0].text).toContain("+1 changed content");
    expect(result.details.path).toBe("a.txt");
  });

  test("diff action accepts an absolute path inside the project root", async () => {
    await seedSessionCache(
      [["a.txt", "old content"]],
      { "leaf-1": [["a.txt", "changed content"]] },
    );
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    const result = await pi.tools.get("undo_redo").execute(
      "t5",
      { action: "diff", path: join(projDir, "a.txt") },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(result.content[0].text).toContain("Diff for a.txt (leaf leaf-1)");
  });

  test("diff action with a path outside the project root errors", async () => {
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    const result = await pi.tools.get("undo_redo").execute(
      "t6",
      { action: "diff", path: "/etc/passwd" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "Diff path must be inside the project root.",
    );
  });

  test("diff action without a path errors", async () => {
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    const result = await pi.tools.get("undo_redo").execute(
      "t7",
      { action: "diff" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Diff action requires a path.");
  });

  test("diff action with an unknown leaf errors", async () => {
    await seedSessionCache([["a.txt", "old"]], {});
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    const result = await pi.tools.get("undo_redo").execute(
      "t8",
      { action: "diff", path: "a.txt", leafId: "ghost-leaf" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "No buffered snapshot for leaf ghost-leaf.",
    );
  });

  test("list_diffs lists items across leaves", async () => {
    await seedSessionCache(
      [["a.txt", "base a"], ["b.txt", "base b"]],
      {
        "leaf-2": [["a.txt", "changed a"]],
        "leaf-3": [["c.txt", "added c"]],
      },
    );
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    const result = await pi.tools.get("undo_redo").execute(
      "t9",
      { action: "list_diffs" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Buffered diffs:");
    expect(result.content[0].text).toContain("[leaf-2] modified a.txt");
    expect(result.content[0].text).toContain("[leaf-3] added c.txt");
    expect(result.details.items).toHaveLength(2);
    expect(result.details.truncated).toBe(false);
  });

  test("diff output beyond the truncation budget is saved to a file", async () => {
    const huge = Array.from({ length: 3000 }, (_, i) => `line-${i} ${"x".repeat(60)}`).join("\n");
    await seedSessionCache([["big.txt", "old"]], { "leaf-1": [["big.txt", huge]] });
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    const result = await pi.tools.get("undo_redo").execute(
      "t10",
      { action: "diff", path: "big.txt" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(result.details.truncated).toBe(true);
    expect(typeof result.details.outputPath).toBe("string");
    expect(result.content[0].text).toContain("[Output truncated:");
    expect(result.content[0].text).toContain(result.details.outputPath);
    expect(existsSync(result.details.outputPath as string)).toBe(true);
  });
});

describe("turn_end — isToolCallTurn branches and leaf tracking", () => {
  async function setupWithTurn(ctx = makeCtx()) {
    const { pi } = await setupUndoRedo(ctx);
    const turnEnd = pi.handlers["turn_end"]![0]!;
    return { pi, ctx, turnEnd };
  }

  test("tool-use turns (stopReason toolUse) are skipped entirely", async () => {
    const { pi, ctx, turnEnd } = await setupWithTurn();
    await turnEnd({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
    await pi.commands.get("undo").handler("", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("No undo history");
  });

  test("assistant content containing a toolCall part is skipped", async () => {
    const { pi, ctx, turnEnd } = await setupWithTurn();
    await turnEnd(
      { message: { role: "assistant", content: [{ type: "toolCall" }] } },
      ctx,
    );
    await pi.commands.get("undo").handler("", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("No undo history");
  });

  test("leaf change on a non-tool-call turn pushes the previous leaf onto the undo stack", async () => {
    const ctx = makeCtx();
    const { pi, turnEnd } = await setupWithTurn(ctx);
    ctx.sessionManager.setLeaf("leaf-2");
    await turnEnd({ message: { role: "user" } }, ctx);

    const navCtx = makeCtx();
    navCtx.waitForIdle = async () => {};
    navCtx.navigateTree = async (id: string, opts: unknown) => {
      navCtx.navCalls.push([id, opts]);
      return { cancelled: false };
    };
    await pi.commands.get("undo").handler("", navCtx);
    expect(navCtx.navCalls.map((c: [string, unknown]) => c[0])).toEqual(["leaf-1"]);
  });

  test("non-object and string-content messages fall through to leaf tracking", async () => {
    const ctx = makeCtx();
    const { pi, turnEnd } = await setupWithTurn(ctx);
    ctx.sessionManager.setLeaf("leaf-2");
    await turnEnd({ message: null }, ctx);
    await turnEnd({ message: { role: "assistant", content: "plain text" } }, ctx);

    const navCtx = makeCtx();
    navCtx.waitForIdle = async () => {};
    navCtx.navigateTree = async (id: string, opts: unknown) => {
      navCtx.navCalls.push([id, opts]);
      return { cancelled: false };
    };
    await pi.commands.get("undo").handler("", navCtx);
    expect(navCtx.navCalls.map((c: [string, unknown]) => c[0])).toEqual(["leaf-1"]);
  });

  test("assistant stopReason toolUse with leaf change still skips", async () => {
    const ctx = makeCtx();
    const { pi, turnEnd } = await setupWithTurn(ctx);
    ctx.sessionManager.setLeaf("leaf-2");
    await turnEnd({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
    await pi.commands.get("undo").handler("", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("No undo history");
  });
});

describe("session_tree event — stack push and restore", () => {
  test("non-navigating leaf switch pushes the old leaf and restores the new one", async () => {
    // leaf-2 carries a snapshot of a.txt with different content.
    await seedSessionCache([["a.txt", "base content"]], {
      "leaf-2": [["a.txt", "restored content"]],
    });
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    // The seeded leaf-1 snapshot was applied during session init; make the
    // real file match it.
    writeFileSync(join(projDir, "a.txt"), "base content", "utf8");

    await pi.handlers["session_tree"]![0]!({ oldLeafId: "leaf-1", newLeafId: "leaf-2" });
    expect(readFileSync(join(projDir, "a.txt"), "utf8")).toBe("restored content");

    const navCtx = makeCtx();
    navCtx.waitForIdle = async () => {};
    navCtx.navigateTree = async (id: string, opts: unknown) => {
      navCtx.navCalls.push([id, opts]);
      return { cancelled: false };
    };
    await pi.commands.get("undo").handler("", navCtx);
    expect(navCtx.navCalls.map((c: [string, unknown]) => c[0])).toEqual(["leaf-1"]);
  });

  test("leaf switch during in-flight navigation does not push the old leaf", async () => {
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    await pi.handlers["session_tree"]![0]!({ oldLeafId: "leaf-1", newLeafId: "leaf-2" });

    // Start /undo but keep waitForIdle pending — navigating is now true.
    let releaseIdle: () => void = () => {};
    const idleGate = new Promise<void>((r) => {
      releaseIdle = r;
    });
    ctx.waitForIdle = () => idleGate;
    ctx.navigateTree = async (id: string, opts: unknown) => {
      ctx.navCalls.push([id, opts]);
      return { cancelled: false };
    };
    const pending = pi.commands.get("undo").handler("", ctx);

    await pi.handlers["session_tree"]![0]!({ oldLeafId: "leaf-2", newLeafId: "leaf-3" });
    releaseIdle();
    await pending;

    // If the old leaf had been pushed, a second /undo would navigate again.
    await pi.commands.get("undo").handler("", ctx);
    expect(ctx.navCalls.map((c: [string, unknown]) => c[0])).toEqual(["leaf-1"]);
    expect(ctx.notices.at(-1)?.msg).toContain("No undo history");
  });
});

describe("extension init / cache lifecycle", () => {
  test("deferred tools throw before session_start initializes them", async () => {
    const pi = makeFakePi();
    undoRedoExtension(pi);
    await expect(
      pi.tools.get("read").execute("t", { path: "a.txt" }, undefined, undefined, makeCtx()),
    ).rejects.toThrow("Undo/redo extension not initialized");
    await expect(
      pi.tools.get("bash").execute("t", { command: "ls" }, undefined, undefined, makeCtx()),
    ).rejects.toThrow("Undo/redo extension not initialized");
  });

  test("undo-redo-clear-cache with existing cache wipes leaves and re-creates the sandbox", async () => {
    const ctx = makeCtx();
    const { pi } = await setupUndoRedo(ctx);
    const cache = createCache("s1");
    await cache.ensure();
    await cache.writeLeaf("stale-leaf", new Map([["x.txt", { exists: true }]]));
    expect(existsSync(join(cache.root, "leaves", "stale-leaf.json"))).toBe(true);

    await pi.commands.get("undo-redo-clear-cache").handler("", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("cache cleared");
    expect(existsSync(join(cache.root, "leaves", "stale-leaf.json"))).toBe(false);
    expect(existsSync(join(cache.root, "sandbox"))).toBe(true);
  });

  test("clear-cache keeps the current leaf snapshot and undo history", async () => {
    const cache = await seedSessionCache(
      [["a.txt", "v0 base"]],
      {
        "leaf-1": [["a.txt", "v1 content"]],
        "leaf-2": [["a.txt", "v2 content"]],
      },
    );
    const ctx = makeCtx();
    ctx.waitForIdle = async () => {};
    ctx.navigateTree = async (id: string, opts: unknown) => {
      ctx.navCalls.push([id, opts]);
      return { cancelled: false };
    };
    const { pi } = await setupUndoRedo(ctx);

    // Two rounds of edits (leaf-1 → leaf-2); the file is currently at v2.
    ctx.sessionManager.setLeaf("leaf-2");
    await pi.handlers["session_tree"]![0]!({
      oldLeafId: "leaf-1",
      newLeafId: "leaf-2",
    });
    expect(readFileSync(join(projDir, "a.txt"), "utf8")).toBe("v2 content");

    await pi.commands.get("undo-redo-clear-cache").handler("", ctx);
    expect(ctx.notices.at(-1)?.msg).toContain("cache cleared");

    // The current-leaf snapshot survived the cache wipe.
    expect(readFileSync(join(projDir, "a.txt"), "utf8")).toBe("v2 content");
    expect(existsSync(join(cache.root, "leaves", "leaf-2.json"))).toBe(true);

    // /undo still restores the most recent step (v2 → v1).
    await pi.commands.get("undo").handler("", ctx);
    expect(ctx.navCalls.map((c: [string, unknown]) => c[0])).toEqual([
      "leaf-1",
    ]);
    await pi.handlers["session_tree"]![0]!({
      oldLeafId: "leaf-2",
      newLeafId: "leaf-1",
    });
    expect(readFileSync(join(projDir, "a.txt"), "utf8")).toBe("v1 content");
  });

  test.skipIf(process.getuid?.() === 0)(
    "undo-redo-clear-cache failure notifies the error",
    async () => {
      const ctx = makeCtx();
      const { pi } = await setupUndoRedo(ctx);
      const cache = createCache("s1");
      await cache.ensure();
      await cache.writeLeaf("keep", new Map());
      chmodSync(cache.root, 0o555);
      try {
        await pi.commands.get("undo-redo-clear-cache").handler("", ctx);
        expect(ctx.notices.at(-1)?.msg).toContain("Failed to clear undo/redo cache");
        expect(ctx.notices.at(-1)?.level).toBe("error");
      } finally {
        chmodSync(cache.root, 0o755);
      }
    },
  );
});
