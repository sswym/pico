/**
 * undo/redo 扩展单元测试。
 *
 * 覆盖:单次回退、连续多次回退、回退到初始状态(文件不存在)、文件新增/删除、
 * 非法回退边界(空栈、失败工具调用不入栈、blob 丢失、redo 分支失效)。
 *
 * 环境隔离:PICO_HOME 重定向到临时目录;真实文件系统操作(写文件/恢复)
 * 全部在临时项目目录内执行,验证端到端恢复。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { undoExtension, performUndo, performRedo, readUndoConfig } from "../src/extensions/undo/index.ts";
import { writeBlob, snapshotFile, clearSessionCache, undoCacheRoot } from "../src/extensions/undo/blob-store.ts";
import {
  cancelCapture,
  captureBefore,
  confirmCapture,
  createUndoSessionState,
  describeState,
  emptyUndoResult,
  findUndoTurnUser,
  popUndo,
  pushRedo,
  trimUndoStack,
  __resetUndoIdForTests,
  type UndoTreeEntry,
} from "../src/extensions/undo/state.ts";

const ORIG_PICO_HOME = process.env.PICO_HOME;
let testHome: string;
let projDir: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "pico-undo-home-"));
  projDir = mkdtempSync(join(tmpdir(), "pico-undo-proj-"));
  process.env.PICO_HOME = testHome;
  __resetUndoIdForTests();
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  if (ORIG_PICO_HOME === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = ORIG_PICO_HOME;
  __resetUndoIdForTests();
});

function filePath(name: string): string {
  return join(projDir, name);
}

/** 模拟一次 edit/write 工具调用:捕获 → 执行 → 确认 */
async function simulateToolCall(
  state: ReturnType<typeof createUndoSessionState>,
  toolCallId: string,
  tool: "edit" | "write",
  path: string,
  mutator: () => void,
  leafId: string | null = null,
  turnUserId: string | null = null,
): Promise<void> {
  const before = await snapshotFile(path);
  if (before.hash !== null) {
    await writeBlob("s1", before.hash, readFileSync(path));
  }
  captureBefore(state, toolCallId, tool, path, path, before, leafId, turnUserId);
  mutator();
  const after = await snapshotFile(path);
  if (after.hash !== null) {
    await writeBlob("s1", after.hash, readFileSync(path));
  }
  confirmCapture(state, toolCallId, after, leafId);
}

// ── 纯状态层(无文件系统依赖) ────────────────────────────────────────────

