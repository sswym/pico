import type { ExtensionAPI, ExtensionFactory, Theme } from "@earendil-works/pi-coding-agent";
import { installDefaultMode, setCcstyleTheme, clearAllAnimations, type DefaultModeHooks } from "./render.ts";
import { installToolGrouping, type ToolGroupingHooks } from "./grouping.ts";
import { installMouseInteraction, teardownMouseInteraction } from "./mouse.ts";
import { readSettingsObject, writeSettings, readSettings, isSettingsDamaged } from "../settings.ts";

/**
 * ccstyle extension — Claude Code style tool rendering for pico.
 *
 * Ported from pi-cc-extensions (MIT, minuque/pi-cc-extensions v0.8.54) with
 * the full suite trimmed to mode "on": consecutive built-in tool calls group
 * into a collapsible card, each tool renders as a single-line summary with a
 * status icon, and the app.tools.expand keybinding (default ctrl+o) toggles
 * the full Input/Output view. pico's own tools (toolDefinition set) keep
 * their registered renderers.
 *
 * v1 limitations (vs upstream): no compact round summary. The grouping patch
 * only affects tools mounted after install — /ccstyle toggling does not
 * re-render tools already on screen (no TUI handle from the extension API).
 * Mouse click-to-expand and edit/write diff are supported in this port.
 *
 * Config: settings.json `ccstyle.enabled` (default true); /ccstyle on|off.
 */

const CcstyleSettingsKey = "ccstyle";

function readCcstyleEnabled(): boolean {
  const config = readSettingsObject(CcstyleSettingsKey);
  return config.enabled !== false;
}

function saveCcstyleEnabled(enabled: boolean): void {
  if (isSettingsDamaged()) return; // never overwrite a damaged settings.json
  const settings = readSettings();
  const config = readSettingsObject(CcstyleSettingsKey);
  settings[CcstyleSettingsKey] = { ...config, enabled };
  writeSettings(settings);
}

export const ccstyleExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  let enabled = readCcstyleEnabled();
  let installation: { render: DefaultModeHooks; grouping: ToolGroupingHooks } | undefined;

  /**
   * Install the rendering patches on the first TUI context. Non-interactive
   * modes (`-p`, rpc, json) never construct transcript components, so the
   * prototype patches stay dormant there.
   */
  const ensureTuiInstallation = (ctx: { mode: string; hasUI: boolean }): boolean => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return false;
    if (installation) return true;
    // 渲染补丁与分组共用同一个 enabled 闭包：/ccstyle off 或
    // settings.json ccstyle.enabled=false 时补丁完全失效（shouldGloballyStyleTool
    // 与 grouping 的 maybeGroup 都读它），恢复上游原生渲染。
    const render = installDefaultMode(() => enabled);
    const grouping = installToolGrouping(() => enabled);
    installation = { render, grouping };
    return true;
  };

  const syncTheme = (ctx: { ui: { theme?: Theme } }): void => {
    if (!installation || !ctx.ui?.theme) return;
    setCcstyleTheme(ctx.ui.theme);
    installation.grouping.setTheme(ctx.ui.theme);
  };

  pi.registerCommand("ccstyle", {
    description: "Toggle Claude Code style tool rendering",
    getArgumentCompletions: (prefix: string) => {
      const choices = [
        { value: "on", label: "on", description: "Enable Claude Code style tool cards" },
        { value: "off", label: "off", description: "Use Pi's native tool rendering" },
        { value: "status", label: "status", description: "Show the current style mode" },
      ];
      return choices.filter((item) => item.value.startsWith(prefix));
    },
    handler: async (args: string, ctx: { mode: string; hasUI: boolean; ui: { notify(message: string, type?: string): void } }) => {
      const arg = args.trim().toLowerCase();
      if (arg === "status") {
        ctx.ui.notify(`Claude Code style: ${enabled ? "on" : "off"}`, "info");
        return;
      }
      if (arg === "on" || arg === "off") {
        enabled = arg === "on";
        saveCcstyleEnabled(enabled);
        ensureTuiInstallation(ctx);
        // New tool calls respect the mode; already-rendered tools keep their
        // current view until the next updateDisplay (v1 limitation).
        ctx.ui.notify(`Claude Code style: ${enabled ? "on" : "off"}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /ccstyle [on|off|status]", "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ensureTuiInstallation(ctx)) return;
    syncTheme(ctx);
    installMouseInteraction(ctx, () => enabled);
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (!ensureTuiInstallation(ctx)) return;
    syncTheme(ctx);
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    syncTheme(ctx);
  });

  pi.on("session_shutdown", async () => {
    teardownMouseInteraction();
    const current = installation;
    installation = undefined;
    if (!current) return;
    current.grouping.shutdown();
    current.render.shutdown();
    clearAllAnimations();
  });
};
