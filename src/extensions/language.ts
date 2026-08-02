/**
 * language extension — injects a language directive into the system prompt
 * so the model always replies in the configured language.
 *
 * Reads/writes the `language` field in settings.json (default: "简体中文").
 * Registers a `/language` slash command to view and change the setting.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import languageTemplate from "../prompts/language-system.md" with { type: "text" };
import { srcodeSettingsPath } from "./paths.ts";

const DEFAULT_LANGUAGE = "简体中文";

function getSettingsPath(): string {
  return srcodeSettingsPath();
}

function readSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(getSettingsPath(), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // missing or malformed settings -> defaults
  }
  return {};
}

function writeSettings(settings: Record<string, unknown>): void {
  const settingsPath = getSettingsPath();
  mkdirSync(dirname(settingsPath), { recursive: true });
  // Same protection as settings.ts: this file may carry API keys.
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

function readLanguage(): string {
  const settings = readSettings();
  if (typeof settings.language === "string" && settings.language.trim()) {
    return settings.language.trim();
  }
  return DEFAULT_LANGUAGE;
}

export const languageExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  // --- system prompt injection ---
  pi.on("before_agent_start", (event) => {
    const base = event.systemPrompt ?? "";
    const guide = languageTemplate.replace("{language}", readLanguage());
    return { systemPrompt: `${base}\n\n${guide}` };
  });

  // --- /language command ---
  pi.registerCommand("language", {
    description: "Show or change the response language (e.g. /language English)",
    handler: async (args, ctx) => {
      const value = args.trim();

      if (!value) {
        ctx.ui.notify(`Language: ${readLanguage()}`, "info");
        return;
      }

      const settings = readSettings();
      settings.language = value;
      writeSettings(settings);

      ctx.ui.notify(`Language set to: ${value}`, "info");
    },
  });
};