describe("undo state (pure)", () => {
  test("capture → confirm pushes entry and clears redo stack", () => {
    const state = createUndoSessionState();
    captureBefore(state, "c1", "write", "/p/a.txt", "a.txt", { hash: null }, null, null);
    confirmCapture(state, "c1", { hash: "h1" });
    expect(state.undoStack).toHaveLength(1);
    expect(state.undoStack[0]!.before.hash).toBeNull();
    expect(state.undoStack[0]!.after.hash).toBe("h1");
    expect(state.pending.size).toBe(0);
  });

  test("confirm with unchanged content drops the entry (no-op edit)", () => {
    const state = createUndoSessionState();
    captureBefore(state, "c1", "edit", "/p/a.txt", "a.txt", { hash: "h1" }, null, null);
    const entry = confirmCapture(state, "c1", { hash: "h1" });
    expect(entry).toBeNull();
    expect(state.undoStack).toHaveLength(0);
  });

  test("failed tool call cancels the pending capture", () => {
    const state = createUndoSessionState();
    captureBefore(state, "c1", "edit", "/p/a.txt", "a.txt", { hash: "h1" }, null, null);
    expect(cancelCapture(state, "c1")).toBe(true);
    expect(state.pending.size).toBe(0);
    expect(state.undoStack).toHaveLength(0);
    // 再次 cancel 返回 false
    expect(cancelCapture(state, "c1")).toBe(false);
  });

  test("confirm without pending capture is a no-op", () => {
    const state = createUndoSessionState();
    expect(confirmCapture(state, "ghost", { hash: "h1" })).toBeNull();
  });

  test("new capture after undo clears the redo branch", () => {
    const state = createUndoSessionState();
    // undo 1
    captureBefore(state, "c1", "write", "/p/a.txt", "a.txt", { hash: null }, null, null);
    confirmCapture(state, "c1", { hash: "h1" });
    // undo 2
    captureBefore(state, "c2", "edit", "/p/a.txt", "a.txt", { hash: "h1" }, null, null);
    confirmCapture(state, "c2", { hash: "h2" });
    // undo 后 redo 有内容
    const undone = popUndo(state)!;
    pushRedo(state, undone);
    expect(state.redoStack).toHaveLength(1);
    // 新捕获清空 redo
    captureBefore(state, "c3", "write", "/p/b.txt", "b.txt", { hash: null }, null, null);
    confirmCapture(state, "c3", { hash: "hb" });
    expect(state.redoStack).toHaveLength(0);
  });

  test("trimUndoStack keeps newest maxEntries", () => {
    const state = createUndoSessionState();
    for (let i = 0; i < 5; i++) {
      captureBefore(state, `c${i}`, "write", `/p/f${i}.txt`, `f${i}.txt`, { hash: null }, null, null);
      confirmCapture(state, `c${i}`, { hash: `h${i}` });
    }
    expect(state.undoStack).toHaveLength(5);
    trimUndoStack(state, 3);
    expect(state.undoStack).toHaveLength(3);
    expect(state.undoStack[0]!.displayPath).toBe("f2.txt");
  });

  test("describeState summarizes stacks", () => {
    const state = createUndoSessionState();
    const text = describeState(state, { enabled: true, maxEntries: 50 });
    expect(text).toContain("Undo entries: 0/50");
    expect(text).toContain("Redo entries: 0");
  });

  test("emptyUndoResult builds failure result", () => {
    const result = emptyUndoResult("No undo history.");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("No undo history.");
    expect(result.files).toEqual([]);
  });

  test("findUndoTurnUser returns the nearest user message across a multi-tool turn", () => {
    // 多工具回合:user → assistant(toolCall) → toolResult → assistant(toolCall) → custom(捕获叶)
    const tree: Record<string, UndoTreeEntry> = {
      "leaf-4": { type: "custom", id: "leaf-4", parentId: "leaf-3" },
      "leaf-3": { type: "message", id: "leaf-3", parentId: "leaf-2", message: { role: "assistant", content: [{ type: "toolCall" }] } },
      "leaf-2": { type: "message", id: "leaf-2", parentId: "leaf-1", message: { role: "toolResult", content: [{ type: "text" }] } },
      "leaf-1": { type: "message", id: "leaf-1", parentId: "leaf-0", message: { role: "assistant", content: [{ type: "toolCall" }] } },
      "leaf-0": { type: "message", id: "leaf-0", parentId: null, message: { role: "user", content: [{ type: "text" }] } },
    };
    expect(findUndoTurnUser((id) => tree[id], "leaf-4")).toBe("leaf-0");
  });

  test("findUndoTurnUser returns null for missing leaf or no user ancestor", () => {
    const tree: Record<string, UndoTreeEntry> = {
      "leaf-1": { type: "message", id: "leaf-1", parentId: null, message: { role: "assistant", content: [{ type: "text" }] } },
    };
    expect(findUndoTurnUser((id) => tree[id], null)).toBeNull();
    expect(findUndoTurnUser((id) => tree[id], "missing")).toBeNull();
    expect(findUndoTurnUser((id) => tree[id], "leaf-1")).toBeNull();
  });
});

// ── 端到端文件恢复(真实文件系统) ────────────────────────────────────────

