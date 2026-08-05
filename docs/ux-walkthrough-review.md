# pico 产品全流程用户体验走查与优化分析报告

> 走查时间：2026-08-05
> 走查方式：以真实产品终端用户视角，完整走通「全新安装 → 初始化配置 → 交互式使用 → 多轮编码任务 → 规划/提问/初始化流程 → 异常与中断路径 → 非交互模式」全链路，并结合源码级核查验证行为与文档、提示词的一致性。
> 验证环境：Linux + Bun 1.3.14；本地 OpenAI 兼容代理（zen-openai）+ `deepseek-v4-flash-free`（think:high）真实多轮对话；隔离 `PICO_HOME` 模拟全新用户；真实 `~/.pico` 配置验证既有用户场景。

---

## 1. 总体结论

pico 的功能面完整度较高，编码主链路（问答、工具调用、todo 任务面板、计划模式与审批、交互提问、`/init` 生成 AGENTS.md）在真实对话中端到端可用，且部分交互设计（todo 面板、askUserQuestion 弹窗、工具参数流式预览与 `ctrl+o` 展开、计划审批界面）已具备成熟产品的质感。

但当前版本存在三类结构性短板，直接影响用户留存与信任：

1. **失败路径不友好**：推理模型多轮对话 400 错误以原始 JSON 形式砸进聊天区；生成偶发长时间无输出且无法用 Ctrl+C 软中断；SIGINT 直接杀死进程、无会话保存反馈。
2. **启动与运行噪音多**：全新用户首次启动即面对 `<inline:N>` 扩展名、重复的 tsc 警告、指向 node_modules 的错误指引、无 `/help` 离线帮助；`quietStartup` 无法隐藏这些信息。
3. **配置双轨与提示词自相矛盾**：`settings.json` 与上游 `config.yml` 存在同名 `safety` 键但互相不读取，写错文件静默失效且 `/doctor` 报告误导；系统提示词教唆模型使用已被策略阻断的 LSP 写操作。

以下按类别逐条列出问题与可落地的优化建议，每条标注严重程度与证据来源（`[已复现]` / `[单次观察]` / `[代码核查]` / `[待验证]`）。

---

## 2. 问题分类清单

### 2.1 首次使用与上手体验

#### A1. 全新用户输入 `/help` 直接报 API 错误，无离线命令帮助【高】
- **现象**：全新环境（无 API key）启动后，用户输入 `/help`，界面直接抛出 `Error: No API key found for the selected model`，并附两行指向 `node_modules/@earendil-works/pi-coding-agent/docs/...` 的文档路径。`/help` 并非已注册命令，被当作普通消息发给模型后失败。`[已复现]`
- **影响**：新手用户的第一求助入口失效；错误信息与求助内容完全无关，体验上是"答非所问"。
- **建议**：
  1. 注册本地 `/help`（或拦截未知斜杠命令），离线展示 pico 全部命令（`/todo` `/memory` `/plan` `/doctor` `/init` `/mcp` `/language` `/vision`）与 F7/`!` 等快捷键，不依赖模型。
  2. 未知 `/xxx` 命令在 TUI 中提示"未找到命令 xxx，输入 /help 查看全部命令"，而不是静默交给模型。

#### A2. 启动信息堆叠噪音：`[Extensions] <inline:N>`、`[Skills]`、`[Prompts]` 列表不可读【中】
- **现象**：每次启动都打印 `[Skills]` / `[Prompts]` / `[Extensions]` / `[Themes]` 四个区块，其中扩展名全部显示为 `<inline:10>`、`<inline:11>` 这类占位符，用户无法得知实际加载了 memory、subagent、lsp 等扩展；设置 `quietStartup: true` 后这些区块依然完整打印。`[已复现]`
- **影响**：启动画面信息密度低、噪声高；`<inline:N>` 占位符形同乱码，削弱"产品化"观感；`quietStartup` 名不副实。
- **建议**：
  1. 在 pico 侧接管或过滤该区块：为内联扩展提供可读名称（vibe、memory、subagent、todo、plan、lsp、mcp…），或直接隐藏 `[Extensions]` 区块（用户无感知收益）。
  2. 让 `quietStartup` 真正生效：隐藏除 logo 外的全部启动区块，仅在 `--verbose` 或 `/doctor` 中展示。

