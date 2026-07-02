<!-- AGENTS.md — srcode 项目知识库，为 AI agent 提供最少必要上下文 -->
<!-- 生成时间: 2026-07-01 -->

# AGENTS.md

## 命令与脚本

| 用途 | 命令 | 说明 |
|---|---|---|
| 构建二进制 | `bun run scripts/build.ts` | 3 阶段构建：① 生成 `src/generated/embedded-assets.ts` ② `bun build --compile` ③ 生成 `build/package.json` |
| 构建目标 | `bun run scripts/build.ts --target bun-darwin-arm64 --out ./dist` | 跨平台编译，默认 `bun-linux-x64-modern` |
| 开发运行 | `bun run bin/srcode.ts` | 源码模式，直接运行入口 |
| 测试 | `bun test` | 无 flags，扁平目录 `tests/*.test.ts` |
| 启动脚本 | `bun run start` → `bun run bin/srcode.ts` | 同开发运行 |

**构建产物**: `build/srcode`（独立二进制）+ `build/package.json`（重命名 pi 元数据使 `APP_NAME="srcode"`）。产物被 `.gitignore` 忽略。

### 导入顺序依赖（关键）

`bin/srcode.ts` 的第一行必须是：
```ts
import "./env-bootstrap.ts";  // 必须在所有 pi 导入之前执行
```
这个副作用模块将 `~/.pi` 重定向到 `~/.srcode/agent/`，从 `settings.json` 注入环境变量，并禁用上游版本检查和思考层级快捷键。ESM 静态导入保证它在其他一切之前执行——但**绝不能**移动或删除这行。

## 代码约定

### TypeScript 非默认配置

- `module: "Preserve"` — 保留原生 ESM，不做转换
- `moduleResolution: "bundler"` — Bun 原生解析
- `verbatimModuleSyntax: true` — **强制 `type` 导入语法**（`import type { Foo } from "..."`）
- `noUncheckedIndexedAccess: true` — 对象属性访问返回 `T | undefined`，强制防御
- `noImplicitOverride: true` — 重写方法必须加 `override` 关键字
- `allowImportingTsExtensions: true` — 导入使用 `.ts` 后缀，不加 `.js`
- `noEmit: true` — Bun 是运行时+转译器，不走 tsc 输出
- `jsx: "react-jsx"` — 保留 JSX 支持（当前未使用，但配置在此）

### 测试模式

- **框架**: `bun:test`（`describe` / `test` / `expect`，从不使用 `it`）
- **模拟**: 完全手写 fake（无 `jest.mock`、`sinon`、`ts-mockito`）。每个测试文件定义自己的 fake 对象。
- **共享**: **无**共享辅助工具。每个 `tests/*.test.ts` 完全自包含。
- **目录清理**: `beforeEach` 创建临时目录 + 设 `$SRCODE_HOME` → `afterEach` 删除 + 恢复 env var。
- **测试接缝**: 部分模块通过条件导出 `__reset*ForTests` 符号暴露测试接口（如 `__resetPlanStateForTests`、`__resetWarnedPaths`）。
- **文件注释**: 每个测试文件以 `/**` 块注释开头，说明测试范围和不测试的内容。

### 错误处理哲学

- **运行器绝不 `throw`** — 总是返回 `{ exitCode, stdout, stderr, timedOut }` 结果对象
- **配置加载器静默降级** — 缺失文件不是错误，JSON 格式错误只日志不抛出
- **工具错误** — 以 `{ content: [...], isError: true }` JSON 形式返回
- **重复警告去重** — 用 `warnOnce()` 和 `Set<string>` 实现
- **配置加载模式** — 两层：`~/.srcode/<module>.json` + `<cwd>/.srcode/<module>.json`，在 `(event|tool|command)` 元组上合并去重

## 仓库礼仪

- **分支命名**: 短名称，**不含斜杠**（如 `ccg`、`master`）
- **提交风格**: 中文描述句，**不使用 Conventional Commit 格式**（`feat:`、`fix:` 等前缀）。例如："实现权限系统"、"增强记忆系统：扩展类别、纠正检测"
- **CI**: **无** GitHub Actions / GitLab CI / 其他 CI 配置
- **Lint/Formatter**: **无** — 项目不配置 eslint、prettier 或类似工具
- **依赖管理**: `bun.lock` 提交到仓库；`node_modules/` 不提交

## 环境要求

