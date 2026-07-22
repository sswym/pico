# srcode

> 带长期记忆、子代理委派、任务追踪、结构化用户提问、规划模式、网页抓取/搜索、MCP 服务器集成、LSP 代码智能、`/init`、钩子系统与 Vibe 编码系统提示词的 Vibe 编码代理。

## 安装与运行

```bash
bun install
bun run bin/srcode.ts            # 交互式 TUI
bun run bin/srcode.ts -p "修复 foo.test.ts 中失败的测试"
bun run bin/srcode.ts setup      # 交互式初始化配置
bun run bin/srcode.ts setup --non-interactive
bun run bin/srcode.ts --help     # 查看所有上游标志
```

执行 `bun link`（或发布后），`srcode` 命令即可在 `$PATH` 中直接使用。

首次使用建议运行 `srcode setup`。它会写入 `~/.srcode/agent/settings.json`，可选写入 `~/.srcode/agent/models.json`，并支持按 section 单独配置：

```text
srcode setup model
srcode setup tools
srcode setup safety
srcode setup ui
srcode setup --reset
```

## 上游能力（开箱即用）

- 流式对话 TUI，含会话选择器、模型切换（`Ctrl+P`）和上下文用量指示条。
- 内置 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 工具。
- `/compact` 摘要压缩、会话分叉、项目信任提示。
- 通过 `pi-ai` 支持多供应商（Anthropic、OpenAI、Google、Mistral 等）。
- 支持单独配置辅助视觉模型：当主模型不支持图片时，会自动调用 `auxiliary.vision` 做图像识别。

## srcode 新增功能

### 1. 长期记忆（`memory` 工具 + `/memory` 命令）

记忆系统分为两层：

- **结构化 facts**：默认内置 provider，底层使用单个 SQLite 文件，位于 `~/.srcode/memory.db`（可通过 `$SRCODE_MEMORY_DB` 覆盖；亦可通过 `$SRCODE_HOME` 重定位整个 srcode 数据根目录）。Schema 是对 hermes-agent 全息存储 (`~/hermes-agent/plugins/memory/holographic/`) 的精简移植——包含 `category`、`tags`、`trust_score` 与 FTS5 镜像——但暂不含 HRR 层（计划在 v2 加入）。
- **curated notes**：短小稳定的人工/自动备注，文件位于 `~/.srcode/memories/MEMORY.md` 与 `~/.srcode/memories/USER.md`。会话启动时生成冻结快照注入系统提示词；会话中新增备注会写盘并进入后续会话，但不会改写本轮已经注入的快照。

**9 类事实**（按提取优先级排列）：

| 类别 | 含义 | 示例 |
| --- | --- | --- |
| `correction` | 纠正 agent 的错误 | "No, use pnpm not npm" |
| `failure` | 什么行不通及原因 | "Tried localStorage for tokens — XSS vulnerability" |
| `insight` | 从经验中学到的教训 | "remember that: graphql cache invalidation is tricky" |
| `user_pref` | 用户偏好 | "I prefer concise output" |
| `convention` | 项目约定 | "our convention is to use kebab-case for files" |
| `tool_quirk` | 工具特定怪癖 | "this library doesn't support node 14" |
| `project` | 项目决策 | "we decided to migrate to Postgres" |
| `tool` | 工具相关事实 | "CI needs --frozen-lockfile" |
| `general` | 通用事实 | （默认类别） |

**两级作用域**：事实可设为 `global`（全局，默认）或 `project`（绑定当前工作目录）。项目级事实在跨项目搜索时不可见，项目搜索中全局事实仍可见但排名低于项目事实。

模型可调用以下动作：

| 动作 | 必需参数 | 用途 |
| --- | --- | --- |
| `add` | `content` | 存储一条持久化事实（可选 `category`、`scope`、`correction_of`） |
| `search` | `query` | FTS 检索，按 trust × bm25 排序（可按 `scope`/`category` 过滤） |
| `probe` | `entity` | 围绕实体名称的短语搜索 |
| `list` | — | 列举事实（可按 `scope`/`category`/`min_trust` 过滤） |
| `update` | `fact_id` | 编辑内容/分类/标签 |
| `remove` | `fact_id` | 删除 |
| `feedback` | `fact_id`, `helpful` | 信任度 ±0.05 / ±0.10 |
| `note_add` | `content` | 写入 curated note（可选 `target=memory|user`） |
| `note_list` | — | 列出 curated notes |
| `note_replace` | `old_text`, `content` | 替换已有 curated note |
| `note_remove` | `old_text` | 删除匹配的 curated note |

