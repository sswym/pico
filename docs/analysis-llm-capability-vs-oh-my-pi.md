# pico × oh-my-pi 模型能力增强机制对比与改造方案

> 分析日期：2026-08-10
> 分析对象：
> - **oh-my-pi**（`~/oh-my-pi`，pi-mono fork，Rust core + TS packages，`packages/coding-agent` 为主战场，1216 个 TS 文件）
> - **pico**（本项目，`@earendil-works/pi-coding-agent@^0.84.0` thin wrapper + 25 个 ExtensionFactory 扩展）
>
> 本报告**仅基于代码事实**（源码位置均已人工核实），未验证运行行为处标记【待确认】。
> 已有文档 `docs/analysis-subagent-vs-oh-my-pi.md` 覆盖子代理编排对比，本文聚焦**其余全部 LLM 能力增强手段**（提示词工程/上下文管理/工具调用优化/记忆/思考/输出约束/后处理），子代理部分只引用其结论不重复。

---

## 1. oh-my-pi 增强模型能力的核心手段（附源码位置）

### 1.1 提示词工程

| # | 手段 | 源码位置 | 说明 |
|---|---|---|---|
| P1 | **Block 数组式 system prompt 组装** | `coding-agent/src/system-prompt.ts:899-920` | 最终交付是 `string[]`：`[主模板(默认或自定义)] → [computer 安全提示(条件)] → [project footer] → [active-repo-context(条件)]`，每块独立发送，互相不污染 |
| P2 | **主模板 6 大段** | `prompts/system/system-prompt.md:1-263` | `<system-conventions>` → ROLE → RUNTIME(skills/规则/URL) → TOOL POLICY → EXECUTION WORKFLOW → DELIVERY CONTRACT(输出约束正文) |
| P3 | **5 秒 deadline 并行准备** | `system-prompt.ts:117, 640-663` | 所有异步步骤（context files/workspace tree/skills/GPU 探测）超过 5s 用最小 fallback，超时步骤后台继续跑暖缓存；慢步骤从 prompt 路径剥离 |
| P4 | **段落级内容去重** | `system-prompt.ts:47-89, 339-349, 842-853` | `normalizePromptBlock` 按 `\n{2,}` 切块；SYSTEM.md 若被 custom/append 覆盖则丢弃；always-apply 规则若已含于来源则剔除；context files 字节级去重（只留离 cwd 最近） |
| P5 | **模型差异化（克制，仅 3 处）** | `task/prompt-policy.ts:4-8`（GPT-5.6 Codex 措辞）、`catalog/src/identity/dialect.ts:18-41`（模型族→工具方言）、`system-prompt.ts:877`（模型名注入） | 不重写整段提示词，只通过 `{{#if}}`/`{{#has}}` 条件与数据开关实现 |
| P6 | **capability 规则分桶** | `capability/rule-buckets.ts:33-66` | 三桶：TTSR 有条件规则（注册运行时断言）/ `alwaysApply`（全文注入）/ rulebook（只注入 name+globs+description，模型按需 `rule://<name>` 拉全文）——**prompt 只塞描述，全文按需拉取** |
| P7 | **自制 Handlebars + 编译缓存** | `packages/utils/src/prompt.ts:316-518, 528-539` | 25+ helper、编译结果按模板字符串缓存；渲染后 `format()` 后处理（压缩表格/替换 ASCII 符号/剥多空行） |
| P8 | **magic keywords 隐藏 notice** | `modes/magic-keywords.ts:23-42` + `prompts/system/{ultrathink-notice,orchestrate-notice,workflow-notice}.md` | 用户消息独立成词出现 `ultrathink`/`orchestrate`/`workflowz` 时注入隐藏 notice（跳过代码块/行内代码/XML 段） |
| P9 | **steering 消息纯函数包裹** | `session/messages.ts:692-711` | 每次发送对所有 steering 消息做相同包裹，避免"队尾被包、被埋后不包"导致 provider prompt 缓存前缀失效 |
| P10 | **personality 三选一** | `prompts/system/personalities/{default,friendly,pragmatic}.md` + `system-prompt.ts:35-39` | `<personality>` 段条件渲染 |
| P11 | **@import 上下文展开** | `discovery/at-imports.ts:64-74` | context 文件里 `@import` 递归展开（≤5 层、断环） |