必要环境变量（通过 `~/.srcode/agent/settings.json` 的 `env` 键管理，也可从 shell 继承）：

| 变量 | 用途 | 说明 |
|---|---|---|
| `$SRCODE_HOME` | 重定位 `~/.srcode` | 可选，默认 `~/.srcode` |
| `$SRCODE_MEMORY_DB` | 自定义记忆数据库路径 | 可选，默认 `<SRCODE_HOME>/memory.db` |
| `$TAVILY_API_KEY` | Web 搜索备选后端 | 可选，不设则用 Exa MCP（无需密钥） |
| `$SRCODE_CODING_AGENT_DIR` | agent 数据目录 | 由 `env-bootstrap.ts` 自动设置 |
| `$SRCODE_CODING_AGENT_SESSION_DIR` | 会话数据目录 | 由 `env-bootstrap.ts` 自动设置 |

API 密钥（Anthropic、OpenAI、Google 等）同样配置在 `~/.srcode/agent/settings.json` 中。

**`.env` 文件**: 项目中存在 `.env`（仅示例用途），但实际环境变量优先通过 `settings.json` 管理。

## 架构决策

### 扩展系统

srcode 是 `@earendil-works/pi-coding-agent`（`^0.79.10`）的包装器，通过 **12 个扩展** 叠加功能。每个扩展是 `ExtensionFactory = (pi: ExtensionAPI) => void`，在 `bin/srcode.ts` 中按**严格顺序**注册：

```
vibe → language → logo → memory → subagent → todo → ask → init → plan → web → permissions → hooks
```

这个顺序影响事件处理优先级（特别是 `tool_call` 和 `turn_end` 事件的监听顺序）。扩展可注册：
- **工具**（LLM 可调用）：`pi.registerTool(defineTool({...}))`
- **斜杠命令**（用户可调用）：`pi.registerCommand("name", {...})`
- **事件钩子**: `pi.on("tool_call" | "turn_end" | "session_shutdown" | "before_agent_start" | "agent_end", ...)`

### 权限优先级

`deny` > `ask` > `allow`。规则从两层配置合并（home + project）。三模式：`default` / `accept-all` / `deny-all`。无 UI 时回退为拒绝。

### 子 agent 架构

- 三种工作模式：`single`、`parallel`（`mapWithConcurrencyLimit` 限制 4 并行）、`chain`（`{previous}` / `{outputs.key}` 占位符）
- 内置角色：`scout`、`planner`、`worker`、`reviewer`、`oracle`、`researcher`
- 最大并行任务硬上限：**8**
- 通过生成独立 pi 进程实现隔离

### 记忆子系统

- 后端：`bun:sqlite` + FTS5 全文搜索
- 信任分数：`[0, 1]` 浮点数，通过 `feedback(true|false)` 调整
- 作用域：`global` / `project` 隔离
- 敏感信息扫描：存储前检测 API 密钥/令牌并阻止
- 实时纠正：`turn_end` 时检测用户纠正并调整已存事实的信任分数
- 关闭时自动摘要提取

### 构建模式

- **源码模式**（`bun run bin/srcode.ts`）：嵌入式资源优雅降级为磁盘读取
- **编译模式**（`bun run scripts/build.ts`）：扫描 `src/extensions/subagent/{agents,prompts}/`、`src/skills/`、pi 包的 `theme/`、`export-html/`、`assets/`，全部内联到 `src/generated/embedded-assets.ts`，生成**完全自包含的独立二进制**
- 编译模式下旧版资源目录（`agents/`、`assets/`、`export-html/`、`prompts/`、`skills/`、`theme/`）在编译前自动清除

### 钩子系统

两层配置（`~/.srcode/hooks.json` + `<cwd>/.srcode/hooks.json`），在 `(event|tool|command)` 元组上去重合并。支持 4 种事件：
- `PreToolUse`（可阻断）
- `PostToolUse`（仅警告）
- `PostUserMessage`
- `PreSessionEnd`

钩子通过 `Bun.spawn(["sh", "-c", command])` 执行，支持 `$FILE` / `$TOOL` / `$TURN` 占位符替换，4KB 输出截断，超时 SIGKILL。

## 导入内容：已有 AI 配置迁移

**无**。项目不包含 `.cursor/`、`.claude/`、`.github/copilot-instructions.md`、`CLAUDE.md` 或任何其他 AI 配置文件。本文件是第一个。