**纠正链接**：当 `add` 时指定 `correction_of=<原始 fact_id>`，原始事实信任度 -0.30，纠正事实以 0.70 高信任值插入，确保纠正立即浮现在原始事实之上。

你也可以直接通过命令驱动：

```text
/memory list
/memory list --scope project
/memory search [--scope global|project] bun
/memory add user_pref 我偏好简洁的输出
/memory add failure --scope project localStorage tokens 有 XSS 漏洞
/memory notes list
/memory notes add --target user 我偏好中文回答
/memory notes replace --target memory "旧项目约定" "新项目约定"
/memory remove 4
/memory clear
/memory status
/memory setup builtin
/memory off
```

`/memory status` 显示当前 backend、数据库路径、provider 与可用工具；`/memory setup <provider>` 将选择写入 `~/.srcode/agent/settings.json`；`/memory off` 会关闭记忆 backend。当前内置 provider 为 `builtin`，并保留 `holographic` provider 工厂接口用于后续扩展或外部 provider 接入。

每轮对话会向系统提示词追加一段短头部、curated notes 快照，并在用户消息命中已存储事实时插入 `## Recalled memory` 块。**实时纠正检测**：`turn_end` 事件中立即匹配纠正模式并存储，无需等到会话结束。会话结束时，`src/extensions/memory/extract.ts` 中的正则引擎从用户消息中提取各类模式（偏好/决策/纠正/失败/洞察/约定/工具怪癖）并自动持久化；curated notes 也会提取适合长期保留的短备注。

**敏感信息扫描**：存储前自动检测 AWS Access Key、GitHub Token、SSH Private Key、通用 API Key 等模式，匹配则拒绝存储并报错，防止密钥泄露。

### 2. 子代理（`subagent` 工具 + 工作流斜杠命令）

源自 `pi-coding-agent` 示例扩展，附带四种角色与三种工作流预设，无需在 `~/.srcode/agent/` 中做任何符号链接即可使用。

**内置角色**（`src/extensions/subagent/agents/*.md`）：

| 角色 | 用途 | 可用工具 |
|---|---|---|
| `scout` | 快速代码库侦察，返回压缩上下文 | read, grep, find, ls, bash, **memory** |
| `planner` | 将上下文 + 需求转化为分步计划 | read, grep, find, ls, **memory** |
| `worker` | 端到端实现计划 | 全部工具，含 **memory** |
| `reviewer` | 只读质量/安全审查 | read, grep, find, ls, bash, **memory** |

每个角色的提示词都指示其在行动前先查询 `memory(action="search", ...)`，并将持久化发现写回，因此子代理运行能共享主会话的项目上下文，而非从零开始。

**模式**：

```ts
// 单一
subagent(agent="scout", task="...")

// 并行——最多同时 8 个代理，并发上限 4
subagent(tasks=[{agent: "scout", task: "..."}, {agent: "scout", task: "..."}])

// 链式——步骤 N 的输出填入步骤 N+1 的 {previous}
subagent(chain=[
  { agent: "scout",   task: "查找认证代码：$@" },
  { agent: "planner", task: "基于以下内容规划变更：{previous}" },
  { agent: "worker",  task: "实现：{previous}" },
])
```

**工作流斜杠命令**（自动从 `src/extensions/subagent/prompts/` 加载）：

```text
/implement <目标>                scout → planner → worker
/scout-and-plan <目标>           scout → planner（不实现）
/implement-and-review <目标>     worker → reviewer → worker
```

每个子代理在独立的 `pi` 进程中运行，拥有自己的上下文窗口，因此主对话不会被侦察噪声污染。Ctrl+C 会传播以终止子进程。