### 1.2 上下文管理

| # | 手段 | 源码位置 | 说明 |
|---|---|---|---|
| C1 | **6 种压缩触发路径** | `docs/compaction.md:61-68` + `session/session-maintenance.ts` | 手动 `/compact`、overflow 恢复、incomplete-output 恢复（`stopReason==="length"`）、threshold 维护、mid-turn 维护、idle 维护 |
| C2 | **阈值判定** | `packages/agent/src/compaction/compaction.ts:335-339, 305-307, 360-384` | `shouldCompact`：`contextTokens > thresholdTokens`；reserve = `max(15% window, 16384)`；`keepRecentTokens=20000`；本地估算与 provider 上报取 max 防抑制 |
| C3 | **findCutPoint 不切 toolResult** | `compaction.ts:624-686` | 反向累计到 keepRecentTokens 找最近合法切点，**硬规则：绝不切在 toolResult 上** |
| C4 | **prepareCompaction 边界** | `compaction.ts:1213-1321` | `boundaryStart = prevCompactionIndex + 1`（只压缩上次之后）；split-turn 时被切断的 turn 前缀单独二次摘要 |
| C5 | **压缩后重建顺序** | `session/session-context.ts:406-465` | summary 先行 → firstKeptEntryId 起的 kept messages → compaction 之后条目；TUI 侧 transcript 不折叠 |
| C6 | **压缩前三层裁剪（避免真压缩）** | `session-maintenance.ts:327-352, 367-395` + `compaction/pruning.ts:54-59` | tool-output 裁剪（protect 40k / min saving 20k / min 50 token 不剪）；superseded read 裁剪（旧 read 结果→`[Superseded]`，cache 感知）；useless 结果省略（`[Uneventful result elided]`） |
| C7 | **Shake 机械压缩** | `session-maintenance.ts:460-540` | 不调 LLM，tool result/fenced 块→`[shaken ~N tokens — recover: artifact://...]` 占位符 |
| C8 | **append-only 上下文** | `packages/agent/src/append-only-context.ts:167-309` + `config/append-only-context-mode.ts:54-61` | StablePrefix（system+tools 冻结）+ AppendOnlyLog（消息只增）+ `syncMessages` 逐消息 digest 找**最长字节稳定前缀**，只重发分歧 tail；auto 模式对 deepseek/本地推理(llama.cpp 等)/loopback 自动启用——**最大化 prefix cache 命中** |
| C9 | **workspace-tree 注入** | `workspace-tree.ts:6-10, 89-114, 239-243` + `prompts/system/project-prompt.md:32-42` | maxDepth 3 / perDirLimit 12 / lineCap 120 硬 cap；目录按 mtime 新→旧排；**ageMode "absolute"（绝对 mtime）**——相对时间("9m ago")每次变会 bust 整个前缀缓存 |
| C10 | **snapcompact 快照压缩** | `packages/snapcompact/src/snapcompact.ts:782-913` | 被丢历史序列化后渲染成像素字体 PNG 帧，vision 模型读图（比原文省 billed token）；MAX_FRAMES=80、3MB 预算、按 provider billing 选形状 |

### 1.3 Agent 调度（子代理部分见既有文档）

