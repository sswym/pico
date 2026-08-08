/**
 * Lightweight, dependency-free schema validation for settings.json.
 *
 * Philosophy (borrowed from claude-code's single zod schema + "drop the bad
 * rule, never veto the file"): validation is *report-only*. It never blocks
 * or rewrites settings — the read/write path in settings.ts is untouched, so
 * a validation issue can never cost the user config (API keys, safety
 * switches, env stanza). This mirrors the settingsDamaged guard in
 * settings.ts: writes are only refused when the file is unparseable; a mere
 * type mismatch is surfaced in /doctor instead.
 *
 * Rules only cover fields pico actually consumes (policy.ts safety flags,
 * language.ts, rtk/index.ts, memory/provider-manager.ts, doctor model
 * summary). Unknown keys (env stanza, provider configs, …) are ignored on
 * purpose. One bad field yields one issue; sibling fields are still
 * validated (逐 key 隔离 — no whole-file veto).
 *
 * The validator is pure and side-effect free: validateSettingsObject touches
 * nothing, validateCurrentSettings only reads the settings file.
 */
import { readSettings } from "./settings.ts";

export interface SettingsIssue {
  /** Dot path, e.g. "safety.enableProjectHooks". */
  key: string;
  /** Human-readable description. */
  message: string;
  /** Expected type/constraint description. */
  expected?: string;
  /** Actual value (serialization-safe: only JSON-serializable values). */
  invalidValue?: unknown;
}

export interface SettingsValidationResult {
  issues: SettingsIssue[];
  /** issues.length === 0 */
  valid: boolean;
}

/** Mirrors LANGUAGE_MAX_LENGTH in language.ts. */
const LANGUAGE_MAX_LENGTH = 64;

/** Safety switches policy.ts reads via readSettingsObject("safety"). */
const SAFETY_KEYS = [
  "enableProjectHooks",
  "enableProjectMcp",
  "enableProjectLsp",
  "allowUnattendedPlanApproval",
  "allowLspFormatOnWrite",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Guarantee the value stored on an issue is JSON-serializable (settings may
 * be fed arbitrary objects by callers; a BigInt/Date/circular value must
 * never leak into the doctor report or a crash). Round-trip through
 * JSON.stringify so the result is always plain JSON.
 */
function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return typeof value === "string" ? value : String(value);
  }
}

function makeIssue(key: string, expected: string, message: string, value: unknown): SettingsIssue {
  return { key, message, expected, invalidValue: jsonSafe(value) };
}

/** Field checkers: `key` is the local lookup key, `path` the dotted issue
 *  key (they differ for namespaced fields, e.g. key "enabled" in
 *  integrations.rtk → path "integrations.rtk.enabled"). */
function checkBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: SettingsIssue[],
): void {
  const value = obj[key];
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    issues.push(makeIssue(path, "boolean", `must be a boolean (got ${typeName(value)})`, value));
  }
}

function checkString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: SettingsIssue[],
  opts: { nonEmpty?: boolean } = {},
): void {
  const value = obj[key];
  if (value === undefined) return;
  if (typeof value !== "string") {
    issues.push(makeIssue(path, "string", `must be a string (got ${typeName(value)})`, value));
    return;
  }
  if (opts.nonEmpty && value.trim().length === 0) {
    issues.push(makeIssue(path, "non-empty string", "must be a non-empty string", value));
  }
}

function checkNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: SettingsIssue[],
): void {
  const value = obj[key];
  if (value === undefined) return;
  if (typeof value !== "number") {
    issues.push(makeIssue(path, "number", `must be a number (got ${typeName(value)})`, value));
  }
}

/** language.ts constraints: non-empty after trim, ≤ 64 chars, no CR/LF. */
function checkLanguage(obj: Record<string, unknown>, issues: SettingsIssue[]): void {
  const value = obj.language;
  if (value === undefined) return;
  const expected = "string, 1-64 chars after trimming, no newlines";
  const path = "language";
  if (typeof value !== "string") {
    issues.push(makeIssue(path, expected, `must be a string (got ${typeName(value)})`, value));
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    issues.push(makeIssue(path, expected, "must not be empty after trimming", value));
    return;
  }
  if (trimmed.length > LANGUAGE_MAX_LENGTH) {
    issues.push(
      makeIssue(
        path,
        expected,
        `must be at most ${LANGUAGE_MAX_LENGTH} characters after trimming (got ${trimmed.length})`,
        value,
      ),
    );
    return;
  }
  if (/[\r\n]/.test(value)) {
    issues.push(makeIssue(path, expected, "must not contain newline characters", value));
  }
}

