# LSP 功能对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使 srcode LSP 功能和集成深度与 oh-my-pi 核心层对齐，覆盖 9 项改进。

**Architecture:** 在现有 `src/extensions/lsp/` 中原地增强。新增 `edits.ts`（workspace edit 引擎）和 `diagnostics-ledger.ts`（诊断去重）。改造 `client.ts`（AbortSignal、版本跟踪、waitForDiagnostics）、`manager.ts`（空闲超时、退避）、`index.ts`（新 action、writethrough 增强、审批分离）。

**Tech Stack:** TypeScript, Bun, Node.js child_process, LSP 3.17 协议

**Spec:** `docs/superpowers/specs/2026-07-06-lsp-parity-design.md`

---

## File Structure

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/extensions/lsp/edits.ts` | Workspace edit 引擎：纯函数 applyTextEditsToString + IO 函数 applyWorkspaceEdit | **新建** |
| `src/extensions/lsp/diagnostics-ledger.ts` | 诊断去重：跟踪已发送诊断，只返回新增 | **新建** |
| `src/extensions/lsp/types.ts` | LSP 协议类型扩展 | 修改 |
| `src/extensions/lsp/client.ts` | LSP 客户端增强：AbortSignal、版本跟踪、waitForDiagnostics | 修改 |
| `src/extensions/lsp/manager.ts` | 服务器生命周期增强：空闲超时、初始化退避 | 修改 |
| `src/extensions/lsp/config.ts` | 配置增强：idleTimeoutMs | 修改 |
| `src/extensions/lsp/index.ts` | 工具入口：新 action、writethrough 增强、审批分离 | 修改 |
| `src/prompts/vibe-system.md` | 系统提示词：更新 LSP 使用指南 | 修改 |
| `tests/lsp.test.ts` | LSP 单元测试 | **新建** |

---

## Task 1: Types 扩展

**Files:**
- Modify: `src/extensions/lsp/types.ts`

- [ ] **Step 1: 读取现有 types.ts 确认当前类型**

Read `src/extensions/lsp/types.ts` to understand existing types (Position, Range, Location, Diagnostic, Hover, Symbol, CodeAction, WorkspaceEdit, etc.).

- [ ] **Step 2: 添加缺失类型**

在 `types.ts` 末尾添加：

```typescript
/** File operation for workspace/willRenameFiles */
export interface FileRename {
  oldUri: string;
  newUri: string;
}

/** workspace/willRenameFiles params */
export interface WillRenameFilesParams {
  files: FileRename[];
}

/** workspace/didRenameFiles params */
export interface DidRenameFilesParams {
  files: FileRename[];
}

/** workspace/symbol params */
export interface WorkspaceSymbolParams {
  query: string;
}

/** Workspace symbol information */
export interface WorkspaceSymbol {
  name: string;
  kind: number;
  location: Location | { uri: string; range: { start: Position; end: Position } };
  containerName?: string;
}

/** Result from applying a workspace edit */
export interface ApplyResult {
  ok: boolean;
  fileCount: number;
  messages: string[];
  error?: string;
}

/** Create file operation */
export interface CreateFile {
  kind: "create";
  uri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

/** Delete file operation */
export interface DeleteFile {
  kind: "delete";
  uri: string;
  options?: { recursive?: boolean; ignoreIfNotExists?: boolean };
}

/** Rename file operation */
export interface RenameFile {
  kind: "rename";
  oldUri: string;
  newUri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

/** Text document edit in a workspace edit */
export interface TextDocumentEdit {
  textDocument: { uri: string; version?: number };
  edits: TextEdit[];
}

/** A single text edit */
export interface TextEdit {
  range: { start: Position; end: Position };
  newText: string;
}

/** Document change types */
export type DocumentChange = TextDocumentEdit | CreateFile | DeleteFile | RenameFile;
```

注意：检查 types.ts 中是否已有部分类型（TextEdit、WorkspaceEdit 等），避免重复定义。只添加缺失的。

- [ ] **Step 3: Commit**

```bash
git add src/extensions/lsp/types.ts
git commit -m "扩展 LSP 类型：添加 rename_file、workspace edit、diagnostics 相关类型"
```

---

## Task 2: Workspace Edit 引擎 (edits.ts)

**Files:**
- Create: `src/extensions/lsp/edits.ts`

- [ ] **Step 1: 创建 edits.ts**

```typescript
/**
 * Workspace edit application engine.
 *
 * Pure function `applyTextEditsToString` for in-memory edits.
 * IO function `applyWorkspaceEdit` for applying LSP WorkspaceEdits to disk.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { uriToPath } from "./client.ts";
import type {
  ApplyResult,
  CreateFile,
  DeleteFile,
  DocumentChange,
  RenameFile,
  TextDocumentEdit,
  TextEdit,
} from "./types.ts";

/**
 * Apply text edits to a string in-memory (pure function).
 * Edits are applied in reverse order (bottom-to-top) to preserve indices.
 */
export function applyTextEditsToString(content: string, edits: TextEdit[]): string {
  const sorted = sortAndValidateTextEdits(edits);
  const lines = content.split("\n");

  for (const edit of sorted) {
    const { start, end } = edit.range;
    if (start.line === end.line) {
      const line = lines[start.line] ?? "";
      lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
    } else {
      const startLine = lines[start.line] ?? "";
      const endLine = lines[end.line] ?? "";
      const merged = startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character);
      lines.splice(start.line, end.line - start.line + 1, ...merged.split("\n"));
    }
  }