| # | 手段 | 源码位置 | 说明 |
|---|---|---|---|
| A1 | **yield 协议三态** | `prompts/system/subagent-system-prompt.md:46-58` | 无 type=终态结构化结果；`type: string[]`=增量 section；`type: string`=终态（省略 data 取最后 assistant turn） |
| A2 | **软预算** | `task/executor.ts:99-118, 121-123, 1886-1903` | scout/sonic 100、default 200 次请求；超预算注入 wrap-up 提示，1.5× 强制 yield，5 次宽限后硬杀 |
| A3 | **信号量双保险** | `task/index.ts:628-636, 1336-1341` + `task/provider-concurrency.ts:76-99` | session 级信号量（task.maxConcurrency）+ per-provider 请求级信号量（只包 stream 本身防死锁 #3749） |
| A4 | **批量全量 preflight** | `task/index.ts:696-721` | 任一 item 策略解析失败整批拒绝，绝不部分执行 |
| A5 | **worktree 隔离** | `task/worktree.ts:422-472, 454` | 多后端（APFS/Btrfs/ZFS/overlay/rcopy）；`git.detachGitDir` 切断隔离层 git 元数据共享防并行污染 |
| A6 | **advisor 监督** | `advisor/runtime.ts:412-446, 638-693, 134-202` + `advisor/emission-guard.ts:157-171` + `advisor/advise-tool.ts:116-132, 216-226` | 独立 advisor 模型增量投喂（只送新增消息）、catchup 门控、quarantine 隔离不安全输出（调用未授权工具/生成 rm -rf 类指令整轮替换）、emission-guard 防刷屏（噪声黑名单+文本去重+每轮限 1 条）、severity 排名升级才放行 |

### 1.4 工具调用优化

| # | 手段 | 源码位置 | 说明 |
|---|---|---|---|
| T1 | **read 结构摘要（tree-sitter 折叠）** | `tools/read-summary.ts:37-97, 224-238` + `settings-schema.ts:3331-3354` | ≥100 行才摘要；折叠 ≥4 行函数体/≥6 行注释块；BFS 展开到 **50 行可见**（unfoldUntil），硬上限 **100 行**；**footer 强制引导重读被折叠范围**（≤2 个示例 `file:start-end`）；按内容 hash LRU 缓存 |
| T2 | **range 上下文补齐** | `tools/read-format.ts:253-254` | 范围读自动补 1 前/3 后上下文行防锚点失败 |
| T3 | **apply-patch 分级容错** | `edit/modes/patch.ts:440-578, 585-830, 947-958, 1030-1057, 1302-1317, 1856-1881` | 精确→字符模糊 0.95→放松 0.92→4 级变体（trim-common/dedupe/collapse/single-line）→分层上下文→行号 hint→全文件重搜；Tab↔空格双向换算；**歧义必报错带行预览（绝不猜）**；写后磁盘字节校验；每次降级产生 warning 随结果返回 |
| T4 | **工具描述精简** | `system-prompt.ts:444-481, 456-468` + `config/inline-tool-descriptors-mode.ts:14-25` + `tools/essential-tools.ts:23-35` | compact/full 双投影（原生 tool calling 时 prompt 只列工具名，描述留 provider schema；Gemini 反走内联）；read 描述模板仅 27 行；essential(11 个)/discoverable 两层 |
| T5 | **output schema 校验（子代理）** | `tools/output-schema-validator.ts:66-134, 153-175, 293-307` + `tools/yield.ts:202-307` | JTD/JSON-Schema 归一化；分节增量校验（数组属性按 items schema）；闭合 schema 拒绝未知 label；失败一次给全所有问题（供模型一轮修完）；yield 工具内联校验（MAX_SCHEMA_RETRIES=3） |
| T6 | **dialect 流式解析 + schema 驱动参数解析** | `packages/ai/src/dialect/anthropic.ts:381-424` + `dialect/coercion.ts:10-26` | 流式 XML/JSON 扫描（半开标签恢复）、纯 string 参数按原文不 JSON 双解析 |
| T7 | **保守类型强转** | `packages/ai/src/utils/validation.ts:76-120, 1702` | 数字串/布尔串("yes"/1/"on")/数组串→正确类型，以 schema 校验为准 |
| T8 | **输出分组折叠** | `tools/grouped-file-output.ts:46-86` | grep/ast/LSP 共享目录树折叠，省重复路径 |
| T9 | **artifact spill** | `tools/output-meta.ts:445-491, 673-798, 804-833` | 超阈值结果落盘 artifact，正文 head+tail+`artifact://<id>`；统一 `[Showing lines X-Y of N … Use :N to continue]` notice；每工具包一层 |