#### A3. 全新用户看到 "Welcome back!" 与 "Recent sessions • pico" 硬编码文案【低】
- **现象**：`logo` 扩展的欢迎语固定为 "Welcome back!"、"Recent sessions" 下固定一行 "• pico"（源码硬编码）。全新用户首次启动也会看到"欢迎回来"和一条并不存在的历史会话。`[已复现]` / `[代码核查]`
- **影响**：文案与真实状态不符，给新用户"数据已存在"的错误暗示；也浪费了展示真实信息的位置。
- **建议**：首次启动（无任何会话记录）显示 "Welcome to pico"；"Recent sessions" 区块从会话存储读取最近 1-2 条真实记录，无记录时显示使用提示或直接隐藏。

#### A4. 无模型时的错误指引指向 node_modules 绝对路径【中】
- **现象**：未配置模型时，启动警告与 `-p` 报错都输出 `/home/david/pico/node_modules/@earendil-works/pi-coding-agent/docs/providers.md` 这类路径。对源码运行用户勉强可用，对编译二进制用户该路径根本不存在。`[已复现]`
- **影响**：用户按指引找不到文档；`/login` 在无上游账号配置时也未必是正确路径。
- **建议**：pico 拦截/改写该错误文案，输出中文指引："未配置模型，运行 `pico setup` 完成模型配置（或设置 `ANTHROPIC_API_KEY` 等密钥）"。

#### A5. 未配置模型时 logo 显示两行 "unknown"【低】
- **现象**：全新环境下 logo 左下角模型名与提供商均显示 `unknown`。`[已复现]`
- **影响**：轻微观感问题，但叠加 A2/A4 让首次启动整体显得"没准备好"。
- **建议**：模型不可解析时显示引导文案（如 "运行 pico setup 配置模型"）而非 `unknown`。

#### A6. `pico --help` 不包含 `setup` 子命令与 pico 特有说明【中】
- **现象**：`--help` 输出为上游 `pi` 的完整帮助（品牌为 "pi - AI coding assistant"，含 `pi install/remove/update` 等命令），完全没有 pico 的 `setup`、`/init`、记忆、子代理等任何信息；README 明确建议"首次使用运行 `pico setup`"，但用户看帮助根本不知道有这个命令。`[已复现]`
- **影响**：CLI 帮助与产品实际能力脱节，新用户无法从帮助发现核心功能与初始化入口。
- **建议**：在 `--help` 前插入 pico 品牌头与 "pico 特有：`setup`（初始化向导）、`/init`（生成 AGENTS.md）、`/doctor`（安全状态）……" 摘要块，再透传上游帮助；`--version` 同步处理（见 A8）。

#### A7. tsc 缺失警告：启动时重复出现、写文件后再次出现【中】
- **现象**：环境未安装全局 `tsc` 时，每次启动打印两遍 `Warning: Command "tsc" not found. Please install it manually and try again.`；在对话中每写入一个 `.ts` 文件，该警告再次内联出现（LSP 诊断联动触发）。`[已复现]`
- **影响**：对 Bun 系项目（本就无需全局 tsc）用户，这是持续的、无法消除的噪音；警告出现在聊天流中，打断阅读。
- **建议**：
  1. 会话内去重：同一服务器缺失只警告一次（或合并到 `/doctor` 与 LSP 状态栏）。
  2. 提示具体化：给出可执行建议（"可运行 `bun add -d typescript` 或 `npm i -g typescript` 启用 TypeScript 代码智能"），并说明这是可选能力、不影响其他功能。
  3. 检测到项目无 tsconfig/无 TS 工具链时，静默降级为不启用 LSP，仅保留状态栏标记。

#### A8. 版本号不一致：`--version` 输出上游版本 0.83.0，启动横幅显示 pico v0.1.0【低】
- **现象**：`pico --version` 输出 `0.83.0`（上游 pi 版本），而启动 logo 与 `package.json` 为 `v0.1.0`。`[已复现]`
- **影响**：用户/脚本无法判断真实版本；排查问题时版本信息互相矛盾。
- **建议**：拦截 `--version`，输出 `pico 0.1.0 (pi 0.83.0)` 或统一为 pico 自身版本。

