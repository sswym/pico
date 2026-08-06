# pico vs oh-my-pi 子代理编排能力对比分析

> 分析日期：2026-08-06（2.7.x 修复完成后更新：G4/G5/G6/G7/G8/G9 已落地，G3 部分落地，G1/G2/G10 未做）
> 分析对象：
> - **pico**（本项目）：`src/extensions/subagent/`（16 文件，编排核心 `orchestrator.ts` 627 行）
> - **oh-my-pi**：`~/oh-my-pi/packages/coding-agent/src/task/`（编排核心 `executor.ts` 3416 行 + `index.ts`/`parallel.ts`/`types.ts`/`isolation-runner.ts` 等）
>
> 本分析**仅基于代码事实**，未验证运行行为处标记【待确认】。两项目时间线不同（pico 为 pi-coding-agent thin wrapper，oh-my-pi 为独立 monorepo），版本差异导致的字段差异不视为缺陷。

---

## 1. 现状说明

### 1.1 pico 子代理（薄封装 + 子进程模型）

pico 的 subagent 是单个 `subagent` 工具，支持**三种互斥模式**（`orchestrator.ts` 中 `modeCount !== 1` 时直接报错）：

| 模式 | 参数 | 执行方式 |
|---|---|---|
| single 单发 | `agent` + `task` | 串行跑一个 agent |
| parallel 并行 | `tasks[]`（≤8 个，并发 4，硬编码常量） | `mapWithConcurrencyLimit` 并发池，可选 git worktree 隔离 |
| chain 链式 | `chain[]`（每步可带 `label`/`model`/`output`/`reads`/`phase`） | 严格串行，`{previous}` / `{outputs.name}` 占位符替换（32KB 上限），任一步失败抛错中止 |

**执行模型是"整进程子代理"**：每个子代理 spawn 一个完整的 pico 子进程（`--mode json -p`），通过 stdout 的 JSONL 事件流（`message_end`/`tool_result_end`，见 `runner.ts`）解析结果。子进程带 `PICO_SUBAGENT_DEPTH` 深度标记（≤3，`bin/pico.ts` 拒绝超深启动）。

**辅助机制**：
- **验收门**（`gates.ts`）：agent frontmatter 声明 `acceptance`（evidence shell 命令 + criteria），成功后执行证据命令验证；失败可 `selfRepair` 重跑（≤5 次）
- **模型 fallback**（`fallback.ts`）：`fallbackModels` 列表，仅当 `stopReason === "error"` 且错误匹配 `429|503|529|rate limit|overloaded|capacity|quota` 正则时触发
- **上下文 fork**（`session.ts`）：`context: "fork"` 通过 `sessionManager.createBranchedSession` 继承父会话历史；`fresh` 为干净上下文
- **会话持久化**（2.7.x）：默认每个子代理写独立 session 文件（`~/.pico/subagent-sessions/`），成功即删、失败/中断保留并输出路径（`pico --session <path>` 续跑）；`subagent.json` 的 `sessions.enabled: false` 恢复 `--no-session` 行为
- **软请求预算**（2.7.x）：agent frontmatter/subagent.json 的 `maxRequests` 达到轮次即终止并保留部分输出（`stopReason: "budget"`）
- **结构化输出**（2.7.x）：frontmatter `output` 声明 JSON Schema 子集（`schema.ts`），校验失败标记 `schema_violation`
- **大输出 spill**（`output.ts`）：`outputMode: "file-only"` 时 >50KB 输出写入临时文件，路径注入结果文本，session 结束时清理
- **worktree 隔离**（`worktree.ts`）：`isolation: "worktree"` 时每任务一个 detached worktree，结束后 commit + merge 回主分支，冲突保留分支
- **配置**：17 个内置 agent（`src/prompts/agents/*.md`，编译模式走 embedded asset map）+ `~/.pico/agent/agents/` + 项目 `.pico/agents/`（需 UI 确认或 `PICO_ALLOW_UNATTENDED_PROJECT_AGENTS`）；`~/.pico/subagent.json` 可全局覆盖 model/thinking/超时/fallback/tools
- **超时**：默认 30min/agent（`DEFAULT_AGENT_TIMEOUT_MS`），frontmatter `maxExecutionTimeMs` 可覆盖
- **取消**：AbortSignal → SIGTERM 进程组（5s 后 SIGKILL），`stopReason: "aborted"` 保留部分输出；并行中断时已完成兄弟任务结果保留

