# pico 深度技术分析报告

> 分析对象：`/home/david/pico`（基于 `@earendil-works/pi-coding-agent` 的 vibe coding agent）
> 规模：src/ 97 个 TS 文件 / 约 2.65 万行，19 个 ExtensionFactory 扩展，27 个测试文件 / 385 用例
> 分析方法：核心模块逐文件精读 + 6 路专项扫描（死代码 / 错误处理 / 资源泄漏 / 性能 / TUI / 健壮性安全）+ 关键声明抽查验证
> 结论基调：整体工程化水平高（多轮审查整改痕迹明显，SSRF 防护、进程组清理、并发控制、prompt 卫生等均已到位）；以下问题为**剩余**缺陷，多数集中在中等及以下等级。

---

## 一、项目概况

### 1.1 定位与架构

pico 是上游 pi-coding-agent 的 thin wrapper：上游提供 agent loop、tool runtime、会话管理，pico 通过 19 个扩展注入产品化能力。入口链：

```
bin/pico.ts → env-bootstrap（副作用，最先导入）→ embedded-runtime 解包
            → args 构建 → setup 分支 → main(args, { extensionFactories })
```

扩展注册顺序（`src/runtime/extensions.ts`，唯一事实来源）：
`vibe → cache-optimizer → todo → retro-theme → language → input-history → logo → memory → subagent → vision → ask → init → plan → web → lsp → rtk → hooks → mcp → doctor`

### 1.2 质量概况（已确认的良好实践）

| 领域 | 已到位的防护 |
|---|---|
| 网络 | webFetch/vision 每跳重定向 + inet_aton 全拼写 IPv4 解析 + 私网拒绝（`fetch.ts` `isPrivateHost`/`parseInetAtonIpv4`） |
| 进程 | 子代理/钩子/MCP 均以独立进程组运行，超时 SIGTERM→SIGKILL 升级，逃逸孙进程有兜底 |
| 递归 | 钩子递归护栏（`PICO_HOOK_RECURSION_GUARD`）与子代理深度护栏（`PICO_SUBAGENT_DEPTH`≥3 拒启）双层 |
| 配置 | settings.json 损坏防护（读-改-写拒绝覆盖）、safety 开关类型校验 + 告警、env 优先 |
| 记忆 | 密钥扫描（`secrets.ts`）、`PICO_MEMORY_DENY` 存储层强制、损坏 DB 备份重建、跨项目所有权门 |
| 会话 | /reload 时 session-scoped 事件订阅清理、plan 模式状态重置、spill 目录会话末清理 |
| 渲染 | `sanitizeTerminalText` 已覆盖大部分工具结果路径、按 code point 截断 |

---

## 二、现存问题清单

> 等级：**高**（直接影响正确性/安全/资源上限）｜**中**（明确缺陷，触发面较广）｜**低**（边缘/体验/规范问题）
> 【待确认】= 静态无法定论，需要运行验证或更多信息

### 2.1 业务功能层面

#### B1 【高】LSP 项目级配置可注入任意启动命令，且无任何确认门
- **位置**：`src/extensions/lsp/config.ts`（`loadConfig` 合并 `<cwd>/.pico/lsp.json`）+ `src/extensions/lsp/manager.ts`（`ensureServer` 预热）
- **现象**：与 hooks（`PICO_ENABLE_PROJECT_HOOKS`）、MCP（`PICO_ENABLE_PROJECT_MCP`）、项目 agents（`confirmProjectAgents` 确认框）不同，LSP 的项目级 `.pico/lsp.json` **没有 opt-in 开关、没有确认框**。配置中的任意 server `command`/`args` 会在 `session_start` 预热（`lsp/index.ts:547-558`）或首次写匹配文件时被直接 spawn。
- **风险影响**：clone 一个恶意仓库后在仓库内启动 pico，恶意 `.pico/lsp.json` 可定义（或覆盖内置 `typescript` 等 server 的）command 为仓库内的可执行文件；`resolveCommand` 还会优先解析项目 `node_modules/.bin/<command>`，恶意仓库可放置同名假二进制。**即"启动即执行任意代码"，无需用户批准**——与 hooks/MCP/agents 的防护级别不对称。
- **触发条件**：在含恶意 `.pico/lsp.json` 的仓库目录运行 pico；预热在 session_start 自动触发。
- **优化建议**：仿照 `PICO_ENABLE_PROJECT_*` 增加 `PICO_ENABLE_PROJECT_LSP`（默认关）或对项目级 server command 弹确认框；至少对非内置 server 的 command 做路径/来源审计并首次启动确认。

#### B2 【中】会话切换后旧 LSP 服务器泄漏残留
- **位置**：`src/extensions/lsp/index.ts`（仅注册 `session_start`/`session_shutdown`，无 `session_before_switch`/`session_before_fork`）；`manager.ts` 的 idle 回收仅在 `state.config.idleTimeoutMs` 配置时启用
- **现象**：`/new`、`/resume`、fork 切换会话时，上一个项目的语言服务器进程不会被关闭；且 `state.config` 首次加载后绑定首个 workspaceRoot，新会话沿用旧项目配置与旧服务器。
- **风险影响**：每个切换过的项目残留一组 LSP 进程（tsserver 等可达数百 MB 内存），长会话多次切换后资源持续累积；新会话的 LSP 行为指向错误的项目根。
- **触发条件**：同一 pico 进程内切换工作目录/会话。
- **优化建议**：在 `session_before_switch`/`session_before_fork` 中 `stopServer(state)` 并按新 cwd 重建；`state.config` 按 workspaceRoot 缓存而非全局单例；默认启用 idle 回收（如 10 分钟）。

