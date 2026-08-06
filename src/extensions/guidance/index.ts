/**
 * guidance extension — offline help, first-run guidance, and failure
 * recovery hints that do not require a working model.
 *
 * 1. `/help` command: offline command/keybinding list. Fresh users typing
 *    `/help` previously had the text sent to the model (and failed with an
 *    API-key error when no provider was configured).
 * 2. No-model guidance: when an interactive session starts without a
 *    resolvable model, send one Chinese onboarding message with the actual
 *    setup path (`pico setup`) instead of leaving only the upstream warning
 *    that points into node_modules.
 * 3. Provider-error guidance: when a turn fails with the known
 *    "reasoning_content must be passed back" 400 (deepseek-style reasoning
 *    contracts over OpenAI-compatible proxies), show a friendly explanation
 *    plus the exact fix steps. The raw upstream error stays in the
 *    transcript; this adds the "what do I do now" part.
 * 4. Crash-recovery marker: a marker file tracks the active session; a
 *    clean quit removes it, so a leftover marker on the next startup means
 *    the previous session ended abnormally (SIGKILL/crash) — suggest
 *    `pico -c` to resume.
 *
 * Guidance is rendered through appendEntry() + registerEntryRenderer(), a
 * display-only channel that never enters the LLM context. (sendMessage()
 * would push the text into agent.state.messages, where convertToLlm() turns
 * it into a user message — the model then treats the hint as a task and
 * starts "fixing" things on its own.)
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionFactory, Theme } from "@earendil-works/pi-coding-agent";
import { picoHome, picoModelsPath, picoSettingsPath } from "../paths.ts";

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

const REASONING_400_PATTERN = /reasoning_content[^\n]{0,120}passed back/i;

export function isReasoningContractError(text: string): boolean {
  return REASONING_400_PATTERN.test(text);
}

export function buildReasoningErrorGuidance(): string {
  return [
    "检测到推理模型的多轮对话被代理拒绝：当前提供商要求把上一轮的 reasoning_content 原样带回，",
    "但本地代理未满足该契约（上游 400）。建议按顺序尝试：",
    "  1. 降低思考级别（Shift+Tab 切到 off/minimal）后重试该轮；",
    `  2. 在 ${picoModelsPath()} 中对应模型（或 provider）的 compat 中加入`,
    "     requiresReasoningContentOnAssistantMessages: true（若代理仍拒绝，请升级代理）；",
    "  3. 切换到非推理模型（/model）。",
    "详情见 docs/user-guide.md「模型与提供商」章节。",
  ].join("\n");
}

export function buildNoModelGuidance(): string {
  return [
    "当前没有可用的模型配置。首次使用请运行：",
    "  pico setup     —— 交互式向导（模型/工具/安全/界面等）",
    `或手动编辑 ${picoSettingsPath()} 与 ${picoModelsPath()}。`,
    "配置完成后重启 pico 即可开始。",
  ].join("\n");
}

export function buildCrashResumeHint(previous: { sessionId?: string; cwd?: string }): string {
  const lines = [
    "检测到上次会话未正常退出（可能被强制终止）。",
  ];
  if (previous.sessionId) {
    lines.push(`  续接会话：pico -c（或 pico -r 选择会话）`);
  }
  if (previous.cwd) {
    lines.push(`  上次工作目录：${previous.cwd}`);
  }
  return lines.join("\n");
}

/**
 * Renders a `pico.guidance` entry in the TUI transcript, using the same box
 * style as custom messages. Returns undefined for empty/non-string data.
 */
export function renderGuidanceEntry(
  entry: { customType: string; data?: unknown },
  _options: { expanded: boolean },
  theme: Theme,
): Component | undefined {
  if (typeof entry.data !== "string" || entry.data.length === 0) return undefined;
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m[${entry.customType}]\x1b[22m`), 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(
    new Markdown(entry.data, 0, 0, getMarkdownTheme(), {
      color: (text) => theme.fg("customMessageText", text),
    }),
  );
  return box;
}

function markerPath(): string {
  return join(picoHome(), "last-session.json");
}

interface LastSessionMarker {
  sessionId?: string;
  cwd?: string;
  timestamp?: number;
  pid?: number;
}

function readMarker(): LastSessionMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(), "utf-8")) as LastSessionMarker;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Missing or malformed marker: treat as absent.
  }
  return null;
}

/**
 * A marker written by the CURRENT process (a session switch inside one
 * run, e.g. /new or resume) is not a crash — only a marker left by an
 * earlier process counts. With multiple pico instances sharing one
 * PICO_HOME, a concurrent instance's marker must also not read as a crash:
 * probe whether the writing process is still alive first.
 */
function isStaleMarker(marker: LastSessionMarker): boolean {
  if (marker.pid === process.pid) return false;
  if (marker.pid !== undefined) {
    try {
      // Signal 0 is a permission-free liveness probe.
      process.kill(marker.pid, 0);
      // Alive → another instance is running, not a crash.
      return false;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EPERM") return false; // exists but owned by another user
      // ESRCH → the writer is gone → stale marker.
    }
  }
  return true;
}

function writeMarker(marker: LastSessionMarker): void {
  try {
    const path = markerPath();
    mkdirSync(picoHome(), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...marker, pid: process.pid }), "utf-8");
  } catch {
    // Unwritable home should never break startup.
  }
}

function clearMarker(): void {
  try {
    rmSync(markerPath(), { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

function extractMessageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = block as { type?: string; text?: string };
        if (typeof b?.text === "string") return b.text;
        return "";
      })
      .join("\n");
  }
  return "";
}

export const guidanceExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  let noModelHintShown = false;
  let reasoningHintShown = false;
  let crashHintShown = false;

  pi.registerEntryRenderer("pico.guidance", renderGuidanceEntry);

  // ---- /help -----------------------------------------------------------
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

  // ---- crash recovery marker + no-model guidance -----------------------
  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const previous = readMarker();

    if (previous && isStaleMarker(previous) && !crashHintShown && ctx.hasUI) {
      crashHintShown = true;
      pi.appendEntry("pico.guidance", buildCrashResumeHint(previous));
    }

    writeMarker({ sessionId, cwd: ctx.cwd, timestamp: Date.now() });

    if (!ctx.model && !noModelHintShown && ctx.hasUI) {
      noModelHintShown = true;
      pi.appendEntry("pico.guidance", buildNoModelGuidance());
    }
  });

  // A clean quit clears the marker — but only when it is OUR marker: another
  // concurrent instance's marker must survive this instance's quit.
  pi.on("session_shutdown", (event) => {
    if (event.reason !== "quit") return;
    const marker = readMarker();
    if (marker?.pid === process.pid) clearMarker();
  });

  // ---- provider contract error guidance --------------------------------
  pi.on("agent_end", (event) => {
    if (reasoningHintShown) return;
    const messages = (event.messages ?? []) as unknown[];
    const found = messages.some((message) => isReasoningContractError(extractMessageText(message)));
    if (!found) return;
    reasoningHintShown = true;
    pi.appendEntry("pico.guidance", buildReasoningErrorGuidance());
  });
};

export default guidanceExtension;
