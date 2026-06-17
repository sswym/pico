# srcode

> 带长期记忆、子代理委派、任务追踪、结构化用户提问、规划模式、网页抓取/搜索、`/init`、钩子系统与 Vibe 编码系统提示词的 Vibe 编码代理。

## 安装与运行

```bash
bun install
bun run bin/srcode.ts            # 交互式 TUI
bun run bin/srcode.ts -p "修复 foo.test.ts 中失败的测试"
bun run bin/srcode.ts --help     # 查看所有上游标志
```

执行 `bun link`（或发布后），`srcode` 命令即可在 `$PATH` 中直接使用。

## 上游能力（开箱即用）

- 流式对话 TUI，含会话选择器、模型切换（`Ctrl+P`）和上下文用量指示条。
- 内置 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 工具。
- `/compact` 摘要压缩、会话分叉、项目信任提示。
- 通过 `pi-ai` 支持多供应商（Anthropic、OpenAI、Google、Mistral 等）。

## srcode 新增功能

### 1. 长期记忆（`memory` 工具 + `/memory` 命令）

底层使用单个 SQLite 文件，位于 `~/.srcode/memory.db`（可通过 `$SRCODE_MEMORY_DB` 覆盖；亦可通过 `$SRCODE_HOME` 重定位整个 srcode 数据根目录）。Schema 是对 hermes-agent 全息存储 (`~/hermes-agent/plugins/memory/holographic/`) 的精简移植——包含 `category`、`tags`、`trust_score` 与 FTS5 镜像——但暂不含 HRR 层（计划在 v2 加入）。

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

**纠正链接**：当 `add` 时指定 `correction_of=<原始 fact_id>`，原始事实信任度 -0.30，纠正事实以 0.70 高信任值插入，确保纠正立即浮现在原始事实之上。

你也可以直接通过命令驱动：

```text
/memory list
/memory list --scope project
/memory search [--scope global|project] bun
/memory add user_pref 我偏好简洁的输出
/memory add failure --scope project localStorage tokens 有 XSS 漏洞
/memory remove 4
/memory clear
```

每轮对话会向系统提示词追加一段短头部，并在用户消息命中已存储事实时插入 `## Recalled memory` 块。**实时纠正检测**：`turn_end` 事件中立即匹配纠正模式并存储，无需等到会话结束。会话结束时，`src/extensions/memory/extract.ts` 中的正则引擎从用户消息中提取各类模式（偏好/决策/纠正/失败/洞察/约定/工具怪癖）并自动持久化。

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

规划模式激活期间，srcode 会以"先研究，写出计划，再 ExitPlanMode 请求批准"为由拦截 `bash`/`edit`/`write`/`NotebookEdit` 工具调用。计划文件存放在 `~/.srcode/plans/<sessionId>.md`。`ExitPlanMode` 会展示计划内容并请求用户确认；在非 TUI 模式下自动批准。

### 6. 网页（`webFetch` + `webSearch` 工具）

- `webFetch(url, prompt)` —— 通过 `Bun.fetch` 抓取 URL，将 HTML 转为 Markdown（去除 `<script>/<style>/<nav>/<footer>`），8 KB 上限，15 分钟 LRU 缓存（50 条）。
- `webSearch(query, max_results?, allowed_domains?, blocked_domains?)` —— 默认使用 DuckDuckGo HTML；设置 `SRCODE_SEARCH_PROVIDER=tavily` 与 `TAVILY_API_KEY` 可切换至 Tavily。

### 7. `/init`（生成 AGENTS.md）

多阶段引导式工作流：询问需要设置什么，可选派出 `scout` 子代理做代码库侦察，通过 `askUserQuestion` 填补信息缺口，然后编写极简的 **AGENTS.md**（以及可选的 AGENTS.local.md），并建议技能/钩子。**srcode 永远不会写入 CLAUDE.md**——这是写死在提示词中的硬规则。

### 8. 权限系统（`~/.srcode/permissions.json` + `<仓库>/.srcode/permissions.json`）

基于 `tool_call` 事件的工具调用前置权限网关。配置按用户级 → 项目级 → 会话级合并；规则语法兼容 Claude Code 的 `ToolName` / `ToolName(content)` 格式，例如 `Bash(npm:*)`、`Edit(./src/**)`。默认模式下，`read`/`grep`/`find`/`ls` 自动允许，`bash`/`edit`/`write` 等高影响工具在无匹配规则时会弹出 TUI 审批。

```json
{
  "permissions": {
    "allow": ["Bash(npm:*)", "Read(./src/**)"],
    "deny": ["Bash(rm -rf:*)", "Edit(/etc/**)"],
    "ask": ["Write(./dist/**)"],
    "defaultMode": "default",
    "additionalDirectories": ["~/projects/notes"]
  }
}
```

