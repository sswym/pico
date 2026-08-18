# pico

**带长期记忆、子代理委派、任务追踪、规划模式、网页搜索/抓取、MCP 服务器集成、LSP 代码智能与自进化技能沉淀的 Vibe 编码代理。**

基于 `@earendil-works/pi-coding-agent` 的薄封装：上游提供 agent loop、工具运行时与会话管理，pico 通过 29 个扩展注入产品化能力。技术栈：Bun + TypeScript，零外部运行时依赖。

## 快速开始

```bash
bun install
bun run bin/pico.ts            # 交互式 TUI
bun run bin/pico.ts -p "修复 foo.test.ts 中失败的测试"
bun run bin/pico.ts setup      # 交互式初始化配置
bun run bin/pico.ts --help     # 查看所有上游标志
```

交互式 TUI 默认启用上游全屏模式（等效 `--tui-mode fullscreen`，可在 `/settings` 运行时切换）；偏好常规模式显式传 `--tui-mode regular`。`-p` / `--mode json|rpc` 等非交互模式不受影响。

首次使用建议运行 `pico setup`（写入 `~/.pico/agent/settings.json`，支持按 section 配置：`setup model` / `tools` / `safety` / `ui` / `--reset`）。

执行 `bun link`（或发布后），`pico` 命令即可在 `$PATH` 中直接使用。

## 核心能力一览

| 能力 | 说明 |
| --- | --- |
| 长期记忆 | SQLite + 全文检索 + 语义相似度的事实库，自动提取偏好/决策/纠错，跨会话回忆；另有人工策展笔记（MEMORY.md / USER.md） |
| 自进化 | 会话末后台审查（默认 6 回合触发、每会话 ≤2 次），把可复用方法论自动沉淀为 `~/.pico/agent/skills/` 下的技能，下一会话生效（默认关闭：`evolution.enabled` / `PICO_EVOLUTION_ENABLED`；详见 `docs/evolution-design.md`） |
| 子代理 | 16 个内置角色（侦察/规划/实现/审查/咨询/研究等），支持单发、并行（≤8，并发 4，可配置）、链式三种编排，可配置验收门、回退模型、结构化输出 schema 与请求预算 |
| 任务清单 | 会话级 todoWrite 工具 + 实时面板（F7 折叠），多步任务进度可视 |
| 规划模式 | 先只读调研、提交计划、用户批准后才解锁写工具 |
| 代码回退 | 旁路观测式 undo：edit/write 前快照原内容，成功才入栈，`/undo` `/redo` 会话回退文件与对话（AI 始终直连真实文件系统） |
| 网页 | webSearch（Exa/Tavily 混合）+ webFetch（HTML→Markdown，私网防护，15 分钟缓存） |
| LSP 代码智能 | 45+ 语言，只读操作全开（hover/definition/references/diagnostics/symbols 等），写操作默认阻断 |
| MCP 集成 | 兼容 Claude Code 配置格式，自动发现并注册外部服务器工具 |
| 钩子系统 | PreToolUse / PostToolUse / PreSessionEnd / PostUserMessage 文件驱动 shell 钩子 |
| 交互提问 | askUserQuestion 结构化选择题，自动追加"其他"选项 |
| Claude Code 风格渲染 | 连续工具调用分组、单行摘要 + 状态图标、Input/Output 展开视图、edit/write 自动展开与 diff、fullscreen 鼠标点击展开/收起（`/ccstyle` 开关，settings.json `ccstyle.enabled`） |
| /init | 多阶段引导生成/审计 AGENTS.md（绝不写 CLAUDE.md） |

> 各功能完整用法（工具动作表、配置示例、命令参考）：见 [`docs/user-guide.md`](docs/user-guide.md)。

## 交互命令与快捷键

TUI 内输入 `/help` 可随时查看离线命令速查（pico 特有命令、上游内置命令与全部快捷键）。