### 1.5 记忆机制

| # | 手段 | 源码位置 | 说明 |
|---|---|---|---|
| M1 | **四后端互斥** | `memory-backend/resolve.ts:19-25` | `memory.backend`：off / local / hindsight(远程) / mnemopi(本地引擎) |
| M2 | **local 两阶段后台管线** | `memories/index.ts:123-151, 345-474, 476-601` | 启动时：Phase1 逐会话 rollout→LLM 提取 raw_memory/rollout_summary；Phase2 全局合并→MEMORY.md/memory_summary.md/skills/；SQLite job 队列 + watermark 增量（`storage.ts:55-87`） |
| M3 | **注入预算与缓存** | `memories/index.ts:201-228, 277-294` | memory_summary + learned.md 共享 `summaryInjectionTokenLimit`（5000 tokens）；per-session 缓存；管线完成自动 refreshBaseSystemPrompt |
| M4 | **mnemopi 召回引擎** | `packages/mnemopi/src/core/beam/recall.ts:709-802, 894-1001` + `polyphonic-recall.ts:85` | FTS5 全文 + 向量余弦 + importance + 时域衰减(72h) + veracity 加权 + MMR 重排 + 词覆盖多样化；4 声部 RRF 融合 |
| M5 | **autolearn 自动学习** | `autolearn/controller.ts:47-151` + `autolearn/managed-skills.ts:152-230` | agent_end 时工具调用 ≥5 触发**私有 capture turn**（只暴露 manage_skill/learn 两工具）；可复用流程→managed skill（隔离目录+安全校验），持久事实→learn 写记忆 |

### 1.6 强制思考 / 输出约束 / 后处理

| # | 手段 | 源码位置 | 说明 |
|---|---|---|---|
| S1 | **thinking level→provider effort** | `thinking.ts:17-46, 102-107, 119-130, 247-267` | 纯参数控制不靠 prompt 文本；按模型 clamp；auto 上限 XHigh 只有 ultrathink 能上 Max |
| S2 | **auto-thinking 小模型分类** | `auto-thinking/classifier.ts:87-165, 174-212` + `prompts/system/auto-thinking-difficulty.md` | 每轮用 tiny/smol 模型判断难度→effort；prompt 要求"只回复一个词 low/medium/high/xhigh"；`disableReasoning` + `maxTokens:1024` 防先吐思考；本地 3-bucket 兜底 |
| S3 | **ultrathink 关键词 notice** | `modes/ultrathink.ts:18-30` + `agent-session.ts:5006-5014` | prose 独立词命中→隐藏 custom 消息注入 `<system-notice>` 多步推理提醒 + 提升 effort |
| S4 | **循环/意外停止后处理** | `session/turn-recovery.ts:1928-1946` + `prompts/system/{thinking-loop-redirect,empty-stop-retry,interrupted-thinking,unexpected-stop-classifier}.md` | ThinkingLoop flag 重试注入"不要再复述计划，发最小工具调用"；空停止注入 `[Continue. Attempt #N/M]`；中断保留 reasoning 作为 hidden continuity |
| S5 | **DELIVERY CONTRACT 输出约束** | `system-prompt.md:217-263` | `<contract>`/`<completeness>`/`<evidence-and-output>`/`<yielding>`/`<personality>`/`<critical>`：不 yield、不伪造输出、不偷换问题、不缩水交付、逐条声明证据、标记 `[INFERENCE]` |
| S6 | **approval-mode 6 步裁决** | `docs/approval-mode.md:10-58, 146-148` | 工具 tier(read/write/exec) + 模式(always-ask/write/yolo) + policy(allow/deny/prompt) + override + critical 模式强制询问 + 子代理 headless 强制 yolo |

