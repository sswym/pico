# 代码操作回退能力 — 选型与实现方案

> 对标 OpenCode undo / Claude Code rewind。调研基于两份源码通读:
> - OpenCode: `/home/david/opencode`(V1 `packages/opencode/src/snapshot` + V2 `packages/core/src/snapshot`)
> - Claude Code: `/home/david/claude-code`(`src/utils/fileHistory.ts` + 编辑工具埋点)
>
> 本文档先对比两套架构,再给出本项目(pico)的选型、裁剪与适配。

---

## 1. 调研对比:两套实现

### 1.1 OpenCode —「影子 git 仓库 + tree hash 快照」

**核心机制**:用一个独立的影子 git 仓库(`~/.local/share/opencode/snapshot/<project>/<hash(worktree)>`),通过 `--git-dir`/`--work-tree` 跟踪真实工作树。快照 = `git write-tree` 得到的 tree hash,增量对象存储,天然去重。

**数据结构**:
- `Snapshot.Patch { hash, files }` — hash 是**改动前**的 tree hash,files 是本次 step 改动文件绝对路径(`packages/opencode/src/snapshot/index.ts:14-17`)
- `Session.Revert { messageID, partID?, snapshot?, diff? }` — 回滚标记,含回滚前捕获的 tree hash 与 unified diff(`session/session.ts:209-214`)
- 消息级 `message.snapshot { start?, end?, files? }`(V2)

**捕获时机**:不在工具调用边界,而在 **LLM step 边界**(V1 `session/processor.ts`):
- `create()` 消息开始时 `snapshot.track()`
- `step-start` 事件补前置 snapshot
- `step-finish` 事件 `track()` + `patch()` 算出本 step 改动文件,写 patch part
- 失败/中断兜底:processor `cleanup()` 里若 snapshot 未结算也补写 patch part

**回滚流程**(V1 `session/revert.ts`):
1. 定位回滚边界 messageID/partID,收集边界后所有 patch part
2. 若有上次 revert 先 `snap.restore()` 全量恢复(幂等)
3. `snap.revert(patches)`:按文件去重、保留最早 hash,`git checkout <hash> -- <file>` 恢复;`ls-tree` 确认文件不在目标 tree 则删除(处理新增文件)
4. 计算 diff、持久化 revert 标记

**边界**:
- 多次 undo/redo:revert.snapshot 复用 + 先 restore 再 revert 幂等
- 文件新增/删除:目标 tree 无此文件 → 删除文件
- 部分消息:支持 partID 级回滚
- 失败:git 失败 logError 后放弃;批量失败降级单文件
- 并发:每 gitdir 一个 Semaphore 串行化;会话忙碌拒绝 revert
- 跨会话:影子 git 持久化,重启可继续

**存储与生命周期**:影子 git 增量对象;每小时 `git gc --prune=7.days`;`snapshot` 配置开关;非 git 项目直接禁用。

**优点**:内容寻址 + git 增量,快照成本≈diff 大小;复用 git 语义(rename/binary/diff);按文件粒度恢复精准;step 粒度多级 undo 幂等;跨会话持久。
**缺陷**:仅 git 项目可用;无工具失败自动回滚;粒度是 LLM step 而非单次写操作(无法撤销单次 edit);>2MB untracked 与 gitignore 文件不在快照内;每 step 两次全树 git 操作有性能成本;V1 全量 restore 会覆盖用户并行改动。

### 1.2 Claude Code —「编辑工具前置埋点 + 按消息快照 + 全量文件备份」

**核心机制**:每次编辑工具执行**前**保存修改前内容为备份(全量拷贝到 `~/.claude/file-history/{sessionId}/`),每条用户消息到达时把变更过的文件提升版本号并入新快照。内存只存元数据,内容全部落盘。

