/**
 * pico undo/redo 扩展。
 *
 * 对标 Claude Code rewind / OpenCode undo 的旁路观测式实现:
 * - 捕获:`pi.on("tool_call")` 在 edit/write 执行**前**读文件原内容存 blob;
 *   `pi.on("tool_result")` 成功才入 undo 栈、失败丢弃。零侵入——不改任何
 *   工具、不重定向执行路径,AI 始终直连真实文件系统(规避 pi-undo-redo
 *   沙箱化导致 AI 看不到 node_modules 的历史缺陷)。
 * - 回滚:文件级「恢复到快照」(OpenCode restore 思想,幂等),支持多级
 *   undo/redo、文件新增(undo=删除)/删除(undo=重建)。
 * - 命令:`/undo` `/redo` `/undo status` `/undo clear`。
 * - 配置:settings.json 的 `undo` 命名空间(enabled/maxEntries)。
 *
 * 详见 docs/undo-design.md。
 */
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  EditToolCallEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
  isEditToolResult,
  isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { readSettingsObject } from "../settings.ts";
import { clearSessionCache, readBlob, snapshotFile, writeBlob } from "./blob-store.ts";
import {
  cancelCapture,
  captureBefore,
  confirmCapture,
  createUndoSessionState,
  describeState,
  emptyUndoResult,
  findUndoTurnUser,
  popRedo,
  popUndo,
  pushRedo,
  pushUndo,
  trimUndoStack,
  __resetUndoIdForTests,
} from "./state.ts";
import type { UndoConfig, UndoResult, UndoSessionState } from "./types.ts";
import type { UndoTreeEntry } from "./state.ts";

const SESSION_FALLBACK = "__default__";

export { __resetUndoIdForTests };

export function readUndoConfig(): UndoConfig {
  const raw = readSettingsObject("undo");
  return {
    enabled: raw.enabled !== false,
    maxEntries:
      typeof raw.maxEntries === "number" && raw.maxEntries > 0
        ? Math.floor(raw.maxEntries)
        : 50,
  };
}

function sessionKey(ctx: { sessionManager?: { getSessionId?: () => string | undefined } }): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? SESSION_FALLBACK;
  } catch {
    return SESSION_FALLBACK;
  }
}

function getLeafId(ctx: { sessionManager?: { getLeafId?: () => string | null | undefined } }): string | null {
  try {
    return ctx.sessionManager?.getLeafId?.() ?? null;
  } catch {
    return null;
  }
}

/** 该工具操作所属回合的 user 消息 id;无 user 祖先/不可得返回 null */
function getTurnUserId(ctx: ExtensionContext): string | null {
  try {
    const sm = ctx.sessionManager;
    const getEntry = (id: string): UndoTreeEntry | undefined => {
      const entry = sm?.getEntry?.(id);
      if (!entry) return undefined;
      const msg = (entry as { message?: unknown }).message;
      if (msg && typeof msg === "object" && "role" in msg) {
        const role = (msg as { role?: unknown }).role;
        return {
          type: entry.type,
          id: entry.id,
          parentId: entry.parentId,
          message: { role: typeof role === "string" ? role : undefined },
        };
      }
      return { type: entry.type, id: entry.id, parentId: entry.parentId };
    };
    return findUndoTurnUser(getEntry, getLeafId(ctx));
  } catch {
    return null;
  }
}

/** 从命令上下文构造会话导航能力(交互模式);非交互返回 undefined */
function navigationFromCtx(ctx: ExtensionCommandContext): UndoNavigation | undefined {
  if (typeof ctx.waitForIdle !== "function" || typeof ctx.navigateTree !== "function") {
    return undefined;
  }
  return {
    waitForIdle: () => ctx.waitForIdle(),
    navigateTree: async (targetId: string) => {
      try {
        const result = await ctx.navigateTree(targetId, { summarize: false });
        return !result.cancelled;
      } catch {
        return false;
      }
    },
  };
}

