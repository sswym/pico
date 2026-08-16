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
  popRedo,
  popUndo,
  pushRedo,
  pushUndo,
  trimUndoStack,
  __resetUndoIdForTests,
} from "./state.ts";
import type { UndoConfig, UndoResult, UndoSessionState } from "./types.ts";

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

/** /undo 核心:恢复到修改前状态 */
export async function performUndo(
  state: UndoSessionState,
  sessionId: string,
): Promise<UndoResult> {
  const entry = popUndo(state);
  if (!entry) return emptyUndoResult("No undo history.");

  const files: UndoResult["files"] = [];
  try {
    const { action } = await restoreFileToSnapshot(sessionId, entry.path, entry.before);
    files.push({ path: entry.displayPath, action });
    // 条目原样入 redo 栈:redo 恢复 entry.after(修改后状态)
    pushRedo(state, entry);
  } catch (err) {
    // 单文件失败:回滚栈状态,不丢失条目
    pushUndo(state, entry);
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      files,
    };
  }
  return {
    ok: true,
    message: `Undid ${entry.tool} on ${entry.displayPath} (${files[0]!.action}).`,
    files,
  };
}

/** /redo 核心:恢复到修改后状态 */
export async function performRedo(
  state: UndoSessionState,
  sessionId: string,
): Promise<UndoResult> {
  const entry = popRedo(state);
  if (!entry) return emptyUndoResult("No redo history.");

  const files: UndoResult["files"] = [];
  try {
    const { action } = await restoreFileToSnapshot(sessionId, entry.path, entry.after);
    files.push({ path: entry.displayPath, action });
    // 条目原样回 undo 栈:下次 undo 恢复 entry.before
    pushUndo(state, entry);
  } catch (err) {
    pushRedo(state, entry);
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      files,
    };
  }
  return {
    ok: true,
    message: `Redid ${entry.tool} on ${entry.displayPath} (${files[0]!.action}).`,
    files,
  };
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
    captureBefore(getState(ctx), event.toolCallId, event.toolName, absPath, displayPath(absPath, ctx.cwd), snapshot);
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
    const entry = confirmCapture(state, event.toolCallId, after);
    if (entry) trimUndoStack(state, readUndoConfig().maxEntries);
  });

  // ── 命令 ────────────────────────────────────────────────────────────────
  pi.registerCommand("undo", {
    description: "Undo the last edit/write file change",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const config = readUndoConfig();
      if (!config.enabled) {
        notify(ctx, emptyUndoResult("Undo is disabled (settings.json undo.enabled=false)."));
        return;
      }
      const result = await performUndo(getState(ctx), sessionKey(ctx));
      notify(ctx, result);
    },
  });

  pi.registerCommand("redo", {
    description: "Redo a change undone with /undo",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const config = readUndoConfig();
      if (!config.enabled) {
        notify(ctx, emptyUndoResult("Undo is disabled (settings.json undo.enabled=false)."));
        return;
      }
      const result = await performRedo(getState(ctx), sessionKey(ctx));
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
