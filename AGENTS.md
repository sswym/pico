# AGENTS.md

> pico — 基于 pi-coding-agent 的 vibe coding agent，通过 ExtensionFactory 插件系统增强。

## 命令

```bash
bun run start              # 源码模式启动（开发用）
bun run build              # 3 阶段编译：嵌入资源生成 → bun compile → 生成 package.json（默认 linux-x64，--target 交叉编译）
bun test                   # Bun 原生测试运行器，完全离线
bun run verify             # 类型检查 + 全量测试
bun test tests/memory.test.ts  # 运行单个测试文件
PI_PACKAGE_DIR=node_modules/@earendil-works/pi-coding-agent bun run scripts/memory-e2e-test.ts  # 记忆系统端到端测试（驱动真实 CLI + sqlite 校验，需网络/模型，慢）
```

无 lint、format 命令；类型检查通过 `bun run verify` 中的 `tsc --noEmit` 执行。

## 运行时与工具链

- **Bun**（非 Node.js）。tsconfig 中 `types: ["bun"]`，所有 import 可带 `.ts` 后缀
- **构建**：`scripts/build.ts` + `bun build --compile`，产出独立二进制（~102MB）
- **包管理**：`bun.lock`，`@earendil-works/*` 系列上游依赖
- **零 lint/formatter 配置** — 不引入 ESLint/Prettier/biome
- **缩进**：默认 2 空格；`src/extensions/subagent/`、`lsp/executor.ts` 沿用 Tab。`.editorconfig` 已记录此分布，新文件跟随所在目录，不要为改缩进产生纯格式 diff

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
bin/pico.ts → bin/env-bootstrap.ts（副作用，必须最先导入）
            → src/runtime/{args,embedded-runtime,setup,extensions}.ts
            → main(args, { extensionFactories: createDefaultExtensionRegistry().factories() })
```

### 扩展注册顺序

唯一事实来源：`src/runtime/extensions.ts` 的 `defaultExtensions`（19 个扩展，含 phase/dependsOn/safety 元数据，注册时校验重复与依赖顺序）。

`vibe → cache-optimizer → todo → retro-theme → language → input-history → logo → memory → subagent → vision → ask → init → plan → web → lsp → rtk → hooks → mcp → doctor`

### 核心模式

- **ExtensionFactory**：`(pi: ExtensionAPI) => void | Promise<void>` — 通过 `pi.registerTool()`、`pi.registerCommand()`、`pi.on(event, handler)` 注入功能
- **事件生命周期**：`before_agent_start` → `session_start` → `tool_call` → `tool_result` → `turn_end` → `agent_end` → `session_shutdown`（多个扩展在 shutdown 做清理/落盘）
- **Session-scoped state**：todo、plan 等状态以 session ID 为 key，module-level 变量持有
- **DI 工厂**：hooks、mcp 扩展用显式依赖注入 `createHooksExtension` / `createMcpExtension`
- **共享模块**：扩展间不直接 import；轻量通知走 `src/extensions/events.ts`，公共设置/安全开关走 `src/extensions/{settings,policy}.ts`

### 关键目录

```
src/extensions/    — 19 个功能扩展（memory、subagent、lsp、plan 等）
src/runtime/       — 启动链：参数构建、嵌入资源解包、setup 命令、扩展注册表
src/setup/         — `pico setup` 向导
src/prompts/       — 系统提示词模板（.md）
src/skills/        — 内置技能（recap、verify）
scripts/build.ts   — 唯一构建脚本
tests/             — 与 src/extensions/ 对应的测试文件（另有 runtime/setup/skills/paths/policy/events/ui 等非扩展测试）
docs/internal-tech-review.md — 架构、踩坑记录、已知局限
CONTEXT.md         — 领域术语与重构记录（改架构前先读）
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
| `PICO_ALLOW_UNATTENDED_PROJECT_AGENTS` | 非交互模式下允许运行项目级子代理（**仅 env，无 settings 对应项**，见 `policy.ts`） |
| `PICO_HOOK_RECURSION_GUARD` | 内部防递归标记：hooks 调起的 `pico` 子进程会带此变量，命中时直接拒绝启动。不要手动设置 |
| `PICO_SUBAGENT_DEPTH` | 内部子代理嵌套深度标记（`subagent/process.ts` 为每个子进程 +1），深度 ≥3 拒绝启动。不要手动设置 |
| `PICO_RTK` | 设为 `0` 关闭 RTK 集成 |
| `PICO_VISION_PROVIDER` / `PICO_VISION_MODEL` | 覆盖辅助视觉模型的 provider/model（无 settings 对应项时也可用） |
| `PICO_CACHE_OPTIMIZER_DISABLE` | 关闭 cache-optimizer（设为任意非空值） |
| `PICO_CACHE_OPTIMIZER_NO_PROMPT_REWRITE` / `PICO_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION` / `PICO_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY` / `PICO_CACHE_OPTIMIZER_ALLOW_PROXY_LONG_RETENTION` | cache-optimizer 分项开关 |

前四个安全开关也可长期写入 `~/.pico/agent/settings.json` 的 `safety` 字段；环境变量优先于 settings。**值必须是布尔**——字符串会被当作禁用并打印告警：

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
