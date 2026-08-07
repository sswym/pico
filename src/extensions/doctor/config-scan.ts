/**
 * doctor config scanning — detect the "dual config" trap.
 *
 * pico's safety switches are read ONLY from ~/.pico/agent/settings.json
 * (`safety` field) plus environment variables. Upstream pi still accepts a
 * legacy `config.yml` that carries the same-looking `safety` keys; users
 * who write the flags there get silent no-ops. This module parses the
 * YAML subset that matters (indented `key: value` maps) and reports keys
 * that are present in config.yml but NOT effective in pico.
 *
 * It also scans models.json for reasoning models whose provider compat
 * lacks `requiresReasoningContentOnAssistantMessages` — the known
 * precondition for "reasoning_content must be passed back" 400s from
 * deepseek-style OpenAI-compatible proxies.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { picoAgentHome, picoModelsPath } from "../paths.ts";
import { readSettings, readSettingsObject } from "../settings.ts";

export const SAFETY_KEYS = [
  "allowUnattendedPlanApproval",
  "allowLspFormatOnWrite",
  "enableProjectHooks",
  "enableProjectMcp",
] as const;

export type SafetyKey = (typeof SAFETY_KEYS)[number];

export interface ConfigYmlSafetyConflict {
  key: SafetyKey;
  configYmlValue: boolean;
  effectiveValue: boolean;
}

/**
 * Parse a `safety:` block out of a config.yml-style document (indentation
 * based, no quotes, no nested lists). Returns null when no safety block
 * exists; unknown keys are ignored.
 */
export function parseConfigYmlSafetyBlock(raw: string): Partial<Record<SafetyKey, boolean>> | null {
  const lines = raw.split("\n");
  let inBlock = false;
  const result: Partial<Record<SafetyKey, boolean>> = {};
  let sawAny = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!inBlock) {
      const match = /^safety\s*:\s*(.*)$/.exec(line);
      if (!match) continue;
      inBlock = true;
      const inline = match[1]?.trim() ?? "";
      // `safety: ` with nothing after: block form. Anything else (e.g.
      // `safety: {}` or a scalar) is not the block we parse.
      if (inline.length === 0) continue;
      if (inline === "{}") return {};
      return null;
    }

    // Block form: children are indented relative to `safety:`. A
    // non-indented non-comment line ends the block.
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;

    const match = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1] as SafetyKey;
    if (!(SAFETY_KEYS as readonly string[]).includes(key)) continue;
    const value = match[2]?.trim();
    if (value === "true") {
      result[key] = true;
      sawAny = true;
    } else if (value === "false") {
      result[key] = false;
      sawAny = true;
    }
  }

  return sawAny ? result : null;
}

export function readConfigYmlSafetyBlock(): Partial<Record<SafetyKey, boolean>> | null {
  try {
    return parseConfigYmlSafetyBlock(readFileSync(join(picoAgentHome(), "config.yml"), "utf-8"));
  } catch {
    return null;
  }
}

function readSettingsSafety(): Partial<Record<SafetyKey, boolean>> {
  const raw = readSettingsObject("safety");
  const result: Partial<Record<SafetyKey, boolean>> = {};
  for (const key of SAFETY_KEYS) {
    const value = raw[key];
    if (typeof value === "boolean") result[key] = value;
  }
  return result;
}

/**
 * Keys present in config.yml's safety block that differ from (or are
 * absent in) the effective settings.json value. `effectiveValue` reflects
 * settings.json (env overrides are not visible here; the report labels the
 * source separately).
 */
export function detectConfigYmlSafetyConflicts(): ConfigYmlSafetyConflict[] {
  const fromYml = readConfigYmlSafetyBlock();
  if (!fromYml) return [];
  const fromSettings = readSettingsSafety();

  const conflicts: ConfigYmlSafetyConflict[] = [];
  for (const key of SAFETY_KEYS) {
    const ymlValue = fromYml[key];
    if (ymlValue === undefined) continue;
    const effective = fromSettings[key] ?? false;
    if (ymlValue !== effective) {
      conflicts.push({ key, configYmlValue: ymlValue, effectiveValue: effective });
    }
  }
  return conflicts;
}

export function formatConfigYmlConflictLines(): string[] {
  const conflicts = detectConfigYmlSafetyConflicts();
  if (conflicts.length === 0) return [];
  const lines = [
    "Config conflict (config.yml safety keys are IGNORED by pico):",
    ...conflicts.map(
      (c) =>
        `  ${c.key}: config.yml=${c.configYmlValue} but effective=${c.effectiveValue} ` +
        `(settings.json or env). Move it to settings.json "safety" to take effect.`,
    ),
  ];
  return lines;
}

// ---- config.yml vs settings.json model selection -------------------------

export type ConfigYmlModelKey = "defaultProvider" | "defaultModel";

export interface ConfigYmlModelConflict {
  key: ConfigYmlModelKey;
  configYmlValue: string;
  settingsValue: string;
}