---

## 2. 对比 pico：当前缺失点与优先级

### 2.1 关键前提（人工核实）

- **pico 上游 `@earendil-works/pi-coding-agent@0.84.0` 已内置基础压缩引擎**（`dist/core/compaction/compaction.js` 644 行）：threshold/overflow/manual 三种触发、`ctx.compact()` API、`SessionBeforeCompactEvent/Result`（支持扩展返回自定义 `CompactionResult`）、`SessionCompactEvent`。→ **压缩差距缩小为"增强级"，不是从零移植**。
- **上游扩展层有 `context` 事件**（`types.d.ts:499-501, 774-777`）：每次 LLM 调用前可 `return { messages }` 修改消息——**扩展层上下文裁剪的可行路径**。
- **上游有 `setThinkingLevel(level)` API**（`types.d.ts:953`）与 `thinking_level_select` 事件——**强制思考扩展层可实现**。
- **上游 read 工具已有截断 notice** `[Truncated: showing X of Y lines]`（`dist/core/tools/read.js:116-125`），但**无结构摘要**（无 tree-sitter 折叠、无 elision footer）。
- **上游无**：append-only 上下文、auto-thinking、advisor、autolearn（pico memory 的 `extract.ts` 是雏形）、yield 协议、magic keywords、workspace-tree 注入、DELIVERY CONTRACT 输出契约文本。
- 上游 pi-agent-core 的 `agent-loop.js` **无 compaction**（grep=0），压缩在 pi-coding-agent 层。

### 2.2 差距清单（🔴 高 / 🟡 中 / 🟢 低）

| # | 差距 | pico 现状 | oh-my-pi 手段 | 优先级 | 说明 |
|---|---|---|---|---|---|
| G1 | **强制思考** | 无；`thinking` 仅作 subagent frontmatter 参数 | S1/S2/S3（thinking level + auto 分类 + ultrathink） | 🔴 | 上游 `setThinkingLevel` 可用；纯扩展层可实现 |
| G2 | **输出约束契约文本** | `vibe-system.md`（213 行）无 DELIVERY CONTRACT/evidence/never 语义 | S5 + system-prompt.md TOOL POLICY | 🔴 | 纯文本资产，零风险低收益比高 |
| G3 | **压缩前工具输出裁剪** | 无；只依赖上游压缩 | C6/C7（prune superseded read / useless elision / shake） | 🔴 | 上游 `context` 事件可改 messages；扩展层可实现 |
| G4 | **read 结构摘要** | 上游 read 只有行截断无折叠 | T1（tree-sitter 折叠 + elision footer） | 🟡 | 上游 read 不可在扩展层替换；需在 subagent 侧或作为补充工具 |
| G5 | **workspace-tree 注入** | 无目录树注入 | C9 | 🟡 | 需上游支持或改 system prompt 组装；扩展层 `before_agent_start` 可 append |
| G6 | **autolearn 自动技能沉淀** | memory `extract.ts` 只提取事实，无技能生成 | M5 | 🟡 | 可用 `agent_end` + 后台子代理实现 |
| G7 | **记忆注入预算/合并遗忘** | 2400 字符预算、无自动合并 | M3（5000 tokens 共享预算 + per-session 缓存）、M4 | 🟡 | 局部可移植 |
| G8 | **advisor 监督** | 无 | A6 | 🟡 | 子进程模型限制大；可降级为"turn_end 后台 reviewer 子代理" |
| G9 | **上下文压缩增强** | 上游基础压缩已内置 | C1-C5 | 🟢 | 上游已有；可加 `/compact` 命令壳 + 自定义指令 |
| G10 | **magic keywords** | 无 | P8 | 🟢 | 与 G1 合并（ultrathink 关键词） |
| G11 | **append-only 上下文** | cache-optimizer 文本级重排（有已知缺陷：拆散 AGENTS.md 包装） | C8（agent-loop 级） | 🟢 | 扩展层不可实现（需 agent-loop 合作）；**参考设计** |
| G12 | **snapcompact** | 无 | C10 | 🟢 | 需 PNG 渲染 + vision；**建议放弃** |
| G13 | **advisor/异步/协作** | 无 | A6/G1-G3（既有文档） | 🟢 | 子进程模型架构差异；**建议放弃**（见既有文档 §4） |