/**
 * Upstream consumes `httpIdleTimeoutMs` from the same settings.json as the
 * per-request model timeout (default 300000ms; 0 = disabled; accepts
 * "disabled" or a numeric string). Validate it here so a typo surfaces in
 * /doctor instead of throwing at request time upstream.
 */
function checkHttpIdleTimeout(obj: Record<string, unknown>, issues: SettingsIssue[]): void {
  const value = obj.httpIdleTimeoutMs;
  if (value === undefined) return;
  const path = "httpIdleTimeoutMs";
  const expected = "non-negative number (ms), or \"disabled\"";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      issues.push(makeIssue(path, expected, `must be a finite non-negative number (got ${String(value)})`, value));
    }
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return;
    const numeric = Number(trimmed);
    if (trimmed.length === 0 || !Number.isFinite(numeric) || numeric < 0) {
      issues.push(makeIssue(path, expected, `unrecognized timeout value "${value}"`, value));
    }
    return;
  }
  issues.push(makeIssue(path, expected, `must be a number or string (got ${typeName(value)})`, value));
}

/**
 * Validate a namespace object (e.g. "safety", "memory"). A present-but-not-
 * object namespace is one issue; otherwise every known field is checked
 * independently (逐 key 隔离). `key` is the local lookup key, `path` the
 * dotted issue key (differ for nested namespaces like integrations.rtk).
 */
function checkNamespace(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  validate: (namespace: Record<string, unknown>, path: string, issues: SettingsIssue[]) => void,
  issues: SettingsIssue[],
): void {
  const value = obj[key];
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    issues.push(makeIssue(path, "object", `"${path}" must be an object`, value));
    return;
  }
  validate(value, path, issues);
}

/** Validate any settings object. Per-key isolation: one bad field produces
 *  one issue, the rest keep validating — never a whole-file veto. */
export function validateSettingsObject(obj: unknown): SettingsValidationResult {
  if (!isPlainObject(obj)) {
    return {
      issues: [makeIssue("settings", "object", "settings.json root must be a JSON object", obj)],
      valid: false,
    };
  }

  const issues: SettingsIssue[] = [];

  checkNamespace(obj, "safety", "safety", (safety, path, out) => {
    for (const key of SAFETY_KEYS) checkBoolean(safety, key, `${path}.${key}`, out);
  }, issues);

  checkNamespace(obj, "integrations", "integrations", (integrations, path, out) => {
    checkNamespace(integrations, "rtk", `${path}.rtk`, (rtk, rtkPath, rtkOut) => {
      checkBoolean(rtk, "enabled", `${rtkPath}.enabled`, rtkOut);
      checkString(rtk, "mode", `${rtkPath}.mode`, rtkOut);
      checkString(rtk, "command", `${rtkPath}.command`, rtkOut);
    }, out);
  }, issues);

  checkNamespace(obj, "memory", "memory", (memory, path, out) => {
    // Fields provider-manager.ts actually reads; anything else under memory
    // is left alone (no invented rules).
    checkString(memory, "backend", `${path}.backend`, out);
    checkNumber(memory, "temporalDecayHalfLifeDays", `${path}.temporalDecayHalfLifeDays`, out);
  }, issues);

  checkLanguage(obj, issues);
  checkString(obj, "defaultProvider", "defaultProvider", issues, { nonEmpty: true });
  checkString(obj, "defaultModel", "defaultModel", issues, { nonEmpty: true });
  checkHttpIdleTimeout(obj, issues);

  return { issues, valid: issues.length === 0 };
}

/** Validate the current settings on disk (reuses settings.ts readSettings,
 *  including its damaged-file → {} fallback). */
export function validateCurrentSettings(): SettingsValidationResult {
  return validateSettingsObject(readSettings());
}