`defaultMode` 支持 `default`、`acceptEdits`、`plan`、`bypassPermissions`、`dontAsk`。`/permissions` 可查看当前规则，`/permissions clear-session` 清除本会话临时允许规则。

### 9. 钩子（`~/.srcode/hooks.json` + `<仓库>/.srcode/hooks.json`）

基于文件的 Shell 钩子，支持 `PreToolUse` / `PostToolUse` / `PreSessionEnd` / `PostUserMessage` 事件。项目级条目按 `(event, tool, command)` 覆盖用户级。占位符：`$FILE`（工具参数）、`$TOOL`（工具名）、`$TURN`（轮次索引）。默认超时 30 秒（最大 120 秒）；`blocking: true` 的 PreToolUse 失败会中止工具调用。

```json
{
  "hooks": [
    { "event": "PostToolUse", "tool": "edit", "command": "biome format $FILE" },
    { "event": "PreToolUse", "tool": "bash", "command": "echo $TOOL >> /tmp/audit.log" }
  ]
}
```

### 10. Vibe 编码系统提示词

`src/prompts/vibe-system.md` 会被追加到每条系统提示词末尾。四条规则——*先思考再编码、用最少的代码解决问题、手术式修改、目标驱动执行*——从 `~/.claude/CLAUDE.md` 中提炼。目标是让 srcode 先问后猜、不重构相邻代码、并将每行 diff 追溯到明确需求。

### 11. 内置技能（`src/skills/`）

三个 `SKILL.md` 技能通过 `--skill <bundled-skills-dir>` 自动加载：

- `verify` —— 运行 lint + 类型检查 + 测试，简洁报告失败项
- `recap` —— 利用存储的项目记忆总结近期工作
- `agents-init` —— 对已有 AGENTS.md 做增量编辑（比 `/init` 更轻量）

`~/.srcode/agent/skills/` 中的用户技能按名称覆盖内置技能。

## 项目结构

```
srcode/
├── bin/srcode.ts                       # main(args) + 自动注入 --prompt-template + --skill
├── src/
│   ├── extensions/
│   │   ├── ask/        # askUserQuestion 工具（schema、提示词、对话框分发）
│   │   ├── hooks/      # 配置加载 + 沙箱运行器 + 事件连线
│   │   ├── init/       # /init 提示词（AGENTS.md，绝不写 CLAUDE.md）
│   │   ├── memory/     # bun:sqlite + FTS5 长期记忆
│   │   ├── permissions/# tool_call 权限规则、审批与 /permissions
│   │   ├── plan/       # EnterPlanMode / ExitPlanMode + tool_call 拦截
│   │   ├── subagent/   # 源自 pi-coding-agent 示例 + memory 钩子
│   │   ├── todo/       # todoWrite 工具 + /todo 命令 + 按会话存储
│   │   ├── web/        # webFetch + webSearch + LRU 缓存
│   │   └── vibe.ts     # 将 vibe-system.md 追加到系统提示词
│   ├── prompts/vibe-system.md
│   ├── skills/{verify,recap,agents-init}/SKILL.md
│   └── types/markdown.d.ts
└── tests/
    ├── ask.test.ts          # 8 个用例——schema 合法性、对话框分发、hasUI 回退
    ├── hooks.test.ts        # 配置加载、运行器、占位符替换
    ├── init.test.ts         # /init 提示词内容 + 命令连线
    ├── memory.test.ts       # 23 个用例——add/search/feedback/update/remove/probe/clear/extract/secrets/scope/correction
    ├── permissions.test.ts   # 规则解析、匹配、决策、扩展拦截
    ├── plan.test.ts         # tool_call 拦截 + ExitPlanMode 流程
    ├── skills.test.ts       # 内置技能加载并包含非空描述
    ├── subagent.test.ts     # 工厂连线、代理发现、worker 提示词
    ├── todo.test.ts         # 9 个用例——id 分配、折叠、不变量
    └── web.test.ts          # 缓存命中、搜索解析、allowed_domains
```

## 测试

```bash
bun test
```

102 个用例，完全离线运行。Hooks 测试使用空操作固件命令；Web 测试桩接 `Bun.fetch`；Ask/Plan 测试伪造 `ctx.ui.*`。

## 路线图

- v2 记忆：HRR 相位编码（将 `holographic.py` 移植至 TS），用于实体推理与矛盾检测。
- `/vibe` 斜杠命令，用于即时切换系统提示词块。
- 子代理：可选共享单个 SQLite WAL 与主会话，使子进程的 `memory(add)` 立即可见（目前 FTS 读取在轮次间获取，因为每个子进程打开同一文件）。
- 成本追踪器（v0.2 跳过——pi 已显示上下文百分比）。