---

## 3. 接入改造方案

### 高优先级（本批次落地）

#### H1：强制思考扩展（G1+G10）
- **实现思路**：新建 `src/extensions/auto-thinking/`。三个子能力：
  1. **ultrathink 关键词**：`before_agent_start` 检测 prompt prose 中独立小写词 `ultrathink`（跳过代码块），命中 → `pi.setThinkingLevel(Effort.Max)` + 注入 `<system-notice>` 多步推理提醒。
  2. **thinking level 快捷指令**：`/thinking <off|low|medium|high|xhigh|max>` 命令 → `setThinkingLevel`。
  3. **auto-thinking 分类器**（可选进阶）：`turn_start`/`before_agent_start` 用主模型带 `disableReasoning` 做一次单字分类（low/medium/high）→ `setThinkingLevel`；失败静默回退不中断 turn（oh-my-pi：分类器失败绝不断 turn）。本地无第二模型时禁用。
- **需要修改的模块**：新建扩展 `src/extensions/auto-thinking/{index,classifier}.ts`；注册进 `src/runtime/extensions.ts`（`auto-thinking` 位置在 `vibe` 之后、`cache-optimizer` 之前）；同步 `tests/auto-thinking.test.ts`。
- **关键配置**：settings 无新项（默认 ultrathink 开、auto 分类关，用环境变量 `PICO_AUTO_THINKING_CLASSIFY` 开启）；thinking 等级可通过子代理 `subagent.json` 已有 `thinking` 字段联动。
- **注意事项**：`setThinkingLevel` 的 Effort 枚举来自 `@earendil-works/pi-ai`（`Effort.Max` 等）；需与上游 ThinkingLevel 类型对齐；ultrathink 只对主 agent 生效，子代理继承父设置。

#### H2：输出约束契约文本（G2）
- **实现思路**：把 oh-my-pi `system-prompt.md:217-263` 的 DELIVERY CONTRACT / evidence-and-output / completeness / critical 语义（去除 oh-my-pi 特有的 yield 部分）改写为 pico 适用的版本，注入 pico 的 `vibe-system.md` 或独立 `src/prompts/delivery-contract.md` 由 `vibe.ts` append。
- **需要修改的模块**：`src/prompts/vibe-system.md`（或新增 `delivery-contract.md` + `vibe.ts` 引入）。
- **注意事项**：保留 pico 现有 vibe 语气；不引入 yield（pico 子进程模型无 yield 工具）；明确"逐条声明证据、标记 [INFERENCE]"。

#### H3：压缩前工具输出裁剪（G3）
- **实现思路**：注册 `context` 事件（每次 LLM 调用前）→ 扫描 messages 中 toolResult，对"同文件后续已有更新 read"的旧 read 结果替换为 `[Superseded by a newer read of this file]`；对超长 toolResult 按阈值截断加 `[truncated]` 标记。完全复用 oh-my-pi C6 的 protect/superseded 语义，但通过 `context` 事件在**发送前**裁剪。
- **需要修改的模块**：新建 `src/extensions/context-pruner/`（或并入 memory 扩展的 pre-compress 逻辑）；注册 `context` 事件。
- **注意事项**：`context` 事件返回 `{ messages }` 会替换发送的消息——必须保留角色顺序与 id 字段兼容性；**保守裁剪**（只替换旧 read 结果，不删 user 消息）；需验证上游 `context` 事件在 toolResult 消息上的消息结构（`AgentMessage` 的 content 为 blocks 数组）。