**数据结构**(`src/utils/fileHistory.ts:20-37`):
- `FileHistoryBackup { backupFileName: string | null, version, backupTime }` — null 表示文件当时不存在
- `FileHistorySnapshot { messageId, trackedFileBackups: Record<路径, FileHistoryBackup>, timestamp }`
- `FileHistoryState { snapshots[], trackedFiles, snapshotSequence }`
- 磁盘备份:`{configHome}/file-history/{sessionId}/{sha256(filePath).slice(0,16)}@v{version}`,每 (文件,版本) 一个全量副本
- 上限 `MAX_SNAPSHOTS = 20`,超出淘汰最旧

**捕获时机**:
- `fileHistoryTrackEdit` — 编辑工具内部埋点,必须在文件实际被改**之前**调用:Edit(`FileEditTool.ts:427-435`)、Write(`FileWriteTool.ts:256-264`)、NotebookEdit、Bash 模拟 sed。三阶段:检查已追踪则跳过 → 异步 createBackup(v1) → 提交时重查竞态
- `fileHistoryMakeSnapshot` — 每条 user 消息到达时调用,对每个 trackedFile 做 stat:ENOENT 记 null(文件被删);未变复用;变了 createBackup(version+1)

**回滚流程**(`fileHistoryRewind` → `applySnapshot`):
1. 用 no-op updater 捕获当前 state(不修改内存态,"rewind 是纯文件系统副作用")
2. `snapshots.findLast(s => s.messageId === messageId)` 定位目标
3. 遍历 `trackedFiles` 并集:目标快照有备份 → `checkOriginFileChanged`(stat mode/size → mtime → 内容比对)已变才 restoreBackup(copyFile + chmod + mkdir);备份 null → unlink 删除;未跟踪 → 回退到 v1
4. 每文件独立 try/catch,单文件失败不阻塞其余

**边界**:
- 多次回退:rewind 不改内存态、不删备份,可反复回退;幂等
- 新增/删除:新增文件 v1=null,回退到创建前 → unlink;外部删除 → 记 null 备份,回退重建
- 部分修改:只恢复与目标备份不同的文件;`trackedFiles` 之外的路径完全不动
- 失败:备份缺失跳过;快照缺失 throw;单文件失败 continue
- 并发:trackEdit Phase-3 重查竞态防双写 v1;rewind 执行期间无锁

**存储与生命周期**:内容全量磁盘、元数据内存(20 快照上限);快照元数据持久化进会话 JSONL(`file-history-snapshot` 条目);`--resume` 时硬链接迁移备份目录重建内存态;30 天自动清理旧 session 目录;`/clear` 重置。

**优点**:语义清晰(按用户消息建 checkpoint);只回滚确实被 AI 编辑过的文件,未改动文件零开销;失败隔离好;dry-run/diff 预览;工程细节扎实(copyFile 防 OOM、stat 分离源缺失/目录缺失、幂等 v1)。
**缺陷**:覆盖面窄——只追踪走过 Edit/Write/NotebookEdit/模拟 sed 的文件,bash 重定向/git 操作**不可回滚**;全量备份非增量,磁盘随版本数线性增长;回滚不等同时间旅行(不截断后续快照、不联动对话);无并发防护;内存态依赖 React 全局 AppState,无 state 入口需传 no-op updater。

### 1.3 对比总表

| 维度 | OpenCode | Claude Code |
|---|---|---|
| 快照载体 | 影子 git tree hash(增量对象) | 全量文件副本(sha256@vN 命名) |
| 捕获粒度 | LLM step 边界 | 编辑工具调用前 + 每条 user 消息 |
| 捕获方式 | 事件驱动(processor step 事件) | 工具源码埋点(trackEdit) |
| 回滚粒度 | 消息/part 级,按文件去重保最早 | 消息级,按文件比对选择性恢复 |
| 依赖 | 必须是 git 项目 | 无(纯文件系统) |
| 存储位置 | ~/.local/share/opencode/snapshot/ | ~/.claude/file-history/{sessionId}/ |
| 跨会话 | 影子 git 持久化 | JSONL 持久化 + resume 硬链接迁移 |
| 清理 | git gc prune 7 天 | 30 天删除旧 session 目录 |
| 自动回滚 | 无(失败消息仅补 patch part 供手动 revert) | 无 |
| 多次 undo | 幂等(restore+revert) | 幂等(不改内存态) |
| 失败隔离 | git 失败降级单文件 | 单文件 try/catch continue |