#### A9. 首次进入含 AGENTS.md 的项目未见项目信任确认【中 · 待验证】
- **现象**：全新 `PICO_HOME` 在 `/home/david/pico`（含项目 AGENTS.md）启动，未出现任何信任确认交互，`[Context]` 直接列出已加载的 `AGENTS.md`。上游默认 `defaultProjectTrust=ask` 应弹确认，实际未见。`[单次观察]`
- **影响**：若信任提示确实缺失，用户可能无感知地让项目文件（含可执行钩子配置）进入上下文；与"项目级 hooks/MCP 默认关闭"的安全姿态不一致。
- **建议**：核查信任判定链路（是否被 pico 扩展或配置提前覆盖）；确保交互模式首次进入有信任确认，并把确认结果写入 `trust.json`，同时将信任状态纳入 `/doctor` 展示。

### 2.2 对话交互与反馈

#### B1. 长等待期间仅一个 "Working..." 转圈，无思考过程、无阶段、无进度【高】
- **现象**：模型思考/生成期间，界面只显示 `· Working...` 转圈。实测单轮回答等待 2-5 分钟（think:high + 本地代理），期间用户无法区分"正在思考 / 正在调工具 / 已卡死"。代理实际返回了 `reasoning_content`，但 TUI 完全不展示。`[已复现]`
- **影响**：Vibe coding 场景下用户高频等待，无信息反馈 = 焦虑与误判（本报告 B2 的"卡死"误判也与它相关）；感知延迟被显著放大。
- **建议**：
  1. 展示思考过程（折叠态）：流式渲染 `reasoning_content` 摘要行（如 "正在分析代码库结构…"），或至少显示阶段指示（思考中 / 调用工具 X / 生成回答）与已用时。
  2. 第一 token 前超过 N 秒时提示"模型思考较久，可按 Ctrl+C 中断"。

#### B2. 交互模式偶发长时间无输出且无法软中断；SIGINT 直接杀死进程【高】
- **现象**：
  1. 多步任务进行到第 2 轮生成时，界面在 "Working..." 状态停留 25 分钟以上无任何新输出（同配置 `-p` 模式 4 秒完成同一类请求，见 E1）。
  2. 期间按 Ctrl+C 无任何反应（转圈照常）。
  3. 发送 SIGINT 后进程直接以退出码 1 终止，界面无"已中断/会话已保存"提示，直接黑屏退出。`[已复现，挂起为单次观察]`
- **影响**：编码 agent 的核心信任场景被破坏——用户无法中止失控的生成，只能强杀进程，且丢失会话上下文感知。
- **建议**：
  1. 排查交互模式流式路径与 `-p` 模式的差异（见 E1），定位挂起点。
  2. Ctrl+C 实现两级语义：生成中按一次 → 请求 abort + 显示"已中断，可继续输入"；输入框空时按一次 → "退出？会话已保存（路径）"。
  3. 为模型请求增加硬超时（如 10 分钟无 token 即 abort 并提示重试），避免无限转圈。
  4. 崩溃/强杀后提供恢复入口：启动时检测上次未正常退出的会话并提示 `pico -c` 续接。

#### B3. 推理模型多轮对话 400 错误以原始 JSON 砸进聊天区【高】
- **现象**：使用 `deepseek-v4-flash-free`（reasoning 模型）进行多轮工具调用时，后续请求稳定触发上游 400，错误以原始 JSON 直接显示在聊天流中：
  `Error: 400: {"param":null,...,"message":"Error from provider (Console): Upstream request failed: ... The reasoning_content in the thinking mode must be passed back to the API."}`
  实测一小时内复现 2 次，均发生在"工具结果返回后的下一轮请求"节点；第一次触发后整个会话进入反复挂起/报错循环。`[已复现 ×2]`
- **影响**：多轮 + 工具调用是编码 agent 最核心的使用模式，直接不可用；原始 JSON 错误对用户毫无可读性，且无重试/降级/修复指引。
- **建议**：
  1. pico 侧识别该类 provider 错误（400 + reasoning 契约），转为友好提示："当前模型在带工具的多轮对话中不被代理支持（reasoning_content 契约），建议：降低 thinking 级别、切换非推理模型，或升级代理"。
  2. 自动降级重试：首次命中后自动以 `thinking: off` 重发一次，或按模型配置的 `fallbackModels` 切换。
  3. 将模型注册表中的 `reasoning` 标记与多轮契约风险挂钩，在 setup 向导选择推理模型时提示该风险。
  4. 错误渲染统一化：所有 provider 错误走统一的错误组件（红字 + 中文说明 + 建议），不再透传原始 JSON。