### 1.2 oh-my-pi 子代理（进程内 session 模型）

oh-my-pi 的 `task` 工具提供**两种形态**（`index.ts`）：

| 形态 | 参数 | 说明 |
|---|---|---|
| flat 单发 | `{ name?, agent?, task?, effort?, outputSchema? }` | 一次一个 spawn |
| batch 并行 | `{ context, tasks[] }`（需 `task.batch` 设置开启） | 共享 `context` 渲染进每个子代理系统提示词；每项可带 `name`/`agent`/`effort`/`outputSchema`/`isolated` |

**执行模型是"进程内 AgentSession"**：每个 spawn 在主进程内创建完整 `AgentSession`（`executor.ts` `runSubprocess`），共享父进程的 ModelRegistry、authStorage、MCP 连接（`createMCPProxyTools` 复用父连接）、ArtifactManager、Settings。子代理会话可持久化为 JSONL（`sessionFile`），供调试、恢复、跨进程复活。

**核心编排特性**：
- **yield 协议**：子代理必须调用 `yield` 工具返回结果（`requireYieldTool: true`）；`driveSessionToYield` 驱动 yield ladder（最多 3 次提醒，最后一次强制 `toolChoice: yield`）
- **软预算**：`softRequestBudget`（scout/sonic 100、default 200 次请求），超预算注入 wrap-up 提示，1.5× 预算强制停轮并驱动最终 yield，再 5 次宽限后硬中止
- **异步执行**：`async.enabled` 时非 `blocking: true` 的 spawn 注册为 AsyncJobManager 后台 job，父 turn 不阻塞；`blocking: true` 的 agent（如 reviewer）内联等待；支持混合调用
- **结构化输出**：`outputSchema`（agent frontmatter `output` 或调用方传参）+ `permissive`/`strict` 模式；yield 数据经 JSON schema 校验，strict 下失败产出 `schema_violation` 结果（exit 1）
- **递归 spawn**：`taskDepth` + `maxRecursionDepth`（默认 2），到深度自动从工具列表移除 `task`；父 agent frontmatter `spawns` 声明可 spawn 的 agent 白名单（`"*"`/列表/禁用）
- **隔离**：worktree 隔离（`isolation-runner.ts`）：capture baseline → per-spawn worktree → 捕获 branch/patch → merge 回父仓库（可选 apply）；支持 nested repos、AI 生成 commit message
- **生命周期管理**：`AgentRegistry`（全局注册表：id/状态/activity）+ `AgentLifecycleManager`（idle → parked → revived，TTL 默认 420s；park 释放 session 但保留 AgentRef+sessionFile；revive 用 `session_init` 条目重建）—— aborted/空闲的子代理**可恢复**，可被 `hub` 唤醒
- **子代理协作**：`hub` 工具（IRC 风格）——子代理间按 id 互发消息/广播，系统提示词注入 peer 名册（`renderIrcPeerRoster`）
- **模型管理**：ModelRegistry 解析（provider/auth 感知），auth 缺失时 fallback 父模型（`parentActiveModelPattern`）、retry fallback chain（role 化注入 settings）、service tier 继承、`effort` lo/med/hi、`prewalk` 首次编辑切换廉价模型
- **进度/可观测**：`AgentProgress` 富数据（当前意图、最近工具、token/cost/requests/context 水位/contextWindow/retry 状态/解析后模型），150ms 合并节流，3 个事件总线 channel（progress/lifecycle/event），launch timing 分阶段 debug 日志
- **配置**：agent 来源最多（bundled + `~/.omp/agent/agents/` + `.omp/agents/` + OMP 扩展包 roots + Claude marketplace 插件）；settings schema 控制 `task.batch`/`task.maxConcurrency`（0=无限，跨调用共享 Semaphore 可动态 resize）/`task.maxRuntimeMs`/`task.softRequestBudget`/`task.disabledAgents`/`task.isolation.mode` 等