#### B3 【中】webFetch 失败语义与代码注释自相矛盾
- **位置**：`src/extensions/web/index.ts:96-97`（注释 "a returned isError flag is dropped by the agent loop"）与 `:105-111`（实际 `return { ..., isError: page.status >= 400 }`）
- **现象**：同一文件内 webSearch 用 `throw new Error` 标记失败，webFetch 却返回 `isError` 字段——而代码注释明确说明该字段会被 agent loop 丢弃（subagent/orchestrator、MCP 扩展均为此专门 throw）。
- **风险影响**：4xx/5xx 抓取会被当作成功工具结果呈现给模型，模型可能把错误页当有效内容使用；与 webSearch 行为不一致。
- **触发条件**：webFetch 命中 404/403/500 等非 2xx 状态。
- **优化建议**：与 webSearch 对齐改为 `throw new Error("webFetch failed: HTTP xxx")`（保留 `details` 中的 status/url 供渲染）。

#### B4 【低】plan 模式工具白名单不含 memory/web 只读工具
- **位置**：`src/extensions/plan/index.ts:34` `PLAN_ALLOWED_TOOLS = ["read","grep","find","ls","EnterPlanMode","SubmitPlan","ExitPlanMode"]`
- **现象**：plan 模式下 `memory`（search/probe/list 等只读动作）、`webSearch`、`lsp` 只读动作一律被 `tool_call` 门拦截。
- **风险影响**：规划阶段的调研能力被不必要地收窄（记忆检索与网页搜索均无副作用），模型被迫用 `read` 重新获取本可秒查的上下文。
- **优化建议**：将明确的只读动作纳入白名单（memory 的 search/probe/list、webSearch），或改为按 `isLspReadonlyInput` 风格做动作级放行。

#### B5 【低】非交互 plan 模式对内存/网页工具的自动放行缺失（与 B4 同源，已含）

#### B6 【低】`memory` 工具 `limit` 参数无上限钳制
- **位置**：`src/extensions/memory/tool.ts`（`limit` 直传 `provider.search`）；`src/extensions/memory/store.ts` 的 SQL 仅钳下限（`Math.max(1, ...)`）
- **现象**：模型可请求 `limit: 100000`，一次检索倾倒全库事实进上下文。
- **风险影响**：token 成本暴涨（自伤型 DoS）；恶意指令诱导下可撑爆上下文。
- **优化建议**：在 tool 层对 limit 钳制（如 1–50），与 `webSearch` 的 `clamp(max_results, 1, 25)` 对齐。

### 2.2 代码与技术实现层面

#### 2.2.1 异常 / 错误处理缺陷

#### E1 【高】输入历史写入失败会吞掉用户消息
- **位置**：`src/extensions/input-history/index.ts:125`（`appendFileSync` 无 try/catch）；`:169-171` onSubmit 包装在 `handler(text)` **之前**调用
- **现象**：历史文件不可写（磁盘满、只读目录、权限变更）时 `appendFileSync` 抛异常，异常发生在用户消息提交回调之前。
- **风险影响**：用户输入被丢弃、TUI 提交流程可能崩溃/失去同步；且没有任何降级（历史写失败本不应影响发送）。
- **触发条件**：`~/.pico/agent/input-history.jsonl` 写入失败。
- **优化建议**：`appendInputHistory` 整体 try/catch（失败仅 console.warn），并将历史写从提交路径移出（fire-and-forget）。

#### E2 【中】全仓库 catch→throw 链丢失原始错误（无 `{ cause }`）
- **位置**：全仓库无一处 `{ cause: err }`；典型：`src/extensions/web/index.ts:113,155`、`src/extensions/vision/index.ts:59`、`src/extensions/mcp/index.ts:338`、`src/extensions/lsp/index.ts:299,328,340,412`、`src/extensions/subagent/orchestrator.ts:420,590`
- **现象**：所有 `catch (e) { throw new Error("...: " + msg) }` 只保留 message，丢失原始堆栈与错误类型。
- **风险影响**：**取消语义被吞掉**——用户中断（AbortError）在 webFetch/vision 被包装成普通失败，上层无法区分"取消"与"出错"；排查问题时堆栈断裂，无法定位源头。
- **触发条件**：任何被二次包装的错误路径。
- **优化建议**：包装处统一 `throw new Error(msg, { cause: err })`；对 AbortError 特殊透传（或直接 re-throw 原错误）。

#### E3 【中】memory DB 迁移错误被静默吞掉
- **位置**：`src/extensions/memory/store.ts:208-216`（`migrate()` 的 `catch {}`，注释声称仅"列已存在"）
- **现象**：迁移 SQL 的任何失败（磁盘错误、约束冲突、schema 损坏）都被静默忽略。
- **风险影响**：DB 停留在旧 schema，后续访问新列的代码在运行期报错，且症状远离根因；迁移永远"看起来成功"。
- **优化建议**：区分幂等错误（`duplicate column name` 等）与真实失败；真实失败应记录并进入 `recoveryNotice` 流程或显式告警。

