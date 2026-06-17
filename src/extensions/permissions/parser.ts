import type { PermissionRuleValue } from "./schema.ts";

const LEGACY_TOOL_NAME_ALIASES: Record<string, string> = {
  BashTool: "Bash",
  ReadTool: "Read",
  EditTool: "Edit",
  WriteTool: "Write",
};

function countBackslashesBefore(s: string, index: number): number {
  let count = 0;
  for (let i = index - 1; i >= 0 && s[i] === "\\"; i--) count++;
  return count;
}

function isEscaped(s: string, index: number): boolean {
  return countBackslashesBefore(s, index) % 2 === 1;
}

function findFirstUnescapedChar(s: string, char: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === char && !isEscaped(s, i)) return i;
  }
  return -1;
}

function findLastUnescapedChar(s: string, char: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === char && !isEscaped(s, i)) return i;
  }
  return -1;
}

function normalizeToolName(toolName: string): string {
  return LEGACY_TOOL_NAME_ALIASES[toolName] ?? toolName;
}

function unescapeRuleContent(content: string): string {
  return content
    .replace(/\\([()])/g, "$1")
    .replace(/\\\\/g, "\\");
}

function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

export function permissionRuleValueFromString(raw: string): PermissionRuleValue | undefined {
  const input = raw.trim();
  if (input.length === 0) return undefined;

  const open = findFirstUnescapedChar(input, "(");
  const close = findLastUnescapedChar(input, ")");
  if (open === -1 || close === -1 || close !== input.length - 1 || close < open) {
    return { toolName: normalizeToolName(input) };
  }

  const toolName = normalizeToolName(input.slice(0, open).trim());
  if (toolName.length === 0) return undefined;

  const rawContent = input.slice(open + 1, close);
  const content = unescapeRuleContent(rawContent).trim();
  if (content.length === 0 || content === "*") return { toolName };
  return { toolName, ruleContent: content };
}

export function permissionRuleValueToString(rule: PermissionRuleValue): string {
  if (!rule.ruleContent || rule.ruleContent === "*") return rule.toolName;
  return `${rule.toolName}(${escapeRuleContent(rule.ruleContent)})`;
}
