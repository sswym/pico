# pico 用户手册

> 面向使用者（开发者、项目成员）的功能详解。快速上手请看根目录 `README.md`；对外科普见 `docs/srcode-intro.md`；内部技术复盘见 `docs/internal-tech-review.md`。

## 目录

1. [长期记忆](#1-长期记忆memory-工具--memory-命令)
2. [子代理](#2-子代理subagent-工具--工作流斜杠命令)
3. [任务清单](#3-任务清单todowrite-工具--todo-命令)
4. [交互提问](#4-交互提问askuserquestion-工具)
5. [规划模式](#5-规划模式enterplanmode--exitplanmode-工具--plan-命令)
6. [网页](#6-网页webfetch--websearch-工具)
7. [/init 生成 AGENTS.md](#7-init-生成-agentsmd)
8. [权限与安全边界](#8-权限与安全边界)
9. [钩子系统](#9-钩子系统)
10. [Vibe 编码系统提示词](#10-vibe-编码系统提示词)
11. [内置技能](#11-内置技能)
12. [MCP 服务器集成](#12-mcp-服务器集成mcp__-工具)
13. [LSP 代码智能](#13-lsp-代码智能lsp-工具)
14. [项目结构](#14-项目结构)
15. [测试](#15-测试)
16. [路线图](#16-路线图)

---

## 1. 长期记忆（`memory` 工具 + `/memory` 命令）

记忆系统分为两层：

- **结构化 facts**：默认内置 provider，底层使用单个 SQLite 文件，位于 `~/.pico/memory.db`（可通过 `$PICO_MEMORY_DB` 覆盖；亦可通过 `$PICO_HOME` 重定位整个 pico 数据根目录）。Schema 是对 hermes-agent 全息存储的精简移植——包含 `category`、`tags`、`trust_score` 与 FTS5 镜像，另加实体抽取与 TF-IDF 稀疏向量检索。`holographic` provider 为预留接口（JSON 实现为演示性质，检索能力不完整）。
- **curated notes**：短小稳定的人工/自动备注，文件位于 `~/.pico/memories/MEMORY.md` 与 `~/.pico/memories/USER.md`（字符上限 2200/1375）。会话启动时生成冻结快照注入系统提示词；会话中新增备注会写盘并进入后续会话，但不会改写本轮已经注入的快照。

**9 类事实**（按提取优先级排列）：

| 类别 | 含义 | 示例 |
| --- | --- | --- |
| `correction` | 纠正 agent 的错误 | "No, use pnpm not npm" |
| `failure` | 什么行不通及原因 | "Tried localStorage for tokens — XSS vulnerability" |
| `insight` | 从经验中学到的教训 | "remember that: graphql cache invalidation is tricky" |
| `user_pref` | 用户偏好 | "I prefer concise output" |
| `convention` | 项目约定 | "our convention is use kebab-case for files" |
| `tool_quirk` | 工具特定怪癖 | "this library doesn't support node 14" |
| `project` | 项目决策 | "we decided to migrate to Postgres" |
| `tool` | 工具相关事实 | "CI needs --frozen-lockfile" |
| `general` | 通用事实 | （默认类别） |

**两级作用域**：事实可设为 `global`（全局，默认）或 `project`（绑定当前工作目录，存为 `project:<cwd>`）。项目级事实在跨项目搜索时不可见；项目搜索中全局事实仍可见但排名低于项目事实。`contradict` 同样遵守作用域隔离。

模型可调用以下动作：

| 动作 | 必需参数 | 用途 |
| --- | --- | --- |
| `add` | `content` | 存储一条持久化事实（可选 `category`、`scope`、`correction_of`） |
| `search` | `query` | 检索，按 trust × 相关性排序（可按 `scope`/`category` 过滤） |
| `probe` | `entity` | 围绕实体名称查询（实体表优先，回退 FTS） |
| `related` | `entity` | 找到与实体共享关联的事实 |
| `reason` | `entities` | 找到同时关联多个实体的事实（AND 语义） |
| `contradict` | — | 检测可能矛盾的事实对 |
| `list` | — | 列举事实（可按 `scope`/`category`/`min_trust` 过滤） |
| `update` | `fact_id` | 编辑内容/分类/标签 |
| `remove` | `fact_id` | 删除 |
| `feedback` | `fact_id`, `helpful` | 信任度 ±0.05 / -0.10（钳制 [0,1]） |
| `note_add` | `content` | 写入 curated note（可选 `target=memory|user`） |
| `note_list` | — | 列出 curated notes |
| `note_replace` | `old_text`, `content` | 替换已有 curated note |
| `note_remove` | `old_text` | 删除匹配的 curated note |

**纠正链接**：当 `add` 时指定 `correction_of=<原始 fact_id>`，原始事实信任度 -0.30，纠正事实以 0.70 高信任值插入，确保纠正立即浮现在原始事实之上。

**命令式用法**：

```text
/memory list
/memory list --scope project
/memory search [--scope global|project] bun
/memory add user_pref 我偏好简洁的输出
/memory add failure --scope project localStorage tokens 有 XSS 漏洞
/memory related Auth Service
/memory reason Auth Service,Postgres
/memory contradict
/memory notes list
/memory notes add user 我偏好中文回答
/memory notes replace memory "旧项目约定" "新项目约定"
/memory remove 4
/memory prune
/memory clear
/memory count
/memory status
/memory setup <provider>
/memory off
```

`/memory status` 显示当前 backend、数据库路径、provider 与可用工具；`/memory setup <provider>` 将选择写入 `~/.pico/agent/settings.json`；`/memory off` 恢复内置 backend。`/memory prune` 列出并（经确认后）删除"低价值"事实（信任度 < 0.2 且从未被检索过，属于其它项目作用域的事实会被保留），是手动版的记忆清理。

**自动提取**：每轮对话向系统提示词追加记忆头部与 curated notes 快照；`turn_end` 时对用户消息做**实时纠正检测**并立即存储；会话结束时从用户消息中按模式（偏好/决策/纠正/失败/洞察/约定/工具怪癖）自动提取事实并持久化，同时写入一条会话主题摘要（`source=session-summary`，供下个会话回忆"上次会话在做什么"）；上下文压缩丢弃消息前，被压缩范围内的用户消息会先归档进记忆库。

**时间衰减**：检索排序按事实最后更新时间乘以半衰期衰减因子（默认 180 天）——陈旧事实排名下降但不会被隐藏；可在 `~/.pico/agent/settings.json` 的 `memory` 字段配置 `"temporalDecayHalfLifeDays": 0` 关闭（0 = 永不衰减）。每轮注入的回忆块（上限 5 条）还有 2400 字符预算，超出部分截断并标注省略。

**敏感信息扫描**：存储前自动检测 AWS Access Key、GitHub Token、SSH Private Key、通用 API Key 等模式，匹配则拒绝存储并报错，防止密钥泄露；读出侧同样净化——若历史库中存在含密钥模式的事实，注入系统提示词时会被替换为 `[BLOCKED]` 占位，不会把密钥送进上下文。curated notes 在容量连续 3 次写满后会返回终止性错误，提示模型停止重试记忆写入。

**环境变量**：

| 变量 | 用途 |
|---|---|
| `PICO_MEMORY_DB` | SQLite 记忆库路径（仅作用于 builtin 后端） |
| `PICO_HOLOGRAPHIC_MEMORY_PATH` | holographic JSON 库路径（与上者互不影响） |
| `PICO_MEMORY_DENY` | 写入门禁关键词（逗号分隔，命中即拒绝写入） |

---

## 2. 子代理（`subagent` 工具 + 工作流斜杠命令）

**内置角色**（`src/prompts/agents/*.md`，共 16 个，全部可直接按名调用）：

| 角色 | 用途 |
| --- | --- |
| `scout` | 快速代码库侦察，返回压缩上下文（只读） |
| `planner` | 将上下文 + 需求转化为分步计划（只读） |
| `worker` | 端到端实现计划（全工具） |
| `reviewer` | 只读质量/安全审查 |
| `oracle` | 独立视角咨询、第二意见 |
| `researcher` | 调研类任务 |
| `executor` | 按既定计划专注实现/重构/测试 |
| `editor` | 定向编辑与修复 |
| `debugger` | 根因分析与回归定位 |
| `architect` | 架构与设计建议（只读） |
| `consultant` | 领域咨询（只读） |
| `director` | 多代理编排视角 |
| `product` | 需求拆解与验收视角 |
| `quick` | 轻量快捷任务 |
| `verifier` | 验证策略与完成度检查（只读） |
| `consensus` | 多视角共识评审 |

每个角色的提示词都指示其行动前先查询 `memory(action="search", ...)`，并将持久化发现写回，使子代理运行能共享主会话的项目上下文。

**模式**：

```ts
// 单一
subagent(agent="scout", task="...")

// 并行——单批最多 8 个代理，并发上限 4（均可通过 subagent.json 调整）
subagent(tasks=[{agent: "scout", task: "..."}, {agent: "scout", task: "..."}])

// 并行 + 共享背景——sharedContext 会前置拼入每个任务（2.7.2）
subagent(
  sharedContext: "项目背景：认证模块现状与约束……",
  tasks=[{agent: "scout", task: "调研 A"}, {agent: "scout", task: "调研 B"}],
)

// 链式——步骤 N 的输出填入步骤 N+1 的 {previous}；具名输出用 {outputs.<key>}
subagent(chain=[
  { agent: "scout",   task: "查找认证代码" },
  { agent: "planner", task: "基于以下内容规划变更：{previous}" },
  { agent: "worker",  task: "实现：{previous}" },
])
```

**工作流斜杠命令**：

```text
/implement <目标>                scout → planner → worker
/scout-and-plan <目标>           scout → planner（不实现）
/implement-and-review <目标>     worker → reviewer → worker
```

每个子代理在独立的 `pi` 进程中运行（`--mode json` 事件流），拥有自己的上下文窗口。Ctrl+C 会传播以终止子进程。

**agent frontmatter 支持**：`model`、`tools`、`thinking`、`maxExecutionTimeMs`、`maxTokens`、`fallbackModels`、`systemPromptMode`（append/replace）、`inheritProjectContext`、`inheritSkills`、`outputMode`（file-only）、`acceptance`（验收门：`criteria`/`evidence`/`selfRepair`/`maxRepairAttempts`）、`output`（结构化输出 JSON Schema 子集：`type`/`required`/`properties`/`items`，最终输出需为符合 schema 的 JSON，否则该次运行标记 `schema_violation` 失败）、`maxRequests`（软请求预算：达到该轮次后终止并保留部分输出，`stopReason: "budget"`）。用户级覆盖：`~/.pico/agent/agents/<name>.md`（同名替换）或 `~/.pico/subagent.json`（部分字段覆盖）。

**`~/.pico/subagent.json` 扩展配置**（除 `agents`/`defaults` 覆盖外）：

```jsonc
{
  "spawns": ["scout", "planner", "worker"], // 实例级 spawn 白名单；缺省/空 = 全部允许（2.7.1）
  "parallel": { "maxTasks": 8, "concurrency": 4 }, // 并行上限（缺省 8/4）
  "sessions": { "enabled": true } // 子代理会话落盘（缺省 true）
}
```

**会话续跑（session persistence）**：默认每个子代理使用独立会话文件（`~/.pico/subagent-sessions/`）。运行成功即删除；失败/中断/超时时文件保留，结果文本与工具详情会给出路径，可用 `pico --session <path> "继续任务"` 续跑（2.7.x）。`context: "fork"` 的分支会话不受此机制管理。

**项目级代理**：若项目根目录下存在 `.pico/agents/*.md`，且传入 `agentScope: "both"`（或 `"project"`），同名项目代理将覆盖内置角色。项目代理是仓库可控代码（可执行任意验收命令），调用前需要确认：

- 交互模式：弹确认框（可用 `confirmProjectAgents: false` 跳过）；
- **非交互模式（CI/`-p`）：默认拒绝**，需设置 `PICO_ALLOW_UNATTENDED_PROJECT_AGENTS=1` 显式放行。

**验收门（acceptance gate）**：配置 `acceptance` 的 agent 完成后，在主进程执行 `evidence` 命令校验；失败时若开启 `selfRepair` 会自动返工重试（`maxRepairAttempts` 次）。注意：criteria 与 evidence 按下标顺序配对。

---

## 3. 任务清单（`todoWrite` 工具 + `/todo` 命令）

会话级任务清单。模型每次调用时传入完整列表（`{content, activeForm, status, id?}`）；在对话间隙以 ☐/⏳/✓ 渲染。当所有任务均为 `completed` 时自动折叠为空。出现多个 `in_progress` 项时，模型会收到警告并自行纠正。清单不落盘（跨会话不恢复，有意设计）。

用户命令：`/todo`、`/todo clear`。面板可用 F7 折叠/展开；面板自动弹出仅针对**真正的新任务内容**（同一批任务换 id 重写不会打断折叠状态）。

---

## 4. 交互提问（`askUserQuestion` 工具）

提出 1-4 道选择题，每题 2-4 个选项；支持 `multiSelect` 和单选项的 `preview` 内容。自动追加"其他"选项并触发自由文本输入。在非 TUI 模式（`-p`/`--mode json`）下返回结构化错误，使模型回退到纯文本。

---

## 5. 规划模式（`EnterPlanMode` / `ExitPlanMode` 工具 + `/plan` 命令）

规划模式激活期间，pico 会以"先研究，写出计划，再 ExitPlanMode 请求批准"为由拦截 `bash`/`edit`/`write` 等工具调用（只放行 read/grep/find/ls 与规划工具）。计划文件存放在 `~/.pico/plans/<sessionId>.md`。`ExitPlanMode` 会展示计划内容并请求用户确认；在非 TUI 模式下默认保持计划模式，除非设置 `safety.allowUnattendedPlanApproval=true`，或临时设置 `PICO_ALLOW_UNATTENDED_PLAN_APPROVAL=1`。切换/分叉会话时计划模式自动重置。

---

## 6. 网页（`webFetch` + `webSearch` 工具）

- `webFetch(url, prompt)` —— 抓取公开 HTTPS URL，将 HTML 转为 Markdown（去除 `<script>/<style>/<nav>/<footer>`），默认拒绝 localhost/内网地址（含 IPv6 ULA、整数/十六进制 IP 写法），手动跟随重定向且每跳复检私网，响应读取上限 1 MiB，输出 8 KiB 上限（UTF-8 边界安全截断），15 分钟 LRU 缓存（50 条），同 URL 并发请求合并为一次网络请求，4xx/5xx 响应不缓存并标记为错误。整体 15 秒超时（含响应体下载）。
- `webSearch(query, max_results?, allowed_domains?, blocked_domains?)` —— 默认使用 Exa MCP；若存在 `TAVILY_API_KEY`，默认合并 Exa + Tavily 结果并按 URL 去重。设置 `PICO_SEARCH_PROVIDER=exa` 或 `=tavily` 强制单一 provider；**强制 tavily 但缺 key、或未知 provider 值，会显式报错**（不会静默换成其他源）。每个请求 15 秒超时。

---

## 7. `/init`（生成 AGENTS.md）

多阶段引导式工作流：询问需要设置什么，可选派出 `scout` 子代理做代码库侦察，通过 `askUserQuestion` 填补信息缺口，然后编写极简的 **AGENTS.md**（以及可选的 AGENTS.local.md），并建议技能/钩子。**pico 永远不会写入 CLAUDE.md**——这是写死在提示词中的硬规则。AGENTS.md 已存在时，`/init` 改为审计模式（提出修改建议，绝不覆盖）。

---

## 8. 权限与安全边界

基础工具审批、项目可信任状态与交互权限由上游 `@earendil-works/pi-coding-agent` 负责。pico 额外做了明确阻断与默认关闭：

- `lsp` 中的写入或高风险 action（`rename`、`rename_file`、`code_actions apply=true`、`request`）在 `tool_call` 阶段被阻断；只读 action（hover、definition、references、diagnostics、symbols、capabilities、status，以及未设置 `apply=true` 的 code_actions）与 `reload`（重启语言服务器，不写文件）可用。
- 项目级 shell hooks、项目级 MCP 服务器、非交互计划自动批准、LSP 自动格式化写回、非交互项目代理：**默认全部关闭**，需显式开启。

`/doctor` 可查看当前 cwd、settings 路径、能力边界、安全开关状态与来源。长期配置写入 `~/.pico/agent/settings.json` 的 `safety` 字段；临时覆盖使用环境变量，**环境变量优先于 settings**：

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

| 开关 | 环境变量（临时覆盖） | 默认 |
|---|---|---|
| 项目级 hooks | `PICO_ENABLE_PROJECT_HOOKS` | 关 |
| 项目级 MCP | `PICO_ENABLE_PROJECT_MCP` | 关 |
| 项目级 LSP | `PICO_ENABLE_PROJECT_LSP` | 关 |
| 非交互计划自动批准 | `PICO_ALLOW_UNATTENDED_PLAN_APPROVAL` | 关 |
| LSP 写后格式化 | `PICO_ALLOW_LSP_FORMAT_ON_WRITE` | 关 |
| 非交互项目代理 | `PICO_ALLOW_UNATTENDED_PROJECT_AGENTS` | 关（仅 env，无 settings 项） |

`auxiliary.vision.provider/model` 必须能被模型注册表解析到。使用自定义 provider、代理或本地视觉模型时，需要先在 `~/.pico/agent/models.json` 中注册该模型，并确保模型声明包含 `"input": ["text", "image"]`，否则会被视为不具备视觉能力。

---

## 9. 钩子系统

基于文件的 Shell 钩子，支持 `PreToolUse` / `PostToolUse` / `PreSessionEnd` / `PostUserMessage` 事件。默认只加载用户级 `~/.pico/hooks.json`；项目级 `<仓库>/.pico/hooks.json` 会执行仓库提供的 shell 命令，需设置 `safety.enableProjectHooks=true` 或 `PICO_ENABLE_PROJECT_HOOKS=1` 才会加载。占位符：`$FILE`（工具参数）、`$TOOL`（工具名）、`$TURN`（轮次索引）。默认超时 30 秒（最大 120 秒）；`blocking: true` 的 PreToolUse 失败会中止工具调用。

```json
{
  "hooks": [
    { "event": "PostToolUse", "tool": "edit", "command": "biome format $FILE" },
    { "event": "PreToolUse", "tool": "bash", "command": "echo $TOOL >> /tmp/audit.log" }
  ]
}
```

注意：钩子配置按工作目录加载并缓存，切换项目后自动重新加载；钩子输出超过 4 KiB 会被截断。

---

## 9.5 生成阶段反馈（`retro-theme` 扩展）

- **生成阶段反馈**：长生成期间工作区显示 `thinking Ns` / `streaming Ns` / `tool <name> Ns` 动态状态，替代无信息的 "Working..."。

---

## 10. Vibe 编码系统提示词

`src/prompts/vibe-system.md` 会被追加到每条系统提示词末尾。四条规则——*先思考再编码、用最少的代码解决问题、手术式修改、目标驱动执行*——从 `~/.claude/CLAUDE.md` 中提炼。目标是让 pico 先问后猜、不重构相邻代码、并将每行 diff 追溯到明确需求。

---

## 11. 内置技能

三个 `SKILL.md` 技能通过 `--skill <bundled-skills-dir>` 自动加载（`-ns`/`--no-skills` 关闭）：

- `verify` —— 运行 lint + 类型检查 + 测试，简洁报告失败项
- `recap` —— 利用存储的项目记忆总结近期工作
- `agents-init` —— 对已有 AGENTS.md 做增量编辑（比 `/init` 更轻量）

`~/.pico/agent/skills/` 中的用户技能按名称覆盖内置技能。

---

## 12. MCP 服务器集成（`mcp__*` 工具）

支持连接外部 MCP（Model Context Protocol）服务器，自动发现并注册其工具为 LLM 可调用的内置工具。兼容 Claude Code 的 `mcpServers` 配置格式。

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
| 全局 | `~/.pico/mcp-servers.json` | 所有项目共享 |
| 项目 | `<cwd>/.pico/mcp-servers.json` | 设置 `safety.enableProjectMcp=true` 或 `PICO_ENABLE_PROJECT_MCP=1` 后覆盖同名 server |

**工具命名规则**：`mcp__<服务器名>__<工具名>`，与权限系统的 `mcp__` 前缀匹配兼容。

**行为**：

- 会话启动时按当前 `ctx.cwd` 加载配置并连接 MCP 服务器，调用 `initialize` + `tools/list` 发现工具；
- 每个 MCP 工具注册为一个独立的 pi 工具，LLM 可直接调用；
- 工具调用通过 JSON-RPC 2.0 stdio 转发至 MCP 服务器（每次写入显式 flush）；
- 单服务器故障不影响其他服务器，请求超时 30 秒；
- 状态栏显示 MCP 连接数量与失败数量；
- server stderr 与协议解析错误收集为最近诊断，不直接写终端，避免破坏 TUI 输入区；
- 会话结束时自动清理子进程；切换工作目录时自动重连。

用户命令：`/mcp` 可查看所有已连接 MCP 服务器的状态、版本、已注册工具列表与最近诊断。

---

## 13. LSP 代码智能（`lsp` 工具）

通过 Language Server Protocol 为 LLM 提供精确的代码智能。支持 14 种操作，自动检测并启动对应的语言服务器。

**支持的操作**：

| 操作 | 用途 | 需要位置参数 | 可用性 |
|------|------|-------------|--------|
| `hover` | 类型信息和文档 | ✓ | 只读 |
| `definition` | 跳转到定义 | ✓ | 只读 |
| `type_definition` | 跳转到类型定义 | ✓ | 只读 |
| `implementation` | 查找接口的具体实现 | ✓ | 只读 |
| `references` | 查找所有引用 | ✓ | 只读 |
| `diagnostics` | 获取错误/警告（文件级或工作区级） | 可选 | 只读 |
| `symbols` | 文件符号列表或工作区符号搜索 | 可选 | 只读 |
| `code_actions` | 列出代码修复/重构/导入建议 | ✓ | 只读（`apply=true` 被策略阻断，需用 edit/write 手工应用） |
| `rename` | 跨文件符号重命名 | ✓ | **阻断** |
| `rename_file` | 文件重命名并应用引用更新 | — | **阻断** |
| `capabilities` | 显示语言服务器能力 | — | 只读 |
| `status` | 显示服务器状态 | — | 只读 |
| `reload` | 重启语言服务器（配置/设置变更后生效） | — | 可用（不写文件） |
| `request` | 原始 LSP 请求（逃生舱） | — | **阻断** |

**可选参数**：`timeout`（1–300 秒，默认 30）——冷启动或大项目索引期间可放宽单次请求预算，例如 `lsp(action="hover", file="src/index.ts", line=10, character=5, timeout=60)`。

**示例**：

```text
lsp(action="hover", file="src/index.ts", line=10, character=5)
lsp(action="definition", file="src/index.ts", line=10, symbol="LspClient")
lsp(action="references", file="src/index.ts", line=10, symbol="LspClient")
lsp(action="diagnostics", file="src/index.ts")
lsp(action="symbols", file="src/index.ts")
```

**自动检测**：根据工作区文件自动选择语言服务器（`tsconfig.json` / `package.json` → TypeScript LSP，`Cargo.toml` → `rust-analyzer`，`pyproject.toml` → `pyright` 等）。TypeScript 项目优先尝试 `typescript-native`；启动前探测本地 `tsc --help --all` 是否声明支持 `--lsp`，旧版 `tsc` 不支持时静默跳过并回退。语言服务器惰性启动，`session_shutdown` 时关闭。

**45+ 语言支持**：TypeScript、JavaScript、Python、Rust、Go、Java、Kotlin、Scala、Haskell、OCaml、Elixir、Ruby、PHP、C#、Lua、Nix、Zig、Bash、YAML、TOML、SQL、Terraform、Docker、Prisma、GraphQL、Swift、Dart、CSS、HTML、JSON、Vue、Svelte、Astro、Tailwind、Deno、Biome、ESLint 等。

**配置系统**：三层合并——内置 defaults.json → `~/.pico/lsp.json`（用户级）→ `.pico/lsp.json`（项目级）。支持 `fileTypes`、`rootMarkers`、`initOptions`、`settings` 配置。本地二进制解析优先检查 `node_modules/.bin/`、`.venv/bin/`、`vendor/bundle/bin/`。**项目级 `.pico/lsp.json` 是安全开关默认关闭的能力**：仓库内的配置（可含任意服务器 command）需设置 `safety.enableProjectLsp=true` 或 `PICO_ENABLE_PROJECT_LSP=1` 才会加载，与项目级 hooks/MCP 一致；被禁用时 session 启动会提示。

**Write/Edit 联动**：编辑代码文件后，LSP 自动同步文件内容、通知服务器重新分析、收集诊断信息并追加到工具结果（500ms 内联等待 + 最长 5s 后台等待）。`.editorconfig` 解析支持自动格式化；自动格式化会二次写文件，因此即使 `formatOnWrite=true`，仍需设置 `safety.allowLspFormatOnWrite=true` 或 `PICO_ALLOW_LSP_FORMAT_ON_WRITE=1` 才会写回。

**TUI 状态栏**：服务器启动后，状态栏显示当前活跃的语言服务器名称和版本。

---

## 14. 项目结构

```
pico/
├── bin/
│   ├── pico.ts                       # 入口：main(args) + 自动注入 --prompt-template + --skill
│   └── env-bootstrap.ts                # 副作用：目录/环境水合（必须最先导入）
├── src/
│   ├── runtime/                        # 参数装配、扩展注册表、嵌入式资源解包、setup 短路
│   ├── extensions/
│   │   ├── ask/        # askUserQuestion 工具（schema、提示词、对话框分发）
│   │   ├── cache-optimizer/  # 系统提示词缓存优化（稳定段前置、技能压缩、OpenAI 缓存键）
│   │   ├── hooks/      # 配置加载 + 运行器 + 事件连线
│   │   ├── init/       # /init 提示词（AGENTS.md，绝不写 CLAUDE.md）
│   │   ├── input-history/  # 持久化输入历史编辑器
│   │   ├── language/   # 响应语言设置（/language）
│   │   ├── logo/       # 启动 ASCII logo
│   │   ├── lsp/        # LSP 代码智能（client/config/manager、只读 action、写透传诊断）
│   │   ├── mcp/        # MCP 客户端（types, config, client, 扩展工厂）
│   │   ├── memory/     # bun:sqlite + FTS5/TF-IDF 长期记忆，实体检索、scope 隔离、策展笔记
│   │   ├── plan/       # EnterPlanMode / ExitPlanMode + tool_call 拦截
│   │   ├── retro-theme/ # TUI 复古主题 + Claude-like 页脚
│   │   ├── rtk/        # rtk 命令代理
│   │   ├── settings.ts / policy.ts / paths.ts  # 配置、安全策略、路径
│   │   ├── subagent/   # 子代理工具 adapter + orchestrator + runner/process/chain/parallel/gate/worktree
│   │   ├── todo/       # todoWrite 工具 + /todo 命令 + 按会话存储 + 面板 widget
│   │   ├── vision/     # visionAnalyze 工具 + 输入图像自动分析
│   │   ├── web/        # webFetch + webSearch + LRU 缓存 + 私网防护
│   │   ├── doctor/     # /doctor 安全状态报告
│   │   ├── events.ts   # 扩展间轻量事件总线
│   │   ├── tool-render.ts / ui/   # 工具行渲染、UI 辅助
│   │   └── vibe.ts     # 将 vibe-system.md 追加到系统提示词
│   ├── prompts/        # 系统提示词模板（vibe、plan-mode、agents/ 等）
│   ├── setup/index.ts  # 交互式 setup 向导
│   ├── skills/{verify,recap,agents-init}/SKILL.md
│   └── types/markdown.d.ts
└── tests/              # 与 src/extensions/ 一一对应（bun:test，完全离线）
```

---

## 15. 测试

```bash
bun run verify          # tsc --noEmit + 全量 bun test（385 用例 / 26 文件）
bun test tests/<feature>.test.ts
```

测试完全离线。约定：hand-rolled fakes（`fakePi`/`FakeUi`）、`__reset*ForTests()` 状态重置钩子、`PICO_HOME` 临时目录隔离、直接替换 `globalThis.fetch` 模拟网络。详细约定见根目录 `AGENTS.md`。

---

## 16. 路线图

- v2 记忆：评估 HRR 相位编码或 embedding 检索，用于实体推理与矛盾检测（当前为 TF-IDF + 同义词表，跨语言/深度改写召回有限）。
- `/vibe` 斜杠命令，用于即时切换系统提示词块。
- 子代理：可选共享单个 SQLite WAL 与主会话，使子进程的 `memory(add)` 立即可见。
- 成本追踪器（v0.2 跳过——pi 已显示上下文百分比）。
- LSP 增强：诊断版本跟踪（2026-08 已实现）、拉取式诊断（`textDocument/diagnostic`，2026-08 已实现）、多服务器并发诊断合并；独立的 LSP 写权限层级（放开受信任项目的 `apply=true`/`rename`，与系统提示词一致）。
- 记忆归档与衰减策略（控制 facts 库膨胀）。
- 子代理输出上限（stderr 截断、会话消息封顶）。
- 上下文缓存命中率展示（需上游 ContextUsage 提供缓存数据）。