#### E4 【中】LSP 启动预热 `catch {}` 吞掉非缺失类错误
- **位置**：`src/extensions/lsp/index.ts:557`
- **现象**：`session_start` 预热时 `catch {}` 吞掉一切异常；`COMMAND_NOT_FOUND` 走正常降级，但 spawn 崩溃/初始化失败等非缺失错误也无任何日志。
- **风险影响**：LSP 静默死亡，用户直到显式调用 lsp 工具才看到"no server available"，且看不到根因。
- **优化建议**：catch 中区分 `COMMAND_NOT_FOUND`（静默）与其他错误（console.warn 或 notify 一次）。

#### E5 【中】`/memory` 清理中途失败无部分进度报告
- **位置**：`src/extensions/memory/command.ts:332-335`（project 范围 clear 循环 `manager.remove(...)` 无逐条容错）
- **现象**：循环中某条 remove 抛错（DB 异常）即中止，已删除与未删除各一部分。
- **风险影响**：用户收到"Error"却不知已删了多少条；无回滚。
- **优化建议**：逐条 try/catch 并统计成功/失败数，最终报告"已删 X 条，Y 条失败"。

#### E6 【低】`webFetch` 返回 `isError` 而非 throw（与 B3 同源，见 2.1）

#### E7 【低】hooks 超时路径悬挂未完成的读取 promise
- **位置**：`src/extensions/hooks/runner.ts:194-199`（超时后 `stdoutPromise`/`stderrPromise` 不再 await）
- **现象**：SIGKILL 进程组后管道可能永不 EOF，`readAll` 的 `reader.read()` 永久挂起（promise 泄漏，无内存累积但占用流对象）。
- **优化建议**：超时后对 reader 调用 `cancel()` 主动终止。

#### 2.2.2 资源泄漏 / 生命周期

#### R1 【中】worktree 部分创建失败泄漏（目录 + git 注册）
- **位置**：`src/extensions/subagent/worktree.ts:61-67`（`git worktree add` 成功但随后 `git checkout -b` 失败 → 整个 `createWorktree` 抛错）；`:96-105`（`prepareParallelWorktrees` 只清理**已返回 handle** 的项）
- **现象**：checkout 失败时，`/tmp/pico-worktree-*` 目录与 `.git/worktrees/` 注册条目同时泄漏。
- **触发条件**：分支名非法/冲突、HEAD 异常等导致 `git checkout -b` 失败。
- **优化建议**：`createWorktree` 内 try/catch，失败时主动 `git worktree remove` 清理后 re-throw。

#### R2 【中】内存库损坏备份文件从不清理
- **位置**：`src/extensions/memory/store.ts:187-206`（`_backupCorrupt` 生成 `memory.db.corrupt-<ts>` + WAL/SHM 侧车文件）
- **现象**：每次损坏恢复都会留下备份，无保留策略。
- **风险影响**：长期使用后 `~/.pico/` 堆积无用的损坏备份（含敏感记忆内容，却以宽松权限存在）。
- **优化建议**：参照 curated-store 的 7 天保留策略清理旧备份；备份文件按 0o600 写入。

#### R3 【低】LSP client 通知队列可永久卡住
- **位置**：`src/extensions/lsp/client.ts`（`notifyQueue` FIFO，`stdin.once("drain", resolve)` 无超时）
- **现象**：服务器死亡瞬间若队首通知正等待 drain，且管道随后关闭不触发 drain，则整条 promise 链永久挂起，后续通知闭包堆积。
- **风险影响**：内存微泄漏（闭包累积），且该 client 的后续通知静默失效。
- **优化建议**：drain 等待加超时或监听 `close`/`error` 兜底。

#### R4 【低】footer 的 git 状态缓存 Map 永不清理
- **位置**：`src/extensions/retro-theme/footer.ts`（`cachedGitStatusByCwd`/`pendingGitStatusByCwd` 模块级 Map，按 cwd 键）
- **现象**：会话多次切换目录后条目累积。
- **优化建议**：会话切换时按 cwd 清理旧键，或改用 LRU。

#### R5 【低】逃逸孙进程保持管道（已知设计取舍）
- **位置**：`src/extensions/subagent/process.ts:261-265`（hangTimer 10s 后 resolve 但仍返回 exit code 的兜底）
- **现象**：setsid/nohup 逃逸的子进程后代持续运行，holding pipes。
- **风险影响**：孤儿进程残留（进程组内已 SIGKILL，仅逃逸者存活），工具调用本身不悬挂——属可接受取舍，但值得文档记录。
- **优化建议**：在工具结果中提示用户存在未被终止的后台进程（当前静默）。

#### 2.2.3 性能隐患

#### P1 【中】记忆检索在候选循环内重复计算查询词向量
- **位置**：`src/extensions/memory/retrieval.ts:186-194`（`tokenize(query)` + `expandQuery` + 建 qVec 在 `for (const fact of candidates)` 循环体内）；`store.ts:448/459` 查询词两次展开
- **现象**：查询词的 tokenize + 同义词展开 + TF-IDF 构建不依赖任何 fact，却在每个候选（最多 30 条）内重复执行。
- **风险影响**：每轮 agent 启动的记忆预取（`before_agent_start`）与每次 memory search 都白做 N 倍查询词处理；中文查询尤甚（见 P3）。
- **优化建议**：将查询词向量计算提升到循环外，`store.search` 的两次展开合并为一次。

