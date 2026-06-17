import { loadPermissionConfig } from "./config.ts";
import { permissionRuleValueToString } from "./parser.ts";
import type {
  LoadedPermissionConfig,
  PermissionBehavior,
  PermissionMode,
  PermissionRule,
  PermissionRuleValue,
} from "./schema.ts";

export class PermissionStore {
  private loaded: LoadedPermissionConfig = {
    rules: [],
    defaultMode: "default",
    defaultModeSpecified: false,
    additionalDirectories: [],
  };
  private sessionRules: PermissionRule[] = [];

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
    return this.loaded.defaultMode;
  }

  additionalDirectories(): string[] {
    return this.loaded.additionalDirectories;
  }
}
