/**
 * Shared settings.json helpers.
 *
 * pico stores user-level agent settings at ~/.pico/agent/settings.json
 * (or $PICO_HOME/agent/settings.json). Callers should tolerate malformed
 * or missing settings and fall back to safe defaults.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { picoSettingsPath } from "./paths.ts";

export type Settings = Record<string, unknown>;

/** Set when settings.json exists but failed to parse. */
let settingsDamaged = false;

/** True when settings.json exists but is unreadable — writes must be refused. */
export function isSettingsDamaged(): boolean {
  return settingsDamaged;
}

export function readSettings(): Settings {
  try {
    const parsed = JSON.parse(readFileSync(picoSettingsPath(), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settingsDamaged = false;
      return parsed as Settings;
    }
  } catch {
    // Missing or malformed settings should never break startup.
  }
  // Distinguish "file missing" (fresh install) from "file damaged": a
  // read-modify-write path must never silently overwrite a damaged file —
  // that would wipe API keys / safety config permanently.
  try {
    if (existsSync(picoSettingsPath())) settingsDamaged = true;
  } catch {
    // ignore
  }
  return {};
}

export function writeSettings(settings: Settings): void {
  const settingsPath = picoSettingsPath();
  mkdirSync(dirname(settingsPath), { recursive: true });
  // settings.json may hold API keys (env stanza) — never world-readable.
  // { mode: 0o600 } only applies on first creation; a file left at 0644/0664
  // by an older version or a concurrent writer keeps its wide mode, so repair
  // it here (same explicit fix as events.jsonl / input-history.jsonl).
  try {
    const mode = statSync(settingsPath).mode & 0o777;
    if ((mode & 0o077) !== 0) chmodSync(settingsPath, 0o600);
  } catch {
    // File does not exist yet — writeFileSync below creates it with 0o600.
  }
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
