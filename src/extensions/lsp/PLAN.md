# srcode LSP 改进计划

## 现状

- 4 文件 / ~400 行
- 3 个硬编码语言服务器（TS / Python / Rust）
- 5 个独立工具（hover / definition / references / diagnostics / symbols）
- 无 write/edit 联动、无配置系统、无多服务器支持

## 目标：逐阶段逼近 oh-my-pi 的 7,277 行 / 11 文件

---

## Phase 1：统一工具 + 新增操作（高优先级）

> 将 5 个独立工具合并为 1 个 `lsp` 工具，通过 `action` 参数路由。
> 同时新增最高价值的缺失操作。

### 1.1 合并为统一 `lsp` 工具

- 将 `lsp_hover` / `lsp_definition` / `lsp_references` / `lsp_diagnostics` / `lsp_symbols` 合并为 `lsp` 工具 + `action` 枚举参数
- 添加 `file` / `line` / `character` / `symbol` / `query` 可选参数
- `symbol` 参数支持按名称自动解析列位置（查找行内子串位置）

### 1.2 新增 `type_definition` 操作

- `client.ts` 新增 `textDocument/typeDefinition` 请求
- 返回类型定义而非值定义（对理解代码更精确）

### 1.3 新增 `implementation` 操作

- `client.ts` 新增 `textDocument/implementation` 请求
- 查找接口/抽象类的具体实现

### 1.4 新增 `code_actions` 操作

- `client.ts` 新增 `textDocument/codeAction` 请求
- 列出可用的代码修复、重构、导入建议
- 支持 `apply: true` + `query` 参数来应用选定的 action

### 1.5 新增 `rename` 操作

- `client.ts` 新增 `textDocument/rename` + `workspace/applyEdit` 请求
- 跨文件符号重命名

### 1.6 新增 `capabilities` 操作

- 显示当前活跃语言服务器支持的能力

### 1.7 新增 `status` 操作

- 显示已配置和已启动的服务器列表及状态

### 1.8 新增 `reload` 操作

- 优雅重启语言服务器

### 1.9 新增 `request` 操作

- 原始 LSP 请求逃生舱（高级用户调试用）

**验证**：手动测试每个 action 在 srcode 自身项目上的表现。

---

## Phase 2：配置系统 + 多服务器（高优先级）

> 建立外部配置，支持同一文件类型的多个语言服务器。

### 2.1 外置 `defaults.json`

- 将硬编码的 `SERVER_CONFIGS` 迁移为 `src/extensions/lsp/defaults.json`
- 覆盖 oh-my-pi 的全部 40+ 语言服务器配置
- 每个配置项：`command` / `args` / `fileTypes` / `rootMarkers` / `initOptions` / `settings`

### 2.2 用户配置文件

- 支持 `.srcode/lsp.json` 项目级配置
- 支持 `~/.srcode/lsp.json` 用户级配置
- 合并策略：用户配置 > 项目配置 > defaults.json

### 2.3 多服务器路由

- 同一文件可同时路由到多个服务器（如 tsserver + eslint + biome）
- 操作分类：type 操作（hover/definition/impl）走 primary 服务器；linter 操作（diagnostics）走所有匹配服务器
- diagnostics 合并去重

### 2.4 本地二进制解析

- 优先检查 `node_modules/.bin/`、`.venv/bin/`、`vendor/bundle/bin/`
- 再回退到 `$PATH`
- 二进制不存在时标记为 `(configured, not started)`

### 2.5 rootMarkers 检测

- 每个语言独立的 root marker 列表（替代当前的文件名存在性检测）
- 支持向上搜索父目录

**验证**：在 srcode 项目（TypeScript）和一个 Rust 项目上测试多服务器路由。

---

## Phase 3：Write/Edit 联动（中优先级）

> 这是 oh-my-pi LSP 最大的价值点——agent 每次编辑代码后立刻获得格式化 + 诊断反馈。

### 3.1 `formatOnWrite`

- write/edit 操作后自动用 LSP formatter 格式化代码
- 从 `.editorconfig` 解析 `tabSize` / `indentStyle`
- 回退到文件内容缩进嗅探

### 3.2 `diagnosticsOnWrite`

- write/edit 操作后自动收集诊断
- 静默窗口策略：先等 500ms inline，超时后后台延迟推送
- 诊断作为工具结果的附加信息返回

### 3.3 writethrough 机制

- 在 `tool_call` 事件中拦截 write/edit
- 自动 sync 文件内容到服务器 → 格式化 → 收集诊断
- 通过事件钩子实现（不侵入 upstream 工具）

**验证**：在 srcode 项目上执行一次真实编辑，验证自动诊断返回。

---

## Phase 4：可靠性 + 性能（低优先级）

### 4.1 惰性预热

- `session_start` 时检测并预热语言服务器（避免首次工具调用冷启动）

### 4.2 references 重试

- 仅返回声明或仅文件内结果时自动重试（3 次，250/500/1000ms 退避）

### 4.3 诊断版本跟踪

- 跟踪 `publishDiagnostics` 的 document version
- 避免返回过期诊断

### 4.4 abort signal 传递

- 将工具的 abort signal 传递到 LSP 请求（替代固定 30s 超时）

### 4.5 结果元数据

- 每个结果附带 `{ serverName, action, success, request }` 便于调试

**验证**：在大型项目上测试冷启动时间和诊断延迟。

---

## 文件结构目标

```
src/extensions/lsp/
├── types.ts          — LSP 协议类型 + 工具详情类型
├── client.ts         — JSON-RPC over stdio（扩展：rename/code_action/impl 等请求）
├── config.ts         — 配置加载 + 合并 + 服务器路由 + 本地二进制解析
├── defaults.json     — 40+ 语言服务器默认配置
├── manager.ts        — 多服务器生命周期管理 + 文件同步
├── format-options.ts — .editorconfig 解析 + 缩进嗅探
├── utils.ts          — 格式化 + 类型守卫 + 辅助函数
└── index.ts          — 统一 lsp 工具 + writethrough 钩子
```

预估最终规模：~2,500-3,000 行（oh-my-pi 的 ~40%，覆盖其 ~80% 用户可见功能）。