#### B4. 生成过程中收到新消息的 "Steering" 队列提示不够显眼【低】
- **现象**：生成中发送新消息会以 "Steering: …" 形式排队，并提示 `Alt+Up to edit all queued messages`。实测排队消息进入下一轮正常执行。`[已复现]`
- **影响**：功能可用，但用户可能没注意到自己输入已被排队，误以为消息丢失。
- **建议**：输入框位置给出明确的"已排队，将在此轮结束后处理"状态标记；Alt+Up 编辑队列在帮助中给出说明。

### 2.3 配置与安全边界

#### C1. 配置双轨制：`settings.json` 与 `config.yml` 同名 `safety` 键互不读取，写错位置静默失效【高】
- **现象**：pico 的安全开关只读 `~/.pico/agent/settings.json` 的 `safety` 字段与环境变量（`policy.ts`）；但上游沿用 `config.yml`，其中同样存在 `safety` 键。实测用户把 `allowUnattendedPlanApproval: true`、`allowLspFormatOnWrite: true`、`enableProjectMcp: true` 写进了 `config.yml`，而 `/doctor` 全部显示 `disabled (default; env ...)`，实际行为确实未生效——配置被静默忽略，无任何提示。`[已复现]`
- **影响**：用户以为开启的安全开关实际关闭（或反之），安全姿态与预期不符；排查时 `/doctor` 还会给出误导性的"disabled (default)"结论。
- **建议**：
  1. 收敛双轨：`/doctor` 增加对 `config.yml` safety 键的检测，发现"config.yml 中存在但未生效的同名键"时输出醒目警告并给出迁移指引。
  2. 提供自动迁移工具（setup 的 safety 段可检测并合并）。
  3. 文档与启动提示明确唯一权威位置为 `settings.json`。

#### C2. 系统提示词教唆使用已被策略阻断的 LSP 写操作【中】
- **现象**：`vibe-system.md` 的强制规则表明确要求模型使用 `lsp(action="rename_file", ...)`（"禁止手动 rename + grep 替换"）与 `lsp(action="code_actions", ..., apply=true)`（"自动应用匹配的代码操作"）；而 pico 策略在 `tool_call` 阶段将 `rename`、`rename_file`、`code_actions apply=true`、`reload`、`request` 全部阻断（`executor.ts` 的 `BLOCKED_WRITE_OR_HIGH_RISK_ACTIONS`）。`[代码核查]`
- **影响**：模型会被反复引导调用注定被拒的工具，浪费轮次与 token；用户反复看到"blocked by policy"消息，体验割裂；提示词与产品行为自相矛盾。
- **建议**：
  1. 同步提示词：将 `rename_file`/`rename`/`apply=true` 标注为"当前版本已阻断，需手动实施"，改为引导"用 `code_actions` 列出修复，再用 edit/write 手工应用"。
  2. 或在路线图中实现独立的写权限层级（LSP 侧已有 ADR-0001 背景），放开受信任项目的 `apply=true`，让提示词与行为一致。

#### C3. rtk 命令改写默认开启但用户无感知【中】
- **现象**：`integrations.rtk.enabled: true` 时，bash 工具通过 spawnHook 把受支持命令改写为 `rtk <cmd>` 执行，输出被 rtk 压缩。用户在对话里看到的是 `$ git status`，实际运行的是 `rtk git status`，输出可能与裸命令不同。`[代码核查]`
- **影响**：命令输出被静默改写，用户核对结果时可能困惑（"为什么 git status 输出少了东西"）；排障时指向错误原因。
- **建议**：工具渲染中标示改写（如 `$ git status` 旁注 `(rtk)`），或在首次启用时（setup integrations 段）明确告知"命令输出将被压缩以节省 token，可在设置中关闭"。