---

## 2. 核心差距清单（含优先级）

> 状态标注：✅ 已修复（2.7.x）｜🟡 部分修复｜⬜ 未做

### 🔴 高优先级（能力缺口，直接影响编排上限）

| # | 差距 | pico 现状 | oh-my-pi 现状 | 说明 |
|---|---|---|---|---|
| G1 | **异步/后台执行** ⬜ | 所有模式同步阻塞：父 agent 在 subagent 工具调用期间完全等待 | `async.enabled` + AsyncJobManager：spawn 后台 job，父 turn 继续工作，`hub jobs/wait/cancel` 管理 | pico 无任何"fire-and-forget"路径；长任务必须等完。需要上游级 job 管理支持 |
| G2 | **子代理间协作** ⬜ | 无。并行任务只能各干各的，通过最终结果合并 | `hub` 工具：子代理按 id/broadcast 互发消息；系统提示词注入 live peer 名册；可唤醒 parked 兄弟 | 并行任务共享文件时只能靠父 agent 预先分配，无法动态协调。需要跨进程通信通道 |
| G3 | **会话持久化与恢复** 🟡 | 默认每个子代理写独立 session 文件（`~/.pico/subagent-sessions/`）；成功删除、失败/中断保留并输出路径，可 `pico --session <path>` 手动续跑；`sessions.enabled: false` 可关闭 | 每个 spawn 有 JSONL sessionFile；park/revive（TTL 后释放资源但可唤醒）；跨进程 `persisted-revive` 重建运行时契约 | 已落地"失败保留 + 手动续跑"；工具内自动 resume 参数、生命周期管理（park/revive）未做 |
| G4 | **软预算控制** ✅（降级版） | `maxRequests`（frontmatter/subagent.json）达到轮次后终止并保留部分输出，`stopReason: "budget"` | 请求数软预算 + wrap-up 提示 + 强制 yield + 宽限硬中止 | 因 json 模式单向 stdout（无 stdin 注入），无法注入 wrap-up 引导，只做"达到阈值即终止"的硬停止变体 |

### 🟡 中优先级

| # | 差距 | pico 现状 | oh-my-pi 现状 | 说明 |
|---|---|---|---|---|
| G5 | **结构化输出契约** ✅ | frontmatter `output` 声明 JSON Schema 子集（type/required/properties/items），最终输出校验失败标记 `schema_violation` | `outputSchema`（agent frontmatter `output` 声明）+ permissive/strict + `schema_violation` | 已落地 mini 校验器（`schema.ts`），无 strict/permissive 模式与 yield 数据装配 |
| G6 | **模型回退面** ✅ | fallback 正则扩展覆盖 429/503/529/rate limit/quota + 401/403/unauthorized/auth/context length/window | ModelRegistry：auth 感知解析、auth 缺失 fallback 父模型、retry fallback chain role、service tier、effort/thinking | 正则面已扩展；无 auth 感知解析/父模型 fallback（需上游模型注册表） |
| G7 | **spawn 策略控制** ✅（配置版） | `subagent.json` 顶层 `spawns` 白名单：白名单外 agent 直接拒绝（嵌套子进程继承同一配置，递归生效） | 父 frontmatter `spawns` 白名单/禁用；动态渲染进工具描述并拒绝越权 spawn | pico 无"父 agent frontmatter"概念（主 agent 非 .md 文件），落地为实例级配置而非逐 agent 声明 |
| G8 | **可配置并发** ✅ | `subagent.json` `parallel.maxTasks`/`concurrency`（缺省 8/4） | `task.maxConcurrency`（0=无限）+ 跨调用共享 Semaphore + 运行中 resize | 已可配置；无 0=无限语义与跨调用共享 |
| G9 | **共享 batch context** ✅ | parallel 模式 `sharedContext` 参数前置拼入每个任务 | batch `context` 渲染进每个子代理系统提示词 | 已落地（拼接进 task 文本，非系统提示词） |
| G10 | **agent 来源扩展** ⬜ | 内置 + user + 项目 `.pico/agents/` 三源 | 另支持 OMP 扩展包 roots、Claude marketplace 插件 agents | pico 无外部包/插件 agent 装载机制【待确认：后续如有包机制再接入】 |

