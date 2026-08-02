# pico

**带长期记忆、子代理委派、任务追踪、规划模式、网页搜索/抓取、MCP 服务器集成与 LSP 代码智能的 Vibe 编码代理。**

基于 `@earendil-works/pi-coding-agent` 的薄封装：上游提供 agent loop、工具运行时与会话管理，pico 通过 19 个扩展注入产品化能力。技术栈：Bun + TypeScript，零外部运行时依赖。

## 快速开始

```bash
bun install
bun run bin/pico.ts            # 交互式 TUI
bun run bin/pico.ts -p "修复 foo.test.ts 中失败的测试"
bun run bin/pico.ts setup      # 交互式初始化配置
bun run bin/pico.ts --help     # 查看所有上游标志
```

首次使用建议运行 `pico setup`（写入 `~/.pico/agent/settings.json`，支持按 section 配置：`setup model` / `tools` / `safety` / `ui` / `--reset`）。

执行 `bun link`（或发布后），`pico` 命令即可在 `$PATH` 中直接使用。

## 核心能力一览

| 能力 | 说明 |
| --- | --- |
| 长期记忆 | SQLite + 全文检索 + 语义相似度的事实库，自动提取偏好/决策/纠错，跨会话回忆；另有人工策展笔记（MEMORY.md / USER.md） |
| 子代理 | 6 个内置角色（侦察/规划/实现/审查/咨询/研究），支持单发、并行（≤8，并发 4）、链式三种编排，可配置验收门与回退模型 |
| 任务清单 | 会话级 todoWrite 工具 + 实时面板（F7 折叠），多步任务进度可视 |
| 规划模式 | 先只读调研、提交计划、用户批准后才解锁写工具 |
| 网页 | webSearch（Exa/Tavily 混合）+ webFetch（HTML→Markdown，私网防护，15 分钟缓存） |
| LSP 代码智能 | 45+ 语言，只读操作全开（hover/definition/references/diagnostics/symbols 等），写操作默认阻断 |
| MCP 集成 | 兼容 Claude Code 配置格式，自动发现并注册外部服务器工具 |
| 钩子系统 | PreToolUse / PostToolUse / PreSessionEnd / PostUserMessage 文件驱动 shell 钩子 |
| 交互提问 | askUserQuestion 结构化选择题，自动追加"其他"选项 |
| /init | 多阶段引导生成/审计 AGENTS.md（绝不写 CLAUDE.md） |

> 各功能完整用法（工具动作表、配置示例、命令参考）：见 [`docs/user-guide.md`](docs/user-guide.md)。

## 安全默认值

以下能力**默认关闭**，需显式开启（`~/.pico/agent/settings.json` 的 `safety` 字段或环境变量，env 优先）：

- 项目级 shell hooks（`PICO_ENABLE_PROJECT_HOOKS`）
- 项目级 MCP 服务器（`PICO_ENABLE_PROJECT_MCP`）
- 非交互模式自动批准计划（`PICO_ALLOW_UNATTENDED_PLAN_APPROVAL`）
- LSP 自动格式化写回（`PICO_ALLOW_LSP_FORMAT_ON_WRITE`）
- 非交互模式运行项目代理（`PICO_ALLOW_UNATTENDED_PROJECT_AGENTS`）

`/doctor` 可查看所有开关状态与来源。

## 文档导航

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [README.md](README.md) | 所有人 | 本页：是什么、快速开始、文档入口 |
| [docs/user-guide.md](docs/user-guide.md) | 使用者 | 全部功能的完整用法手册（记忆/子代理/todo/plan/web/LSP/MCP/hooks…） |
| [docs/pico-intro.md](docs/pico-intro.md) | 零基础大众 | 科普介绍：项目是什么、怎么运作（含流程图） |
| [docs/internal-tech-review.md](docs/internal-tech-review.md) | 团队内部 | 架构、核心实现、踩坑记录、已知局限、部署运维要点 |
| [AGENTS.md](AGENTS.md) | 开发者 | 开发约定：命令、架构、测试规范、编辑注意事项 |

## 测试与开发

```bash
bun run verify              # tsc --noEmit + 全量测试（385 用例 / 26 文件，完全离线）
bun test tests/<feature>.test.ts
bun run build               # 三阶段构建，产出独立二进制（~102MB）
bun run start               # 源码模式启动（开发用）
```

详细开发约定见 [`AGENTS.md`](AGENTS.md)。