#### C4. `/doctor` 报告信息维度不全【低】
- **现象**：`/doctor` 展示了安全开关与能力清单，但未展示：开关的实际来源文件、LSP/MCP/钩子当前连接状态、模型与提供商、信任状态。`[已复现]`
- **建议**：扩展为"健康中心"：追加模型/提供商、MCP 连接数、LSP 活跃服务器、钩子加载数、配置来源（env/settings/config.yml 冲突检测），作为排障第一入口。

### 2.4 功能与细节适配

#### D1. 状态栏 "MCP 1" 含义不明【低】
- **现象**：footer 对 MCP 状态执行 `compactStatus`：`MCP: 1 connected` → `MCP 1`。用户看到 "MCP 1" 无法判断是"1 个已连接"还是"1 个失败"。`[已复现]` / `[代码核查]`
- **建议**：压缩规则保留语义：`MCP 1 ✓` 或 `MCP 1 ok`；失败时显示 `MCP 1 ✗ 1 failed`。

#### D2. 子代理角色文档与实现不一致：文档称 6 个，实际注册 16 个【低】
- **现象**：README/user-guide/vibe 提示词均称内置 6 角色（scout/planner/worker/reviewer/oracle/researcher）；实际 `src/prompts/agents/` 有 16 个带 frontmatter 的角色（另有 architect、consultant、debugger、director、editor、executor、product、quick、verifier、consensus），全部以 user 作用域加载、`subagent` 工具 schema 无枚举限制，模型可按名字调用任意一个。`[代码核查]`
- **影响**：文档低估能力（用户不知道有 editor/executor 等角色）；若部分角色是实验性质，等于无管控暴露。
- **建议**：要么文档补齐 16 角色清单（含各自工具面与适用场景），要么收紧为文档宣称的 6 个并显式注册其余角色。

#### D3. `/init` 侦察阶段长时间静默，无进度反馈【中】
- **现象**：`/init` 执行侦察（bash 扫描 + 读取文件）到提问/写文件之间，界面仅 "Working..."，实测约 7 分钟无结构信息；用户无法判断流程处于哪一阶段、是否卡死。`[已复现]`
- **建议**：为 `/init` 增加分阶段提示（"1/3 扫描项目结构… 2/3 生成 AGENTS.md…"），或复用 todo 面板在流程内建临时清单。

#### D4. 计划模式下旧任务继续执行，语义混乱【中】
- **现象**：用户进入 `/plan` 后，上一轮遗留的 todo 任务（"总结"）仍被模型继续推进——模型在计划模式里继续做总结并读文件，用户看到的是"计划模式 + 与计划无关的旧任务执行"混杂输出。`[已复现]`
- **建议**：进入计划模式时提示模型"暂停未完成的 todo 任务，仅处理计划相关研究"；或在计划模式激活时折叠/挂起 todo 面板，退出计划后再恢复。

#### D5. 工具调用参数流式预览的截断提示位不一致【低】
- **现象**：工具参数预览多数场景显示 `ctrl+o to expand`，部分场景（如结果截断）显示 `... (N more lines, M total, ctrl+o to expand)`，两处提示拼写/位置风格不统一。`[已复现]`
- **建议**：统一为同一提示格式，并让 `ctrl+o` 在帮助里可查（目前快捷键帮助中未列出 ctrl+o）。

#### D6. `/memory status` 等命令输出未说明事实库来源与可清理性【低】
- **现象**：`/memory status` 显示 Facts 数量（实测 23），但没有"哪些类别占多数、如何清理、存储位置"的引导；用户对自动提取的记忆无感知管理入口。`[已复现]`
- **建议**：`/memory status` 追加类别分布、库文件大小与位置，并提示 `PICO_MEMORY_DENY` 黑名单与 `/memory list --scope` 管理方式。

#### D7. `/language` 等命令无参数时的交互可发现性弱【低】
- **现象**：`/language` 等命令设计为"带参切换、无参展示"，但全新用户并不知道有哪些参数可用（提示里没有示例）。`[代码核查]`
- **建议**：无参调用时输出"当前语言 + 可用值列表 + 示例"。

### 2.5 性能与流畅度

