export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type PermissionBehavior = "allow" | "deny" | "ask";
export type PermissionRuleSource = "userSettings" | "projectSettings" | "session";

export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

export interface PermissionRule {
  source: PermissionRuleSource;
  behavior: PermissionBehavior;
  value: PermissionRuleValue;
  /** Root used to resolve path-like rule content for this source. */
  root: string;
}

export interface LoadedPermissionConfig {
  rules: PermissionRule[];
  defaultMode: PermissionMode;
  defaultModeSpecified: boolean;
  additionalDirectories: string[];
}

export interface PermissionDecision {
  behavior: PermissionBehavior;
  reason: string;
  matchedRule?: PermissionRule;
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}
