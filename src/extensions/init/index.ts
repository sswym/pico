/**
 * pico init extension.
 *
 * Registers a single `/init` slash command that handles both cases:
 *   - No AGENTS.md → injects a prompt to parallel-scan the codebase and write one
 *   - AGENTS.md exists → injects audit instructions to check for drift and
 *     propose targeted edits (never overwrites without confirmation)
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import GENERATE_PROMPT from "./prompt.md" with { type: "text" };
const AUDIT_PROMPT = `AGENTS.md 已存在，正在审计。

请执行以下步骤：

1. 读取完整的 AGENTS.md
2. 对照当前代码库逐项校验：
   - 构建/测试/lint 命令是否与 package.json 等配置一致
   - 目录结构描述是否匹配实际
   - 风格约定是否与最新代码一致
   - 工具链描述（Bun/Node、包管理器等）是否准确
3. 识别 AGENTS.md 未覆盖的重要领域（新扩展、新命令、新技能等）
4. 以 numbered list 提出修改建议，每条包含：
   - **位置**：AGENTS.md 中的章节标题或行号
   - **原因**：不匹配或遗漏
   - **建议改动**：精确的替换文本

**绝不覆盖 AGENTS.md**。等待用户确认后再修改。`;

export const initExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerCommand("init", {
    description:
      "Initialize AGENTS.md for a new project, or audit and update an existing one",
    handler: async (_args, ctx) => {
      const agentsMdPath = resolve(ctx.cwd, "AGENTS.md");
      if (existsSync(agentsMdPath)) {
        // Code-level gate before an audit that may propose edits to a file
        // the user cares about. The prompt-level "never overwrite" rule is
        // reinforced here with an explicit confirmation.
        if (ctx.hasUI) {
          let approved = false;
          try {
            approved = await ctx.ui.confirm(
              "审计 AGENTS.md？",
              "模型将对照代码库校验 AGENTS.md 并提出修改建议；任何实际改动前你仍会看到并确认。",
            );
          } catch {
            approved = false;
          }
          if (!approved) {
            try { ctx.ui.notify("已取消 /init 审计。", "info"); } catch {}
            return;
          }
        }
        pi.sendUserMessage(AUDIT_PROMPT);
      } else {
        pi.sendUserMessage(GENERATE_PROMPT);
      }
    },
  });
};