describe("undo end-to-end file restore", () => {
  test("write new file → undo deletes it (file created)", async () => {
    const state = createUndoSessionState();
    await simulateToolCall(state, "c1", "write", filePath("new.txt"), () => {
      writeFileSync(filePath("new.txt"), "hello", "utf8");
    });
    expect(existsSync(filePath("new.txt"))).toBe(true);

    const result = await performUndo(state, "s1");
    expect(result.ok).toBe(true);
    expect(result.files[0]!.action).toBe("deleted");
    expect(existsSync(filePath("new.txt"))).toBe(false);
  });

  test("edit existing file → undo restores original content, redo reapplies", async () => {
    writeFileSync(filePath("a.txt"), "v1", "utf8");
    const state = createUndoSessionState();

    // edit v1 → v2
    await simulateToolCall(state, "c1", "edit", filePath("a.txt"), () => {
      writeFileSync(filePath("a.txt"), "v2", "utf8");
    });
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v2");

    // undo → v1
    const undone = await performUndo(state, "s1");
    expect(undone.ok).toBe(true);
    expect(undone.files[0]!.action).toBe("created");
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v1");

    // redo → v2
    const redone = await performRedo(state, "s1");
    expect(redone.ok).toBe(true);
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v2");
  });

  test("consecutive multi-undo unwinds to initial state", async () => {
    writeFileSync(filePath("a.txt"), "v1", "utf8");
    const state = createUndoSessionState();

    await simulateToolCall(state, "c1", "edit", filePath("a.txt"), () => writeFileSync(filePath("a.txt"), "v2", "utf8"));
    await simulateToolCall(state, "c2", "edit", filePath("a.txt"), () => writeFileSync(filePath("a.txt"), "v3", "utf8"));

    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v3");
    expect(state.undoStack).toHaveLength(2);

    await performUndo(state, "s1");
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v2");
    await performUndo(state, "s1");
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v1");
    // 栈空
    const empty = await performUndo(state, "s1");
    expect(empty.ok).toBe(false);
    expect(empty.message).toContain("No undo history");
  });

  test("undo to state before file existed, then redo recreates it", async () => {
    const state = createUndoSessionState();
    // 新增文件
    await simulateToolCall(state, "c1", "write", filePath("b.txt"), () => {
      writeFileSync(filePath("b.txt"), "data", "utf8");
    });
    // 修改
    await simulateToolCall(state, "c2", "edit", filePath("b.txt"), () => {
      writeFileSync(filePath("b.txt"), "data2", "utf8");
    });

    // undo edit → data
    await performUndo(state, "s1");
    expect(readFileSync(filePath("b.txt"), "utf8")).toBe("data");
    // undo write → 文件删除(回到创建前)
    await performUndo(state, "s1");
    expect(existsSync(filePath("b.txt"))).toBe(false);
    // redo ×2 → data2
    await performRedo(state, "s1");
    expect(readFileSync(filePath("b.txt"), "utf8")).toBe("data");
    await performRedo(state, "s1");
    expect(readFileSync(filePath("b.txt"), "utf8")).toBe("data2");
  });

  test("file deleted externally → undo recreates it", async () => {
    writeFileSync(filePath("a.txt"), "v1", "utf8");
    const state = createUndoSessionState();
    await simulateToolCall(state, "c1", "edit", filePath("a.txt"), () => writeFileSync(filePath("a.txt"), "v2", "utf8"));
    // 外部删除
    rmSync(filePath("a.txt"), { force: true });
    expect(existsSync(filePath("a.txt"))).toBe(false);

    const result = await performUndo(state, "s1");
    expect(result.ok).toBe(true);
    expect(result.files[0]!.action).toBe("created");
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v1");
  });

  test("restore into missing subdirectory fails gracefully (undo of created file deletes, no dir rebuild)", async () => {
    const state = createUndoSessionState();
    const nested = filePath("sub/deep/n.txt");
    await simulateToolCall(state, "c1", "write", nested, () => {
      mkdirSync(join(projDir, "sub/deep"), { recursive: true });
      writeFileSync(nested, "content", "utf8");
    });
    // 外部删除整个目录
    rmSync(join(projDir, "sub"), { recursive: true, force: true });

    const result = await performUndo(state, "s1");
    expect(result.ok).toBe(true);
    // undo = 删除(创建前不存在),目录不重建
    expect(existsSync(nested)).toBe(false);
  });

  test("blob missing (cache cleared) fails gracefully without corrupting file", async () => {
    writeFileSync(filePath("a.txt"), "v2", "utf8");
    const state = createUndoSessionState();
    // 构造一条 undo 条目但清空缓存(blob 丢失)
    await simulateToolCall(state, "c1", "edit", filePath("a.txt"), () => writeFileSync(filePath("a.txt"), "v3", "utf8"));
    await clearSessionCache("s1");

    const result = await performUndo(state, "s1");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Snapshot blob missing");
    // 文件未被破坏,条目回滚回栈
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v3");
    expect(state.undoStack).toHaveLength(1);
  });

  test("redo with empty stack fails cleanly", async () => {
    const state = createUndoSessionState();
    const result = await performRedo(state, "s1");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No redo history");
  });

  test("multiple files tracked independently", async () => {
    writeFileSync(filePath("x.txt"), "x1", "utf8");
    writeFileSync(filePath("y.txt"), "y1", "utf8");
    const state = createUndoSessionState();

    await simulateToolCall(state, "c1", "edit", filePath("x.txt"), () => writeFileSync(filePath("x.txt"), "x2", "utf8"));
    await simulateToolCall(state, "c2", "edit", filePath("y.txt"), () => writeFileSync(filePath("y.txt"), "y2", "utf8"));

    await performUndo(state, "s1");
    expect(readFileSync(filePath("y.txt"), "utf8")).toBe("y1");
    expect(readFileSync(filePath("x.txt"), "utf8")).toBe("x2"); // x 未受影响

    await performUndo(state, "s1");
    expect(readFileSync(filePath("x.txt"), "utf8")).toBe("x1");
  });

  test("undo navigates conversation to parent leaf; redo to after leaf", async () => {
    writeFileSync(filePath("a.txt"), "v1", "utf8");
    const state = createUndoSessionState();
    const navCalls: string[] = [];
    const nav = {
      waitForIdle: async () => {},
      navigateTree: async (targetId: string) => {
        navCalls.push(targetId);
        return true;
      },
    };

    // 捕获时 leaf-2(操作所在消息),所属回合 user 为 leaf-1
    await simulateToolCall(state, "c1", "edit", filePath("a.txt"), () => writeFileSync(filePath("a.txt"), "v2", "utf8"), "leaf-2", "leaf-1");

    const undone = await performUndo(state, "s1", nav);
    expect(undone.ok).toBe(true);
    expect(undone.message).toContain("Conversation rewound");
    expect(navCalls).toEqual(["leaf-1"]); // undo 导航到所属回合 user
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v1");

    navCalls.length = 0;
    const redone = await performRedo(state, "s1", nav);
    expect(redone.ok).toBe(true);
    expect(redone.message).toContain("Conversation restored");
    expect(navCalls).toEqual(["leaf-2"]); // afterLeafId 缺省时回退到 leafId
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v2");
  });

  test("undo falls back to capture leaf when turn user absent", async () => {
    writeFileSync(filePath("a.txt"), "v1", "utf8");
    const state = createUndoSessionState();
    const navCalls: string[] = [];
    const nav = {
      waitForIdle: async () => {},
      navigateTree: async (targetId: string) => {
        navCalls.push(targetId);
        return true;
      },
    };

    await simulateToolCall(state, "c1", "edit", filePath("a.txt"), () => writeFileSync(filePath("a.txt"), "v2", "utf8"), "leaf-1", null);
    const undone = await performUndo(state, "s1", nav);
    expect(undone.ok).toBe(true);
    expect(navCalls).toEqual(["leaf-1"]); // 无 user → 回退到捕获叶
  });

  test("redo uses afterLeafId when present (conversation moves forward)", async () => {
    writeFileSync(filePath("a.txt"), "v1", "utf8");
    const state = createUndoSessionState();
    const navCalls: string[] = [];
    const nav = {
      waitForIdle: async () => {},
      navigateTree: async (targetId: string) => {
        navCalls.push(targetId);
        return true;
      },
    };

    // 捕获时 leaf-1,确认时 leaf-2(编辑完成后对话前进)
    await simulateToolCall(state, "c1", "edit", filePath("a.txt"), () => writeFileSync(filePath("a.txt"), "v2", "utf8"), "leaf-2");
    // 条目 leafId=leaf-2(与 simulate 一致);手工改成 leaf-1 模拟叶推进
    const entry = state.undoStack[0]!;
    entry.leafId = "leaf-1";
    entry.afterLeafId = "leaf-2";

    await performUndo(state, "s1", nav);
    expect(navCalls).toEqual(["leaf-1"]); // undo 回退到编辑前

    navCalls.length = 0;
    await performRedo(state, "s1", nav);
    expect(navCalls).toEqual(["leaf-2"]); // redo 前进到编辑后
  });

  test("conversation navigation skipped when nav capability absent (headless)", async () => {
    writeFileSync(filePath("a.txt"), "v1", "utf8");
    const state = createUndoSessionState();
    await simulateToolCall(state, "c1", "edit", filePath("a.txt"), () => writeFileSync(filePath("a.txt"), "v2", "utf8"), "leaf-1");

    const result = await performUndo(state, "s1", undefined);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("(conversation not rewound: non-interactive)");
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v1");
  });

  test("navigation failure still restores file and reports it", async () => {
    writeFileSync(filePath("a.txt"), "v1", "utf8");
    const state = createUndoSessionState();
    const nav = {
      waitForIdle: async () => {},
      navigateTree: async () => false, // 导航取消/失败
    };

    await simulateToolCall(state, "c1", "edit", filePath("a.txt"), () => writeFileSync(filePath("a.txt"), "v2", "utf8"), "leaf-1");
    const result = await performUndo(state, "s1", nav);
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("Conversation rewound");
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v1");
  });
});