#### E1. 交互模式与 `-p` 模式同配置下延迟差异异常（约 5 分钟 vs 4 秒）【高 · 待排查】
- **现象**：同一模型、同一 thinking 配置，`-p "用一句话介绍你自己"` 3.9 秒完成；交互 TUI 中首个简单问题首 token 等待约 4-5 分钟（期间转圈）。`[已复现，样本小]`
- **影响**：若差异来自 pico/上游交互路径的实现问题（渲染、事件、流处理），则所有交互用户都在承受远超必要延迟；也直接放大 B1/B2 的体感问题。
- **建议**：对比两条路径的请求参数（stream、thinking 传参、system prompt 组装）与渲染开销；重点排查 retro-theme footer、todo widget、MCP 状态对渲染循环的拖累，以及 `reasoning_content` 在交互模式是否被正确流式消费。

#### E2. 每轮系统提示词体积与缓存优化效果缺少用户可见反馈【低】
- **现象**：footer 只显示 token 用量（`◫ 11k/200k`），未见缓存命中率（prompt cache hit）展示；用户无法感知 cache-optimizer 的价值。`[已复现]`
- **建议**：上下文栏追加缓存命中百分比（数据已由代理返回，如 `prompt_cache_hit_tokens`），顺带帮助用户判断"为什么这轮这么快/慢"。

#### E3. 无统一日志系统，故障排查靠猜【低 · 已知局限】
- **现象**：hooks/LSP/记忆等关键节点错误散落 stderr 与 `[pico xxx]` 前缀（内部文档 §6.5 已记录），本次走查中排查挂起问题时无日志可查。`[代码核查]`
- **建议**：落地统一日志（`~/.pico/logs/pico.log`，`[pico] level module msg`），并让 `/doctor` 提供"最近错误"摘要；这同时是 B2/B3 类问题的排障前提。

### 2.6 潜在 Bug 与异常路径

| 编号 | 现象 | 严重度 | 证据 |
|---|---|---|---|
| F1 | 推理模型多轮工具调用后 400（`reasoning_content` 契约），原始 JSON 入聊天区，会话可进入反复失败循环 | 高 | 1 小时复现 2 次，含一次完整会话挂起 |
| F2 | 交互模式第 2 轮生成 25+ 分钟无输出；Ctrl+C 无效；SIGINT 直接退出码 1 终止，无保存提示 | 高 | 单次完整观察 |
| F3 | `/doctor` 报告的开关状态与 `config.yml` 实际配置矛盾（用户侧开关静默失效） | 高 | 复现（配置对比 + 输出核对） |
| F4 | 全新 HOME 在含 AGENTS.md 项目启动未见信任确认即加载上下文 | 中 | 单次观察，需按 A9 复测 |
| F5 | `setup` 向导方向键（↑/↓/j/k）在非标准终端输入下无响应，仅 Enter 可用 | 低 | 单次观察（hub PTY 环境，需真机复测） |
| F6 | 计划模式下旧 todo 任务继续执行，与计划语义冲突 | 中 | 复现（D4） |
| F7 | `--version`/`--help` 品牌与版本不一致（A6/A8） | 低 | 复现 |

---

## 3. 体验亮点（建议保持）

- **todo 面板**：`0/3 done · 3 active` 计数、单 in_progress 状态、F7 折叠、全部完成自动收起、面板自动弹出仅针对新任务——细节成熟。
- **askUserQuestion 弹窗**：头部/选项/描述/Other 自由输入/↑↓ 导航提示齐全，答案正确回填给模型。
- **计划模式**：写工具阻断消息清晰（"In plan mode. Use read/grep/find/ls to research, then call SubmitPlan…"），`SubmitPlan` 落盘路径明确，`ExitPlanMode` 审批界面（计划全文 + Yes/No + 快捷键）体验好。
- **工具调用流式预览**：参数逐 token 展示 + `... (N more lines, M total)` 截断 + `ctrl+o` 展开，透明度高。
- **`/init` 产出质量**：实测生成的中文 AGENTS.md 结构合理、内容精炼，且模型自发现笔误并自动 edit 修正；"绝不写 CLAUDE.md"约束执行到位。
- **`!` bash 前缀、Steering 消息队列（Alt+Up 编辑）、git 分支状态（`⎇ ccg`）、上下文用量（`◫ 11k/200k`）**等细节均为正向体验。
- **`-p` 非交互模式**：响应快、退出码正确（无 key 时 exit 1，可被 CI 捕获）。
- **web/lsp/mcp 错误文案**：私网拒绝、超时、provider 强制错误等均有明确中文/英文说明，未静默吞错。