/**
 * Parse top-level `key: value` pairs from a config.yml-style document
 * (indentation based, no quotes). Nested blocks (safety: …) are skipped
 * because their children are indented.
 */
export function parseConfigYmlTopLevel(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (/^\s/.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/.exec(trimmed);
    if (match) result[match[1]!] = match[2]!.trim();
  }
  return result;
}

/**
 * defaultProvider/defaultModel present in config.yml that differ from
 * settings.json. settings.json wins at runtime; a differing config.yml is a
 * silent surprise when the user edits the "wrong" file.
 */
export function detectConfigYmlModelConflicts(): ConfigYmlModelConflict[] {
  let yml: Record<string, string>;
  try {
    yml = parseConfigYmlTopLevel(readFileSync(join(picoAgentHome(), "config.yml"), "utf-8"));
  } catch {
    return [];
  }
  const conflicts: ConfigYmlModelConflict[] = [];
  const settings = readSettings();
  for (const key of ["defaultProvider", "defaultModel"] as const) {
    const ymlValue = yml[key];
    if (ymlValue === undefined) continue;
    const settingsValue = settings[key];
    if (typeof settingsValue !== "string") continue;
    if (ymlValue !== settingsValue) {
      conflicts.push({ key, configYmlValue: ymlValue, settingsValue });
    }
  }
  return conflicts;
}

export function formatConfigYmlModelConflictLines(): string[] {
  const conflicts = detectConfigYmlModelConflicts();
  if (conflicts.length === 0) return [];
  return [
    "Config conflict (config.yml model selection is IGNORED by pico — settings.json wins):",
    ...conflicts.map(
      (c) =>
        `  ${c.key}: config.yml=${c.configYmlValue} but settings.json=${c.settingsValue}. ` +
        `Update settings.json (or remove the key from config.yml).`,
    ),
  ];
}

// ---- models.json reasoning-compat scan ----------------------------------

export interface ReasoningCompatIssue {
  provider: string;
  model: string;
  hasCompatFlag: boolean;
}

interface ProviderScan {
  name: string;
  reasoningModels: string[];
  hasCompat: boolean;
}

/**
 * Scan the JSON model catalog (models.json) for provider/model compat
 * structure:
 *
 *   {
 *     "providers": {
 *       "zen-openai": {
 *         "compat": { "supportsDeveloperRole": false },
 *         "models": [
 *           { "id": "deepseek-v4-flash-free", "reasoning": true,
 *             "compat": { "requiresReasoningContentOnAssistantMessages": true } }
 *         ]
 *       }
 *     }
 *   }
 *
 * The flag may live on the provider or on any of its models; either way it
 * covers the provider's reasoning models (matching the legacy YAML scan).
 */
export function scanModelsJson(raw: string): ProviderScan[] {
  let parsed: { providers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
  } catch {
    return [];
  }
  const providers: ProviderScan[] = [];
  for (const [name, value] of Object.entries(parsed.providers ?? {})) {
    if (!value || typeof value !== "object") continue;
    const p = value as {
      compat?: Record<string, unknown>;
      models?: Array<{ id?: unknown; reasoning?: unknown; compat?: Record<string, unknown> }>;
    };
    const hasFlag = (c: Record<string, unknown> | undefined): boolean =>
      c?.["requiresReasoningContentOnAssistantMessages"] === true;
    const reasoningModels: string[] = [];
    let hasCompat = hasFlag(p.compat);
    for (const m of p.models ?? []) {
      if (m?.reasoning === true) {
        reasoningModels.push(typeof m.id === "string" ? m.id : String(m.id ?? ""));
      }
      if (hasFlag(m?.compat)) hasCompat = true;
    }
    providers.push({ name, reasoningModels, hasCompat });
  }
  return providers;
}

export function detectReasoningCompatIssues(): ReasoningCompatIssue[] {
  try {
    const raw = readFileSync(picoModelsPath(), "utf-8");
    const providers = scanModelsJson(raw);
    const issues: ReasoningCompatIssue[] = [];
    for (const provider of providers) {
      if (provider.reasoningModels.length === 0) continue;
      for (const model of provider.reasoningModels) {
        issues.push({
          provider: provider.name,
          model,
          hasCompatFlag: provider.hasCompat,
        });
      }
    }
    return issues;
  } catch {
    return [];
  }
}

export function formatReasoningCompatLines(): string[] {
  const issues = detectReasoningCompatIssues();
  if (issues.length === 0) return [];
  const missing = issues.filter((issue) => !issue.hasCompatFlag);
  if (missing.length === 0) return [];
  const lines = [
    "Reasoning models without requiresReasoningContentOnAssistantMessages compat",
    "(multi-turn tool calls may hit 400 from deepseek-style proxies):",
    ...missing.map(
      (issue) =>
        `  ${issue.provider}/${issue.model} — add compat.requiresReasoningContentOnAssistantMessages: true ` +
        `in ${picoModelsPath()}`,
    ),
  ];
  return lines;
}