#### P2 【中】`contradict()` 内层循环重复 tokenize（O(n²)）
- **位置**：`src/extensions/memory/retrieval.ts:424-451`（双循环内对 `f1.content`/`f2.content` 各自 `jaccardTokens`）
- **现象**：500 条事实两两比较时，每条事实的内容被反复 tokenize（约 25 万次调用）。
- **风险影响**：`/memory contradict` 命令在事实库较大时明显卡顿（秒级~十秒级）。
- **优化建议**：先为每条事实预计算 token 集合，再进入双循环。

#### P3 【中】`tokenize` 对每条文本执行 41 次 CJK 术语子串扫描
- **位置**：`src/extensions/memory/tfidf.ts:22-28`（对 `CJK_RETRIEVAL_TERMS` 逐个 `normalized.includes(term)`）
- **现象**：每次 tokenize 都做 41 次全串 `includes`；检索/回退检索路径上对每条候选事实都调用。
- **风险影响**：500 行回退检索（`_fallbackSearch`/`_substringFallback`）累积大量冗余子串扫描。
- **优化建议**：CJK 术语匹配改为一次正则或构建前缀/后缀 Trie；至少在循环外只对查询词做一次。

#### P4 【中】子代理 stdout 流按 chunk 全量重切（O(n²)）
- **位置**：`src/extensions/subagent/process.ts:232-238`（`buffer += text` 后 `buffer.split("\n")` 重切整个累积缓冲）
- **现象**：长会话子代理输出大时，每个 chunk 都重切全部缓冲。
- **风险影响**：大输出（数百 KB）子代理的 JSON 行解析耗时随输出量平方增长。
- **优化建议**：保留未含换行的尾部即可，避免整缓冲重切；或限制 stdout 缓冲上限（类似 stderr 已做 256KB cap）。

#### P5 【中】`before_agent_start` 链每轮同步磁盘 IO
- **位置**：`src/extensions/language.ts:29-33`（每轮 `readSettings()` = `readFileSync` + `JSON.parse`）；`src/extensions/memory/index.ts:254`（每轮 `manager.count()` = SQLite `SELECT COUNT(*)`）；`src/extensions/cache-optimizer/index.ts`（每轮全量重算 stable prefix，无记忆化）
- **现象**：每个用户消息的 agent 启动路径上，多个扩展各自同步读盘/查库/全量字符串处理。
- **风险影响**：交互首 token 延迟叠加；settings.json 较大或处于网络盘时更明显。
- **优化建议**：`language`/`count()` 结果按会话缓存（设置变更时失效）；cache-optimizer 对不变输入记忆化 `stablePrefix`。

#### P6 【低】TUI 重渲染重复 sanitize + preview 大输出
- **位置**：`src/extensions/tool-render.ts`（`renderToolResultText` 每次重渲染重新 `sanitizeTerminalText`（5 次全串正则）+ `previewText`（逐行 `visibleWidth`））；`src/extensions/ui/rendering.ts:19-25`（`truncateWithEllipsis` 对短文本也 `Array.from` 全量分配）
- **风险影响**：MB 级工具输出在流式重渲染时每帧重复消毒/测量，UI 卡顿。
- **优化建议**：按 tool result 的 content 指纹缓存消毒+预览结果；`truncateWithEllipsis` 先判 `text.length <= maxLength` 快速路径。

#### P7 【低】LSP client 每次发送双重 `JSON.stringify`
- **位置**：`src/extensions/lsp/client.ts:603`（`Buffer.byteLength(JSON.stringify(response))` 后再 stringify 一次）
- **优化建议**：stringify 一次，复用结果计算字节长度。

#### P8 【低】子代理调用每次全量重读 agent 清单
- **位置**：`src/extensions/subagent/orchestrator.ts:275`（`discoverAgents(ctx.cwd, agentScope)` 每次调用重读全部 agent .md 并解析 frontmatter）
- **优化建议**：按 (cwd, scope) 缓存 + mtime 失效。

#### P9 【低】webSearch SSE 读取每 chunk 全量重解析（O(n²)）
- **位置**：`src/extensions/web/search.ts:170-197`（`readBodyUntilParsed` 每 chunk 对累积串 `parseExaResponse` 即 `JSON.parse`）
- **优化建议**：增量解析或仅当累积含完整 `data:` 事件边界时解析。

### 2.3 死代码专项清单

> 判定方法：全仓库（src/ + tests/ + bin/）符号引用计数 + tsc `--noUnusedLocals` 交叉验证；仅统计**确认零引用**的符号。
> 已排除：通过 `registerTool`/`registerCommand`/`pi.on` 动态注册的扩展（工具名/命令名是字符串，静态无法确认，见文末【待确认】清单）。

#### D1 确认死代码（导出但零引用，可安全删除）