| 快捷键 | 作用 |
| --- | --- |
| `Esc` | 中断当前任务（agent 运行中） |
| `Ctrl+D` | 退出 pico（输入框为空时） |
| `Ctrl+C` | 清空输入框（**不是**中断——中断用 Esc） |
| `Ctrl+V` | 粘贴图片或文本 |
| `Ctrl+O` | 展开/折叠工具输出 |
| `!` / `!!` | 运行 bash 命令（`!!` 不进上下文） |
| `F7` | 折叠/展开 todo 面板 |

pico 特有命令：`/init`（生成或审计 AGENTS.md）、`/doctor`（安全开关与配置冲突）、`/memory`（长期记忆）、`/todo`（任务清单）、`/plan`（计划模式）、`/language`（切换语言）、`/mcp`（MCP 服务器）、`/vision`（视觉模型）、`/thinking`（思考等级）等；退出用 `/quit`。消息正文出现 `ultrathink` 关键词会临时提升该轮思考等级到模型上限并注入多步推理提醒。

> 注意：以 `/` 开头但未注册的输入（如拼错的命令）会被当作普通消息发给模型——模型会收到本地引导提示并指引你使用 `/help`，不会猜测命令含义。

## 安全默认值

以下能力**默认关闭**，需显式开启（`~/.pico/agent/settings.json` 的 `safety` 字段或环境变量，env 优先）：

- 项目级 shell hooks（`PICO_ENABLE_PROJECT_HOOKS`）
- 项目级 MCP 服务器（`PICO_ENABLE_PROJECT_MCP`）
- 项目级 LSP 配置（`PICO_ENABLE_PROJECT_LSP`）
- 非交互模式自动批准计划（`PICO_ALLOW_UNATTENDED_PLAN_APPROVAL`）
- LSP 自动格式化写回（`PICO_ALLOW_LSP_FORMAT_ON_WRITE`）
- 非交互模式运行项目代理（`PICO_ALLOW_UNATTENDED_PROJECT_AGENTS`）

`/doctor` 可查看所有开关状态与来源。

> **注意**：安全开关只认 `settings.json` 的 `safety` 字段与环境变量。上游旧版 `config.yml` 里同名 `safety` 键会被**静默忽略**——`/doctor` 检测到这种"写错位置"的配置时会明确告警并给出迁移指引。
>
> `config.yml` 里的 `defaultProvider` / `defaultModel` 同样**不生效**（实际读取 `settings.json`）——两者不一致时，启动时会弹出一次警告，`/doctor` 也列出冲突明细。
>
> **DeepSeek 系网关（如自定义 OpenAI 兼容代理）的多轮对话 400**：若报错 `The reasoning_content in the thinking mode must be passed back to the API`，说明该模型缺 `compat.requiresReasoningContentOnAssistantMessages: true`。在 `~/.pico/agent/models.json` 的对应模型/提供商补上该标志即可；`/doctor` 会列出所有缺标志的推理模型，默认模型缺失时启动也会警告一次。

## 文档导航

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [README.md](README.md) | 所有人 | 本页：是什么、快速开始、文档入口 |
| [docs/user-guide.md](docs/user-guide.md) | 使用者 | 全部功能的完整用法手册（记忆/子代理/todo/plan/web/LSP/MCP/hooks…） |
| [docs/srcode-intro.md](docs/srcode-intro.md) | 零基础大众 | 科普介绍：项目是什么、怎么运作（含流程图） |
| [docs/internal-tech-review.md](docs/internal-tech-review.md) | 团队内部 | 架构、核心实现、踩坑记录、已知局限、部署运维要点 |
| [AGENTS.md](AGENTS.md) | 开发者 | 开发约定：命令、架构、测试规范、编辑注意事项 |

## 测试与开发

```bash
bun run verify              # tsc --noEmit + 全量测试（1236 用例 / 56 文件，完全离线）
bun test tests/<feature>.test.ts
bun run build               # 三阶段构建，产出独立二进制（~102MB）
bun run start               # 源码模式启动（开发用）
```

详细开发约定见 [`AGENTS.md`](AGENTS.md)。
