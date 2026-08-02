/**
 * Shared settings.json helpers.
 *
 * srcode stores user-level agent settings at ~/.srcode/agent/settings.json
 * (or $SRCODE_HOME/agent/settings.json). Callers should tolerate malformed
 * or missing settings and fall back to safe defaults.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { srcodeSettingsPath } from "./paths.ts";

export type Settings = Record<string, unknown>;

export function readSettings(): Settings {
  try {
    const parsed = JSON.parse(readFileSync(srcodeSettingsPath(), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Settings;
    }
  } catch {
    // Missing or malformed settings should never break startup.
  }
  return {};
}

export function writeSettings(settings: Settings): void {
  const settingsPath = srcodeSettingsPath();
  mkdirSync(dirname(settingsPath), { recursive: true });
  // settings.json may hold API keys (env stanza) — never world-readable.
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

export function readSettingsObject(key: string): Record<string, unknown> {
  const settings = readSettings();
  const value = settings[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