### 🟢 低优先级

| # | 差距 | 说明 |
|---|---|---|
| G11 | 进度数据丰富度 | pico 的 `onUpdate` 只有文本 + 结果数组；oh-my-pi `AgentProgress` 含意图/工具/token/cost/context 水位/retry 状态，供 HUD/协作面实时展示 |
| G12 | 可观测性 | oh-my-pi 有 OTEL span 嵌套 + handoff span + launch timing 分段日志；pico 只有 extension event |
| G13 | 子代理内部工具数据提取 | oh-my-pi `subprocess-tool-registry`（如 review 工具的 findings 提取进结果）；pico 无 |

---

## 3. 可落地改进方向

按"性价比"排序，每项给出落点文件与最小改动思路（✅ = 已实施，见提交 2.7.x）：

1. **异步执行（G1）** ⬜【改动大】
   - 落点：`orchestrator.ts` 增加 `async` 模式或 `detach: true` 参数；需要上游提供 job 管理或自行维护 module-level job 表 + `subagent_status` 查询工具
   - 最小可行：先支持"后台 spawn + 轮询结果"单层能力，不做 full job manager

2. **可配置并发（G8）** ✅
   - 落点：`orchestrator.ts` 常量改为读 `~/.pico/subagent.json` 的 `parallel.maxTasks` / `parallel.concurrency`（沿用 `config.ts` 的 `applyOverrides` 模式）
   - 同步修改 schema 描述与 `tests/subagent.test.ts`

3. **软预算（G4）** ✅（降级版）
   - 落点：`process.ts` 的 `runJsonProcess` 无法观测"请求数"（事件流里有 `message_end` assistant 计数，`runner.ts` 的 `applyJsonModeEvent` 已统计 `usage.turns`）；在 `runSingleAgent` 循环里轮询 `currentResult.usage.turns`，超过阈值后向子进程注入 wrap-up 消息【待确认：json 模式下子进程 stdin 是否可写】——否则只能降级为"达到阈值后 SIGTERM 并保留部分结果"
   - 结论：stdin 为 `ignore`（json 模式单向 stdout），注入不可行；落地为 `maxRequests` 阈值终止变体（stopReason "budget"，保留部分结果）

4. **结构化输出契约（G5）** ✅
   - 落点：`agents.ts` 解析 frontmatter `output`（JSON schema）→ 结果返回前用轻量校验（无依赖可用 `JSON.parse` + 手工必填字段检查，或引入 tiny schema validator）；`results.ts` 增加 `structuredOutput` 字段
   - 与现有验收门互补：schema 校验数据形状，evidence 校验行为（已落地 `schema.ts` mini 校验器；`structuredOutput` 结构化字段未做）

5. **spawn 策略（G7）** ✅（配置版）
   - 落点：`agents.ts` frontmatter 增加 `spawns` 字段解析；`index.ts` 工具描述动态渲染可 spawn 列表；`orchestrator.ts` 在 `runSubagentRequest` 入口校验请求的 agent 是否在父 agent 白名单内（需传递调用方 agent 身份【待确认：ExtensionAPI 是否暴露当前 agent 名】）
   - 结论：ExtensionAPI 未暴露调用方 agent 名；落地为 `subagent.json` 顶层 `spawns` 实例级白名单（嵌套子进程继承，递归生效）

6. **共享 batch context（G9）** ✅
   - 落点：`index.ts` SubagentParams 的 tasks 分支增加 `context` 字段；`orchestrator.ts` parallel 分支将其前置于每个 task 字符串（复用 `chain.ts` 的拼装思路）
   - 已落地（字段名 `sharedContext`，避免与 single 模式的 `context: "fresh"|"fork"` 冲突）