**项目级代理。** 若项目根目录下存在 `.srcode/agents/*.md`，且传入 `agentScope: "both"`，则同名项目代理将覆盖内置角色。调用项目代理前工具会请求确认（可通过 `confirmProjectAgents` 配置）。

### 3. 任务清单（`todoWrite` 工具 + `/todo` 命令）

会话级任务清单，镜像 claude-code 的 TodoWriteTool。模型每次调用时传入完整列表（`{content, activeForm, status, id?}`）；在对话间隙以 ☐/⏳/✓ 渲染。当所有任务均为 `completed` 时自动折叠为空。出现多个 `in_progress` 项时，模型会收到警告并自行纠正。

用户命令：`/todo`、`/todo clear`。

### 4. 交互提问（`askUserQuestion` 工具）

提出 1-4 道选择题，每题 2-4 个选项；支持 `multiSelect` 和单选项的 `preview` 内容。自动追加"其他"选项并触发自由文本输入。在非 TUI 模式（`-p`/`--mode json`）下返回结构化错误，使模型回退到纯文本。

### 5. 规划模式（`EnterPlanMode` / `ExitPlanMode` 工具 + `/plan` 命令）

规划模式激活期间，srcode 会以"先研究，写出计划，再 ExitPlanMode 请求批准"为由拦截 `bash`/`edit`/`write`/`NotebookEdit` 工具调用。计划文件存放在 `~/.srcode/plans/<sessionId>.md`。`ExitPlanMode` 会展示计划内容并请求用户确认；在非 TUI 模式下默认保持计划模式，除非在 `~/.srcode/agent/settings.json` 设置 `safety.allowUnattendedPlanApproval=true`，或临时设置 `SRCODE_ALLOW_UNATTENDED_PLAN_APPROVAL=1`。

### 6. 网页（`webFetch` + `webSearch` 工具）

- `webFetch(url, prompt)` —— 通过 `Bun.fetch` 抓取公开 HTTPS URL，将 HTML 转为 Markdown（去除 `<script>/<style>/<nav>/<footer>`），默认拒绝 localhost/内网地址，响应读取上限 1 MiB，输出 8 KiB 上限，15 分钟 LRU 缓存（50 条）。
- `webSearch(query, max_results?, allowed_domains?, blocked_domains?)` —— 默认使用 Exa MCP；若存在 `TAVILY_API_KEY`，默认合并 Exa + Tavily 结果并按 URL 去重。设置 `SRCODE_SEARCH_PROVIDER=exa` 或 `SRCODE_SEARCH_PROVIDER=tavily` 可强制单一 provider。

### 7. RTK 命令压缩（可选）

