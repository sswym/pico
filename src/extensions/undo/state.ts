/**
 * undo/redo 会话状态与核心逻辑(纯逻辑,可独立单测)。
 *
 * 捕获流程:
 *   captureBefore(toolCallId, tool, path) — tool_call 时调用,读文件原内容存快照
 *   confirm(toolCallId, after) — tool_result 成功时调用,after 为工具执行后的文件状态
 *   cancel(toolCallId) — tool_result 失败时调用,丢弃暂存
 *
 * undo/redo 流程:
 *   undo() / redo() — 操作栈;恢复文件时采用「恢复到快照」而非「反向应用」,
 *   天然幂等(OpenCode restore 思想)。undo 后新捕获会清空 redo 栈。
 */
import type { UndoConfig, UndoEntry, UndoResult, UndoSessionState } from "./types.ts";

export function createUndoSessionState(): UndoSessionState {
  return {
    undoStack: [],
    redoStack: [],
    pending: new Map(),
  };
}

/** 生成条目 id:时间戳 + 递增计数(进程内唯一) */
let idCounter = 0;
export function nextEntryId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function isSameContent(a: { hash: string | null }, b: { hash: string | null }): boolean {
  return a.hash === b.hash && a.hash !== null;
}

/** tool_call:登记修改前状态。返回 true 表示已暂存(内容不同或文件新增)。 */
export function captureBefore(
  state: UndoSessionState,
  toolCallId: string,
  tool: UndoEntry["tool"],
  path: string,
  displayPath: string,
  before: { hash: string | null },
  leafId: string | null,
  turnUserId: string | null,
): boolean {
  state.pending.set(toolCallId, { tool, path, displayPath, before, leafId, turnUserId });
  return true;
}

/**
 * tool_result 成功:将暂存提升为正式条目入 undo 栈,清空 redo 栈。
 * before/after 内容相同(空操作)时丢弃,不产生条目。
 */
export function confirmCapture(
  state: UndoSessionState,
  toolCallId: string,
  after: { hash: string | null },
  afterLeafId: string | null = null,
  at = Date.now(),
): UndoEntry | null {
  const pending = state.pending.get(toolCallId);
  if (!pending) return null;
  state.pending.delete(toolCallId);

  if (isSameContent(pending.before, after)) return null;

  const entry: UndoEntry = {
    id: nextEntryId(),
    tool: pending.tool,
    path: pending.path,
    displayPath: pending.displayPath,
    before: { ...pending.before },
    after: { ...after },
    toolCallId,
    at,
    leafId: pending.leafId,
    turnUserId: pending.turnUserId,
    afterLeafId,
  };
  state.undoStack.push(entry);
  // 新编辑使 redo 分支失效(与 git/编辑器语义一致)
  state.redoStack.length = 0;
  return entry;
}

/** tool_result 失败:丢弃暂存。 */
export function cancelCapture(state: UndoSessionState, toolCallId: string): boolean {
  return state.pending.delete(toolCallId);
}

/** 弹出下一个待恢复的 undo 条目;空栈返回 null */
export function popUndo(state: UndoSessionState): UndoEntry | null {
  return state.undoStack.pop() ?? null;
}

/** 弹出下一个待恢复的 redo 条目;空栈返回 null */
export function popRedo(state: UndoSessionState): UndoEntry | null {
  return state.redoStack.pop() ?? null;
}

/** 恢复完成后压入对方栈 */
export function pushUndo(state: UndoSessionState, entry: UndoEntry): void {
  state.undoStack.push(entry);
}

export function pushRedo(state: UndoSessionState, entry: UndoEntry): void {
  state.redoStack.push(entry);
}

/** 超限裁剪:保留最近 maxEntries 条(最旧淘汰) */
export function trimUndoStack(state: UndoSessionState, maxEntries: number): void {
  if (maxEntries <= 0 || state.undoStack.length <= maxEntries) return;
  state.undoStack.splice(0, state.undoStack.length - maxEntries);
}

/** 汇总 undo/redo 状态文本(供 /undo status) */
export function describeState(state: UndoSessionState, config: UndoConfig): string {
  const undoN = state.undoStack.length;
  const redoN = state.redoStack.length;
  const pendingN = state.pending.size;
  const lines = [
    `Undo entries: ${undoN}/${config.maxEntries}`,
    `Redo entries: ${redoN}`,
    `Pending captures: ${pendingN}`,
  ];
  if (undoN > 0) {
    const latest = state.undoStack.at(-1)!;
    lines.push(`Latest: ${latest.displayPath} (${latest.tool}, ${new Date(latest.at).toISOString()})`);
  }
  return lines.join("\n");
}

/** 测试钩子:重置进程级 id 计数 */
export function __resetUndoIdForTests(): void {
  idCounter = 0;
}

/** 供测试断言:导出空结果构造 */
export function emptyUndoResult(message: string): UndoResult {
  return { ok: false, message, files: [] };
}

/** 会话树条目的最小形状(供向上查找;仅依赖 id/parentId/role/content) */
export interface UndoTreeEntry {
  type: string;
  id: string;
  parentId: string | null;
  message?: { role?: string; content?: Array<{ type?: string }> };
}

/**
 * 沿 parent 链向上查找「最近的 user 消息」,返回它的 id = 该工具操作所属
 * 回合的对话起点。
 *
 * 背景:一次 user 消息驱动的回合内常有多个工具调用,会话树按
 * `assistant(toolCall) → custom → toolResult → assistant(toolCall) → …`
 * 逐段 append,每个 toolCall 消息的父是前一个 toolResult 而非 user。
 * 若只回退到 toolCall 消息的父,对话停在回合中间(残留工具卡与结果)。
 * 回退到最近的 user 消息,整轮操作从对话中消失,对齐 Claude Code
 * 「回退到某条 user 消息」的语义。
 *
 * @param getEntry 按 id 取条目(会话树查找器)
 * @param leafId   捕获时的叶 id
 * @returns 最近 user 消息 id;找不到返回 null
 */
export function findUndoTurnUser(
  getEntry: (id: string) => UndoTreeEntry | undefined,
  leafId: string | null,
): string | null {
  if (!leafId) return null;
  let entry = getEntry(leafId);
  let guard = 0;
  while (entry && guard < 500) {
    guard++;
    if (entry.type === "message") {
      const role = entry.message?.role;
      if (role === "user") {
        return entry.id;
      }
    }
    entry = entry.parentId ? getEntry(entry.parentId) : undefined;
  }
  return null;
}