### 中优先级（后续批次）

#### M1：read 结构摘要补充工具（G4）
- 上游 read 不可覆盖；改为在 **subagent 侧**启用：给 `quick`/`researcher` 等只读子代理 frontmatter 注入"读大文件优先用 `file:start-end` 精确范围"的指导 + 提供 `summarize` 工具（正则折叠：函数体/注释块折叠 + footer 引导）。低成本对齐 T1 的"footer 引导重读"行为。

#### M2：workspace-tree 注入（G5）
- `before_agent_start` 时构建 ≤120 行目录树（绝对 mtime，mtime 新→旧，depth≤3，perDirLimit 12）append 到 system prompt（沿用 cache-optimizer 的 stable 段策略——树放 dynamic 段避免 bust 前缀缓存）。注意与 cache-optimizer 的 `optimizeSystemPrompt` 交互：树含 mtime 会变化，必须放 stablePrefix 之外。

#### M3：autolearn 自动技能沉淀（G6）
- `agent_end` 时若工具调用数 ≥5 且 `PICO_AUTOLEARN_ENABLED` → 后台 spawn `worker` 子代理（只暴露 skill 工具）从 transcript 提取可复用流程写 managed skill。安全校验：路径逃逸/symlink/大小上限（照抄 M5 的 managed-skills.ts:152-230）。

#### M4：记忆注入预算（G7）
- pico memory `prompt.ts` 召回块 2400 字符预算改为与 oh-my-pi 一致的共享 token 预算 + per-session 缓存。

### 建议放弃（架构不匹配）

| 机制 | 原因 |
|---|---|
| append-only 上下文（C8） | 需 agent-loop 层 StablePrefix/AppendOnlyLog/syncMessages 合作，pico 扩展层只能改文本；**唯一可借鉴**：cache-optimizer 不应重排稳定段（AGENTS.md 已知缺陷 #37），应改为"冻结前缀不重排" |
| snapcompact（C10） | 需像素字体 PNG 渲染管线 + vision 模型，成本高收益场景窄 |
| advisor 完整版（A6） | 需独立模型轮询 + 增量投喂 + catchup 门控，pico 子进程模型无进程内多会话；降级方案见 G8 |
| yield 协议/异步/协作（A1/A2/G13） | 子进程模型架构差异（既有文档 §4 已述） |
| dialect 流式解析（T6/T7） | provider 层能力，pico 无 ai 层控制权 |
| capability 框架（P6） | pico 已有 25 扩展注册表，只需借鉴 rule-buckets 三桶思想 |

---

## 4. 风险提示（逐项）

| 改造点 | 移植风险 | oh-my-pi 架构独有、不可照搬的部分 |
|---|---|---|
| H1 强制思考 | `setThinkingLevel` 若在流式轮次中途调用可能不生效（【待确认】上游语义：需在 turn 边界调用）；auto 分类器消耗额外模型请求（成本）；分类 prompt 被模型无视时静默回退 | auto-thinking 的"每轮分类"依赖小模型独立部署；pico 只有主模型时需用主模型带 disableReasoning 降级 |
| H2 输出契约 | 文本过长可能稀释其他指令；与现有 vibe 语气冲突需人工调优 | oh-my-pi 的 yield/steering/plan-mode 专属段落必须删除（pico 无对应机制） |
| H3 上下文裁剪 | `context` 事件替换 messages 若破坏 provider 兼容字段（toolCallId 等）会导致请求 400；裁剪过度损失模型信息 | oh-my-pi 在 agent-core 层做（有完整 entry 模型）；pico 扩展层只能按消息文本启发式匹配（无结构化 entry） |
| M1 read 摘要 | 正则折叠不如 tree-sitter 精确（字符串内 `{` 会误判）；footer 行号在编辑后漂移 | tree-sitter 折叠依赖 Rust native；pico 无 |
| M2 workspace-tree | 树含 mtime 变化 → 若放入 stablePrefix 会 bust 整个前缀缓存（必须放 dynamic 段）；大仓库扫描慢 | ageMode absolute 语义；AGENTS.md 清单（AGENTS_MD_LIMIT） |
| M3 autolearn | 后台子代理成本；误学（把一次性操作当技能）；技能污染（prompt 注入面扩大） | managed skill 目录隔离 + 安全校验；autolearn capture turn 的"私有会话"概念 |
| M4 记忆预算 | token 估算需对齐 pico 上游估算函数（chars/4 启发式） | 无特殊风险 |

