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
bun run update-deps               # 升级 @earendil-works/pi-* 到最新版，显示 diff 后跑 bun run verify（scripts/update-deps.sh）
```

无 lint、format 命令；类型检查通过 `bun run verify` 中的 `tsc --noEmit` 执行。

**CI**：`.github/workflows/ci.yml` 在 push/PR 时跑 `bun install --frozen-lockfile` + `bun run verify`（build 作业依赖 verify 通过）。本地门禁同样只有一个：改动后跑 `bun run verify`。

## 运行时与工具链

- **Bun**（非 Node.js）。tsconfig 中 `types: ["bun"]`，所有 import 可带 `.ts` 后缀
- **构建**：`scripts/build.ts` + `bun build --compile`，产出独立二进制（~102MB）
- **包管理**：`bun.lock`，`@earendil-works/*` 系列上游依赖（`pi-ai` / `pi-agent-core` / `pi-coding-agent` / `pi-tui` 4 包**版本锁步**在 `^0.84.1`，靠 `update-deps` 同步升级，不要单独锁某一包）
- **零 lint/formatter 配置** — 不引入 ESLint/Prettier/biome
- **缩进**：默认 2 空格；`src/extensions/subagent/`、`lsp/executor.ts` 沿用 Tab。`.editorconfig` 已记录此分布，新文件跟随所在目录，不要为改缩进产生纯格式 diff

## 关键 tsconfig 非默认值

```jsonc
"verbatimModuleSyntax": true,   // 必须用 `import type` 导入纯类型
"noUncheckedIndexedAccess": true, // arr[0] 类型为 T | undefined
"noImplicitOverride": true,
"allowImportingTsExtensions": true,
"strict": true,
// 显式关闭（默认反而开）：noUnusedLocals / noUnusedParameters / noPropertyAccessFromIndexSignature 均为 false
// 其余非默认：module: "Preserve", moduleResolution: "bundler", skipLibCheck: true
```

## 架构

pico 是 `@earendil-works/pi-coding-agent` 的 **thin wrapper**。上游提供 agent loop、tool runtime、session 管理；pico 通过 30 个 ExtensionFactory 插件注入功能。

### 入口链

```
bin/pico.ts → bin/env-bootstrap.ts（副作用，必须最先导入）
            → src/runtime/{args,embedded-runtime,setup,extensions}.ts
            → main(args, { extensionFactories: createDefaultExtensionRegistry().factories() })
```

### 扩展注册顺序

唯一事实来源：`src/runtime/extensions.ts` 的 `defaultExtensions`（**30 个扩展**）。每个带 `phase: "prompt" | "ui" | "tools" | "runtime" | "diagnostics"`、可选 `dependsOn` / `safety` 元数据；注册时校验**重名**与 **dependsOn 必须先于依赖者注册**。所有工厂以 `hidden: true` 注册，避免上游启动面板出现 `<inline:N>` 占位噪行。

`vibe → auto-thinking → ponytail → cache-optimizer → todo → retro-theme → language → input-history → ccstyle → logo → memory → context-pruner → subagent → skill → vision → ask → init → plan → undo → web → lsp → rtk → hooks → evolution → mcp → observability → signals → doctor → help`

### 双运行模式（源码 vs 编译二进制）

- **源码模式**：`bun run start` 直跑 TS。**编译模式**：`scripts/build.ts` 生成的单文件二进制 `build/pico`，资源（prompts/skills/theme/export-html）先内嵌成 `src/generated/embedded-assets.ts`，运行时由 `embedded-runtime.ts` 检测 Bun 内部 URL 特征（`$bunfs`）解压到临时目录，加载完成后注册 exit 清理。
- **信号处理**：`signals` 扩展注册 SIGINT/SIGTERM 处理器（进程级仅注册一次，`/reload` 不叠加）：运行中收到 SIGINT → `ctx.abort()` 取消当前任务（等价 Esc 中断，5s 内第二次 SIGINT 强制优雅退出）；空闲时 SIGINT / 任意 SIGTERM → `ctx.shutdown()` 走宿主优雅关闭（session flush、MCP shutdown）。不要给嵌入式运行时再加信号清理（embedded-runtime 只注册 `exit` 清理）。
- 两级**递归护栏**（防 LLM 失控递归）：hook 进程与子代理子进程都在启动时拒绝运行（`PICO_HOOK_RECURSION_GUARD==1` / `PICO_SUBAGENT_DEPTH≥3`），这俩变量**不要手动设置**。

### 子代理分层（src/extensions/subagent/）

`index.ts` 只做 schema/描述/渲染适配，**执行全在 `orchestrator.ts`**；`process.ts` 负责子进程 spawn、`parallel.ts` + `worktree.ts`（git worktree 隔离）+ `concurrency.ts` 限并发、`chain.ts` 带 `{previous}` 内联 2MB 上限、`gates.ts` 校验 frontmatter `acceptance`、`session.ts` fork 父会话历史、`schema.ts` 校验 frontmatter `output`（JSON Schema 子集）、`config.ts` 读 `~/.pico/subagent.json`（agents 覆盖 + `spawns` 白名单 + `parallel` 上限 + `sessions` 开关）。改子代理前先读 `orchestrator.ts`，别在 `index.ts` 塞逻辑。

### UI 渲染安全（src/extensions/ui/rendering.ts）

工具/子代理输出上屏前必须先过 `sanitizeTerminalText`（剥除 OSC/DCS 序列，防剪贴板劫持/kitty 图形注入）；`truncateWithEllipsis` 按 code point 截断（防切断半 emoji）。新 UI 渲染路径必须走这两个函数。

### 核心模式


- **ExtensionFactory**：`(pi: ExtensionAPI) => void | Promise<void>` — 通过 `pi.registerTool()`、`pi.registerCommand()`、`pi.on(event, handler)` 注入功能
- **事件生命周期**：`before_agent_start` → `session_start` → `tool_call` → `tool_result` → `turn_end` → `agent_end` → `session_shutdown`（多个扩展在 shutdown 做清理/落盘）
- **Session-scoped state**：todo、plan 等状态以 session ID 为 key，module-level 变量持有
- **DI 工厂**：hooks、mcp 扩展用显式依赖注入 `createHooksExtension` / `createMcpExtension`
- **共享模块**：扩展间不直接 import；轻量通知走 `src/extensions/events.ts`，公共设置/安全开关走 `src/extensions/{settings,policy}.ts`

### 关键目录

```
src/extensions/    — 29 个功能扩展（memory、subagent、lsp、plan、undo、signals、ponytail、ccstyle、evolution 等）
src/runtime/       — 启动链：参数构建、嵌入资源解包、setup 命令、扩展注册表
src/setup/         — `pico setup` 向导
src/prompts/       — 系统提示词模板（.md）
scripts/build.ts   — 唯一构建脚本
tests/             — 与 src/extensions/ 对应的测试文件（另有 runtime/setup/paths/policy/events/ui 等非扩展测试）
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
| `PICO_ENABLE_PROJECT_LSP` | 启用 `<repo>/.pico/lsp.json` 项目级 LSP 配置 |
| `PICO_ALLOW_UNATTENDED_PROJECT_AGENTS` | 非交互模式下允许运行项目级子代理（**仅 env，无 settings 对应项**，见 `policy.ts`） |
| `PICO_HOOK_RECURSION_GUARD` | 内部防递归标记：hooks 调起的 `pico` 子进程会带此变量，命中时直接拒绝启动。不要手动设置 |
| `PICO_SUBAGENT_DEPTH` | 内部子代理嵌套深度标记（`subagent/process.ts` 为每个子进程 +1），深度 ≥3 拒绝启动。不要手动设置 |
| `PICO_RTK` | 设为 `0` 关闭 RTK 集成 |
| `PICO_VISION_PROVIDER` / `PICO_VISION_MODEL` | 覆盖辅助视觉模型的 provider/model（无 settings 对应项时也可用） |
| `PICO_CACHE_OPTIMIZER_DISABLE` | 关闭 cache-optimizer（设为 `1`/`true`/`yes`/`on`；`0`/`false` 视为未禁用） |
| `PICO_CACHE_OPTIMIZER_NO_PROMPT_REWRITE` / `PICO_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION` / `PICO_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY` / `PICO_CACHE_OPTIMIZER_ALLOW_PROXY_LONG_RETENTION` | cache-optimizer 分项开关 |
| `PICO_EVOLUTION_ENABLED` | 启用自进化审查（会话后自动沉淀技能；默认关，settings `evolution.enabled` 或 env） |
| `PICO_EVOLUTION_PROVIDER` / `PICO_EVOLUTION_MODEL` | 覆盖审查模型（默认跟随主模型） |
| `PICO_EVOLUTION_DENY` | 审查输出门禁关键词（逗号分隔，命中拒写技能） |

前五个安全开关也可长期写入 `~/.pico/agent/settings.json` 的 `safety` 字段；环境变量优先于 settings。**值必须是布尔**——字符串会被当作禁用并打印告警：

```json
{
  "safety": {
    "enableProjectHooks": false,
    "enableProjectMcp": false,
    "enableProjectLsp": false,
    "allowUnattendedPlanApproval": false,
    "allowLspFormatOnWrite": false
  }
}
```

### 用户级配置收敛（2026-08）

用户级 pico 配置统一存于 `~/.pico/agent/settings.json`（`$PICO_HOME` 可重定位）命名空间：`safety` / `auxiliary.vision` / `memory` / `integrations.rtk` / `hooks` / `mcpServers` / `lsp` / `subagent` / `env`。旧独立文件（`~/.pico/hooks.json`、`~/.pico/mcp-servers.json`、`~/.pico/lsp.json`、`~/.pico/subagent.json`）在 `pico setup` 运行时自动迁入对应键（`src/extensions/config-migrate.ts`）；未迁移时各扩展加载器回退旧文件。**项目级配置保持分文件**（`.pico/hooks.json`、`.pico/mcp-servers.json`、`.pico/lsp.json`、`.pico/agents/`，仓库可控 + 安全开关 gate）。

修改用户级配置读取/写入时：先查 settings.json 命名空间（`readSettings()`），再回退旧文件；新写路径一律写 settings.json 命名空间。全量 `PICO_*` 环境变量与 settings 键的对应关系登记在 `src/extensions/envmap.ts`，`/doctor` 的 `Env ↔ settings:` 段展示生效值——新增 `PICO_*` 变量必须在此登记。

### 模型请求超时（settings.json `httpIdleTimeoutMs`）

单次模型请求超时由上游读取同一份 `~/.pico/agent/settings.json` 的 `httpIdleTimeoutMs`（单位 ms；`0` = 禁用；也接受 `"disabled"` 或数值字符串），**默认 300000（5 分钟）**。上游挂起时表现为"等待 Ns 计时 + 超时后自动重试（最多 3 次，指数退避）"，最坏约 4×超时。pico 侧已做校验（非法值进 /doctor）并在 /doctor 的 `Request timeout:` 段展示生效值。示例：

```json
{ "httpIdleTimeoutMs": 60000 }
```

## 编辑注意事项

- `bin/env-bootstrap.ts` 有副作用（设置路径），必须在 `bin/pico.ts` 最先导入
- `src/generated/` 是构建时生成的，不要手动编辑
- 扩展间通过事件链解耦，不要在扩展间直接 import
- 修改扩展时检查对应的 `tests/<feature>.test.ts`，可能需要同步更新 `__reset*ForTests()` 钩子
- LSP 扩展最复杂（只读 action + 被阻断的写入/高风险 action、workspace edit 引擎、diagnostics ledger），改动前先读 `src/extensions/lsp/` 全部文件
- `cache-optimizer` 有已记录缺陷（见先前审查 `(memory:#37)`）：`optimizeSystemPrompt` 会拆散 AGENTS.md/CLAUDE.md 的 `<project_instructions>` 包装、按候选顺序重排 system prompt 稳定段。它直接改每个请求的 prompt/token 成本，改动前先做边界审计（空输入/超长/中文/特殊字符）
- `cache-optimizer` 支持扩展用 `<!-- PICO_CACHE_STABLE:START -->…<!-- PICO_CACHE_STABLE:END -->` 标记把每轮字节不变的注入段标为稳定，`optimizeSystemPrompt` 会将其提取进缓存前缀；模式相关文本（如 ponytail 的 `lite/full/ultra` 级别行）必须留在标记外——进前缀后模式切换会整前缀缓存失效。标记会参与结构标记安全网校验（`extractStructuralMarkers`）
- `ponytail`（`src/extensions/ponytail/` + `src/skills/ponytail*/`）是 vendored 自 https://github.com/DietrichGebert/ponytail（MIT，v4.9.0）的第 28 个内置扩展：规则注入 + 6 个 `/ponytail*` 命令 + 会话模式持久化。配置收敛在 settings.json `ponytail` 命名空间（defaultMode/quietStartup/hideStatus，env `PONYTAIL_*` 优先）；SKILL.md 走嵌入式资源（源码模式 `src/skills/`）。注入文本用 `PICO_CACHE_STABLE` 标记拆稳定/模式段（见上条）。同步上游时更新版本注释；已内置后不要再 `pico install` 外部 ponytail（技能会双份）
- `ccstyle`（`src/extensions/ccstyle/`）是移植自 https://github.com/minuque/pi-cc-extensions（MIT，v0.8.54）的第 29 个内置扩展（phase: ui）：Claude Code 风格工具渲染——连续工具调用分组（`Container.prototype.addChild/removeChild/clear` 补丁 → `ToolGroupComponent`）、单行摘要 + 状态图标、Input/Output 展开视图、edit/write 结果自动展开与着色 diff（复用上游 `result.details.diff`，无 shiki 依赖）、fullscreen 鼠标点击展开/收起（实例级包装 `handleViewportInput` + `currentLayout` 布局树命中）。配置：settings.json `ccstyle.enabled`（默认 true）+ `/ccstyle on|off|status`。接管规则：**全部工具**统一 ccstyle 渲染（上游内置与 pico 定制工具），渲染与执行解耦；pico 工具折叠摘要复用 `summarizeToolCall`（`tool-render.ts`）。改这里前先读 `render.ts`（原型补丁的 downstream 必须是方法值快照，别名会自递归）与 `grouping.ts`（edit/write/apply_patch 不入组但渲染被接管）
- `evolution`（`src/extensions/evolution/`）是第 30 个内置扩展（phase: runtime）：自进化闭环——`agent_end` 回合末异步审查会话消息（辅助模型直调，`review.ts`），输出严格 JSON 经 `apply.ts` 校验（技能名消毒、路径穿越、注入特征 `PICO_EVOLUTION_DENY`、大小上限）后写入 `~/.pico/agent/skills/`，`.pico-evolved.json` 清单记录自产技能（用户手写技能永不触碰，mtime 比对新则跳过）。默认关（`evolution.enabled` / `PICO_EVOLUTION_ENABLED`）；设计文档 `docs/evolution-design.md`。改这里前先读 `apply.ts` 的安全校验清单与 `index.ts` 的触发/频率限制
- `undo`（`src/extensions/undo/`，phase: tools）是旁路观测式代码回退（对标 Claude Code rewind / OpenCode undo，设计文档 `docs/undo-design.md`）：`tool_call` 时读 edit/write 目标文件原内容存内容寻址 blob（`$PICO_HOME/agent/cache/undo/<sessionId>/blobs/`），`tool_result` 成功才入 undo 栈、失败丢弃；`/undo` `/redo` `/undo-status` `/undo-clear` 命令。**关键约束：纯旁路观测——不覆盖工具、不重定向执行路径，AI 始终直连真实文件系统**（历史教训：沙箱式 undo-redo 使 AI 看不到 node_modules 等 gitignore 文件而被移除）。只追踪 edit/write；bash 直写/git 操作不可回滚（与 Claude Code 一致）。会话回退：/undo 导航到该操作所属回合的 user 消息（`findUndoTurnUser` 沿 parent 链向上定位，多工具回合的 toolCall 消息父是前一个 toolResult 而非 user），整轮操作卡从对话消失；非交互自动降级纯文件回退。配置 settings.json `undo` 命名空间（enabled/maxEntries）
