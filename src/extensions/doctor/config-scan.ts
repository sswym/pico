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
 * It also scans models.yml for reasoning models whose provider compat
 * lacks `requiresReasoningContentOnAssistantMessages` — the known
 * precondition for "reasoning_content must be passed back" 400s from
 * deepseek-style OpenAI-compatible proxies.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { picoAgentHome } from "../paths.ts";
import { readSettingsObject } from "../settings.ts";

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

// ---- models.yml reasoning-compat scan ----------------------------------

export interface ReasoningCompatIssue {
  provider: string;
  model: string;
  hasCompatFlag: boolean;
}

interface ProviderScan {
  name: string;
  reasoningModels: string[];
  compatLine: string | null;
}

const MODEL_FILE_SUBKEYS = new Set(["compat", "models", "baseurl", "api", "apikey", "authheader", "name"]);

/**
 * Minimal YAML scan for provider/model/compat structure:
 *
 *   providers:
 *     zen-openai:
 *       compat:
 *         supportsDeveloperRole: false
 *       models:
 *         - id: deepseek-v4-flash-free
 *           reasoning: true
 */
export function scanModelsYml(raw: string): ProviderScan[] {
  const lines = raw.split("\n");
  const providers: ProviderScan[] = [];
  let current: ProviderScan | null = null;

  const providerIndent = (line: string): number => line.length - line.trimStart().length;
  const topLevel = lines.findIndex((l) => l.trim() === "providers:");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (i <= topLevel || topLevel < 0) continue;

    const indent = providerIndent(line);
    if (indent === 0) continue;

    // Provider block: exactly the standard 2-space nesting directly under
    // `providers:` — deeper keys (compat/models/baseUrl) are subkeys, not
    // providers, and must never reset the current block.
    const providerMatch = /^([A-Za-z0-9_-]+)\s*:\s*$/.exec(trimmed);
    if (providerMatch && indent === 2 && !MODEL_FILE_SUBKEYS.has(providerMatch[1]!.toLowerCase())) {
      current = { name: providerMatch[1]!, reasoningModels: [], compatLine: null };
      providers.push(current);
      continue;
    }
    if (!current) continue;

    if (/^compat\s*:\s*$/.test(trimmed)) {
      // Look ahead for requiresReasoningContentOnAssistantMessages within
      // the compat block (next non-comment line with greater indent).
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!.trim();
        if (!next || next.startsWith("#")) continue;
        const nextIndent = providerIndent(lines[j]!);
        if (nextIndent <= indent) break;
        if (/^requiresReasoningContentOnAssistantMessages\s*:\s*true\s*$/.test(next)) {
          current.compatLine = `requiresReasoningContentOnAssistantMessages: true`;
        }
        break;
      }
      continue;
    }

    const modelMatch = /^-\s*id\s*:\s*(.+)$/.exec(trimmed);
    if (modelMatch) {
      const id = modelMatch[1]!.trim();
      // Reasoning flag lives in a following line (`reasoning: true`).
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const next = lines[j]!.trim();
        if (next.startsWith("- ") || /^[A-Za-z]/.test(next) && !next.startsWith("reasoning")) break;
        if (/^reasoning\s*:\s*true\s*$/.test(next)) {
          current.reasoningModels.push(id);
          break;
        }
        if (next.startsWith("reasoning")) break;
      }
      continue;
    }
  }

  return providers;
}

export function detectReasoningCompatIssues(): ReasoningCompatIssue[] {
  try {
    const raw = readFileSync(join(picoAgentHome(), "models.yml"), "utf-8");
    const providers = scanModelsYml(raw);
    const issues: ReasoningCompatIssue[] = [];
    for (const provider of providers) {
      if (provider.reasoningModels.length === 0) continue;
      for (const model of provider.reasoningModels) {
        issues.push({
          provider: provider.name,
          model,
          hasCompatFlag: provider.compatLine !== null,
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
        `in ~/.pico/agent/models.yml`,
    ),
  ];
  return lines;
}
