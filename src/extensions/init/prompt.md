为当前代码库生成 AGENTS.md。

**并行启动多个探查 agent**，分区域扫描代码库：
- 核心源码与入口
- 构建配置与 CI
- 测试框架与模式
- 脚本与文档（README、现有 AGENTS.md/CLAUDE.md、工具配置）

综合扫描结果，写入最少必要信息。

<structure>
AGENTS.md 只包含 "移除后 pico 会犯错" 的内容：

- **命令与脚本**：构建/测试/lint/运行命令（非标准 flags、顺序、前置步骤）
- **代码约定**：与语言默认值不同的风格（缩进、命名、错误处理、异步模式）
- **仓库礼仪**：分支命名、PR 约定、提交风格、code review 要求
- **环境要求**：必要 env vars、外部服务、本地设置步骤
- **架构决策**：非显而易见的模块边界、弃用路线、设计选择
- **导入内容**：从已有 AI 配置（.cursor/rules、.github/copilot-instructions.md 等）迁移的关键约束

不包含：文件结构列表、标准语言惯例、通用建议。
</structure>

<directives>
- 标题使用 "AGENTS.md"，以标准前缀注释开头。**绝不用 CLAUDE.md。**
- 内容要具体：写明命令、路径和示例。
- 若文件已存在：读取后提具体 diff，不静默覆盖。
</directives>

<output>
分析后在项目根目录写入 AGENTS.md。
</output>