| # | 位置 | 符号 | 类型 | 说明 |
|---|---|---|---|---|
| D1-1 | `src/extensions/embedded-assets.ts:43` | `isEmbedded` | 函数 | 编译态检测改用 `isBunBinaryRuntime`（embedded-runtime.ts）后遗留 |
| D1-2 | `src/extensions/hooks/config.ts:172` | `HOOK_TIMEOUT_DEFAULT` | 常量 | = `TIMEOUT_DEFAULT` 的冗余别名，无引用 |
| D1-3 | `src/extensions/hooks/config.ts:173` | `HOOK_TIMEOUT_MAX` | 常量 | 无引用 |
| D1-4 | `src/extensions/hooks/runner.ts:213` | `HOOK_TRUNCATE_BYTES` | 常量 | 仅供测试的导出别名，tests 也未引用 |
| D1-5 | `src/extensions/logo/index.ts:143` | `invalidateSessionCacheForTests` | 函数 | 测试钩子，tests 未调用（见 D3 注） |
| D1-6 | `src/extensions/lsp/config.ts:262` | `getAllServersForFile` | 函数 | 被 `getServersForFile`/`getPrimaryServerForFile` 取代 |
| D1-7 | `src/extensions/lsp/edits.ts:68` | `applyWorkspaceEdit` | 函数 | 工作区编辑引擎入口，当前无任何调用点（⚠️ 见 S5：潜伏写原语） |
| D1-8 | `src/extensions/lsp/index.ts:104` | `__resetWarnedMissingCommandsForTests` | 函数 | 测试钩子，tests 未调用 |
| D1-9 | `src/extensions/lsp/install.ts:165` | `resetDetection` | 函数 | 测试钩子，tests 未调用 |
| D1-10 | `src/extensions/lsp/manager.ts:91` | `resetUnsupportedProbeCache` | 函数 | 测试钩子，tests 未调用 |
| D1-11 | `src/extensions/lsp/manager.ts:555` | `ensureServerForFile` | 函数 | 被 `ensureServer`/`syncDocumentForFile` 取代 |
| D1-12 | `src/extensions/lsp/manager.ts:612` | `getServersForFilePath` | 函数 | 无引用 |
| D1-13 | `src/extensions/lsp/types.ts:28` | `JsonRpcMessage` | 类型 | 未使用的协议类型 |
| D1-14 | `src/extensions/lsp/types.ts:166` | `CodeActionKind` | 类型 | 未使用 |
| D1-15 | `src/extensions/lsp/types.ts:255` | `WillRenameFilesParams` | 类型 | 未使用 |
| D1-16 | `src/extensions/lsp/types.ts:259` | `DidRenameFilesParams` | 类型 | 未使用 |
| D1-17 | `src/extensions/lsp/types.ts:263` | `WorkspaceSymbolParams` | 类型 | 未使用（client 用内联结构） |
| D1-18 | `src/extensions/mcp/types.ts:56` | `McpListToolsResult` | 类型 | 未使用 |
| D1-19 | `src/extensions/memory/tfidf.ts:62` | `buildIdfMap` | 函数 | TF-IDF 重构后遗留 |
| D1-20 | `src/extensions/settings.ts:17` | `__resetSettingsDamagedForTests` | 函数 | 测试钩子，tests 未调用 |
| D1-21 | `src/extensions/subagent/agents.ts:360` | `formatAgentList` | 函数 | 被 `summarizeParallelResults`/renderer 取代 |
| D1-22 | `src/extensions/todo/schema.ts:46` | `TodoWriteInput` | 类型 | 未使用 |
| D1-23 | `src/setup/index.ts:1420` | `__resetSetupFilesForTests` | 函数 | 测试钩子，tests 未调用 |
| D1-24 | `src/extensions/tool-render.ts:49` | `collapseLine` | 函数（未导出） | 唯一"未导出且未调用"的内部函数（tsc 亦证实） |

#### D2 未使用的 import / 局部变量（tsc `--noUnusedLocals` 证实，17 处）

`lsp/client.ts:21`（`PublishDiagnosticsParams`）、`lsp/config.ts:303`（sort 比较器参数）、`lsp/edits.ts:70`（`applyWorkspaceEdit` 的 `cwd` 参数，随 D1-7 一起删除）、`lsp/index.ts:21`（`Location`/`Position`）、`lsp/index.ts:27`（`getActiveClients` import）、`lsp/index.ts:150`（`workspaceRoot`）、`lsp/manager.ts:7`（`readdirSync`）、`memory/holographic-provider.ts:12`（`join`）、`memory/holographic-provider.ts:71`（`_sessionId`）、`memory/index.ts:22`（`MemoryWriteMetadata`）、`todo/index.ts:8`（`Type`）、`web/search.ts:170`（`signal` 参数）、`setup/index.ts:710`（`language`）、`setup/index.ts:1085`（`settings`）。

#### D3 【附注】测试钩子未被测试调用的信号

D1-5 / D1-8 / D1-9 / D1-10 / D1-20 / D1-23 均为 `__reset*ForTests` / `invalidate*` 测试钩子，但对应测试文件（lsp.test.ts / setup.test.ts / logo.test.ts / settings 相关）**没有调用它们**。这说明：
1. 这些钩子是死代码；
2. 更值得警惕的是——对应模块的测试间状态隔离可能依赖这些从未调用的重置，意味着相关测试存在隐式状态耦合风险（【待确认】：需逐测试核对是否依赖模块级状态，若依赖则存在测试间污染）。

#### D4 【待确认】动态注册符号（非死代码判定，仅静态不可确认）

