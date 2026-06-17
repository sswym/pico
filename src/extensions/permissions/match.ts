import type { PermissionRule } from "./schema.ts";
import { fileRuleMatchesPath, inputFilePath } from "./filesystem.ts";

const FILE_PATTERN_TOOLS = new Set([
  "read",
  "Read",
  "edit",
  "Edit",
  "write",
  "Write",
  "NotebookEdit",
  "NotebookRead",
]);

const SAFE_WRAPPERS = new Set(["timeout", "time", "nice", "nohup"]);
const COMPOUND_RE = /(&&|\|\||;|\|)/;

export type ShellPermissionRule =
  | { type: "exact"; command: string }
  | { type: "prefix"; prefix: string }
  | { type: "wildcard"; pattern: string };

export function toolMatchesRule(toolName: string, rule: PermissionRule): boolean {
  const ruleTool = rule.value.toolName;
  if (ruleTool.endsWith("__*")) return toolName.startsWith(ruleTool.slice(0, -1));
  if (ruleTool.startsWith("mcp__") && !ruleTool.includes("__", "mcp__".length)) {
    return toolName === ruleTool || toolName.startsWith(`${ruleTool}__`);
  }
  return toolName === ruleTool || toolName.toLowerCase() === ruleTool.toLowerCase();
}

function hasUnescapedWildcard(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i - 1] !== "\\") return true;
  }
  return false;
}

export function parseShellRule(ruleContent: string): ShellPermissionRule {
  if (ruleContent.endsWith(":*") && ruleContent.length > 2) {
    return { type: "prefix", prefix: ruleContent.slice(0, -2).trim() };
  }
  if (hasUnescapedWildcard(ruleContent)) return { type: "wildcard", pattern: ruleContent };
  return { type: "exact", command: ruleContent.trim() };
}

function wildcardToRegExp(pattern: string): RegExp {
  const ESCAPED_STAR = "__SRCODE_ESCAPED_STAR__";
  const ESCAPED_BACKSLASH = "__SRCODE_ESCAPED_BACKSLASH__";
  let source = pattern
    .replace(/\\\\/g, ESCAPED_BACKSLASH)
    .replace(/\\\*/g, ESCAPED_STAR)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(new RegExp(ESCAPED_STAR, "g"), "\\*")
    .replace(new RegExp(ESCAPED_BACKSLASH, "g"), "\\\\");

  if (pattern.endsWith(" *") && (pattern.match(/(?<!\\)\*/g) ?? []).length === 1) {
    source = `${source.slice(0, -3)}(?: .*)?`;
  }
  return new RegExp(`^${source}$`, "s");
}

function stripLeadingEnvVars(command: string): string {
  let out = command.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/.test(out)) {
    out = out.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, "");
  }
  return out.trim();
}

function stripSafeWrapper(command: string): string {
  const parts = command.trim().split(/\s+/);
  if (parts.length < 2) return command.trim();
  const first = parts[0]!;
  if (!SAFE_WRAPPERS.has(first)) return command.trim();

  if (first === "timeout" && /^\d+[smhd]?$/.test(parts[1] ?? "")) {
    return parts.slice(2).join(" ").trim() || command.trim();
  }
  if (first === "nice") {
    if (parts[1] === "-n" && parts.length > 3) return parts.slice(3).join(" ").trim();
    return parts.slice(1).join(" ").trim();
  }
  return parts.slice(1).join(" ").trim();
}

function commandCandidates(command: string): string[] {
  const candidates = new Set<string>();
  const trimmed = command.trim();
  candidates.add(trimmed);
  candidates.add(stripLeadingEnvVars(trimmed));
  candidates.add(stripSafeWrapper(stripLeadingEnvVars(trimmed)));
  return [...candidates].filter(Boolean);
}

export function bashRuleMatches(ruleContent: string, command: string | undefined): boolean {
  if (!command) return false;
  const rule = parseShellRule(ruleContent);
  for (const candidate of commandCandidates(command)) {
    if (rule.type === "exact" && candidate === rule.command) return true;
    if (rule.type === "prefix") {
      if (COMPOUND_RE.test(candidate)) continue;
      if (candidate === rule.prefix || candidate.startsWith(`${rule.prefix} `)) return true;
      if (candidate.startsWith(`xargs ${rule.prefix} `)) return true;
    }
    if (rule.type === "wildcard") {
      if (COMPOUND_RE.test(candidate)) continue;
      if (wildcardToRegExp(rule.pattern).test(candidate)) return true;
    }
  }
  return false;
}

export function ruleMatchesInput(
  rule: PermissionRule,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): boolean {
  if (!toolMatchesRule(toolName, rule)) return false;
  const content = rule.value.ruleContent;
  if (!content) return true;

  if (rule.value.toolName.toLowerCase() === "bash" || toolName.toLowerCase() === "bash") {
    const command = input.command;
    return bashRuleMatches(content, typeof command === "string" ? command : undefined);
  }

  if (FILE_PATTERN_TOOLS.has(rule.value.toolName) || FILE_PATTERN_TOOLS.has(toolName)) {
    return fileRuleMatchesPath(content, inputFilePath(input), cwd);
  }

  return false;
}
