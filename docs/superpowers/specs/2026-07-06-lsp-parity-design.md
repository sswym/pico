# LSP 功能对齐设计：srcode → oh-my-pi

**日期**: 2026-07-06
**状态**: 设计中
**目标**: 使 srcode 的 LSP 功能和集成深度与 oh-my-pi 核心层对齐

## 背景

srcode 当前 LSP 实现 ~2,700 行，覆盖 oh-my-pi ~8,000 行中的 agent 可见查询操作。
但缺少被动集成层（writethrough 深度、workspace edit 引擎、诊断去重、新 action 等）。

本设计覆盖以下 9 项改进（跳过 lspmux、TUI 渲染、linter CLI 适配）：

| # | 特性 | 优先级 |
|---|------|--------|
| 1 | `rename_file` action | P0 |
| 2 | workspace diagnostics (`file="*"`) | P0 |
| 3 | code_actions apply/resolve | P0 |
| 4 | workspace symbol search | P0 |
| 5 | format-on-write | P1 |
| 6 | deferred diagnostics + DiagnosticsLedger | P1 |
| 7 | workspace edit 引擎 (edits.ts) | P1 |
| 8 | 空闲超时 + 初始化退避 | P2 |
| 9 | read/write 审批分离 | P2 |

**不做**: lspmux 集成、TUI 渲染层、linter CLI 适配 (Biome/SwiftLint)、5 层配置 + YAML 支持。

## 方案

原地增强：在现有文件中添加功能，新增 `edits.ts` 和 `diagnostics-ledger.ts` 两个模块。
不重构现有结构，不拆分 `index.ts`。

---

## 1. 新 Actions

### 1.1 `rename_file`

**参数**: `file`（源路径，必填）+ `newName`（目标路径，必填）

**流程**:
1. 解析 `file` 和 `newName` 为绝对路径
2. 构造 `RenameFile` 对象：`{ oldUri: pathToUri(file), newUri: pathToUri(newName) }`
3. 发送 `workspace/willRenameFiles` 请求到所有活跃服务器
4. 合并返回的 `WorkspaceEdit`（去重重叠编辑）
5. 通过 `edits.ts` 的 `applyWorkspaceEdit()` 应用到磁盘
6. 执行文件系统 rename（`fs.rename`）
7. 发送 `workspace/didRenameFiles` 通知
8. 同步更新内部 document cache（关闭旧 URI，打开新 URI）

**返回**: `Modified N file(s): ...` 或错误信息。

### 1.2 `diagnostics` 增强 — workspace 模式

当 `file="*"` 时：
1. 从所有活跃 LSP 服务器收集所有已缓存诊断
2. 按文件分组，格式化为 `[path] line:col severity: message`
3. 返回汇总

不做 CLI 子进程检测（cargo check, tsc --noEmit 等）——那是 oh-my-pi 的高级特性，需要项目类型推断逻辑，超出本次范围。

### 1.3 `code_actions` 增强 — apply 模式

当 `apply=true` 时：
1. 调用 `textDocument/codeAction` 获取候选列表
2. 如果有 `query`，按标题模糊匹配；否则选第一个
3. 如果匹配的 action 有 `edit` 字段，直接通过 `applyWorkspaceEdit()` 应用
4. 如果匹配的 action 有 `command` 字段，调用 `workspace/executeCommand`
5. 如果 action 有 `data` 字段（需要 resolve），先调用 `codeAction/resolve` 再应用
6. 返回应用结果摘要

**默认行为**: `apply` 不传或 `false` 时，行为与现在一致（列出可用 actions）。

### 1.4 `symbols` 增强 — workspace 模式

当无 `file` 或 `file="*"` 且有 `query` 时：
1. 调用 `workspace/symbol`，`query` 作为搜索词
2. 格式化结果为 `symbolName kind file:line`
3. 返回匹配列表

---

## 2. Workspace Edit 引擎

新增 `src/extensions/lsp/edits.ts`（~180 行）。

替换 `index.ts` 中现有的内联 `applyWorkspaceEdit` 函数。

### 2.1 `applyTextEditsToString(content, edits) → string`