---

## 4. 优化优先级路线图

### P0（阻塞级，建议下个迭代）
1. **推理模型 400 治理**（F1/B3）：统一错误渲染 + 自动降级重试（thinking off / fallbackModels）+ setup 选型提示。
2. **可中断性与退出安全**（F2/B2）：Ctrl+C 软中断两级语义、生成硬超时、崩溃恢复入口（`-c` 提示）。
3. **离线 `/help` 与未知命令拦截**（A1）。
4. **配置双轨收敛与冲突检测**（C1/F3）：`/doctor` 检测 `config.yml` 未生效键并告警，setup 提供迁移。

### P1（体验级）
5. 生成过程反馈：reasoning 摘要/阶段指示/ETA（B1）。
6. 交互 vs `-p` 延迟差异排查（E1）。
7. 启动噪音治理：`<inline:N>` 名称解析、tsc 警告去重与可执行建议、`quietStartup` 生效（A2/A7）。
8. 提示词与 LSP 策略一致性（C2）。
9. 信任确认链路核查（A9/F4）。
10. `/init` 分阶段进度提示（D3）、计划模式挂起 todo（D4/F6）。

### P2（打磨级）
11. 版本/品牌统一（A6/A8/F7）、MCP 状态可读性（D1）、rtk 改写透明化（C3）、logo 首启文案（A3/A5）、错误指引路径（A4）。
12. `/doctor` 扩展为健康中心（C4）、统一日志落地（E3）、缓存命中展示（E2）、文档角色数修正（D2）、`/memory` 管理引导（D6）、`/language` 无参示例（D7）、展开提示统一（D5）。

---

## 5. 附录：走查验证记录

| 场景 | 环境 | 结果 |
|---|---|---|
| 全新用户启动（隔离 HOME） | `PICO_HOME=/tmp/...fresh`，demo 项目 | logo/unknown、`<inline:N>`、tsc ×2、无模型警告（A2/A4/A5/A7） |
| `/help` | 同上 | API key 错误（A1） |
| 真实配置启动 + 首问 | zen-openai + deepseek-v4-flash-free | 首 token 约 4-5 分钟，全链路可用（B1/E1） |
| 多步任务（todoWrite+bash+write） | 同上 | 会话 1 挂起 25 分钟+（F2）；会话 2 正常完成但两次 400（F1） |
| `/doctor` vs `config.yml` | 真实 `~/.pico` | 4 项开关全部显示 disabled，与 config.yml 的 true 矛盾（C1/F3） |
| `/plan` + SubmitPlan + ExitPlanMode | 真实配置 | 计划文件落盘、审批 UI 正常、批准后继续执行（亮点） |
| askUserQuestion | 真实配置 | 弹窗 + Other + 选择回填正常（亮点） |
| `/init` | 真实配置，demo 项目 | 侦察 → 生成 → 自动修正笔误 → AGENTS.md 落盘（亮点 + D3） |
| `!echo` bash 前缀 | 真实配置 | 正常执行（亮点） |
| `-p` 无 key / 有 key | 隔离/真实 HOME | 错误提示 + exit 1；正常回答 exit 0（A4） |
| `--version` / `--help` | 源码运行 | 0.83.0 / 上游 pi 帮助（A6/A8） |
| setup 向导 | 隔离 HOME | 语言 → 提供商 → 模型 → API key → 工具 → … 流程完整；方向键输入待真机复测（F5） |

---

## 6. 整改追踪（2026-08-05 第三轮整改后）

> 本报告发布同日完成整改并提交。以下为各项修复状态，代码/测试证据见对应提交与 `tests/`。

