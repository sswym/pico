# AGENTS.md

> pico — 基于 pi-coding-agent 的 vibe coding agent，通过 ExtensionFactory 插件系统增强。

## 命令

```bash
bun run start              # 源码模式启动（开发用）
bun run build              # 3 阶段编译：嵌入资源生成 → bun compile → 生成 package.json
bun test                   # Bun 原生测试运行器，完全离线
bun run verify             # 类型检查 + 全量测试
bun test tests/memory.test.ts  # 运行单个测试文件
```

无 lint、format 命令；类型检查通过 `bun run verify` 中的 `tsc --noEmit` 执行。

## 运行时与工具链

- **Bun**（非 Node.js）。tsconfig 中 `types: ["bun"]`，所有 import 可带 `.ts` 后缀
- **构建**：`scripts/build.ts` + `bun build --compile`，产出独立二进制（~102MB）
- **包管理**：`bun.lock`，`@earendil-works/*` 系列上游依赖
- **零 lint/formatter 配置** — 不引入 ESLint/Prettier/biome
- **缩进**：默认 2 空格；`src/extensions/subagent/`、`oma.ts`、`lsp/executor.ts` 沿用 Tab。`.editorconfig` 已记录此分布，新文件跟随所在目录，不要为改缩进产生纯格式 diff

## 关键 tsconfig 非默认值

```jsonc
"verbatimModuleSyntax": true,   // 必须用 `import type` 导入纯类型
"noUncheckedIndexedAccess": true, // arr[0] 类型为 T | undefined
"noImplicitOverride": true,
"allowImportingTsExtensions": true,
"strict": true
```

## 架构

pico 是 `@earendil-works/pi-coding-agent` 的 **thin wrapper**。上游提供 agent loop、tool runtime、session 管理；pico 通过 19 个 ExtensionFactory 插件注入功能。

### 入口链

```
bin/pico.ts → bin/env-bootstrap.ts（副作用，必须最先导入）→ main(args, { extensionFactories })
```

### 扩展注册顺序

`vibe → cache-optimizer → todo → retro-theme → language → input-history → logo → memory → subagent → vision → ask → init → plan → web → lsp → rtk → hooks → mcp → doctor`

### 核心模式

- **ExtensionFactory**：`(pi: ExtensionAPI) => void | Promise<void>` — 通过 `pi.registerTool()`、`pi.registerCommand()`、`pi.on(event, handler)` 注入功能
- **事件生命周期**：`before_agent_start` → `session_start` → `tool_call` → `tool_result` → `turn_end` → `agent_end`
- **Session-scoped state**：todo、plan 等状态以 session ID 为 key，module-level 变量持有
- **DI 工厂**：hooks 扩展用显式依赖注入 `createHooksExtension({ load, run, cwd })`

### 关键目录

```
src/extensions/    — 19 个功能扩展（memory、subagent、lsp、plan 等）
src/prompts/       — 系统提示词模板（.md）
src/skills/        — 内置技能（verify、recap、agents-init）
scripts/build.ts   — 唯一构建脚本
tests/             — 与 src/extensions/ 一一对应的测试文件
```

## 测试约定

- 框架：`bun:test`，无 jest/vitest/mocha
- **Hand-rolled fakes 优先**：不使用 mock 库，每个测试文件内联定义 `fakePi`、`FakeUi`、`stubTheme` 等
- **`__reset*ForTests()` 钩子**：生产代码导出 `__resetPlanStateForTests()`、`__resetWarnedPaths()` 等供测试重置状态
- **环境变量隔离**：`process.env.PICO_HOME` 重定向到 `mkdtempSync()` 临时目录
- **网络 mock**：直接替换 `globalThis.fetch`，测试后恢复
- 文件命名：`tests/<feature>.test.ts`，与 `src/extensions/<feature>/` 对应
- 大部分用扁平 `test()`，不用 `describe` 分组（`web.test.ts`、`ask.test.ts` 例外）
- 无共享 `tests/helpers.ts`，无 fixture 目录，无覆盖率配置

### 测试模式示例

```typescript
// Extension 测试 — 用 fakePi 驱动工厂
function makeFakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers: Record<string, Array<...>> = {};
  return {
    tools, commands, handlers,
    on: (event, handler) => { (handlers[event] ??= []).push(handler); },
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: (n, opts) => commands.set(n, opts),
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
}
```

## 环境变量

| 变量 | 用途 |
|------|------|
| `PICO_HOME` | 重定位整个 pico 数据根目录（默认 `~/.pico`） |
| `PICO_MEMORY_DB` | 覆盖记忆数据库路径（默认 `~/.pico/memory.db`） |
| `PICO_SEARCH_PROVIDER` | 设为 `tavily` 切换搜索引擎（默认 Exa MCP） |
| `TAVILY_API_KEY` | Tavily 搜索 API 密钥（可选） |
| `PICO_ALLOW_UNATTENDED_PLAN_APPROVAL` | 非交互模式下允许 `ExitPlanMode` 自动批准 |
| `PICO_ALLOW_LSP_FORMAT_ON_WRITE` | 允许 LSP `formatOnWrite` 在 edit/write 后自动二次写文件 |
| `PICO_ENABLE_PROJECT_HOOKS` | 启用 `<repo>/.pico/hooks.json` 项目级 shell hooks |
| `PICO_ENABLE_PROJECT_MCP` | 启用 `<repo>/.pico/mcp-servers.json` 项目级 MCP 服务器 |

这些安全开关也可长期写入 `~/.pico/agent/settings.json` 的 `safety` 字段；环境变量优先于 settings：

```json
{
  "safety": {
    "enableProjectHooks": false,
    "enableProjectMcp": false,
    "allowUnattendedPlanApproval": false,
    "allowLspFormatOnWrite": false
  }
}
```

## 编辑注意事项

- `bin/env-bootstrap.ts` 有副作用（设置路径），必须在 `bin/pico.ts` 最先导入
- `src/generated/` 是构建时生成的，不要手动编辑
- 扩展间通过事件链解耦，不要在扩展间直接 import
- 修改扩展时检查对应的 `tests/<feature>.test.ts`，可能需要同步更新 `__reset*ForTests()` 钩子
- LSP 扩展最复杂（只读 action + 被阻断的写入/高风险 action、workspace edit 引擎、diagnostics ledger），改动前先读 `src/extensions/lsp/` 全部文件