  return lines.join("\n");
}

/**
 * Sort text edits in reverse order (bottom-to-top) and validate no overlaps.
 */
function sortAndValidateTextEdits(edits: TextEdit[]): TextEdit[] {
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
    return b.range.start.character - a.range.start.character;
  });

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]!;
    const next = sorted[i + 1]!;
    if (
      current.range.end.line > next.range.start.line ||
      (current.range.end.line === next.range.start.line &&
        current.range.end.character > next.range.start.character)
    ) {
      throw new Error(
        `Overlapping text edits at lines ${next.range.start.line}:${next.range.start.character} and ${current.range.start.line}:${current.range.start.character}`,
      );
    }
  }

  return sorted;
}

/**
 * Apply a full LSP WorkspaceEdit to disk.
 * Handles `changes` (URI→TextEdit[] map) and `documentChanges` (file ops).
 */
export function applyWorkspaceEdit(
  edit: {
    changes?: Record<string, TextEdit[]>;
    documentChanges?: DocumentChange[];
  },
  cwd: string,
): ApplyResult {
  const messages: string[] = [];
  let fileCount = 0;
  let hasError = false;

  try {
    // Handle documentChanges (higher priority per spec)
    if (edit.documentChanges) {
      for (const change of edit.documentChanges) {
        try {
          applyDocumentChange(change, cwd);
          fileCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          messages.push(`  ERROR: ${msg}`);
          hasError = true;
        }
      }
    }

    // Handle changes map
    if (edit.changes) {
      for (const [uri, textEdits] of Object.entries(edit.changes)) {
        const filePath = uriToPath(uri);
        try {
          let content = readFileSync(filePath, "utf8");
          content = applyTextEditsToString(content, textEdits);
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, content, "utf8");
          fileCount++;
          messages.push(`  ${filePath} (${textEdits.length} edit(s))`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          messages.push(`  ${filePath}: FAILED — ${msg}`);
          hasError = true;
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, fileCount: 0, messages: [], error: msg };
  }

  return {
    ok: !hasError,
    fileCount,
    messages,
  };
}

function applyDocumentChange(change: DocumentChange, cwd: string): void {
  if ("textDocument" in change) {
    // TextDocumentEdit
    const tde = change as TextDocumentEdit;
    const filePath = uriToPath(tde.textDocument.uri);
    let content = readFileSync(filePath, "utf8");
    content = applyTextEditsToString(content, tde.edits);
    writeFileSync(filePath, content, "utf8");
    return;
  }

  if ("kind" in change) {
    if (change.kind === "create") {
      const c = change as CreateFile;
      const filePath = uriToPath(c.uri);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "", "utf8");
      return;
    }
    if (change.kind === "delete") {
      const d = change as DeleteFile;
      const filePath = uriToPath(d.uri);
      unlinkSync(filePath);
      return;
    }
    if (change.kind === "rename") {
      const r = change as RenameFile;
      const oldPath = uriToPath(r.oldUri);
      const newPath = uriToPath(r.newUri);
      mkdirSync(dirname(newPath), { recursive: true });
      renameSync(oldPath, newPath);
      return;
    }
  }
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `bun run -e "import './src/extensions/lsp/edits.ts'" 2>&1 || true`
Expected: No syntax errors (import resolution errors are OK at this stage).

- [ ] **Step 3: Commit**

```bash
git add src/extensions/lsp/edits.ts
git commit -m "实现 workspace edit 引擎：applyTextEditsToString + applyWorkspaceEdit"
```

---

## Task 3: DiagnosticsLedger (诊断去重)

**Files:**
- Create: `src/extensions/lsp/diagnostics-ledger.ts`

- [ ] **Step 1: 创建 diagnostics-ledger.ts**

```typescript
/**
 * Diagnostics deduplication ledger.
 *
 * Tracks diagnostics that have already been sent to the agent,
 * so writethrough only surfaces *new* diagnostics and avoids
 * repeatedly showing the same errors.
 */
const DIAGNOSTIC_LOCATION_PREFIX_RE = /^.*?:\d+:\d+\s+/;

function diagnosticIdentity(message: string): string {
  return message.replace(DIAGNOSTIC_LOCATION_PREFIX_RE, "");
}

export class DiagnosticsLedger {
  readonly #seen = new Map<string, Set<string>>();

  /**
   * Filter out diagnostics already sent for this file.
   * Returns only the new (previously unseen) messages.
   */
  reduce(absPath: string, messages: string[]): string[] {
    const previous = this.#seen.get(absPath);
    const currentIdentities = new Set<string>();
    const fresh: string[] = [];

    for (const message of messages) {
      const identity = diagnosticIdentity(message);
      currentIdentities.add(identity);
      if (!previous?.has(identity)) {
        fresh.push(message);
      }
    }

    if (currentIdentities.size === 0) {
      this.#seen.delete(absPath);
    } else {
      this.#seen.set(absPath, currentIdentities);
    }

    return fresh;
  }

  /** Clear all tracked state (e.g., on session restart). */
  clear(): void {
    this.#seen.clear();
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/extensions/lsp/diagnostics-ledger.ts
git commit -m "实现 DiagnosticsLedger：诊断去重，只推送新增诊断"
```

---

## Task 4: Client 增强 — AbortSignal 贯穿

**Files:**
- Modify: `src/extensions/lsp/client.ts`

- [ ] **Step 1: 读取 client.ts 完整结构**

Read `src/extensions/lsp/client.ts` to understand:
- `request()` method signature and timeout handling
- `getDiagnostics()` method
- `didOpen/didChange/didSave` methods
- pending request tracking

- [ ] **Step 2: 添加 AbortSignal 到 request 方法**

将 `request()` 方法改造为接受可选 `signal` 参数：

```typescript
// 在 request 方法签名中添加 signal 参数
private async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
  // ... existing id/message building ...

  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      this.pending.delete(id);
      reject(new LspError(`Request ${method} timed out`, -1));
    }, 30_000);

    // AbortSignal handling
    const onAbort = () => {
      clearTimeout(timeoutId);
      this.pending.delete(id);
      reject(new LspError(`Request ${method} aborted`, -1));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    this.pending.set(id, {
      resolve: (result) => {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        resolve(result as T);
      },
      reject: (err) => {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    });

    // ... existing write logic ...
  });
}
```

- [ ] **Step 3: 将 signal 传递到所有公开方法**

给以下方法添加可选 `signal?: AbortSignal` 参数并传递到 `this.request()`：
- `textDocumentHover(uri, position, signal?)`
- `textDocumentDefinition(uri, position, signal?)`
- `textDocumentTypeDefinition(uri, position, signal?)`
- `textDocumentImplementation(uri, position, signal?)`
- `textDocumentReferences(uri, position, context, signal?)`
- `textDocumentDocumentSymbol(uri, signal?)`
- `workspaceSymbol(query, signal?)`
- `textDocumentCodeAction(uri, range, context, signal?)`
- `codeActionResolve(action, signal?)`
- `textDocumentRename(uri, position, newName, signal?)`
- `workspaceWillRenameFiles(params, signal?)`
- `workspaceDidRenameFiles(params, signal?)`（新方法）
- `textDocumentFormatting(uri, options, signal?)`
- `rawRequest(method, params, signal?)`

- [ ] **Step 4: 添加 workspace/symbol 方法**

```typescript
async workspaceSymbol(
  query: string,
  signal?: AbortSignal,
): Promise<WorkspaceSymbol[]> {
  return this.request("workspace/symbol", { query }, signal);
}
```

- [ ] **Step 5: 添加 workspaceDidRenameFiles 方法**

```typescript
async workspaceDidRenameFiles(
  params: DidRenameFilesParams,
  signal?: AbortSignal,
): Promise<void> {
  this.notify("workspace/didRenameFiles", params);
}
```

- [ ] **Step 6: 添加 docVersions Map 和版本跟踪**

```typescript
// 在 LspClient 类中添加
private docVersions = new Map<string, number>();

// 修改 textDocument/didOpen 调用中记录版本
// 在 didOpen 方法中：
this.docVersions.set(uri, 0);

// 在 didChange 方法中：
const version = (this.docVersions.get(uri) ?? 0) + 1;
this.docVersions.set(uri, version);
// 在 notification params 中使用 version
```

- [ ] **Step 7: 添加 waitForDiagnostics 方法**

```typescript
/**
 * Wait for fresh diagnostics for a specific URI.
 * Returns diagnostics when they arrive, or null on timeout/abort.
 */
async waitForDiagnostics(
  uri: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Diagnostic[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      resolve(null);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // Check if diagnostics already arrived
    const existing = this.diagnosticCache.get(uri);
    if (existing && existing.length > 0) {
      cleanup();
      resolve(existing);
      return;
    }

    // Store callback for when diagnostics arrive
    const handler = (params: PublishDiagnosticsParams) => {
      if (params.uri === uri) {
        cleanup();
        this.diagnosticHandlers.delete(handler);
        resolve(params.diagnostics);
      }
    };
    this.diagnosticHandlers.add(handler);
  });
}
```

注意：`diagnosticHandlers` 是一个新的 Set，用于在 publishDiagnostics 回调中通知等待者。需要在现有的 onDiagnostics 回调中调用它们。

- [ ] **Step 8: 验证编译**

Run: `bun run -e "import './src/extensions/lsp/client.ts'" 2>&1 || true`
Expected: No new errors.

- [ ] **Step 9: Commit**

```bash
git add src/extensions/lsp/client.ts
git commit -m "增强 LSP 客户端：AbortSignal 贯穿、版本跟踪、waitForDiagnostics"
```

---

## Task 5: Manager 增强 — 空闲超时 + 初始化退避

**Files:**
- Modify: `src/extensions/lsp/manager.ts`

- [ ] **Step 1: 读取 manager.ts 完整结构**

Read `src/extensions/lsp/manager.ts` to understand:
- `LspManagerState` interface
- `createLspManager()` function
- `ensureServer()` / `stopServer()` functions
- `getActiveClients()` function

- [ ] **Step 2: 添加空闲超时**

在 `manager.ts` 顶部添加：

```typescript
// ── Idle timeout ────────────────────────────────────────────────────────────

let idleTimeoutMs: number | null = null;
let idleCheckInterval: ReturnType<typeof setInterval> | null = null;
const IDLE_CHECK_INTERVAL_MS = 60_000;

export function setIdleTimeout(ms: number | null | undefined): void {
  idleTimeoutMs = ms ?? null;
  if (idleTimeoutMs && idleTimeoutMs > 0) {
    startIdleChecker();
  } else {
    stopIdleChecker();
  }
}

function startIdleChecker(): void {
  if (idleCheckInterval) return;
  idleCheckInterval = setInterval(() => {
    if (!idleTimeoutMs) return;
    // Check each managed server's lastActivity
    // (需要在 LspManagerState 中跟踪 lastActivity)
  }, IDLE_CHECK_INTERVAL_MS);
}

function stopIdleChecker(): void {
  if (idleCheckInterval) {
    clearInterval(idleCheckInterval);
    idleCheckInterval = null;
  }
}
```

- [ ] **Step 3: 添加初始化失败退避**

```typescript
// ── Init failure backoff ────────────────────────────────────────────────────

const initFailures = new Map<string, { at: number; message: string }>();
const INIT_FAILURE_BACKOFF_MS = 3 * 60 * 1000;

function checkInitBackoff(serverName: string): void {
  const failure = initFailures.get(serverName);
  if (!failure) return;
  if (Date.now() - failure.at < INIT_FAILURE_BACKOFF_MS) {
    throw new LspError(
      `Server "${serverName}" failed to start recently (${failure.message}). Retry in ${Math.ceil((INIT_FAILURE_BACKOFF_MS - (Date.now() - failure.at)) / 1000)}s.`,
      -1,
    );
  }
  initFailures.delete(serverName);
}

function recordInitFailure(serverName: string, message: string): void {
  initFailures.set(serverName, { at: Date.now(), message });
}
```

- [ ] **Step 4: 集成到 ensureServer**

在 `ensureServer()` 的 spawn 逻辑前调用 `checkInitBackoff()`，在 catch 块中调用 `recordInitFailure()`。

- [ ] **Step 5: 添加 lastActivity 跟踪到 LspClient**

在 `LspClient` 类中添加 `lastActivity: number` 字段，在每次 `request()` 调用开始时更新 `Date.now()`。

在 manager 的 `getActiveClients()` 中返回 `lastActivity` 信息。

- [ ] **Step 6: 导出新函数**

确保 `setIdleTimeout` 和相关函数被正确导出。

- [ ] **Step 7: Commit**

```bash
git add src/extensions/lsp/manager.ts
git commit -m "增强 LSP manager：空闲超时 + 初始化失败退避"
```

---

## Task 6: Config 增强 — idleTimeoutMs

**Files:**
- Modify: `src/extensions/lsp/config.ts`

- [ ] **Step 1: 读取 config.ts 确认结构**

Read `src/extensions/lsp/config.ts` to understand config loading and `LspConfig` type.

- [ ] **Step 2: 添加 idleTimeoutMs 到配置**

在 config 的顶层类型中添加 `idleTimeoutMs?: number`。

在 `loadConfig()` 中读取并返回 `idleTimeoutMs`。

- [ ] **Step 3: Commit**

```bash
git add src/extensions/lsp/config.ts
git commit -m "配置增强：支持 idleTimeoutMs"
```

---

## Task 7: 新 Action — rename_file

**Files:**
- Modify: `src/extensions/lsp/index.ts`
- Modify: `src/extensions/lsp/client.ts`（已在 Task 4 添加方法）

- [ ] **Step 1: 添加 rename_file 到 ACTIONS 数组**

在 `index.ts` 的 ACTIONS 常量中添加 `"rename_file"`。

- [ ] **Step 2: 添加 newName 参数到 LspParams**

```typescript
newName: Type.Optional(Type.String({ description: "New name/path for rename_file action." })),
```

注意：现有代码有 `newName` 参数但叫 `newName`。确认命名一致性。

- [ ] **Step 3: 实现 rename_file action handler**

在 `execute` 方法的 action switch 中添加：

```typescript
if (action === "rename_file") {
  if (!file || !params.newName) {
    return fail("rename_file requires both 'file' (source) and 'newName' (destination).");
  }

  const resolvedFile = resolveToCwd(file, ctx.cwd);
  const resolvedNew = resolveToCwd(params.newName, ctx.cwd);

  // Step 1: willRenameFiles
  const willParams: WillRenameFilesParams = {
    files: [{ oldUri: pathToUri(resolvedFile), newUri: pathToUri(resolvedNew) }],
  };

  let workspaceEdit: { changes?: Record<string, TextEdit[]>; documentChanges?: DocumentChange[] } | null = null;
  try {
    workspaceEdit = await client.workspaceWillRenameFiles(willParams, signal) as any;
  } catch (err) {
    // Server may not support willRenameFiles — continue with just the rename
  }

  // Step 2: Apply workspace edits
  if (workspaceEdit) {
    const result = applyWorkspaceEdit(workspaceEdit, ctx.cwd);
    if (!result.ok) {
      return fail(`Failed to apply workspace edits:\n${result.messages.join("\n")}`);
    }
  }

  // Step 3: Filesystem rename
  try {
    const { renameSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(resolvedNew), { recursive: true });
    renameSync(resolvedFile, resolvedNew);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Filesystem rename failed: ${msg}`);
  }

  // Step 4: didRenameFiles notification
  try {
    client.workspaceDidRenameFiles({
      files: [{ oldUri: pathToUri(resolvedFile), newUri: pathToUri(resolvedNew) }],
    });
  } catch {}

  // Step 5: Sync document cache
  // Close old URI, open new URI
  try {
    syncDocument(state, resolvedNew);
  } catch {}

  const lines = [`Renamed: ${file} → ${params.newName}`];
  if (workspaceEdit) {
    lines.push(`Applied workspace edits from LSP server.`);
  }
  return ok(lines.join("\n"), { action: "rename_file", success: true });
}
```

- [ ] **Step 4: 更新 ACTIONS 列表的 description**

在工具 description 中添加 `rename_file` 到 action 列表。

- [ ] **Step 5: Commit**

```bash
git add src/extensions/lsp/index.ts
git commit -m "实现 rename_file action：workspace/willRenameFiles + 文件系统 rename"
```

---

## Task 8: 新 Action — workspace diagnostics

**Files:**
- Modify: `src/extensions/lsp/index.ts`

- [ ] **Step 1: 修改 diagnostics action 处理**

在现有 diagnostics 处理中，检查 `file === "*"` 进入 workspace 模式：

```typescript
if (action === "diagnostics") {
  if (file === "*") {
    // Workspace diagnostics: collect from all active servers
    const activeClients = getActiveClients(state);
    if (activeClients.length === 0) {
      return ok("No active language servers.", { action: "diagnostics", success: true });
    }

    const allMessages: string[] = [];
    for (const managed of activeClients) {
      const cache = managed.client.getAllCachedDiagnostics();
      for (const [uri, diags] of cache.entries()) {
        if (diags.length === 0) continue;
        const filePath = uriToPath(uri);
        const relPath = filePath.startsWith(ctx.cwd)
          ? filePath.slice(ctx.cwd.length + 1)
          : filePath;
        for (const d of diags) {
          const pos = lspPositionToDisplay(d.range.start);
          const sev = d.severity === 1 ? "ERROR" : d.severity === 2 ? "WARNING" : d.severity === 3 ? "INFO" : "HINT";
          const code = d.code ? ` [${d.code}]` : "";
          const src = d.source ? ` (${d.source})` : "";
          allMessages.push(`${relPath}:${pos.line}:${pos.character} ${sev}${code}${src}: ${d.message}`);
        }
      }
    }

    if (allMessages.length === 0) {
      return ok("No diagnostics found.", { action: "diagnostics", success: true });
    }
    return ok(`Workspace diagnostics (${allMessages.length}):\n${allMessages.join("\n")}`, { action: "diagnostics", success: true });
  }

  // ... existing single-file diagnostics logic ...
}
```

注意：需要在 `LspClient` 中添加 `getAllCachedDiagnostics()` 方法返回整个 `diagnosticCache` Map。

- [ ] **Step 2: 添加 getAllCachedDiagnostics 到 LspClient**

在 `client.ts` 中添加：

```typescript
getAllCachedDiagnostics(): Map<string, Diagnostic[]> {
  return new Map(this.diagnosticCache);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/extensions/lsp/index.ts src/extensions/lsp/client.ts
git commit -m "实现 workspace diagnostics：file=* 收集所有服务器诊断"
```

---

## Task 9: 增强 — code_actions apply/resolve

**Files:**
- Modify: `src/extensions/lsp/index.ts`

- [ ] **Step 1: 修改 code_actions 处理逻辑**

在现有 code_actions 处理中添加 `apply=true` 分支：

```typescript
if (action === "code_actions") {
  // ... existing code action fetching logic ...

  if (apply) {
    // Match by query (fuzzy title match) or select first
    let selected = result[0];
    if (query && result.length > 1) {
      selected = result.find(a =>
        a.title.toLowerCase().includes(query.toLowerCase())
      ) ?? result[0];
    }

    if (!selected) {
      return fail("No matching code action found.");
    }

    // Resolve if needed (has `data` but no `edit`)
    if (selected.data && !selected.edit) {
      try {
        selected = await client.codeActionResolve(selected, signal);
      } catch {}
    }

    // Apply the edit
    if (selected.edit) {
      const editResult = applyWorkspaceEdit(selected.edit as any, ctx.cwd);
      return ok(
        `Applied "${selected.title}":\n${editResult.messages.join("\n")}`,
        { action: "code_actions", success: true },
      );
    }

    // Execute command if present
    if (selected.command) {
      try {
        await client.rawRequest("workspace/executeCommand", {
          command: selected.command.command,
          arguments: selected.command.arguments,
        }, signal);
        return ok(`Executed command: ${selected.command.command}`, { action: "code_actions", success: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(`Command execution failed: ${msg}`);
      }
    }

    return fail(`Code action "${selected.title}" has no edit or command to apply.`);
  }

  // ... existing listing logic (apply is falsy) ...
}
```

- [ ] **Step 2: Commit**

```bash
git add src/extensions/lsp/index.ts
git commit -m "增强 code_actions：支持 apply=true 自动应用 quickfix"
```

---

## Task 10: 增强 — workspace symbol search

**Files:**
- Modify: `src/extensions/lsp/index.ts`

- [ ] **Step 1: 修改 symbols action 处理**

在现有 symbols 处理中，添加 workspace 模式：

```typescript
if (action === "symbols") {
  // Workspace symbol search: no file or file="*" with query
  if ((!file || file === "*") && query) {
    try {
      const results = await client.workspaceSymbol(query, signal);
      if (!results || results.length === 0) {
        return ok(`No symbols found matching "${query}".`, { action: "symbols", success: true });
      }
      const lines = results.slice(0, 50).map(s => {
        const kind = SYMBOL_KIND_NAMES[s.kind] ?? "Unknown";
        const loc = "uri" in s.location ? s.location : null;
        const locStr = loc ? ` (${uriToPath(loc.uri)}:${loc.range.start.line + 1})` : "";
        return `  ${s.name} ${kind}${locStr}`;
      });
      return ok(`Workspace symbols matching "${query}" (${results.length}):\n${lines.join("\n")}`, { action: "symbols", success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`Workspace symbol search failed: ${msg}`);
    }
  }

  // ... existing document symbol logic ...
}
```

添加 `SYMBOL_KIND_NAMES` 常量映射（1→File, 2→Module, 3→Namespace, ... 26→TypeParameter）。

- [ ] **Step 2: Commit**

```bash
git add src/extensions/lsp/index.ts
git commit -m "增强 symbols：支持 workspace symbol search"
```

---

## Task 11: Writethrough 增强 — Deferred Diagnostics + Format-on-Write + Ledger

**Files:**
- Modify: `src/extensions/lsp/index.ts`

- [ ] **Step 1: 导入新模块**

在 `index.ts` 顶部添加：

```typescript
import { applyTextEditsToString, applyWorkspaceEdit } from "./edits.ts";
import { DiagnosticsLedger } from "./diagnostics-ledger.ts";
```

- [ ] **Step 2: 创建 DiagnosticsLedger 实例**

在 `lspExtension` 工厂函数中：

```typescript
const ledger = new DiagnosticsLedger();
```

- [ ] **Step 3: 改造 writethrough 事件处理器**

替换现有的 `pi.on("tool_result", ...)` 处理器：

```typescript
pi.on("tool_result", async (event) => {
  if (event.toolName !== "write" && event.toolName !== "edit") return;

  const input = event.input;
  const filePath = typeof input === "object" && input !== null && "path" in input
    ? String((input as Record<string, unknown>)["path"])
    : undefined;
  if (!filePath) return;

  const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
  if (!CODE_EXTENSIONS.has(ext)) return;

  const client = state.servers.size > 0
    ? Array.from(state.servers.values()).find((s) => s.client.ready)?.client
    : null;
  if (!client) return;

  try {
    // Step 1: Sync file
    const uri = syncDocument(state, filePath);
    if (!uri) return;

    // Step 2: Format-on-write
    try {
      const formatOpts = resolveFormattingOptions(filePath);
      const edits = await client.textDocumentFormatting(uri, formatOpts);
      if (edits && edits.length > 0) {
        const currentContent = readFileSync(filePath, "utf8");
        const formatted = applyTextEditsToString(currentContent, edits);
        if (formatted !== currentContent) {
          writeFileSync(filePath, formatted, "utf8");
          // Re-sync after formatting
          syncDocument(state, filePath);
        }
      }
    } catch {
      // Format failure is non-fatal
    }

    // Step 3: DidSave
    client.didSave(uri);

    // Step 4: Deferred diagnostics
    const inlineTimeout = 500;
    const diags = await client.waitForDiagnostics(uri, inlineTimeout);

    if (diags && diags.length > 0) {
      const diagText = formatDiagnosticsForFile(filePath, diags);
      const freshMessages = ledger.reduce(filePath, diagText.split("\n").filter(Boolean));
      if (freshMessages.length > 0) {
        event.content = [
          ...event.content,
          { type: "text", text: `\n[LSP] ${freshMessages.join("\n")}` },
        ];
      }
    } else {
      // Deferred: wait longer in background
      const deferredSignal = AbortSignal.timeout(25_000);
      const deferredDiags = await client.waitForDiagnostics(uri, 25_000, deferredSignal);
      if (deferredDiags && deferredDiags.length > 0) {
        const diagText = formatDiagnosticsForFile(filePath, deferredDiags);
        const freshMessages = ledger.reduce(filePath, diagText.split("\n").filter(Boolean));
        if (freshMessages.length > 0) {
          event.content = [
            ...event.content,
            { type: "text", text: `\n[LSP] ${freshMessages.join("\n")}` },
          ];
        }
      }
    }
  } catch {
    // Silently ignore writethrough failures
  }
});
```

- [ ] **Step 4: 在 session_start 中重置 ledger**

```typescript
pi.on("session_start", async (_event, ctx) => {
  ledger.clear();
  // ... existing warmup logic ...
});
```

- [ ] **Step 5: Commit**

```bash
git add src/extensions/lsp/index.ts
git commit -m "增强 writethrough：deferred diagnostics + format-on-write + 诊断去重"
```

---

## Task 12: 审批分离

**Files:**
- Modify: `src/extensions/lsp/index.ts`

- [ ] **Step 1: 添加 tool_call 事件处理器**

在 `lspExtension` 工厂函数中（writethrough 之前）：

```typescript
const LSP_READONLY_ACTIONS = new Set([
  "hover", "definition", "type_definition", "implementation",
  "references", "diagnostics", "symbols", "status", "capabilities",
]);

pi.on("tool_call", async (event) => {
  if (event.toolName !== "lsp") return;
  const action = String((event.input as Record<string, unknown>)?.action ?? "").toLowerCase();
  if (LSP_READONLY_ACTIONS.has(action)) return;
  // Write-tier actions: rename, rename_file, code_actions(apply), reload, request
  // 走 srcode 权限系统默认行为（不需要额外处理）
});
```

注意：srcode 的 `tool_call` 事件可以返回 `{ block: true, reason }` 来阻断调用。
对于只读操作不做任何处理（放行），对于写操作让权限系统接管。
这需要检查 srcode 的 `pi.on("tool_call")` 是否支持 `approval` 回调。
如果不支持，此功能可能需要通过 `defineTool` 的参数来实现。

- [ ] **Step 2: 验证审批行为**

手动测试：
- `lsp(action="hover", ...)` — 不弹确认
- `lsp(action="rename", ...)` — 走权限系统

- [ ] **Step 3: Commit**

```bash
git add src/extensions/lsp/index.ts
git commit -m "实现审批分离：只读 LSP 操作跳过权限确认"
```

---

## Task 13: 系统提示词更新

**Files:**
- Modify: `src/prompts/vibe-system.md`

- [ ] **Step 1: 更新 LSP 使用指南**

在 `## 使用 LSP 获取代码智能` 部分添加新 action 说明：

```markdown
## 使用 LSP 获取代码智能

你有一个基于真实语言服务器的 `lsp` 工具。当你需要时，优先使用它而不是原始 `grep`/`read`：

- **诊断**：`lsp(action="diagnostics", file=...)` — 真实的类型错误、缺少的导入、未使用的变量。在编写或编辑代码后始终检查诊断。
  - `lsp(action="diagnostics", file="*")` — 收集所有活跃服务器的 workspace 级诊断。
- **悬停/类型信息**：`lsp(action="hover", file=..., line=..., symbol=...)` — 符号的精确类型，无需读取整个文件。
- **引用**：`lsp(action="references", file=..., line=..., symbol=...)` — 每个调用点，包括 `grep` 错过的动态分发和重新导出。
- **定义**：`lsp(action="definition", ...)` 或 `lsp(action="type_definition", ...)` — 跳转到源码。跨包工作。
- **代码操作**：`lsp(action="code_actions", ...)` — 列出快速修复和重构。
  - `lsp(action="code_actions", ..., apply=true)` — 自动应用匹配的代码操作。
- **文件重命名**：`lsp(action="rename_file", file="old.ts", newName="new.ts")` — 重命名文件并自动更新所有引用。
- **工作区符号**：`lsp(action="symbols", query="MyClass")` — 在整个工作区中搜索符号。

经验法则：**在编辑导出符号之前**，调用 `lsp references` 查看影响范围。**在编写代码之后**，调用 `lsp diagnostics` 验证它能编译。**在重命名文件之前**，使用 `lsp rename_file` 而不是手动 rename，以确保所有引用更新。
```

- [ ] **Step 2: Commit**

```bash
git add src/prompts/vibe-system.md
git commit -m "更新系统提示词：添加新 LSP action 使用指南"
```

---

## Task 14: 测试

**Files:**
- Create: `tests/lsp.test.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
/**
 * srcode LSP extension unit tests.
 *
 * Tests the workspace edit engine (edits.ts) and diagnostics ledger
 * (diagnostics-ledger.ts) — the two new modules with testable pure logic.
 *
 * Does NOT test: actual LSP server communication, TUI rendering,
 * or extension event wiring (requires running language servers).
 */
import { expect, test, describe } from "bun:test";
import { applyTextEditsToString, applyWorkspaceEdit } from "../src/extensions/lsp/edits.ts";
import { DiagnosticsLedger } from "../src/extensions/lsp/diagnostics-ledger.ts";
import type { TextEdit } from "../src/extensions/lsp/types.ts";

describe("applyTextEditsToString", () => {
  test("applies single-line edit", () => {
    const content = "hello world";
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "there" },
    ];
    expect(applyTextEditsToString(content, edits)).toBe("hello there");
  });

  test("applies multi-line edit", () => {
    const content = "line1\nline2\nline3";
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 4 }, end: { line: 2, character: 4 } }, newText: "X\nY\nZ" },
    ];
    expect(applyTextEditsToString(content, edits)).toBe("lineX\nY\nZ3");
  });

  test("applies multiple edits in reverse order", () => {
    const content = "aaa bbb ccc";
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } }, newText: "DDD" },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "AAA" },
    ];
    expect(applyTextEditsToString(content, edits)).toBe("AAA bbb DDD");
  });

  test("throws on overlapping edits", () => {
    const content = "hello";
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: "a" },
      { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, newText: "b" },
    ];
    expect(() => applyTextEditsToString(content, edits)).toThrow("Overlapping text edits");
  });

  test("handles empty edits", () => {
    expect(applyTextEditsToString("hello", [])).toBe("hello");
  });

  test("handles insert (empty range)", () => {
    const content = "ac";
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "b" },
    ];
    expect(applyTextEditsToString(content, edits)).toBe("abc");
  });
});

describe("DiagnosticsLedger", () => {
  test("first call returns all messages", () => {
    const ledger = new DiagnosticsLedger();
    const result = ledger.reduce("/foo.ts", ["1:1 ERROR: bad", "2:1 WARNING: warn"]);
    expect(result).toEqual(["1:1 ERROR: bad", "2:1 WARNING: warn"]);
  });

  test("second call returns only new messages", () => {
    const ledger = new DiagnosticsLedger();
    ledger.reduce("/foo.ts", ["1:1 ERROR: bad", "2:1 WARNING: warn"]);
    const result = ledger.reduce("/foo.ts", ["1:1 ERROR: bad", "3:1 ERROR: new"]);
    expect(result).toEqual(["3:1 ERROR: new"]);
  });

  test("clear resets all state", () => {
    const ledger = new DiagnosticsLedger();
    ledger.reduce("/foo.ts", ["1:1 ERROR: bad"]);
    ledger.clear();
    const result = ledger.reduce("/foo.ts", ["1:1 ERROR: bad"]);
    expect(result).toEqual(["1:1 ERROR: bad"]);
  });

  test("different files tracked independently", () => {
    const ledger = new DiagnosticsLedger();
    ledger.reduce("/foo.ts", ["1:1 ERROR: bad"]);
    const result = ledger.reduce("/bar.ts", ["1:1 ERROR: bad"]);
    expect(result).toEqual(["1:1 ERROR: bad"]);
  });

  test("empty diagnostics for file clears tracking", () => {
    const ledger = new DiagnosticsLedger();
    ledger.reduce("/foo.ts", ["1:1 ERROR: bad"]);
    ledger.reduce("/foo.ts", []);
    // After clearing, same message should be "new" again
    const result = ledger.reduce("/foo.ts", ["1:1 ERROR: bad"]);
    expect(result).toEqual(["1:1 ERROR: bad"]);
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `bun test tests/lsp.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/lsp.test.ts
git commit -m "添加 LSP 单元测试：edits.ts + diagnostics-ledger.ts"
```

---

## Task 15: 集成验证

- [ ] **Step 1: 全量构建**

Run: `bun run bin/srcode.ts --help`
Expected: 正常启动，无编译错误。

- [ ] **Step 2: 全量测试**

Run: `bun test`
Expected: 所有测试通过（包括新增的 `tests/lsp.test.ts`）。

- [ ] **Step 3: 手动验证新 action（如有语言服务器可用）**

在 srcode 项目自身上测试：
- `lsp(action="symbols", query="LspClient")` — 应返回 LspClient 符号
- `lsp(action="diagnostics", file="*")` — 应返回 workspace 诊断

- [ ] **Step 4: Final commit**

```bash
git commit -m "LSP 功能对齐 oh-my-pi：9 项改进全部完成" --allow-empty
```