---

## 5. 最小验证用例（TUI）

| 改造点 | 验证输入 | 预期结果 |
|---|---|---|
| H1 ultrathink | TUI 输入 `ultrathink 帮我设计这个模块的并发方案` | 启动该 turn 前系统提示出现"multi-step reasoning" notice（可开 `/thinking` 或观察 footer）；`/thinking max` 后 `Esc` 中断再输入普通问题，模型输出变长推理 |
| H2 输出契约 | TUI 输入 `总结当前会话进展` | system prompt 含 DELIVERY CONTRACT 段（可 /doctor 或日志观察）；模型输出带证据声明与 `[INFERENCE]` 标记倾向 |
| H3 上下文裁剪 | 连续两次 `read src/foo.ts`（中间改文件）再让模型继续 | 第二次读后，第一轮的旧 read toolResult 被替换为 `[Superseded...]`（日志/请求 payload 观察） |
| M1 read 摘要 | subagent 让 `researcher` 读一个 500 行文件 | 子代理输出含折叠提示 + `file:start-end` 精确重读 |
| M2 workspace-tree | 启动 pico 于多目录仓库 | system prompt 含 `<workspace-tree>` 目录树（≤120 行，mtime 排序） |
| M3 autolearn | 完成一次 ≥5 次工具调用的任务后查看 `~/.pico/agent/managed-skills/` | 出现新 SKILL.md（若提取到可复用流程） |
| M4 记忆预算 | `/memory` 查看召回结果 | 召回块长度受 token 预算约束（不超限） |

---

## 6. 可移植性分级汇总

| 分级 | 机制 | 说明 |
|---|---|---|
| **可直接移植**（扩展层实现） | H1 强制思考（S1/S2/S3）、H2 输出契约（S5）、H3 上下文裁剪（C6 语义）、M1 read footer 引导、M2 workspace-tree、M3 autolearn、M4 记忆预算 | 上游 ExtensionAPI 均支持（setThinkingLevel / context 事件 / before_agent_start / agent_end / 后台子代理） |
| **仅参考设计思路** | C8 append-only（借鉴"冻结前缀不重排"修正 cache-optimizer 缺陷）、P4 段落去重（可移植）、P6 三桶（简化版）、T3 apply-patch 容错（若 pico 上游 edit 已内置则跳过）、A6 advisor（降级为后台 reviewer） | 需 agent-loop/provider 层能力或成本高，取其思想落地 |
| **建议放弃** | C10 snapcompact、A1/A2/G13 yield/异步/协作、T6/T7 dialect 流式解析、P8 magic keywords 的 orchestrate/workflowz（ultrathink 除外）、capability 框架 | 架构不匹配或 pico 已有等价物 |

---

## 7. 结论

pico 与 oh-my-pi 同属 pi-mono 血统，**上游已内置基础压缩与 read 截断**，差距集中在四类扩展层可实现的能力：**强制思考、输出契约文本、压缩前上下文裁剪、记忆增强**。其中 H1/H2/H3 为高优先级（上游 API 直接支持、验证容易），本批次按序落地；append-only 等 agent-loop 级机制明确放弃，但其中"冻结前缀不重排"的设计思想应反馈给 cache-optimizer 修复其已知缺陷。
