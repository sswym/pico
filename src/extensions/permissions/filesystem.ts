import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import ignore from "ignore";

export function expandPath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return resolve(cwd, path);
}

function normalizeForComparison(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function pathInDirectory(path: string, directory: string): boolean {
  const abs = normalizeForComparison(resolve(path));
  const root = normalizeForComparison(resolve(directory));
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function ruleRootAndPattern(pattern: string, cwd: string): { root: string; pattern: string } {
  if (pattern.startsWith("~/")) {
    return { root: homedir(), pattern: pattern.slice(2) };
  }
  if (pattern.startsWith("/")) {
    return { root: "/", pattern: pattern.slice(1) };
  }
  if (pattern.startsWith("./")) {
    return { root: cwd, pattern: pattern.slice(2) };
  }
  return { root: cwd, pattern };
}

export function fileRuleMatchesPath(ruleContent: string, filePath: string | undefined, cwd: string): boolean {
  if (!filePath) return false;
  const { root, pattern } = ruleRootAndPattern(ruleContent, cwd);
  const absoluteFile = expandPath(filePath, cwd);
  const relativeFile = relative(resolve(root), absoluteFile).replace(/\\/g, "/");
  if (relativeFile.startsWith("..") || isAbsolute(relativeFile)) return false;

  const normalizedPattern = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
  const ig = ignore().add(normalizedPattern);
  const result = ig.test(relativeFile || ".");
  return result.ignored;
}

export function inputFilePath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ["file_path", "path", "notebook_path"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