// ── 扩展工厂接线 ─────────────────────────────────────────────────────────

describe("undo extension factory", () => {
  interface FakePi {
    commands: Map<string, { description: string; handler: (args: string, ctx: FakeCtx) => Promise<void> }>;
    handlers: Record<string, Array<(event: unknown, ctx?: FakeCtx) => Promise<void> | void>>;
    on: (event: string, handler: (event: unknown, ctx?: FakeCtx) => Promise<void> | void) => void;
    registerCommand: (name: string, opts: { description: string; handler: (args: string, ctx: FakeCtx) => Promise<void> }) => void;
    registerTool: () => void;
    sendMessage: () => void;
    sendUserMessage: () => void;
  }

  interface FakeCtx {
    sessionManager: {
      getSessionId: () => string;
      getLeafId: () => string;
      getLeafEntry?: () => { type: string; id: string; parentId: string | null; message?: { role?: string; content?: Array<{ type?: string }> } } | undefined;
      getEntry?: (id: string) => { type: string; id: string; parentId: string | null; message?: { role?: string; content?: Array<{ type?: string }> } } | undefined;
    };
    cwd: string;
    hasUI: boolean;
    ui: { notify: (message: string, level: string) => void };
    notifies: Array<{ message: string; level: string }>;
  }

  function makeFakePi(): FakePi {
    const commands = new Map<string, { description: string; handler: (args: string, ctx: FakeCtx) => Promise<void> }>();
    const handlers: Record<string, Array<(event: unknown, ctx?: FakeCtx) => Promise<void> | void>> = {};
    return {
      commands,
      handlers,
      on: (event: string, handler: (event: unknown, ctx?: FakeCtx) => Promise<void> | void) => {
        (handlers[event] ??= []).push(handler);
      },
      registerCommand: (name: string, opts: { description: string; handler: (args: string, ctx: FakeCtx) => Promise<void> }) => {
        commands.set(name, opts);
      },
      registerTool: () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
    };
  }

  function makeCtx(): FakeCtx {
    const notifies: Array<{ message: string; level: string }> = [];
    return {
      sessionManager: { getSessionId: () => "s1", getLeafId: () => "leaf-1" },
      cwd: projDir,
      hasUI: true,
      ui: { notify: (message: string, level: string) => notifies.push({ message, level }) },
      notifies,
    };
  }

  /** 结构化相似足以驱动扩展的最小 pi;仅测试接线,类型边界允许 unchecked cast */
  function installExtension(): { pi: FakePi; ctx: FakeCtx } {
    const pi = makeFakePi();
    undoExtension(pi as unknown as ExtensionAPI);
    return { pi, ctx: makeCtx() };
  }

  /** 走完整事件链:tool_call → (改文件) → tool_result;handler 为 async,直接 await */
  async function runEditChain(pi: FakePi, ctx: FakeCtx, toolCallId: string, path: string, writeNewContent: string): Promise<void> {
    await pi.handlers["tool_call"]![0]!({ type: "tool_call", toolName: "edit", toolCallId, input: { path } }, ctx);
    writeFileSync(filePath(path), writeNewContent, "utf8");
    await pi.handlers["tool_result"]![0]!(
      { type: "tool_result", toolName: "edit", toolCallId, input: { path }, content: [], isError: false },
      ctx,
    );
  }

  test("registers /undo /redo /undo-status /undo-clear commands", () => {
    const { pi } = installExtension();
    for (const name of ["undo", "redo", "undo-status", "undo-clear"]) {
      expect(pi.commands.has(name)).toBe(true);
    }
  });

  test("tool_call captures, tool_result success commits entry; /undo restores", async () => {
    const { pi, ctx } = installExtension();
    writeFileSync(filePath("a.txt"), "v1", "utf8");

    await runEditChain(pi, ctx, "c1", "a.txt", "v2");
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v2");

    await pi.commands.get("undo")!.handler("", ctx);
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v1");
    expect(ctx.notifies.at(-1)!.level).toBe("info");
  });

  test("failed tool_result does not create undo entry", async () => {
    const { pi, ctx } = installExtension();
    writeFileSync(filePath("a.txt"), "v1", "utf8");

    await pi.handlers["tool_call"]![0]!({ type: "tool_call", toolName: "edit", toolCallId: "c1", input: { path: "a.txt" } }, ctx);
    await pi.handlers["tool_result"]![0]!(
      { type: "tool_result", toolName: "edit", toolCallId: "c1", input: { path: "a.txt" }, content: [], isError: true },
      ctx,
    );

    await pi.commands.get("undo")!.handler("", ctx);
    expect(ctx.notifies.at(-1)!.message).toContain("No undo history");
    expect(ctx.notifies.at(-1)!.level).toBe("warning");
  });

  test("disabled via settings.json skips capture and blocks undo", async () => {
    mkdirSync(join(testHome, "agent"), { recursive: true });
    writeFileSync(join(testHome, "agent", "settings.json"), JSON.stringify({ undo: { enabled: false } }));
    expect(readUndoConfig().enabled).toBe(false);

    const { pi, ctx } = installExtension();
    writeFileSync(filePath("a.txt"), "v1", "utf8");

    await runEditChain(pi, ctx, "c1", "a.txt", "v2");
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v2");

    await pi.commands.get("undo")!.handler("", ctx);
    expect(ctx.notifies.at(-1)!.message).toContain("Undo is disabled");
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v2");
  });

  test("undo-clear resets stacks and cache", async () => {
    const { pi, ctx } = installExtension();
    writeFileSync(filePath("a.txt"), "v1", "utf8");

    await runEditChain(pi, ctx, "c1", "a.txt", "v2");
    await pi.commands.get("undo-clear")!.handler("", ctx);
    expect(ctx.notifies.at(-1)!.message).toContain("cleared");
    expect(existsSync(undoCacheRoot("s1"))).toBe(false);

    await pi.commands.get("undo")!.handler("", ctx);
    expect(ctx.notifies.at(-1)!.message).toContain("No undo history");
  });

  test("session_shutdown drops in-memory state", async () => {
    const { pi, ctx } = installExtension();
    writeFileSync(filePath("a.txt"), "v1", "utf8");

    await runEditChain(pi, ctx, "c1", "a.txt", "v2");
    await pi.handlers["session_shutdown"]![0]!({}, ctx);
    await pi.commands.get("undo")!.handler("", ctx);
    expect(ctx.notifies.at(-1)!.message).toContain("No undo history");
  });



  test("redo after undo via factory commands", async () => {
    const { pi, ctx } = installExtension();
    writeFileSync(filePath("a.txt"), "v1", "utf8");

    await runEditChain(pi, ctx, "c1", "a.txt", "v2");
    await pi.commands.get("undo")!.handler("", ctx);
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v1");
    await pi.commands.get("redo")!.handler("", ctx);
    expect(readFileSync(filePath("a.txt"), "utf8")).toBe("v2");
  });
});
