import { resolve } from "node:path";
import { expandPath, inputFilePath, pathInDirectory } from "./filesystem.ts";
import { permissionRuleValueToString } from "./parser.ts";
import { ruleMatchesInput } from "./match.ts";
import type { PermissionDecision, PermissionMode, PermissionRule } from "./schema.ts";
import type { PermissionStore } from "./store.ts";

const LOW_RISK_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write", "NotebookEdit"]);

function ruleReason(behavior: "allow" | "deny" | "ask", rule: PermissionRule): string {
  return `${behavior} rule ${permissionRuleValueToString(rule.value)} from ${rule.source}`;
}

function findMatchingRule(rules: PermissionRule[], toolName: string, input: Record<string, unknown>, cwd: string): PermissionRule | undefined {
  return rules.find((rule) => ruleMatchesInput(rule, toolName, input, cwd));
}

function isInAllowedWorkingDirectory(
  filePath: string | undefined,
  cwd: string,
  additionalDirectories: readonly string[],
): boolean {
  if (!filePath) return false;
  const absolute = expandPath(filePath, cwd);
  const roots = [resolve(cwd), ...additionalDirectories.map((dir) => expandPath(dir, cwd))];
  return roots.some((root) => pathInDirectory(absolute, root));
}

function applyDontAsk(decision: PermissionDecision, mode: PermissionMode): PermissionDecision {
  if (mode !== "dontAsk" || decision.behavior !== "ask") return decision;
  return {
    behavior: "deny",
    reason: `Permission prompt suppressed by dontAsk mode: ${decision.reason}`,
    matchedRule: decision.matchedRule,
  };
}

export function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  store: PermissionStore,
  mode: PermissionMode = store.defaultMode(),
): PermissionDecision {
  const denyRule = findMatchingRule(store.rulesByBehavior("deny"), toolName, input, cwd);
  if (denyRule) return { behavior: "deny", reason: ruleReason("deny", denyRule), matchedRule: denyRule };

  const askRule = findMatchingRule(store.rulesByBehavior("ask"), toolName, input, cwd);
  if (askRule) return applyDontAsk({ behavior: "ask", reason: ruleReason("ask", askRule), matchedRule: askRule }, mode);

  if (mode === "bypassPermissions") {
    return { behavior: "allow", reason: "bypassPermissions mode" };
  }

  if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) {
    const filePath = inputFilePath(input);
    if (isInAllowedWorkingDirectory(filePath, cwd, store.additionalDirectories())) {
      return { behavior: "allow", reason: "acceptEdits mode inside working directory" };
    }
  }

  const allowRule = findMatchingRule(store.rulesByBehavior("allow"), toolName, input, cwd);
  if (allowRule) return { behavior: "allow", reason: ruleReason("allow", allowRule), matchedRule: allowRule };

  if (LOW_RISK_TOOLS.has(toolName)) {
    return { behavior: "allow", reason: "low-risk read-only tool" };
  }

  return applyDontAsk({ behavior: "ask", reason: `No permission rule matched ${toolName}` }, mode);
}