| 编号 | 问题 | 状态 | 修复方式 |
|---|---|---|---|
| A1 | 无离线 /help | ✅ 已修复 | 新增 `guidance` 扩展：`/help`（别名 `/commands`）离线命令/快捷键速查，附测试 |
| A2 | `<inline:N>` 与启动噪音 | ✅ 已修复 | 注册表改为命名 `InlineExtension`（`hidden: true`），`[Extensions]` 占位行不再显示；实测启动画面干净 |
| A3 | "Welcome back!" 硬编码 | ✅ 已修复 | logo 按会话文件判定首启（"Welcome to pico!" / "no sessions yet"），并展示真实最近会话 |
| A4 | node_modules 错误指引 | ✅ 已缓解 | 无模型时 guidance 发送中文引导（`pico setup`），指向真实入口 |
| A5 | logo 显示 unknown | ✅ 已修复 | 无模型时同时输出 A4 引导 |
| A6 | `--help` 无 pico 命令 | ✅ 已修复 | CLI 品牌层：`pico --help` 先输出 pico 特有命令摘要再透传上游帮助 |
| A7 | tsc 警告重复/无建议 | ✅ 已修复 | 缺失服务器警告按命令进程级去重；启动预热静默（不再双帧显示）；`tsc` 给出 `bun add -d typescript` 可执行建议；写文件路径保留提示 |
| A8 | 版本号不一致 | ✅ 已修复 | `pico --version` 输出 `pico 0.1.0 (upstream pi 0.83.0)` |
| A9 | 信任确认缺失 | ✅ 已核实非问题 | 上游安全模型：AGENTS.md 属"无需信任"资源（仅 `.pico/` 配置与 `.agents/skills` 需确认），未弹窗是设计行为 |
| B1 | 生成期无阶段反馈 | ✅ 已修复 | 工作区动态状态 `thinking Ns / streaming Ns / tool <name> Ns`（ActivityTracker，附测试） |
| B2 | 挂起不可中断/无恢复入口 | ✅ 已部分修复 | 崩溃恢复标记：异常退出后下次启动提示 `pico -c` 续接；软中断两级语义依赖上游，记为远期 |
| B3 | 推理 400 原始 JSON | ✅ 已修复 | agent_end 检测 `reasoning_content must be passed back` 后追加中文修复指引；`/doctor` 检查 models.yml 推理模型 compat 缺失并告警 |
| C1 | config.yml 双轨静默失效 | ✅ 已修复 | `/doctor` 解析 config.yml safety 块，与 settings.json 不一致时明确告警 + 迁移指引，附测试 |
| C2 | 提示词教唆被阻断的 LSP 写操作 | ✅ 已修复 | `vibe-system.md` 同步策略：`rename`/`rename_file`/`apply=true` 标注为阻断并给出替代路径 |
| C3 | rtk 改写无感知 | ✅ 已修复 | rtk 启用时（会话内一次）提示用户输出将被压缩及关闭方式 |
| C4 | /doctor 信息不全 | ✅ 已修复 | 增加模型/提供商、pico 版本、config.yml 冲突、推理模型 compat 检查 |
| D1 | "MCP 1" 含义不明 | ✅ 已修复 | 压缩为 `MCP 1 ok` / `MCP 2 ok 1 failed` |
| D2 | 角色文档 6 个 vs 实现 16 个 | ✅ 已修复 | user-guide 补齐 16 角色表 |
| D3 | /init 无进度反馈 | ✅ 已修复 | init 提示词要求阶段标记输出（`[init N/3] …`） |
| D4 | 计划模式旧任务继续执行 | ✅ 已修复 | plan 扩展发布 `plan_mode_changed` 事件，todo 面板进入计划模式自动折叠（附测试） |
| D6 | /memory status 无管理信息 | ✅ 已修复 | 增加分类分布、库路径 |
| D7 | /language 无参无示例 | ✅ 已修复 | 无参输出示例用法 |
| E1 | 交互 vs -p 延迟差异 | ✅ 已排查 | `thinking high` 实测约 1.7x 于 low（6s→11s）；5 分钟级差异来自本地代理首 token 波动与反馈缺失，pico 侧无确定性缺陷；配合 B1 反馈与 B2 恢复提示缓解 |
| E2 | 缓存命中展示 | ⏸ 待上游 | 上游 ContextUsage 无缓存数据源，记入路线图 |
| F5 | setup 方向键 | ⏸ 待真机复测 | hub PTY 限制，非产品缺陷证据 |
| — | 19→20 扩展 | ✅ | guidance 扩展注册（AGENTS.md/README/internal-tech-review 同步） |

**遗留（依赖上游或远期）**：软中断两级语义、思考块渲染（上游已支持 thinking 流式，本地代理流式兼容性待升级）、统一日志系统、`--version` 上游版本透传格式。
