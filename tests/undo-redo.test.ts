/**
 * pico undo-redo extension tests.
 *
 * Guards the pico integration of pi-undo-redo: sandbox path mapping,
 * cache layout (PICO_HOME), snapshot save/restore across leaves, and
 * the sandbox sync helpers.
 *
 * All tests redirect PICO_HOME to a temp dir so the real cache is untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getCacheRoot } from "../src/extensions/undo-redo/cache.ts";
import { UndoRedoEditor } from "../src/extensions/undo-redo/editor.ts";
import {
  isWithinRoot,
  mapToRealPath,
  mapToSandboxPath,
  resolveUserPath,
  toRelativePath,
} from "../src/extensions/undo-redo/paths.ts";
import { prepareSandbox, SandboxState } from "../src/extensions/undo-redo/sandbox.ts";
import { SnapshotTracker } from "../src/extensions/undo-redo/tracker.ts";
import { createCache } from "../src/extensions/undo-redo/cache.ts";

const ORIG_PICO_HOME = process.env.PICO_HOME;
let testHome: string;
let projDir: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "pico-undo-redo-home-"));
  projDir = mkdtempSync(join(tmpdir(), "pico-undo-redo-proj-"));
  process.env.PICO_HOME = testHome;
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  if (ORIG_PICO_HOME === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = ORIG_PICO_HOME;
});

// ── paths ────────────────────────────────────────────────────────────────

describe("undo-redo paths", () => {
  test("resolveUserPath resolves relative and absolute paths from cwd", () => {
    expect(resolveUserPath("src/a.ts", projDir)).toBe(join(projDir, "src", "a.ts"));
    expect(resolveUserPath(join(projDir, "b.ts"), projDir)).toBe(join(projDir, "b.ts"));
  });

  test("isWithinRoot rejects paths outside the root", () => {
    expect(isWithinRoot(join(projDir, "src", "a.ts"), projDir)).toBe(true);
    expect(isWithinRoot(join(projDir, "..", "other", "a.ts"), projDir)).toBe(false);
    expect(isWithinRoot("/etc/passwd", projDir)).toBe(false);
  });

  test("toRelativePath yields null for out-of-root paths", () => {
    expect(toRelativePath(join(projDir, "src", "a.ts"), projDir)).toBe("src/a.ts");
    expect(toRelativePath("/etc/passwd", projDir)).toBeNull();
  });

  test("sandbox mapping is a round trip", () => {
    const sandboxRoot = join(testHome, "sandbox");
    const sandboxPath = mapToSandboxPath(join(projDir, "src", "a.ts"), projDir, sandboxRoot);
    expect(sandboxPath).toBe(join(sandboxRoot, "src", "a.ts"));
    expect(mapToRealPath(sandboxPath!, projDir, sandboxRoot)).toBe(join(projDir, "src", "a.ts"));
  });
});

// ── cache ────────────────────────────────────────────────────────────────

describe("undo-redo cache", () => {
  test("cache root lives under PICO_HOME", () => {
    const root = getCacheRoot("session-1");
    expect(root.startsWith(testHome)).toBe(true);
    expect(root.includes("undo-redo")).toBe(true);
    expect(root.includes("session-1")).toBe(true);
  });

  test("createCache + blob write/read round trip", async () => {
    const cache = createCache("session-1");
    await cache.ensure();
    const hash = "deadbeef";
    await cache.writeBlob(hash, Buffer.from("hello content"));
    const raw = await cache.readBlob(hash);
    expect(raw.toString("utf8")).toBe("hello content");
  });
});

// ── sandbox ──────────────────────────────────────────────────────────────

describe("undo-redo sandbox", () => {
  test("prepareSandbox copies project files into the sandbox", async () => {
    writeFileSync(join(projDir, "a.txt"), "aaa\n", "utf8");
    writeFileSync(join(projDir, "b.txt"), "bbb\n", "utf8");
    const sandboxRoot = join(testHome, "sandbox");
    const { reused } = await prepareSandbox(projDir, sandboxRoot, { ignores: () => false } as any, false);
    expect(reused).toBe(false);
    expect(readFileSync(join(sandboxRoot, "a.txt"), "utf8")).toBe("aaa\n");
    expect(readFileSync(join(sandboxRoot, "b.txt"), "utf8")).toBe("bbb\n");
  });

  test("SandboxState initialize + rescan tracks file stats", async () => {
    writeFileSync(join(projDir, "a.txt"), "hello", "utf8");
    const sandboxRoot = join(testHome, "sandbox");
    const state = new SandboxState(projDir, sandboxRoot, () => {});
    await state.initialize();
    const stats = await state.rescan();
    expect(stats.size).toBeGreaterThanOrEqual(1);
    let total = 0;
    for (const entry of stats.values()) total += entry.size;
    expect(total).toBeGreaterThanOrEqual(5);
  });

  test("prepareSandbox skips .codegraph daemon socket instead of crashing", async () => {
    // A live codegraph index dir contains a Unix socket (daemon.sock);
    // fs.cp would throw "cannot copy a socket file" and break session start.
    const socketDir = join(projDir, ".codegraph");
    mkdirSync(socketDir, { recursive: true });
    const sockPath = join(socketDir, "daemon.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });
    try {
      const sandboxRoot = join(testHome, "sandbox");
      const state = new SandboxState(projDir, sandboxRoot, () => {});
      await state.initialize();
      expect(existsSync(join(sandboxRoot, ".codegraph"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(sockPath);
      } catch {
        // socket already removed by close
      }
    }
  });

  test("sandbox gets a .git gitdir redirect so git works inside it", async () => {
    // Bash runs inside the sandbox, whose copy omits `.git/` — without a
    // gitdir redirect, every git command would report "not a git repository".
    execSync("git init -q", { cwd: projDir });
    const sandboxRoot = join(testHome, "sandbox");
    const state = new SandboxState(projDir, sandboxRoot, () => {});
    await state.initialize();

    expect(statSync(join(sandboxRoot, ".git")).isFile()).toBe(true);
    expect(readFileSync(join(sandboxRoot, ".git"), "utf8")).toBe(
      `gitdir: ${join(projDir, ".git")}\n`,
    );

    // git resolves the real repo from inside the sandbox.
    const gitDir = execSync("git rev-parse --absolute-git-dir", {
      cwd: sandboxRoot,
      encoding: "utf8",
    }).trim();
    expect(gitDir).toBe(join(projDir, ".git"));
  });
});

// ── tracker (snapshot save/restore) ──────────────────────────────────────

describe("undo-redo snapshot tracker", () => {
  test("saveLeaf + modify + restoreLeaf recovers the original content", async () => {
    const file = join(projDir, "notes.txt");
    writeFileSync(file, "original", "utf8");

    const cache = createCache("session-1");
    await cache.ensure();
    const sandboxRoot = join(testHome, "sandbox");
    await prepareSandbox(projDir, sandboxRoot, { ignores: () => false } as any, false);

    const tracker = new SnapshotTracker(cache, projDir, sandboxRoot, () => {});
    await tracker.loadBase();

    // Leaf 1: original content (tracked through the sandbox, as tools do)
    await tracker.ensureBaseFromSandbox("notes.txt");
    await tracker.updateFromSandbox("notes.txt");
    await tracker.saveLeaf("leaf-1");

    // Modify the file through the sandbox (simulating a tool write)
    writeFileSync(join(sandboxRoot, "notes.txt"), "modified", "utf8");
    await tracker.updateFromSandbox("notes.txt");
    await tracker.saveLeaf("leaf-2");

    // Restore leaf-1: file should come back to "original"
    await tracker.restoreLeaf("leaf-1", [sandboxRoot, projDir]);
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(readFileSync(join(sandboxRoot, "notes.txt"), "utf8")).toBe("original");
  });

  test("restoring a leaf with no snapshot leaves the file untouched", async () => {
    const file = join(projDir, "untracked.txt");
    writeFileSync(file, "keep me", "utf8");
    const cache = createCache("session-1");
    await cache.ensure();
    const sandboxRoot = join(testHome, "sandbox");
    await prepareSandbox(projDir, sandboxRoot, { ignores: () => false } as any, false);
    const tracker = new SnapshotTracker(cache, projDir, sandboxRoot, () => {});
    await tracker.loadBase();
    await tracker.saveLeaf("leaf-1");
    await tracker.restoreLeaf("leaf-1", [sandboxRoot, projDir]);
    expect(readFileSync(file, "utf8")).toBe("keep me");
  });
});

// ── UndoRedoEditor (Ctrl+Shift+Z / Ctrl+Shift+Y shortcuts) ────────────────

function makeFakeTui() {
  return { requestRender: () => {}, terminal: { rows: 24 } } as any;
}

const stubTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selected: (text: string) => text,
    normal: (text: string) => text,
    dim: (text: string) => text,
    border: (text: string) => text,
    highlight: (text: string) => text,
  },
} as any;

function makeKeybindings(config: Record<string, unknown> = {}) {
  return {
    matches: () => false,
    getEffectiveConfig: () => ({ treeUndo: "ctrl+shift+z", treeRedo: "ctrl+shift+y", ...config }),
  } as any;
}

describe("UndoRedoEditor keybindings", () => {
  // Kitty-protocol CSI-u sequences: ctrl+shift+<key> = <codepoint>;6u
  const CTRL_SHIFT_Z = "\x1b[122;6u";
  const CTRL_SHIFT_Y = "\x1b[121;6u";
  const CTRL_SHIFT_X = "\x1b[120;6u";

  test("ctrl+shift+z submits /undo and ctrl+shift+y submits /redo", () => {
    const submitted: string[] = [];
    const editor = new UndoRedoEditor(makeFakeTui(), stubTheme, makeKeybindings());
    editor.onSubmit = (text) => submitted.push(text);

    editor.handleInput(CTRL_SHIFT_Z);
    editor.handleInput(CTRL_SHIFT_Y);
    editor.handleInput(CTRL_SHIFT_Z);

    expect(submitted).toEqual(["/undo", "/redo", "/undo"]);
  });

  test("custom treeUndo/treeRedo keybindings override the defaults", () => {
    const submitted: string[] = [];
    const editor = new UndoRedoEditor(
      makeFakeTui(),
      stubTheme,
      makeKeybindings({ treeUndo: "ctrl+shift+x", treeRedo: "alt+shift+y" }),
    );
    editor.onSubmit = (text) => submitted.push(text);

    editor.handleInput(CTRL_SHIFT_X);
    editor.handleInput(CTRL_SHIFT_Z);
    expect(submitted).toEqual(["/undo"]);
  });

  test("single-key string binding is accepted (normalizeKeys array branch)", () => {
    const submitted: string[] = [];
    const editor = new UndoRedoEditor(
      makeFakeTui(),
      stubTheme,
      makeKeybindings({ treeUndo: "ctrl+shift+z", treeRedo: "ctrl+shift+y" }),
    );
    editor.onSubmit = (text) => submitted.push(text);
    editor.handleInput(CTRL_SHIFT_Z);
    expect(submitted).toEqual(["/undo"]);
  });

  test("non-shortcut input falls through to the upstream editor", () => {
    const submitted: string[] = [];
    const editor = new UndoRedoEditor(makeFakeTui(), stubTheme, makeKeybindings());
    editor.onSubmit = (text) => submitted.push(text);

    editor.handleInput("a");
    editor.handleInput(CTRL_SHIFT_X);
    expect(submitted).toHaveLength(0);
  });
});
