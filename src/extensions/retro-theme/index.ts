/**
 * retro-theme extension — applies a Claude Code‑inspired warm‑dark colour
 * scheme with purple/orange accents, and customizes the working indicator.
 *
 * Applies the theme on session_start by:
 *   1. Syncing the bundled retro-terminal.json to the custom themes
 *      directory (~/.pico/agent/themes/) so pi's discovery can find it.
 *   2. Calling ctx.ui.setTheme("retro-terminal") which loads it via the
 *      theme discovery system (getCustomThemeInfos → loadThemeJson).
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import retroTheme from "../../theme/retro-terminal.json" with { type: "json" };
import { picoAgentHome } from "../paths.ts";
import { installClaudeLikeFooter } from "./footer.ts";
import { ActivityTracker } from "./activity.ts";

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

  pi.on("session_start", async (_event, ctx) => {
    activity.attach((message) => ctx.ui.setWorkingMessage(message));
    // ── Sync theme to filesystem so discovery finds it ───────────────
    // ctx.ui.setTheme() checks instanceof Theme for objects, but we can
    // only pass a plain JSON import. So we write the file to the custom
    // themes dir (~/.pico/agent/themes/) and load it by name instead.
    // We always overwrite so edits to the JSON are picked up on restart.
    const agentDir =
      process.env.PI_CODING_AGENT_DIR ?? picoAgentHome();
    const themeDir = join(agentDir, "themes");
    try {
      if (!existsSync(themeDir)) {
        mkdirSync(themeDir, { recursive: true });
      }
      writeFileSync(
        join(themeDir, "retro-terminal.json"),
        JSON.stringify(retroTheme, null, 2),
        "utf-8",
      );
    } catch {
      // Unwritable themes dir (permissions / read-only mount / disk full):
      // skip the theme sync instead of aborting the rest of session_start.
      // The theme may still apply from a previously written copy.
    }

    // ── Apply the retro-terminal theme by name ───────────────────────
    // Now the file is in place, pi's loadTheme("retro-terminal") will
    // find it via getCustomThemeInfos scan.
    const result = ctx.ui.setTheme("retro-terminal");
    if (!result.success) {
      // Edge case: first run race with extension init. Retry once.
      ctx.ui.setTheme("retro-terminal");
    }

    // ── Custom working indicator: subtle pulse ───────────────────────
    // A two-frame pulse using the Claude-purple accent.
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