function displayPath(absPath: string, cwd: string): string {
  const relative = path.relative(cwd, absPath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return absPath;
}

/** 从工具 input 解析文件路径(edit/write 的 path 字段,相对 cwd) */
function resolveInputPath(input: Record<string, unknown>, cwd: string): string | null {
  const raw = input.path;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
}

function isEditCall(event: ToolCallEvent): event is EditToolCallEvent {
  return event.toolName === "edit";
}
function isWriteCall(event: ToolCallEvent): event is WriteToolCallEvent {
  return event.toolName === "write";
}

/** 恢复到某个文件快照:hash 存在 → 写回;null → 删除(文件当时不存在) */
export async function restoreFileToSnapshot(
  sessionId: string,
  absPath: string,
  snapshot: { hash: string | null },
): Promise<{ action: "restored" | "deleted" | "created" }> {
  if (snapshot.hash === null) {
    await rm(absPath, { force: true });
    return { action: "deleted" };
  }
  const content = await readBlob(sessionId, snapshot.hash);
  if (content === null) {
    // blob 丢失(缓存被清/损坏):跳过,不破坏现状
    throw new Error(`Snapshot blob missing for ${absPath}`);
  }
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, content);
  return { action: "created" };
}

/** 会话树导航能力(交互模式);非交互时 undefined → 只回退文件 */
export interface UndoNavigation {
  /** 等 agent 空闲(避免导航打断流式生成) */
  waitForIdle(): Promise<void>;
  /** 导航到目标叶节点(对话回退)。返回 false 表示取消/失败。 */
  navigateTree(targetId: string): Promise<boolean>;
}

interface RestoreOutcome {
  files: UndoResult["files"];
  /** 会话导航是否发生(用于消息提示) */
  navigated: boolean;
  /** 导航是否因非交互/无叶节点而跳过 */
  navSkipped: boolean;
}

/** 先恢复文件,再(能力可用时)把对话导航到目标叶节点 */
async function restoreWithNavigation(
  displayPath: string,
  targetLeafId: string | null,
  nav: UndoNavigation | undefined,
  restore: () => Promise<{ action: "restored" | "deleted" | "created" }>,
): Promise<RestoreOutcome> {
  const files: UndoResult["files"] = [];
  const outcome: RestoreOutcome = { files, navigated: false, navSkipped: false };

  try {
    const { action } = await restore();
    files.push({ path: displayPath, action });
  } catch (err) {
    throw err;
  }

  if (!targetLeafId || !nav) {
    outcome.navSkipped = true;
    return outcome;
  }
  await nav.waitForIdle();
  const ok = await nav.navigateTree(targetLeafId);
  outcome.navigated = ok;
  return outcome;
}

/** /undo 核心:恢复文件到修改前 + 把对话回退到该操作所属回合的 user 消息 */
export async function performUndo(
  state: UndoSessionState,
  sessionId: string,
  nav?: UndoNavigation,
): Promise<UndoResult> {
  const entry = popUndo(state);
  if (!entry) return emptyUndoResult("No undo history.");

  try {
    // 对话回退到该回合的 user 消息(整轮操作从对话消失);无 user 则回退捕获叶
    const outcome = await restoreWithNavigation(
      entry.displayPath, entry.turnUserId ?? entry.leafId, nav,
      () => restoreFileToSnapshot(sessionId, entry.path, entry.before),
    );
    // 条目原样入 redo 栈:redo 恢复 entry.after(修改后状态)
    pushRedo(state, entry);
    const navText = outcome.navigated
      ? " Conversation rewound."
      : outcome.navSkipped && entry.leafId
        ? " (conversation not rewound: non-interactive)"
        : "";
    return {
      ok: true,
      message: `Undid ${entry.tool} on ${entry.displayPath} (${outcome.files[0]!.action}).${navText}`,
      files: outcome.files,
    };
  } catch (err) {
    // 单文件失败:回滚栈状态,不丢失条目
    pushUndo(state, entry);
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      files: [],
    };
  }
}

/** /redo 核心:恢复文件到修改后 + 把对话前进到重做时刻 */
export async function performRedo(
  state: UndoSessionState,
  sessionId: string,
  nav?: UndoNavigation,
): Promise<UndoResult> {
  const entry = popRedo(state);
  if (!entry) return emptyUndoResult("No redo history.");

  try {
    const outcome = await restoreWithNavigation(
      entry.displayPath, entry.afterLeafId ?? entry.leafId, nav,
      () => restoreFileToSnapshot(sessionId, entry.path, entry.after),
    );
    // 条目原样回 undo 栈:下次 undo 恢复 entry.before
    pushUndo(state, entry);
    const navText = outcome.navigated
      ? " Conversation restored."
      : outcome.navSkipped && entry.leafId
        ? " (conversation not restored: non-interactive)"
        : "";
    return {
      ok: true,
      message: `Redid ${entry.tool} on ${entry.displayPath} (${outcome.files[0]!.action}).${navText}`,
      files: outcome.files,
    };
  } catch (err) {
    pushRedo(state, entry);
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      files: [],
    };
  }
}