---

## 2. 选型:本项目采用「Claude Code 思路 + OpenCode 幂等思想」裁剪适配

### 2.1 为什么不用 OpenCode 影子 git 方案

1. **项目依赖冲突**:pico 是通用 AI coding agent,目标项目**不一定是 git 仓库**(初始化、单文件编辑、非 git 目录都常见)。影子 git 方案在非 git 项目直接禁用,覆盖面大打折扣。
2. **粒度不匹配**:OpenCode 快照在 LLM step 边界(一个 step = 一次完整模型输出回合,可能含多个工具调用)。用户要求"代码操作回退"——单次 edit/write 操作级回退更符合直觉(对标 Claude Code rewind 的精确性)。step 级无法撤销单次 edit。
3. **性能**:每 step 两次全树 `git add + write-tree`,超大仓库成本高。pico 会话频繁(每条用户消息多个 step),全树哈希开销不可接受。
4. **本项目的直接教训**:pico 曾内置 sandbox 式 undo-redo(pi-undo-redo),因**工具被重定向到沙箱副本导致 AI 看不到 node_modules 等被 gitignore 的真实文件**而被移除。影子 git 方案若在工具执行层做任何重定向/拦截,会重蹈覆辙。必须选**旁路观测**式捕获——不动工具执行路径。

### 2.2 为什么不全盘照搬 Claude Code

1. **埋点方式冲突**:Claude Code 在工具源码内部埋 `fileHistoryTrackEdit`。pico 是 `@earendil-works/pi-coding-agent` 的 thin wrapper,**不能改上游包源码**。但 pico 的上游扩展 API 提供 `pi.on("tool_call")`(工具执行**前**触发,含完整 input)与 `pi.on("tool_result")`(执行后,含 `isError` 与 edit 的 `patch` details)——这正好提供**零侵入的等价捕获点**,无需改工具。
2. **消息选择器 UI**:Claude 的 rewind 靠 REPL 消息选择器(React 组件)。pico 是 TUI(pi-tui),没有现成消息选择器;pico 已有 `/undo` `/redo` 式的命令模式(plan/todo/automode 均为命令驱动),命令栈更贴合现有架构。
3. **内存态耦合**:Claude 的 FileHistoryState 依赖 React 全局 AppState。pico 扩展是纯函数 + module-level state(session-scoped 模式,如 todo/plan),需按 pico 模式重写。

### 2.3 选型结论

**采用「Claude Code 的编辑前快照捕获 + 全量备份存储」为骨架,适配为 pico 的旁路观测扩展;叠加 OpenCode 的「幂等 restore + 多级 undo/redo 栈」思想**。

具体:

| 设计点 | 采用方案 | 来源 |
|---|---|---|
| 捕获时机 | `pi.on("tool_call")` 在 edit/write 执行**前**读文件原内容存备份;`pi.on("tool_result")` 成功才入栈、失败丢弃 | Claude trackEdit + pico 事件模型 |
| 捕获范围 | `edit`、`write` 两工具(上游唯一两个文件写工具;无 apply_patch) | pico 上游事实 |
| 快照存储 | 内容寻址 blob(`PICO_HOME/agent/cache/undo/<sessionId>/`),内存只存元数据 | Claude 全量备份 + pico PICO_HOME 模式 |
| 快照粒度 | 单次 edit/write 工具调用 = 一个 undo 条目(文件级) | 裁剪 Claude(消息级→操作级) |
| 回滚粒度 | 文件级:恢复备份内容 / 删除(新增文件 undo)/ 重建(删除后 redo) | Claude applySnapshot |
| 触发入口 | `/undo` `/redo` 命令 + `undo_redo` LLM 工具(可选) | pico 命令模式 |
| 幂等 | undo 前若已有 redo 栈则清空;undo 恢复文件时用「恢复到快照」而非「反向应用」,天然幂等 | OpenCode restore 思想 |
| 回退失败 | 单文件 try/catch,失败 continue + 通知;命令级失败提示 | Claude 失败隔离 |
| 生命周期 | session 级 state;`session_shutdown` 清理内存;磁盘保留(可跨会话恢复,复用 Claude 的 JSONL 持久化思路,但简化:仅保留最近 N 次会话的缓存) | Claude 30 天清理裁剪 |
| 配置 | settings.json `undo` 命名空间:`enabled`(默认 true)、`maxEntries`(默认 50)、`keepSnapshotsDays`(默认 7) | pico settings 模式 |

