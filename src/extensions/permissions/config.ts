import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { srcodeHome } from "../paths.ts";
import { permissionRuleValueFromString, permissionRuleValueToString } from "./parser.ts";
import {
  isPermissionMode,
  type LoadedPermissionConfig,
  type PermissionBehavior,
  type PermissionMode,
  type PermissionRule,
  type PermissionRuleSource,
} from "./schema.ts";

const DEFAULT_MODE: PermissionMode = "default";
const warnedPaths = new Set<string>();

function warnOnce(path: string, err: unknown): void {
  if (warnedPaths.has(path)) return;
  warnedPaths.add(path);
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[srcode permissions] ignoring ${path}: ${msg}`);
}

/** Reset the once-per-path warning cache. Test-only. */
export function __resetWarnedPaths(): void {
  warnedPaths.clear();
}

export function permissionConfigPaths(cwd: string): Array<{ path: string; source: PermissionRuleSource; root: string }> {
  const home = srcodeHome();
  const project = resolve(cwd);
  return [
    { path: join(home, "permissions.json"), source: "userSettings", root: home },
    { path: join(project, ".srcode", "permissions.json"), source: "projectSettings", root: project },
  ];
}

function normalizeRules(
  rawRules: unknown,
  behavior: PermissionBehavior,
  source: PermissionRuleSource,
  root: string,
): PermissionRule[] {
  if (!Array.isArray(rawRules)) return [];
  const rules: PermissionRule[] = [];
  for (const item of rawRules) {
    if (typeof item !== "string") continue;
    const value = permissionRuleValueFromString(item);
    if (!value) continue;
    rules.push({ source, behavior, value, root });
  }
  return rules;
}

function readPermissionsObject(raw: unknown, sourcePath: string): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") {
    warnOnce(sourcePath, new Error("expected an object"));
    return undefined;
  }
  const top = raw as Record<string, unknown>;
  const permissions = top.permissions ?? top;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    warnOnce(sourcePath, new Error("expected `permissions` object"));
    return undefined;
  }
  return permissions as Record<string, unknown>;
}

function loadOne(path: string, source: PermissionRuleSource, root: string): LoadedPermissionConfig {
  const empty: LoadedPermissionConfig = {
    rules: [],
    defaultMode: DEFAULT_MODE,
    defaultModeSpecified: false,
    additionalDirectories: [],
  };
  if (!existsSync(path)) return empty;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const permissions = readPermissionsObject(raw, path);
    if (!permissions) return empty;

    const rules = [
      ...normalizeRules(permissions.deny, "deny", source, root),
      ...normalizeRules(permissions.ask, "ask", source, root),
      ...normalizeRules(permissions.allow, "allow", source, root),
    ];
    const defaultModeSpecified = isPermissionMode(permissions.defaultMode);
    const defaultMode = defaultModeSpecified ? permissions.defaultMode as PermissionMode : DEFAULT_MODE;
    const additionalDirectories = Array.isArray(permissions.additionalDirectories)
      ? permissions.additionalDirectories.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
    return { rules, defaultMode, defaultModeSpecified, additionalDirectories };
  } catch (err) {
    warnOnce(path, err);
    return empty;
  }
}

function dedupeKey(rule: PermissionRule): string {
  return `${rule.behavior}|${permissionRuleValueToString(rule.value)}`;
}

export function loadPermissionConfig(cwd: string): LoadedPermissionConfig {
  const layers = permissionConfigPaths(cwd).map((entry) => loadOne(entry.path, entry.source, entry.root));
  const rules: PermissionRule[] = [];
  const seen = new Set<string>();
  for (const layer of layers) {
    for (const rule of layer.rules) {
      const key = dedupeKey(rule);
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push(rule);
    }
  }

  const defaultMode = [...layers].reverse().find((layer) => layer.defaultModeSpecified)?.defaultMode ?? DEFAULT_MODE;
  const additionalDirectories = layers.flatMap((layer) => layer.additionalDirectories);
  return { rules, defaultMode, defaultModeSpecified: layers.some((layer) => layer.defaultModeSpecified), additionalDirectories };
}
