/**
 * guidance extension — offline help that does not require a working model.
 *
 * `/help` command: offline command/keybinding list. Fresh users typing
 * `/help` previously had the text sent to the model (and failed with an
 * API-key error when no provider was configured).
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const HELP_COMMAND_LIST = [
  "pico 命令",
  "  /help      显示本帮助（离线，无需模型）",
  "  /doctor    查看安全开关、能力边界与配置冲突",
  "  /todo      查看/清空任务清单（面板可用 F7 折叠）",
  "  /memory    长期记忆管理（list / add / search / clear 等）",
  "  /plan      进入计划模式（只读调研，ExitPlanMode 请求批准）",
  "  /init      生成或审计 AGENTS.md",
  "  /mcp       查看已连接 MCP 服务器与工具",
  "  /language  查看/切换响应语言（如 /language English）",
  "  /vision    查看辅助视觉模型配置",
  "",
  "上游内置命令",
  "  /model /settings /hotkeys /session /name /export /import /share",
  "  /copy /tree /fork /clone /new /resume /compact /trust /login",
  "  /logout /reload /quit",
  "",
  "快捷键",
  "  /            命令菜单",
  "  !            直接执行 bash（如 !git status）",
  "  F7           todo 面板折叠/展开",
  "  Shift+Tab    切换思考级别",
  "  Ctrl+O       展开被截断的工具调用/结果",
  "  Alt+Up       编辑排队中的消息",
].join("\n");

export function buildHelpText(): string {
  return ["pico 命令与快捷键速查", "", HELP_COMMAND_LIST].join("\n");
}

export const guidanceExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerCommand("help", {
    description: "Show offline command and keybinding help",
    handler: async (_args, ctx) => {
      pi.sendMessage({
        customType: "pico.help",
        content: buildHelpText(),
        display: true,
      });
      void ctx;
    },
  });
  pi.registerCommand("commands", {
    description: "Alias for /help",
    handler: async () => {
      pi.sendMessage({
        customType: "pico.help",
        content: buildHelpText(),
        display: true,
      });
    },
  });
};

export default guidanceExtension;