以下符号通过字符串注册（`registerTool`/`registerCommand`/`pi.on`/`defaultExtensions` 数组），静态 import 分析无法判定死活，**不视为死代码**：
- 19 个扩展工厂函数（`vibeExtension`…`doctorExtension`，被 `defaultExtensions` 数组引用，存活）
- 所有工具名：`memory`、`lsp`、`webFetch`、`webSearch`、`subagent`、`todo`、`EnterPlanMode`/`SubmitPlan`/`ExitPlanMode`、`visionAnalyze`、`askUserQuestion`、MCP 动态工具 `mcp__<id>__<tool>`
- 所有斜杠命令：`/memory` `/todo` `/plan` `/mcp` `/language` `/doctor` `/help` `/init`
- 事件订阅（`before_agent_start`、`tool_call`、`session_shutdown` 等）
- `ProviderManager.registerMemoryProviderFactory`（`builtin`/`holographic`，可被外部代码注册）
- 各扩展导出的渲染辅助（`renderWebFetchCall` 等，被 index 引用，存活）

#### D5 行为性死代码（函数活着但功能上无效）

- **`stripSessionOverviewChurn`**（`src/extensions/cache-optimizer/index.ts:153-171`）：**仍在被调用**（`:363`），但 `<session-overview>` 标签在整个代码库与上游（含 node_modules 的 pi-agent-core）中**从未被任何 prompt 构建路径生成**，因此函数在真实输入下恒为 no-op。**AGENTS.md 中"stripSessionOverviewChurn 是死代码"的记录已过时**——它从"死代码"变成了"每轮白白多跑一次全串 indexOf 的活代码"。建议：删除函数与调用，并同步更新 AGENTS.md。
- **文档死链**：`README.md:58` 与 `docs/user-guide.md:3` 引用 `docs/pico-intro.md`，实际文件为 `docs/srcode-intro.md`（AGENTS.md 已记录，仍未修）。

### 2.4 前端 / TUI 层面

#### U1 【高】web 扩展渲染未过 `sanitizeTerminalText`
- **位置**：`src/extensions/web/render.ts`（`formatWebFetchDisplay`/`formatWebSearchDisplay` 直接渲染页面内容、搜索标题/URL）；对比 `tool-render.ts` 所有入口均已消毒
- **现象**：webFetch 抓取的页面正文（尤其 `<pre>` 代码块，`fetch.ts:139-141` 原文保留）与 Exa/Tavily 返回的标题/URL 均**未消毒**直达终端。
- **风险影响**：恶意网页/搜索结果可携带 OSC 52 剪贴板劫持、标题篡改、光标控制、假 UI 注入——**恰好是本项目 `sanitizeTerminalText` 要防的向量**。外部可控内容上屏是最关键的消毒场景。
- **触发条件**：模型调用 webFetch 抓取含转义序列的页面，或搜索结果含恶意字段。
- **优化建议**：`formatWebFetchDisplay`/`formatWebSearchDisplay` 内所有 `theme.fg`/Text 内容先过 `sanitizeTerminalText`；为搜索标题/URL 增加统一的消毒辅助函数。

#### U2 【中】子代理渲染未过 `sanitizeTerminalText`
- **位置**：`src/extensions/subagent/renderer.ts`（`r.task`、`item.text`、`finalOutput`、`errorMessage` 等直接进入 Text）
- **现象**：子代理进程回传的 assistant 文本/错误信息（可能来自其内部工具输出如 eslint 彩色报错、读文件内容）未消毒。
- **风险影响**：与 U1 同源（ANSI/OSC 注入），子代理输出中的转义序列直达父终端。
- **优化建议**：renderer 入口处统一消毒；子代理 stderr 已在 `process.ts` 截断但未消毒。

#### U3 【中】LSP 安装失败通知未消毒子进程输出
- **位置**：`src/extensions/lsp/index.ts:191`（`ctx.ui.notify("Installation failed:\n" + result.output)`）
- **现象**：`installServer` 捕获的 npm/包管理器 stdout/stderr（可含 ANSI 彩色）原样进入 notify。
- **优化建议**：notify 前过 `sanitizeTerminalText`。

#### U4 【低】ask 选项预览按 UTF-16 单元截断
- **位置**：`src/extensions/ask/index.ts:82`（`flat.slice(0, PREVIEW_MAX_CHARS)`）
- **现象**：含 emoji（代理对）的选项文本被 `slice` 切断成孤立半代理字符。
- **风险影响**：选项对话框出现 � 乱码。
- **优化建议**：改用 `Array.from(flat).slice(0, N).join("")` 或复用 `truncateWithEllipsis`。

#### U5 【低】plan 确认摘要按 UTF-16 单元截断
- **位置**：`src/extensions/plan/index.ts:204`（`plan.slice(0, MAX_SUMMARY_CHARS)`）
- **现象**：模型写的含 emoji 的 plan 在确认框中被切断成乱码。
- **优化建议**：同上。

