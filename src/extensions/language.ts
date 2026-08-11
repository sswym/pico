/**
 * language extension — injects a language directive into the system prompt
 * so the model always replies in the configured language.
 *
 * Reads/writes the `language` field in settings.json (default: "简体中文").
 * Registers a `/language` slash command to view and change the setting.
 *
 * Reuses the shared settings.ts read/write helpers (including the damaged-file
 * guard) instead of maintaining a second private copy that could overwrite a
 * corrupted settings.json with a language-only object.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import languageTemplate from "../prompts/language-system.md" with { type: "text" };
import { isSettingsDamaged, readSettings, writeSettings } from "./settings.ts";

const DEFAULT_LANGUAGE = "简体中文";
const LANGUAGE_MAX_LENGTH = 64;
/** How long the parsed language stays valid before re-reading settings.json. */
const LANGUAGE_CACHE_TTL_MS = 10_000;

// before_agent_start fires on every agent turn — cache the parsed language
// instead of re-reading settings.json from disk each time. The cache is
// refreshed by the /language write path, so changes apply immediately.
let cachedLanguage: string | null = null;
let cachedLanguageAt = 0;

function readLanguage(): string {
  if (cachedLanguage !== null && Date.now() - cachedLanguageAt < LANGUAGE_CACHE_TTL_MS) {
    return cachedLanguage;
  }
  const settings = readSettings();
  const language = typeof settings.language === "string" && settings.language.trim()
    ? settings.language.trim()
    : DEFAULT_LANGUAGE;
  cachedLanguage = language;
  cachedLanguageAt = Date.now();
  return language;
}

/** Test-only hook: drop the cached language so the next read hits disk again. */
export function __resetLanguageCacheForTests(): void {
  cachedLanguage = null;
  cachedLanguageAt = 0;
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
      try {
        const value = args.trim();

        if (!value) {
          ctx.ui.notify(
            `Language: ${readLanguage()}\nChange it with: /language English（或任意语言名）`,
            "info",
          );
          return;
        }

        if (value.length > LANGUAGE_MAX_LENGTH || /[\r\n]/.test(value)) {
          ctx.ui.notify(
            `语言名无效：长度不能超过 ${LANGUAGE_MAX_LENGTH} 字符且不能包含换行。`,
            "error",
          );
          return;
        }

        const settings = readSettings();
        if (isSettingsDamaged()) {
          // Overwriting here would replace the unreadable settings.json with a
          // language-only object, permanently losing env/safety/API keys.
          ctx.ui.notify(
            "settings.json 已损坏（无法解析）。拒绝写入以免覆盖现有配置；请先修复该文件。",
            "error",
          );
          return;
        }

        settings.language = value;
        writeSettings(settings);
        // Keep the cache in sync so the next agent turn sees the new language
        // without waiting out the TTL.
        cachedLanguage = value;
        cachedLanguageAt = Date.now();

        ctx.ui.notify(`Language set to: ${value}`, "info");
      } catch (err) {
        // notify/writeSettings can throw outside the TUI (headless runs) or
        // on disk failure — surface instead of crashing the command loop.
        try {
          ctx.ui.notify(`Failed to set language: ${err instanceof Error ? err.message : String(err)}`, "error");
        } catch {
          // no UI — swallow
        }
      }
    },
  });
};