### 2.4 裁剪与明确不做

1. **不做 bash 写文件追踪**:Claude 只追踪模拟 sed;pico 的 bash 是真实 shell,无法可靠区分写文件命令。文档明示局限(与 Claude 一致)。
2. **不做跨会话自动恢复**:pico 会话树(leaf)模型复杂,跨会话恢复会引入 fork/switch 联动。v1 只在当前会话内可 undo/redo;磁盘 blob 保留供未来增强。
3. **不做 UI 消息选择器**:v1 命令栈(`/undo` `/redo`),无 diff 预览 UI(可后续加)。
4. **不做工具失败自动回滚**:OpenCode/Claude 都没有;保持一致性——失败消息只保证能事后手动 undo。
5. **不改任何工具执行路径**:纯旁路观测,AI 始终直连真实文件系统(规避 pi-undo-redo 的沙箱缺陷)。

### 2.6 会话回退(对话联动)

**v1 起文件与对话一起回退**(对齐旧 undo-redo 的「会话叶导航 + 文件恢复」语义,也对齐 Claude 的 Restore code + conversation):

- 每条 undo 条目记录捕获时的会话叶节点 id(`UndoEntry.leafId`)与确认时的叶 id(`UndoEntry.afterLeafId`);
- **对话回退目标 = 含该 toolCall 的 assistant 消息的父节点**(`findUndoTargetParent` 沿 parent 链向上查找)。原因:tool_call 捕获时 assistant 消息(含 toolCall)已 append 进会话树,捕获叶往往是其子(custom 等);若直接回退到捕获叶或其父,操作产生的消息(如 Write 卡)仍残留在对话里。回退到 toolCall 消息的父,操作卡彻底消失;
- `/undo`:`waitForIdle()` 等 agent 空闲 → `navigateTree(toolCall消息父, { summarize: false })` 把对话回退到操作之前 → 恢复文件到 before;
- `/redo`:`navigateTree(afterLeafId ?? leafId)` 把对话前进到编辑完成后的叶 → 恢复文件到 after;
- 非交互模式(无 `waitForIdle`/`navigateTree`)自动降级为纯文件回退,消息提示 "(conversation not rewound: non-interactive)";
- 导航失败/取消不阻断文件恢复(各自独立 try/catch)。

### 2.5 与现有架构的接口契约

- 新扩展 `src/extensions/undo/`,phase: `"tools"`(注册命令 + 事件监听),注册到 `src/runtime/extensions.ts`(紧跟 `plan` 之后,与 `todo` 对称)。
- 事件:`tool_call` / `tool_result` / `session_start` / `session_shutdown`。
- 状态:module-level session map(与 todo/plan 同模式),key = sessionId。
- 不 import 其他扩展;不修改现有扩展;不覆盖任何内置工具。
- 测试:`tests/undo.test.ts`,沿用 hand-rolled fakePi + `__resetUndoStateForTests()` 模式。

---

## 3. 数据结构设计

