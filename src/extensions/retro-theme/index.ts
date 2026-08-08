/**
 * retro-theme extension — applies pico's Claude Code dark colour scheme and
 * customizes the working indicator.
 *
 * Applies the theme on session_start by:
 *   1. Syncing the bundled claude-code-dark.json to the custom themes directory
 *      (~/.pico/agent/themes/) so pi's discovery can find it.
 *   2. Calling ctx.ui.setTheme("claude-code-dark") which loads it via the theme
 *      discovery system (getCustomThemeInfos → loadThemeJson).
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolExecutionStartEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import claudeCodeDarkTheme from "../../theme/claude-code-dark.json" with { type: "json" };
import { friendlyErrorMessage } from "../errors.ts";
import { picoAgentHome } from "../paths.ts";
import { installClaudeLikeFooter } from "./footer.ts";
import { ActivityTracker } from "./activity.ts";

/**
 * True when settings.json contains an explicit theme selection — in that
 * case the user's choice wins and pico must not force its own theme
 * (2.1.1: the upstream setTheme persists, silently overriding /theme picks
 * on every restart).
 */
function userConfiguredTheme(agentDir: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    if (!raw || typeof raw !== "object") return false;
    const settings = raw as Record<string, unknown>;
    if (typeof settings.theme === "string" && settings.theme.trim()) return true;
    const ui = settings.ui;
    if (ui && typeof ui === "object") {
      const theme = (ui as Record<string, unknown>).theme;
      if (typeof theme === "string" && theme.trim()) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export const retroThemeExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  // Generation-phase feedback: replace the bare "Working..." row with a
  // live status (thinking Ns / streaming Ns / tool <name> Ns). Driven by
  // lifecycle events so long silent phases stay self-explanatory.
  const activity = new ActivityTracker();

  pi.on("turn_start", () => activity.beginThinking());
  pi.on("message_update", () => activity.beginStreaming());
  pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => activity.beginTool(event.toolName));
  pi.on("tool_execution_end", () => activity.endTool());
  pi.on("agent_end", () => activity.finish());
  // If a session dies mid-phase (interrupt, crash recovery), agent_end may
  // never fire — reset the tracker so no stale timer/sink leaks into the
  // next session. finish() is idempotent when already idle.
  pi.on("session_shutdown", () => activity.finish());

  // Failed turns (provider 400s, stream failures) used to end with a blank
  // assistant message and the status row simply going idle — the failure was
  // invisible. Surface a notification + a footer marker until the next turn.
  // The notification is deferred to `agent_settled`: upstream auto-retries
  // failed requests (each attempt emits its own turn_end), so notifying on
  // turn_end spammed one "任务失败" toast per retry attempt. agent_settled
  // fires once after the retry cycle settles, so the failure surfaces a
  // single time with the final attempt's error.
  let lastTurnError: { errorMessage: string } | null = null;

  pi.on("turn_end", (event: TurnEndEvent) => {
    const message = event.message as { stopReason?: string; errorMessage?: string };
    // A user-initiated cancel (Esc) ends the turn with stopReason "aborted"
    // (and some providers surface the same cancel as an error result whose
    // message is "Operation aborted") — that is not a task failure and must
    // not render as one.
    if (message?.stopReason === "aborted") {
      lastTurnError = null;
      return;
    }
    if (message?.stopReason !== "error" || !message.errorMessage) {
      lastTurnError = null;
      return;
    }
    if (/aborted/i.test(message.errorMessage)) {
      lastTurnError = null;
      return;
    }
    lastTurnError = { errorMessage: message.errorMessage };
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!lastTurnError) return;
    const errorMessage = lastTurnError.errorMessage;
    lastTurnError = null;
    try {
      ctx.ui.notify(`任务失败：${friendlyErrorMessage(errorMessage)}`, "error");
      ctx.ui.setStatus("pico.lastError", "!failed");
    } catch {
      // notify/setStatus are no-ops when no UI is attached (non-interactive).
    }
  });
  pi.on("turn_start", (_event, ctx) => {
    try {
      ctx.ui.setStatus("pico.lastError", undefined);
    } catch {}
  });
  // A session ending between turn_end and agent_settled must not leak a
  // stale failure into the next session.
  pi.on("session_shutdown", () => {
    lastTurnError = null;
  });

  pi.on("session_start", async (_event, ctx) => {
    activity.attach((message) => ctx.ui.setWorkingMessage(message));
    // ── Sync theme to filesystem so discovery finds it ───────────────
    // ctx.ui.setTheme() checks instanceof Theme for objects, but we can
    // only pass a plain JSON import. So we write the file to the custom
    // themes dir (~/.pico/agent/themes/) and load it by name instead.
    // 2.1.1: only OUR file is overwritten — hand-authored theme files
    // (carbon.json, titanium.json, …) were previously deleted on every
    // startup and the user's theme choice silently overridden.
    const agentDir =
      process.env.PI_CODING_AGENT_DIR ?? picoAgentHome();
    const themeDir = join(agentDir, "themes");
    try {
      if (!existsSync(themeDir)) {
        mkdirSync(themeDir, { recursive: true });
      }
      writeFileSync(
        join(themeDir, "claude-code-dark.json"),
        JSON.stringify(claudeCodeDarkTheme, null, 2),
        "utf-8",
      );
    } catch {
      // Unwritable themes dir (permissions / read-only mount / disk full):
      // skip the theme sync instead of aborting the rest of session_start.
      // The theme may still apply from a previously written copy.
    }

    // ── Apply the Claude Code dark theme by name ──────────────────────
    // Only when the user has NOT configured a theme of their own: the
    // upstream setTheme() persists its choice into settings, so forcing it
    // here would override a deliberate `/theme` selection on every launch.
    if (!userConfiguredTheme(agentDir)) {
      const result = ctx.ui.setTheme("claude-code-dark");
      if (!result.success) {
        // Edge case: first run race with extension init. Retry once.
        ctx.ui.setTheme("claude-code-dark");
      }
    }

    // ── Custom working indicator: subtle pulse ───────────────────────
    // A two-frame pulse using the theme accent.
    ctx.ui.setWorkingIndicator({
      frames: [
        ctx.ui.theme.fg("dim", "·"),
        ctx.ui.theme.fg("accent", "●"),
      ],
      intervalMs: 600,
    });

    installClaudeLikeFooter(ctx, { getThinkingLevel: () => pi.getThinkingLevel() });
  });
};