#### U6 【低】`sanitizeTerminalText` 漏网双字节转义序列
- **位置**：`src/extensions/ui/rendering.ts:34-47`
- **现象**：`ESC ( B` / `ESC ( 0`（字符集选择）、`ESC 7`/`ESC 8`（保存/恢复光标）等非 OSC/DCS/CSI 序列不被匹配；C0 正则只删 `ESC` 本身，留下 `(B`/`(0` 等字符垃圾。
- **风险影响**：显示层出现 "(B" 等杂字符（低危，因 ESC 已被剥除，无终端驱动能力）。
- **优化建议**：增加 `\x1b[()#=><78DECHMc]\x1b\\?` 类双字节序列剥离（或直接对 `\x1b[\x30-\x3f]` 段做保守清理）。

#### U7 【低】子代理折叠视图无整体行数预算
- **位置**：`src/extensions/subagent/renderer.ts:227`（collapsed 模式 `COLLAPSED_ITEM_COUNT=10` 项 × 每项 3 行，但**单行宽度不限**）
- **现象**：单条 1 万字符的输出行在折叠视图被 TUI 换行成上百行；chain/parallel 折叠视图累计可达数百行。
- **风险影响**：折叠失去意义，小终端上占据整个视口。
- **优化建议**：折叠项内做 `truncateByWidth`，并对整体行数设硬预算（如 40 行）。

#### U8 【低】vision 图片分析期间无进度反馈
- **位置**：`src/extensions/vision/index.ts`（input 事件内异步分析，最长 60s × N 张图）
- **现象**：分析发生在消息提交路径（非工具执行），ActivityTracker 不会显示进度；用户看到"输入无响应"。
- **优化建议**：分析前发一条 `pico.vision.progress` 自定义消息或复用 tool 执行进度通道。

#### U9 【低】logo 头部宽字符歧义可能错位【待确认】
- **位置**：`src/extensions/logo/index.ts`（`visibleWidth` 对 `───` 等制表符的宽度判定依赖终端的 East Asian Ambiguous 处理）
- **现象**：部分 CJK 终端字体将制表符按 2 列渲染，而 `visibleWidth` 按 1 列计算，边框错位。
- **优化建议**【待确认】：在 CJK 终端实测；必要时对边框字符用非歧义宽度字符（`-`）或强制 double-width 假设。

### 2.5 健壮性与安全

> 已验证修复（本轮未发现绕过）：vision `image_url` 每跳 SSRF 检查（`analyze.ts:105-139`）；plan/LSP/hooks 的 `tool_call` 异步阻断门（返回 `{block:true}` 均被上游兑现）；project agents 确认门 + 非交互拒启；settings 损坏写入拒绝；subagent 递归深度护栏。

#### S1 【高】LSP 项目配置无 opt-in 门（与 B1 同源，见 2.1——此为最高优先安全项）

#### S2 【中】LSP FramedReader 无界缓冲
- **位置**：`src/extensions/lsp/client.ts`（`Content-Length` 解析后 `Buffer.concat` 累积至声明的 body 长度，无上限）
- **现象**：声明超大 `Content-Length`（如 `9999999999`）并持续喂数据的服务器可让缓冲无限增长。
- **风险影响**：与 S1 叠加时（恶意项目配置的"服务器"），内存耗尽 DoS；对正常服务器的异常响应同样缺乏保护。
- **优化建议**：对声明长度与已累积缓冲设硬上限（如 64MB），超限直接断开并报错。

#### S3 【中】`allow_private_network` 参数直接暴露给模型
- **位置**：`src/extensions/web/index.ts`（`WebFetchParams.allow_private_network`）+ `fetch.ts:336-338`
- **现象**：模型可自行传 `allow_private_network: true` 绕过私网防护。
- **风险影响**：网页内容中的提示注入可诱导模型开启该参数访问内网/云元数据（169.254.169.254）；当前防护对"模型主动绕过"无效。
- **优化建议**：该参数仅在用户显式确认时生效（如首次触发弹确认），或从工具参数中移除改为 settings 白名单。

#### S4 【中】DNS rebinding 残余（hostname 级校验不验证连接 IP）【待确认可利用性】
- **位置**：`src/extensions/web/fetch.ts:327-340`、`vision/analyze.ts:105-139`
- **现象**：防护基于 `parsed.hostname`，实际连接发生在 Bun.fetch 内部；攻击者可让域名首次解析为公网 IP 通过校验，连接时重绑定到内网。
- **风险影响**：经典 SSRF 变体；对本 CLI 工具实际威胁中等（需要受害者在 pico 中主动抓取恶意域名）。
- **优化建议**【待确认】：如需彻底防护，先用 DNS 解析结果比对 IP 再连接；或接受现状并文档化。

#### S5 【低】`applyWorkspaceEdit` 无工作区包含校验（当前为死代码，潜伏风险）
- **位置**：`src/extensions/lsp/edits.ts:68-`（`uriToPath` 后直接 read/write/rename/delete）
- **现象**：D1-7 确认其当前无调用点，但一旦接入（如开放 rename/apply 动作），服务器返回的 `file://` URI 可指向工作区外任意路径。
- **优化建议**：接入前必须增加 `pathWithinWorkspace` 校验（对齐上游对 read-only LSP 的边界约束）；当前建议直接删除或标注 FIXME。

#### S6 【低】vision `image_path` 无目录包含限制
- **位置**：`src/extensions/vision/analyze.ts:193`（`resolve(cwd, path)` 无边界校验）
- **现象**：模型可读取 cwd 外任意文件（`../`、绝对路径）并 base64 后送外部 vision API。
- **风险影响**：与模型已有的 read 能力相当，但将文件内容定向外发到第三方 API；低危但值得加边界（读取限制在 cwd 内，或需用户确认）。