```ts
// src/extensions/undo/types.ts
/** 一个文件在某个时刻的状态(内容寻址) */
interface FileSnapshot {
  /** 内容 sha256;null = 文件当时不存在 */
  hash: string | null;
  /** blob 大小(仅 hash 非空时有意义) */
  size?: number;
}

/** 一条 undo 记录 = 一次 edit/write 工具调用前后的文件状态 */
interface UndoEntry {
  id: string;
  /** 触发工具:edit | write */
  tool: "edit" | "write";
  /** 文件绝对路径(工具 input.path 解析) */
  path: string;
  /** 修改前的文件状态(undo 目标) */
  before: FileSnapshot;
  /** 修改后的文件状态(redo 目标) */
  after: FileSnapshot;
  /** 相对 cwd 的路径,用于展示 */
  displayPath: string;
  /** 时间戳 */
  at: number;
  /** 捕获时的会话叶 id(undo 对话回退目标) */
  leafId: string | null;
  /** 确认时的会话叶 id(redo 对话前进目标) */
  afterLeafId: string | null;
}

interface UndoSessionState {
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  /** tool_call 后、tool_result 前的暂存(按 toolCallId) */
  pending: Map<string, PendingCapture>;
}

interface PendingCapture {
  tool: "edit" | "write";
  path: string;
  displayPath: string;
  before: FileSnapshot;
}
```

**捕获流程**:

```
tool_call(edit|write) → 读文件当前内容 → 算 hash → 存 blob → pending.set(toolCallId, {before})
tool_result(成功,非 isError) → pending.get(toolCallId) → 读文件当前内容(after) → 存 blob
    → 若 before.hash === after.hash → 丢弃(内容未变,无操作)
    → 否则 push undoStack,清空 redoStack
tool_result(失败,isError) → pending.delete(toolCallId) → 丢弃(不记录)
```

**undo 流程**(OpenCode 幂等思想):

```
/undo:
  stack 为空 → 提示 "No undo history"
  entry = undoStack.pop()
  恢复文件到 entry.before:
    before.hash 存在 → blob 读回 → 写文件(mkdir 递归)
    before.hash null → 删除文件(存在则 rm,不存在忽略)
  捕获当前文件状态 → push redoStack
  通知 UI + 返回恢复摘要
```

**redo 流程**:对称。恢复文件到 entry.after → push undoStack。

**边界**:
- 文件在 undo 前被外部改动(非工具):仍恢复到快照(快照优先,幂等);不检测冲突(v1 简化,文档明示)。
- 连续多次 undo:栈天然支持;undo 到空栈提示。
- 文件新增:before.hash=null,undo = 删除;redo = 重建。
- 文件删除(外部):before 有 hash → undo 重建文件。
- 非法回退(文件路径不存在目录):mkdir 递归。
- 快照 blob 缺失(磁盘被清):跳过该文件 + 通知,不崩溃。

---

## 4. 实施计划

1. `src/extensions/undo/types.ts` — 类型
2. `src/extensions/undo/blob-store.ts` — 内容寻址 blob 读写(`PICO_HOME/agent/cache/undo/`)
3. `src/extensions/undo/state.ts` — session state + undo/redo 栈操作(纯函数,可单测)
4. `src/extensions/undo/index.ts` — 扩展工厂:事件监听、命令注册、UI 通知
5. `src/runtime/extensions.ts` — 注册
6. `tests/undo.test.ts` — 单元测试(单次/多次/初始/新增删除/非法边界)
7. 真实操作场景测试(tmux 驱动 TUI)
8. 文档:本方案 + 测试报告

## 5. 验证清单

- [ ] `bun run verify` 全绿(类型检查 + 全量测试)
- [ ] 单测覆盖:单次回退、连续多次回退、回退到初始状态、文件新增删除、非法回退边界
- [ ] 真实场景:edit 后 /undo 恢复、write 新文件后 /undo 删除、连续 undo/redo
- [ ] 确认 AI 工具仍直连真实文件系统(无沙箱重定向;node_modules 可见)
- [ ] git 提交信息含功能简述与实现思路