export function undoExtension(pi: ExtensionAPI): void {
  const states = new Map<string, UndoSessionState>();

  const getState = (ctx: ExtensionContext): UndoSessionState => {
    const key = sessionKey(ctx);
    let state = states.get(key);
    if (!state) {
      state = createUndoSessionState();
      states.set(key, state);
    }
    return state;
  };

  const notify = (ctx: ExtensionCommandContext | ExtensionContext, result: UndoResult) => {
    if (ctx.hasUI) {
      try {
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
      } catch {}
    } else {
      try {
        console.log(result.message);
      } catch {}
    }
  };

  // ── 捕获:edit/write 执行前读原内容 ─────────────────────────────────────
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    const config = readUndoConfig();
    if (!config.enabled) return;
    if (!isEditCall(event) && !isWriteCall(event)) return;

    const absPath = resolveInputPath(event.input, ctx.cwd);
    if (!absPath) return;

    const snapshot = await snapshotFile(absPath);
    if (snapshot.hash !== null) {
      await writeBlob(sessionKey(ctx), snapshot.hash, await readFile(absPath));
    }
    const leafId = getLeafId(ctx);
    const turnUserId = getTurnUserId(ctx);
    captureBefore(getState(ctx), event.toolCallId, event.toolName, absPath, displayPath(absPath, ctx.cwd), snapshot, leafId, turnUserId);
  });

  // ── 确认/丢弃:工具结果 ────────────────────────────────────────────────
  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    const config = readUndoConfig();
    if (!config.enabled) return;
    if (!isEditToolResult(event) && !isWriteToolResult(event)) return;

    const state = getState(ctx);
    const key = sessionKey(ctx);
    if (event.isError) {
      cancelCapture(state, event.toolCallId);
      return;
    }

    const pending = state.pending.get(event.toolCallId);
    if (!pending) return;
    const after = await snapshotFile(pending.path);
    if (after.hash !== null) {
      await writeBlob(key, after.hash, await readFile(pending.path));
    }
    const entry = confirmCapture(state, event.toolCallId, after, getLeafId(ctx));
    if (entry) trimUndoStack(state, readUndoConfig().maxEntries);
  });

  // ── 命令 ────────────────────────────────────────────────────────────────
  pi.registerCommand("undo", {
    description: "Undo the last edit/write file change (files and conversation)",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const config = readUndoConfig();
      if (!config.enabled) {
        notify(ctx, emptyUndoResult("Undo is disabled (settings.json undo.enabled=false)."));
        return;
      }
      const result = await performUndo(getState(ctx), sessionKey(ctx), navigationFromCtx(ctx));
      notify(ctx, result);
    },
  });

  pi.registerCommand("redo", {
    description: "Redo a change undone with /undo (files and conversation)",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const config = readUndoConfig();
      if (!config.enabled) {
        notify(ctx, emptyUndoResult("Undo is disabled (settings.json undo.enabled=false)."));
        return;
      }
      const result = await performRedo(getState(ctx), sessionKey(ctx), navigationFromCtx(ctx));
      notify(ctx, result);
    },
  });

  pi.registerCommand("undo-status", {
    description: "Show undo/redo stack status",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const state = getState(ctx);
      const text = describeState(state, readUndoConfig());
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(text, "info");
        } catch {}
      } else {
        console.log(text);
      }
    },
  });

  pi.registerCommand("undo-clear", {
    description: "Clear undo/redo history and snapshot cache for this session",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const key = sessionKey(ctx);
      states.delete(key);
      await clearSessionCache(key);
      if (ctx.hasUI) {
        try {
          ctx.ui.notify("Undo history cleared.", "info");
        } catch {}
      } else {
        console.log("Undo history cleared.");
      }
    },
  });

  // ── 生命周期:会话关闭清理内存(磁盘 blob 保留供跨会话复用,受后续 GC 约束) ──
  pi.on("session_shutdown", (_event, ctx) => {
    const key = sessionKey(ctx);
    states.delete(key);
  });
}

export default undoExtension;
