import { loadPermissionConfig } from "./config.ts";
import { permissionRuleValueToString } from "./parser.ts";
import {
  PERMISSION_MODES,
  type LoadedPermissionConfig,
  type PermissionBehavior,
  type PermissionMode,
  type PermissionRule,
  type PermissionRuleValue,
} from "./schema.ts";

export class PermissionStore {
  private loaded: LoadedPermissionConfig = {
    rules: [],
    defaultMode: "default",
    defaultModeSpecified: false,
    additionalDirectories: [],
  };
  private sessionRules: PermissionRule[] = [];
  private modeOverride: PermissionMode | undefined;

  reload(cwd: string): void {
    this.loaded = loadPermissionConfig(cwd);
  }

  addSessionRule(behavior: PermissionBehavior, value: PermissionRuleValue, root: string): void {
    const key = `${behavior}|${permissionRuleValueToString(value)}`;
    if (this.sessionRules.some((rule) => `${rule.behavior}|${permissionRuleValueToString(rule.value)}` === key)) {
      return;
    }
    this.sessionRules.push({ source: "session", behavior, value, root });
  }

  clearSessionRules(): void {
    this.sessionRules = [];
  }

  rulesByBehavior(behavior: PermissionBehavior): PermissionRule[] {
    return [...this.loaded.rules, ...this.sessionRules].filter((rule) => rule.behavior === behavior);
  }

  allRules(): PermissionRule[] {
    return [...this.loaded.rules, ...this.sessionRules];
  }

  defaultMode(): PermissionMode {
    return this.modeOverride ?? this.loaded.defaultMode;
  }

  configuredMode(): PermissionMode {
    return this.loaded.defaultMode;
  }

  modeIsOverridden(): boolean {
    return this.modeOverride !== undefined;
  }

  setMode(mode: PermissionMode): void {
    this.modeOverride = mode;
  }

  clearModeOverride(): void {
    this.modeOverride = undefined;
  }

  cycleMode(): PermissionMode {
    const cycle: PermissionMode[] = PERMISSION_MODES.filter((mode): mode is PermissionMode => mode !== "plan");
    const current = this.defaultMode();
    const index = cycle.indexOf(current);
    const next = cycle[(index + 1) % cycle.length] ?? "default";
    this.modeOverride = next;
    return next;
  }

  additionalDirectories(): string[] {
    return this.loaded.additionalDirectories;
  }
}