纯函数，不碰磁盘：
- 输入：文件内容字符串 + TextEdit 数组
- 按 reverse order（bottom-to-top）排序编辑
- 逐个应用单行和多行编辑
- 返回修改后的字符串

### 2.2 `sortAndValidateTextEdits(edits) → TextEdit[]`

- 按 `(start.line, start.character)` 降序排序
- 检测重叠编辑（throw Error）

### 2.3 `applyWorkspaceEdit(edit, cwd) → ApplyResult`

有副作用的 IO 函数：
- 处理 `edit.changes`（`Record<string uri, TextEdit[]>` 映射）
- 处理 `edit.documentChanges`（`CreateFile | DeleteFile | RenameFile | TextDocumentEdit[]`）
- 每个文件：`readFileSync` → `applyTextEditsToString` → `writeFileSync`
- 返回 `{ ok: boolean, fileCount: number, messages: string[], error?: string }`

### 2.4 导出

```typescript
export { applyTextEditsToString, applyWorkspaceEdit };
export type { ApplyResult };
```

---

## 3. Writethrough 增强

### 3a. Deferred Diagnostics（延迟诊断）

改造 `pi.on("tool_result")` 中的诊断收集逻辑：

```
现有: 固定 800ms sleep → 同步收集 → 注入
新:
  Phase 1 (inline): 500ms 等待
    ↓ 诊断到达？→ 直接注入结果
    ↓ 超时？
  Phase 2 (deferred): 创建 AbortSignal.timeout(25_000)
    → 在后台继续监听 publishDiagnostics
    → 到达后通过 event.content.push() 注入
    → 超时或 session 结束则丢弃
```

实现方式：
- 在 `LspClient` 中添加 `waitForDiagnostics(uri, timeoutMs, signal)` 方法
- 利用现有的 diagnostics cache + `onDiagnostics` 回调
- 返回 `Promise<Diagnostic[] | null>`，超时返回 null

### 3b. DiagnosticsLedger

新增 `src/extensions/lsp/diagnostics-ledger.ts`（~50 行）：

```typescript
class DiagnosticsLedger {
  #seen = new Map<string, Set<string>>(); // absPath → Set<identity>

  reduce(absPath: string, messages: string[]): string[] {
    // 去除已发送过的诊断消息
    // identity = 去掉 location prefix 后的消息文本
  }
}
```

在 writethrough 中使用：
1. 收集诊断 → `ledger.reduce(absPath, messages)` → 只返回新增
2. 无新增则不注入（避免 agent 反复看相同错误）

### 3c. Format-on-Write

在 writethrough 的 sync 和 didSave 之间插入格式化步骤：

```
现有: syncDocument → didSave → 等待 → 诊断
新:   syncDocument → formatting → applyTextEditsToString → didSave → 等待 → 诊断
```

- 调用 `textDocument/formatting`，使用已有的 `resolveFormattingOptions()`
- 将格式化后的文本通过 `applyTextEditsToString` 应用到缓冲区
- 将格式化后的内容写回磁盘（`writeFileSync`）
- 然后 `didSave`
- 格式化失败静默回退到原内容

### 3d. Document Version Tracking

在 `LspClient` 中：
- `textDocument/didOpen` 时记录 `docVersions: Map<uri, number>`
- `textDocument/didChange` 时递增版本
- `publishDiagnostics` 回调中检查 diagnostic version 与当前文档 version
- version 不匹配时丢弃（stale diagnostic）

在 `manager.ts` 中：
- `syncDocument` 返回时携带版本信息
- `getDiagnostics` 接受 version 参数进行过滤

---

## 4. Client 增强

### 4a. 空闲超时

在 `manager.ts` 中添加：

```typescript
let idleTimeoutMs: number | null = null;
let idleCheckInterval: NodeJS.Timeout | null = null;

function setIdleTimeout(ms: number | null): void;
function startIdleChecker(): void;  // 60s 间隔
function stopIdleChecker(): void;
```

- `LspClient` 增加 `lastActivity: number` 字段，每次请求更新
- 定时检查：`Date.now() - lastActivity > idleTimeoutMs` → `shutdownClient()`
- 下次请求时自动冷启动（现有 `ensureServer` 逻辑已有）