若系统 PATH 中安装了 [`rtk`](https://github.com/rtk-ai/rtk)，srcode 会在内置 `bash` 工具执行前调用 `rtk rewrite <command>`，把受支持的命令透明改写为 RTK 版本，例如 `git status` → `rtk git status`，从而减少进入上下文的 shell 输出。RTK 不可用或没有匹配规则时命令原样执行；RTK deny 规则命中时会阻断该次 `bash` 调用。

- `/rtk` —— 探测并显示当前 RTK rewrite 状态。
- `SRCODE_RTK=0` —— 禁用自动改写。
- `SRCODE_RTK_VERBOSE=1` —— 在改写或不可用时输出诊断消息。

### 8. `/init`（生成 AGENTS.md）

多阶段引导式工作流：询问需要设置什么，可选派出 `scout` 子代理做代码库侦察，通过 `askUserQuestion` 填补信息缺口，然后编写极简的 **AGENTS.md**（以及可选的 AGENTS.local.md），并建议技能/钩子。**srcode 永远不会写入 CLAUDE.md**——这是写死在提示词中的硬规则。

### 9. 权限与高风险动作边界

srcode 当前不注册独立的 `/permissions` 扩展；基础工具审批、项目可信任状态与交互权限由上游 `@earendil-works/pi-coding-agent` 负责。

srcode 自己额外做了一层明确阻断：`lsp` 中的写入或高风险 action（`rename`、`rename_file`、`code_actions apply=true`、`reload`、`request`）会在 `tool_call` 阶段被阻断，直到这些能力拆入独立的写权限工具。只读 action（hover、definition、references、diagnostics、symbols、capabilities、status，以及未设置 `apply=true` 的 code_actions）仍可使用。

`/doctor` 可查看当前 cwd、settings 路径、能力边界、安全开关状态与来源。项目级 shell hooks、项目级 MCP 服务器、非交互计划自动批准、LSP 自动格式化写回都需要显式启用。长期配置写入 `~/.srcode/agent/settings.json` 的 `safety` 字段；临时覆盖使用环境变量，环境变量优先于 settings。

```json
{
  "safety": {
    "enableProjectHooks": false,
    "enableProjectMcp": false,
    "allowUnattendedPlanApproval": false,
    "allowLspFormatOnWrite": false
  },
  "auxiliary": {
    "vision": {
      "provider": "openai",
      "model": "gpt-4o-mini"
    }
  }
}
```

`auxiliary.vision.provider/model` 必须能被模型注册表解析到。若使用上游内置且已认证的视觉模型，通常只需写上面的 `settings.json`；若使用自定义 provider、代理或本地视觉模型，需要先在 `~/.srcode/agent/models.json` 中注册该模型，并确保模型声明包含 `"input": ["text", "image"]`，否则会被视为不具备视觉能力。

### 10. 钩子（`~/.srcode/hooks.json` + `<仓库>/.srcode/hooks.json`）

基于文件的 Shell 钩子，支持 `PreToolUse` / `PostToolUse` / `PreSessionEnd` / `PostUserMessage` 事件。默认只加载用户级 `~/.srcode/hooks.json`；项目级 `<仓库>/.srcode/hooks.json` 会执行仓库提供的 shell 命令，需设置 `safety.enableProjectHooks=true` 或 `SRCODE_ENABLE_PROJECT_HOOKS=1` 才会加载。占位符：`$FILE`（工具参数）、`$TOOL`（工具名）、`$TURN`（轮次索引）。默认超时 30 秒（最大 120 秒）；`blocking: true` 的 PreToolUse 失败会中止工具调用。

```json
{
  "hooks": [
    { "event": "PostToolUse", "tool": "edit", "command": "biome format $FILE" },
    { "event": "PreToolUse", "tool": "bash", "command": "echo $TOOL >> /tmp/audit.log" }
  ]
}
```

### 11. Vibe 编码系统提示词

`src/prompts/vibe-system.md` 会被追加到每条系统提示词末尾。四条规则——*先思考再编码、用最少的代码解决问题、手术式修改、目标驱动执行*——从 `~/.claude/CLAUDE.md` 中提炼。目标是让 srcode 先问后猜、不重构相邻代码、并将每行 diff 追溯到明确需求。

### 12. 内置技能（`src/skills/`）

三个 `SKILL.md` 技能通过 `--skill <bundled-skills-dir>` 自动加载：

- `verify` —— 运行 lint + 类型检查 + 测试，简洁报告失败项
- `recap` —— 利用存储的项目记忆总结近期工作
- `agents-init` —— 对已有 AGENTS.md 做增量编辑（比 `/init` 更轻量）

`~/.srcode/agent/skills/` 中的用户技能按名称覆盖内置技能。

### 13. MCP 服务器集成（`mcp__*` 工具）

srcode 支持连接外部 MCP（Model Context Protocol）服务器，自动发现并注册其工具为 LLM 可调用的内置工具。兼容 Claude Code 的 `mcpServers` 配置格式。

**配置方式**，双层合并（项目覆盖家目录）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {}
    }
  }
}
```

| 层级 | 路径 | 说明 |
|------|------|------|
| 全局 | `~/.srcode/mcp-servers.json` | 所有项目共享 |
| 项目 | `<cwd>/.srcode/mcp-servers.json` | 设置 `safety.enableProjectMcp=true` 或 `SRCODE_ENABLE_PROJECT_MCP=1` 后覆盖同名 server |

**工具命名规则**：`mcp__<服务器名>__<工具名>`，与权限系统的 `mcp__` 前缀匹配兼容。

**行为**：

- 会话启动时按当前 `ctx.cwd` 加载配置并连接 MCP 服务器，调用 `initialize` + `tools/list` 发现工具
- 每个 MCP 工具注册为一个独立的 pi 工具，LLM 可直接调用
- 工具调用通过 JSON-RPC 2.0 stdio 转发至 MCP 服务器
- 单服务器故障不影响其他服务器，超时 30 秒
- 状态栏显示 MCP 连接数量与失败数量
- server stderr 与协议解析错误会收集为最近诊断，不直接写终端，避免破坏 TUI 输入区
- 会话结束时自动清理子进程

用户命令：`/mcp` 可查看所有已连接 MCP 服务器的状态、版本、已注册工具列表与最近诊断。

### 14. LSP 代码智能（`lsp` 工具）

通过 Language Server Protocol 为 LLM 提供精确的代码智能。支持 14 种操作，自动检测并启动对应的语言服务器。

**支持的操作**：

| 操作 | 用途 | 需要位置参数 |
|------|------|-------------|
| `hover` | 类型信息和文档 | ✓ |
| `definition` | 跳转到定义 | ✓ |
| `type_definition` | 跳转到类型定义 | ✓ |
| `implementation` | 查找接口的具体实现 | ✓ |
| `references` | 查找所有引用 | ✓ |
| `diagnostics` | 获取错误/警告（文件级或工作区级） | 可选 |
| `symbols` | 文件符号列表或工作区符号搜索 | 可选 |
| `code_actions` | 列出/应用代码修复、重构、导入建议 | ✓ |
| `rename` | 跨文件符号重命名 | ✓ |
| `rename_file` | 文件重命名并应用语言服务器返回的引用更新 | — |
| `capabilities` | 显示语言服务器能力 | — |
| `status` | 显示服务器状态 | — |
| `reload` | 重启语言服务器 | — |
| `request` | 原始 LSP 请求（逃生舱） | — |

只读 action（`hover`、`definition`、`type_definition`、`implementation`、`references`、`diagnostics`、`symbols`、`capabilities`、`status`，以及未设置 `apply=true` 的 `code_actions`）可直接使用。写入或高风险 action 当前会被阻断，避免 `lsp` 这个只读权限层执行文件修改。

**示例**：

```text
lsp(action="hover", file="src/index.ts", line=10, character=5)
lsp(action="definition", file="src/index.ts", line=10, symbol="LspClient")
lsp(action="references", file="src/index.ts", line=10, symbol="LspClient")
lsp(action="diagnostics", file="src/index.ts")
lsp(action="symbols", file="src/index.ts")
```

**自动检测**：根据工作区文件自动选择语言服务器（`tsconfig.json` / `package.json` → TypeScript LSP，`Cargo.toml` → `rust-analyzer`，`pyproject.toml` → `pyright` 等）。TypeScript 项目会优先尝试 `typescript-native`；启动前会探测本地 `tsc --help --all` 是否声明支持 `--lsp`，旧版 `tsc` 不支持时会静默跳过并回退到后续可用服务器，避免出现 `Server exited with code 1` 的误报。语言服务器惰性启动，`session_shutdown` 时关闭。

**45+ 语言支持**：TypeScript、JavaScript、Python、Rust、Go、Java、Kotlin、Scala、Haskell、OCaml、Elixir、Ruby、PHP、C#、Lua、Nix、Zig、Bash、YAML、TOML、SQL、Terraform、Docker、Prisma、GraphQL、Swift、Dart、CSS、HTML、JSON、Vue、Svelte、Astro、Tailwind、Deno、Biome、ESLint 等。

**配置系统**：三层合并——内置 defaults.json → `~/.srcode/lsp.json`（用户级）→ `.srcode/lsp.json`（项目级）。支持 `fileTypes`、`rootMarkers`、`initOptions`、`settings` 配置。本地二进制解析优先检查 `node_modules/.bin/`、`.venv/bin/`、`vendor/bundle/bin/`。

**Write/Edit 联动**：编辑代码文件后，LSP 自动同步文件内容、通知服务器重新分析、收集诊断信息并追加到工具结果。`.editorconfig` 解析支持自动格式化；自动格式化会二次写文件，因此即使 `formatOnWrite=true`，仍需设置 `safety.allowLspFormatOnWrite=true` 或 `SRCODE_ALLOW_LSP_FORMAT_ON_WRITE=1` 才会写回。

**TUI 状态栏**：服务器启动后，状态栏显示当前活跃的语言服务器名称和版本。

## 项目结构

```
srcode/
├── bin/srcode.ts                       # main(args) + 自动注入 --prompt-template + --skill
├── src/
│   ├── extensions/
│   │   ├── ask/        # askUserQuestion 工具（schema、提示词、对话框分发）
│   │   ├── hooks/      # 配置加载 + 沙箱运行器 + 事件连线
│   │   ├── init/       # /init 提示词（AGENTS.md，绝不写 CLAUDE.md）
│   │   ├── lsp/        # LSP 代码智能（只读工具层、client/config/manager、write-through 诊断）
│   │   ├── mcp/        # MCP 客户端（types, config, client, 扩展工厂）
│   │   ├── memory/     # bun:sqlite + FTS5/TF-IDF 长期记忆，含项目 scope 检索
│   │   ├── oma.ts      # OMA 系统提示词增强
│   │   ├── plan/       # EnterPlanMode / ExitPlanMode + tool_call 拦截
│   │   ├── retro-theme/ # TUI 复古主题
│   │   ├── subagent/   # 子代理工具 adapter + orchestrator + runner/process/chain/parallel/gate 模块
│   │   ├── todo/       # todoWrite 工具 + /todo 命令 + 按会话存储
│   │   ├── web/        # webFetch + webSearch + LRU 缓存
│   │   ├── events.ts   # 扩展间轻量事件总线
│   │   └── vibe.ts     # 将 vibe-system.md 追加到系统提示词
│   ├── prompts/vibe-system.md
│   ├── setup/index.ts
│   ├── skills/{verify,recap,agents-init}/SKILL.md
│   └── types/markdown.d.ts
└── tests/
    ├── ask.test.ts      # 8 个用例——schema 合法性、对话框分发、hasUI 回退
    ├── events.test.ts   # 扩展事件总线
    ├── hooks.test.ts    # 配置加载、运行器、占位符替换
    ├── init.test.ts     # /init 提示词内容 + 命令连线
    ├── lsp.test.ts      # workspace edit、diagnostics ledger、action helpers、权限分类、session cwd
    ├── mcp.test.ts      # MCP 扩展工厂、session cwd、失败隔离
    ├── memory.test.ts   # SQLite store、检索、project scope、extract、provider hooks
    ├── plan.test.ts     # tool_call 拦截 + ExitPlanMode 流程
    ├── setup.test.ts    # setup CLI 参数、非交互默认配置、自定义 provider、reset
    ├── skills.test.ts   # 内置技能加载并包含非空描述
    ├── subagent.test.ts # 工厂连线、代理发现、runner/process/chain/parallel/fallback/output/worktree/gate 逻辑
    ├── todo.test.ts     # 9 个用例——id 分配、折叠、不变量
    └── web.test.ts      # 缓存命中、搜索解析、allowed_domains
```

## 测试

```bash
bun run verify
```

`bun run verify` 会先执行 `bunx tsc --noEmit`，再运行 `bun test`。测试完全离线运行。Hooks 测试使用空操作固件命令；Web 测试桩接 `Bun.fetch`；Ask/Plan 测试伪造 `ctx.ui.*`；MCP 测试使用 fake client，不启动真实服务器。

## 路线图

- v2 记忆：HRR 相位编码（将 `holographic.py` 移植至 TS），用于实体推理与矛盾检测。
- `/vibe` 斜杠命令，用于即时切换系统提示词块。
- 子代理：可选共享单个 SQLite WAL 与主会话，使子进程的 `memory(add)` 立即可见（目前 FTS 读取在轮次间获取，因为每个子进程打开同一文件）。
- 成本追踪器（v0.2 跳过——pi 已显示上下文百分比）。
- LSP 增强：references 重试机制、诊断版本跟踪、多服务器并发诊断合并。