#### S7 【低】MCP 服务器原始输出进入 `/mcp` 诊断
- **位置**：`src/extensions/mcp/client.ts:137`（`processBuffer` 解析失败时将原始行 append 到 diagnostics，`mcp/index.ts:108-114` 上屏）
- **风险影响**：故障服务器的输出（可能含环境变量/密钥回显）出现在诊断视图。
- **优化建议**：诊断输出截断 + 密钥掩码（复用 `scanSecrets`）。

#### S8 【低】acceptance evidence 命令数量无上限
- **位置**：`src/extensions/subagent/gates.ts`（`evidence` 数组遍历执行，无条数钳制）
- **现象**：恶意 agent frontmatter 声明数千条 evidence 命令（每条最长 60s）→ 验收门长时间阻塞。
- **风险影响**：DoS（self-inflicted 为主，project agents 已有确认门）；仍建议对 evidence 条数与总时长设上限（如 20 条 / 5 分钟）。

#### S9 【低】链式任务的 `reads` 文件读取无路径边界
- **位置**：`src/extensions/subagent/chain.ts:43` + `orchestrator.ts:362`（`fs.readFileSync(filePath)`）
- **现象**：chain 步骤的 `reads` 数组可指向任意绝对路径，内容注入子代理 prompt。
- **风险影响**：与模型已有 read 能力等价，非越权；但内容进子代理上下文前无 size cap 之外的限制。
- **优化建议**：非必要不调整；如追求一致可限制在 cwd 内。

#### S10 【低】`PICO_MEMORY_DENY` 每写读 env（性能微损，非安全）——并入 P 类，不单列

---

## 三、整体优化方向

按投入产出比排序：

1. **安全缺口收敛（最高优先）**
   - S1/B1：为项目级 LSP 配置补 opt-in 门或确认框，与 hooks/MCP/agents 对齐；
   - U1：web 渲染消毒（外部内容上屏，直接补上 `sanitizeTerminalText`）；
   - S2：LSP FramedReader 缓冲上限；
   - S3：`allow_private_network` 增加用户确认层。

2. **错误语义治理**
   - 全仓库统一 `{ cause: err }` 包装；AbortError 透传；
   - E1 输入历史写失败与提交解耦；E3 迁移错误区分幂等/真实失败。

3. **资源生命周期补齐**
   - B2 LSP 会话切换清理 + 按 workspaceRoot 缓存 config；
   - R1 worktree 失败路径清理；R2 记忆备份保留策略。

4. **性能热路径优化**
   - P1/P2/P3 记忆检索循环不变量提升（收益最大：每轮 agent 启动都会触发）；
   - P4 子代理 stdout 增量行解析；P5 `before_agent_start` 链缓存化。

5. **死代码清理（低风险、快收益）**
   - 按 D1 清单（23 项）删除，预计净减 ~600 行；
   - D5 删除 `stripSessionOverviewChurn` 调用并修正 AGENTS.md 过时记录；
   - 同步修复 README 死链（`pico-intro.md` → `srcode-intro.md`）；
   - 补齐 D3 中未被调用的测试重置钩子（或删除并核对测试隔离）。

6. **前端体验**
   - U7 折叠视图行数硬预算；U8 vision 进度反馈；U4/U5 截断改 code point。

---

## 四、总结

pico 在工程纪律上明显高于同类 agent 项目：SSRF 防护（inet_aton 全拼写解析、逐跳重定向校验）、进程组生命周期管理、递归护栏、配置损坏防护、密钥扫描、事件订阅生命周期管理、每轮审查整改留下的注释式决策记录，都是高质量实践。

剩余问题的集中区域：

- **安全侧**最大不对称在 **LSP 项目配置缺少 opt-in 门**（S1/B1）——项目可注入启动命令而无需任何批准，与 hooks/MCP/agents 的防护级别不一致；
- **前端侧**最直接的缺口是 **web/子代理渲染未消毒**（U1/U2），恰好绕过本项目自己建立的终端安全防线；
- **工程侧**以**循环内重复计算**（记忆检索 P1-P3）与**错误链丢失 cause**（E2）为系统性问题；
- **死代码**共确认 23 项导出符号 + 17 处未用 import/局部量 + 1 处行为性死代码，均可安全清理，无争议点。

按"先安全（S1/U1/S2/S3）→ 再语义（cause/E1）→ 后性能（P1-P5）→ 随手清死代码"的顺序推进，即可在不改动架构的前提下完成一轮高质量的健壮性提升。

---

## 附录：待确认事项汇总

| 项 | 内容 | 需要的验证 |
|---|---|---|
| D3 | 未调用的测试重置钩子是否意味着相关测试存在状态耦合 | 逐测试核对模块级状态依赖 |
| U9 | logo 边框在 CJK 终端（Ambiguous width）是否错位 | CJK 终端实测 |
| S4 | DNS rebinding 是否构成实际可利用面 | 评估威胁模型（本地 CLI） |
| B4/B5 | plan 模式只读工具白名单放宽的预期收益 | 产品决策 |
| R5 | 逃逸孙进程是否需要用户可见提示 | 产品决策 |