配置来源：`~/.srcode/lsp.json` 或 `.srcode/lsp.json` 中的 `idleTimeoutMs` 字段。

### 4b. 初始化失败退避

在 `manager.ts` 中添加：

```typescript
const initFailures = new Map<string, { at: number; message: string }>();
const INIT_FAILURE_BACKOFF_MS = 3 * 60 * 1000;
```

- `ensureServer` 中，启动前检查 `initFailures`
- 如果 3 分钟内有失败记录且非瞬态（非 signal.aborted、非超时），直接抛出缓存的错误
- 启动成功时清除失败记录

### 4c. AbortSignal 贯穿

改造 `LspClient.request()` 方法：
- 接受可选 `signal?: AbortSignal` 参数
- 用 `AbortSignal.any([callerSignal, timeoutSignal])` 组合超时和调用方取消
- pending request 被 abort 时清理并 reject

改造 `index.ts` 中的 action 执行：
- `execute` 方法的 `signal` 参数传递到所有 LSP 请求
- 超时由 `AbortSignal.timeout()` 控制，不再依赖 client 内部的固定 30s

---

## 5. 审批分离

在 `index.ts` 的 `lspExtension` 中，通过 `pi.on("tool_call")` 事件添加审批逻辑：

```typescript
const LSP_READONLY_ACTIONS = new Set([
  "hover", "definition", "type_definition", "implementation",
  "references", "diagnostics", "symbols", "status", "capabilities",
]);

pi.on("tool_call", async (event) => {
  if (event.toolName !== "lsp") return;
  const action = String(event.input?.action ?? "").toLowerCase();
  if (LSP_READONLY_ACTIONS.has(action)) return; // 只读，不干预
  // rename, rename_file, code_actions(apply), reload, request
  // 走 srcode 权限系统默认行为
});
```

效果：只读 LSP 操作（占 90%+ 调用）不会触发权限确认弹窗。

---

## 文件变更清单

| 文件 | 操作 | 行数变化 |
|------|------|----------|
| `src/extensions/lsp/edits.ts` | **新增** | ~180 |
| `src/extensions/lsp/diagnostics-ledger.ts` | **新增** | ~50 |
| `src/extensions/lsp/index.ts` | 修改 | +300 (新 action + writethrough 增强 + 审批) |
| `src/extensions/lsp/client.ts` | 修改 | +80 (AbortSignal + waitForDiagnostics + version tracking) |
| `src/extensions/lsp/manager.ts` | 修改 | +100 (空闲超时 + 退避 + diagnostics 收集) |
| `src/extensions/lsp/types.ts` | 修改 | +20 (新增类型) |
| `src/extensions/lsp/defaults.json` | 不变 | 0 |
| `src/extensions/lsp/config.ts` | 修改 | +10 (idleTimeoutMs) |
| `src/extensions/lsp/install.ts` | 不变 | 0 |
| `src/extensions/lsp/format-options.ts` | 不变 | 0 |
| `src/prompts/vibe-system.md` | 修改 | +10 (更新 LSP 使用指南) |

**预估总增量**: ~750 行（从 ~2,700 → ~3,450 行）。

---

## 不做的事

- lspmux 多路复用（需要外部二进制，独立特性）
- TUI 渲染层（需要 pi-tui 组件系统，复杂度高）
- linter CLI 适配（Biome/SwiftLint，需要自定义输出解析）
- 5 层配置 + YAML 支持（增量价值低）
- CLI 子进程 workspace diagnostics（cargo check/tsc --noEmit，需要项目类型推断）

---

## 验证标准

1. `lsp(action="rename_file", file="src/foo.ts", newName="src/bar.ts)` — 正确移动文件并更新所有引用
2. `lsp(action="diagnostics", file="*")` — 返回所有活跃服务器的诊断
3. `lsp(action="code_actions", file="src/foo.ts", line=10, apply=true)` — 自动应用第一个匹配的 quickfix
4. `lsp(action="symbols", query="MyClass")` — workspace 级符号搜索
5. write/edit 工具写入 `.ts` 文件后，自动格式化 + 只返回新增诊断
6. LSP 服务器空闲超时后自动关闭，下次请求冷启动
7. 同一服务器 3 分钟内初始化失败不重复 spawn
