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
import AUDIT_PROMPT from "./audit-prompt.md" with { type: "text" };
import GENERATE_PROMPT from "./prompt.md" with { type: "text" };

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