7. **模型回退面扩展（G6）** ✅
   - 落点：`fallback.ts` 的 `isProviderFailure` 增加 `401|403|auth|context length|insufficient` 等模式（认证失败/上下文溢出场景）
   - 注意：不改触发语义，仅扩正则 + 测试（已落地）

8. **agent 来源扩展（G10）** ⬜【改动中】
   - 落点：`agents.ts` 的 `discoverAgents` 增加对 pico 扩展/插件目录的扫描（若有既定插件机制）【待确认：pico 目前 19 扩展是否暴露可安装 agent 的插件路径】
   - 结论：pico 无外部包机制（19 扩展为内置注册），暂不实施

9. **持久化/恢复（G3）** 🟡
   - 落点：`process.ts` 的 `buildAgentProcessArgs` 目前传 `--no-session`；可改为 `--session <file>` 让子进程写 JSONL，aborted 后以 `--session` 续跑（上游 `--mode json` 是否支持续跑【待确认】）
   - 结论：上游 `--session <path>` + json 模式支持续跑；已落地"默认写 session 文件，成功删除、失败/中断保留并输出路径，`pico --session <path>` 手动续跑"。工具内自动 resume 参数、park/revive 生命周期未做

---

## 4. 不属于差距的设计差异（选型取舍）

以下差异是**有意设计**，不应按"补齐"对待：

| 维度 | pico | oh-my-pi | 性质 |
|---|---|---|---|
| **执行隔离** | 整进程子代理（OS 级隔离，崩溃/内存不影响主进程，但启动重、无共享状态） | 进程内 session（轻、共享一切，但子代理崩溃/资源泄漏影响宿主） | 取舍：pico 偏安全隔离，oh-my-pi 偏性能与共享 |
| **结果协议** | 自由文本输出（子进程按普通对话跑完，最后一段文本即结果） | 强制 `yield` 工具 + 提醒 ladder | 取舍：pico 对模型更宽容，oh-my-pi 契约更强（换取可校验性） |
| **链式编排** | 有 `chain`（`{previous}`/`{outputs.name}`/`reads`/per-step model） | **无 chain**，靠父 agent 多次调用 + hub 协作 | pico **领先**的能力；oh-my-pi 理念是"协作而非接力" |
| **验收机制** | shell 证据命令验收门 + self-repair | 无 shell 验收门；用 schema 校验 + eval backends | 理念不同：pico 验证"行为结果"，oh-my-pi 验证"数据结构" |
| **递归护栏** | 进程级环境变量（`PICO_SUBAGENT_DEPTH` ≤3，硬拒绝启动） | 工具级（`taskDepth` 到深度自动移除 task 工具，`spawns` 白名单） | pico 更硬（防失控进程栈），oh-my-pi 更软（保留模型可见性） |
| **超时默认** | 默认 30min/agent | 默认无墙钟限制（`maxRuntimeMs=0`），靠软预算兜底 | 取向差异：pico 保守，oh-my-pi 信任 + 预算 |
| **上下文继承** | `fork` 分支会话文件继承历史；`fresh` 干净 | 默认干净 + 显式传递（context/contextFiles/skills/planReference/rules） | 两者都支持，传递粒度不同 |
| **取消语义** | aborted = 结果保留，结束 | aborted = 可恢复（registry 存活、hub 可唤醒、可续跑） | pico 视为终结，oh-my-pi 视为暂停 |

---

## 5. 一句话总结

pico 的 subagent 是**"一次调用一次进程"的轻量编排**：单发/并行/链式三模式 + 验收门 + 模型 fallback，简单可靠，链式编排反而是其相对优势；oh-my-pi 是**"常驻 agent 生态"**：进程内 session + 持久化 + 异步 + 协作 + 生命周期管理，编排深度与可观测性远超 pico。**高优先级差距集中在异步执行、子代理协作、持久化恢复、软预算**四项——它们决定的是"编排能力天花板"，而非"单次委派质量"。
