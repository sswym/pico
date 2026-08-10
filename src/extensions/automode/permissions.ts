import type { ToolPattern } from "./types.ts";
import {
  expandHomePattern,
  normalizePathForMatch,
  resolveInputPath,
} from "./paths.ts";

function normalizeToolName(name: string): string {
  const lower = name.trim().replace(/^@/, "").toLowerCase();
  const aliases: Record<string, string> = {
    bash: "bash",
    read: "read",
    edit: "edit",
    write: "write",
    grep: "grep",
    find: "find",
    ls: "ls",
  };
  return aliases[lower] ?? lower;
}

/**
 * Parse Pi permission entries such as `bash(git push *)`.
 *
 * Capitalized names such as `Bash(...)` are accepted as a convenience, but Pi's
 * actual tool names are lowercase. Scoped entries stay scoped: we do not flatten
 * `bash(git status *)` into a blanket `bash` permission.
 */
export function parseToolPattern(value: unknown): ToolPattern | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;

  const match = raw.match(/^@?([A-Za-z0-9_-]+)(?:\((.*)\))?$/s);
  if (!match) return { raw };
  return {
    raw,
    toolName: normalizeToolName(match[1] ?? ""),
    argumentPattern: match[2],
  };
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function getPrimaryArgument(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string {
  if (toolName === "bash" && typeof input.command === "string") {
    return input.command;
  }
  if (
    (toolName === "read" || toolName === "write" || toolName === "edit") &&
    typeof input.path === "string"
  ) {
    return normalizePathForMatch(
      resolveInputPath(cwd, input.path) ?? input.path,
      cwd,
    );
  }
  if (toolName === "grep" && typeof input.pattern === "string") {
    return input.pattern;
  }
  if (
    (toolName === "find" || toolName === "ls") &&
    typeof input.path === "string"
  ) {
    return normalizePathForMatch(
      resolveInputPath(cwd, input.path) ?? input.path,
      cwd,
    );
  }
  return JSON.stringify(input);
}

/**
 * Whether a resolved absolute path matches a configured path-denial pattern.
 * Patterns support `~`/`$HOME` expansion and `*` globs, where `*` matches any
 * characters, including `/`. Matching is case-insensitive and
 * conservative-safe: over-matching only blocks more.
 */
export function matchesDeniedPath(
  resolvedPath: string,
  deniedPaths: string[],
): boolean {
  const normalized = resolvedPath.replace(/\\/g, "/");
  return deniedPaths.some((pattern) => {
    const expanded = expandHomePattern(pattern).replace(/\\/g, "/");
    return wildcardToRegExp(expanded).test(normalized);
  });
}

/** Match a scoped permission rule against a concrete tool call. */
export function matchesToolPattern(
  pattern: ToolPattern,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): boolean {
  if (!pattern.toolName) return false;
  if (pattern.toolName !== normalizeToolName(toolName)) return false;
  if (!pattern.argumentPattern || pattern.argumentPattern === "*") return true;
  const primary = getPrimaryArgument(toolName, input, cwd);
  if (toolName === "bash" && typeof input.command === "string") {
    // Claude Code-style semantics: a bash permission pattern matches any
    // segment of a compound command (`a && b`, `a; b`, `a | b`, newlines),
    // so `bash(rm -rf *)` also blocks `mkdir x && rm -rf x`. Without this a
    // deny rule is trivially bypassed by chaining the forbidden command.
    const segments = input.command
      .split(/\s*(?:&&|\|\||\||;|\n)\s*/)
      .filter(Boolean);
    return segments.some((segment) =>
      wildcardToRegExp(pattern.argumentPattern!).test(segment),
    );
  }
  return wildcardToRegExp(pattern.argumentPattern).test(primary);
}
