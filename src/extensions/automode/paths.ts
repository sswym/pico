import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
} from "node:path";
import { HOME, PATH_BEARING_TOOLS, PROFILE_FILES } from "./constants.ts";

function stripLeadingAt(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

export function resolveInputPath(
  cwd: string,
  value: unknown,
): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const raw = stripLeadingAt(value.trim());
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}

/** The target path a file tool operates on, from `input.path` (or undefined). */
export function extractInputPath(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!PATH_BEARING_TOOLS.has(toolName)) return undefined;
  const value = input.path;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Expand a leading `~`, `$HOME`, or `${HOME}` in a path-denial pattern. */
export function expandHomePattern(pattern: string): string {
  const home = HOME.replace(/\\/g, "/");
  if (pattern === "~" || pattern === "$HOME" || pattern === "${HOME}") {
    return home;
  }
  if (pattern.startsWith("~/")) return `${home}/${pattern.slice(2)}`;
  if (pattern.startsWith("$HOME/")) return `${home}/${pattern.slice(6)}`;
  if (pattern.startsWith("${HOME}/")) return `${home}/${pattern.slice(8)}`;
  return pattern;
}

export function normalizePathForMatch(path: string, cwd: string): string {
  const normalized = normalize(path);
  const rel = relative(cwd, normalized);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : normalized;
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve symlinks through the nearest existing ancestor of a path. */
export function resolvePathForPolicy(path: string): string | undefined {
  return resolvePathForPolicyInner(resolve(path), new Set<string>());
}

function resolvePathForPolicyInner(
  path: string,
  visitedSymlinks: Set<string>,
): string | undefined {
  let current = path;
  const missingSegments: string[] = [];

  while (true) {
    try {
      return resolve(realpathSync(current), ...missingSegments);
    } catch {
      try {
        const stat = lstatSync(current);
        if (!stat.isSymbolicLink() || visitedSymlinks.has(current)) {
          return undefined;
        }
        visitedSymlinks.add(current);
        const target = resolve(dirname(current), readlinkSync(current));
        return resolvePathForPolicyInner(
          resolve(target, ...missingSegments),
          visitedSymlinks,
        );
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String(error.code)
          : undefined;
        if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
        const parent = dirname(current);
        if (parent === current) return undefined;
        missingSegments.unshift(basename(current));
        current = parent;
      }
    }
  }
}

export function matchesProtectedPath(
  relativePath: string,
  protectedPaths: string[],
): boolean {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  return protectedPaths.some((pattern) => {
    const normalizedPattern = pattern.replace(/\\/g, "/");
    return normalizedPath === normalizedPattern ||
      normalizedPath.startsWith(`${normalizedPattern}/`);
  });
}

export function isProtectedPath(
  path: string,
  cwd: string,
  protectedPaths: string[],
): boolean {
  // Resolve through the nearest existing ancestor so symlinked directories are
  // respected even when the final write target does not exist yet.
  const resolved = resolvePathForPolicy(path) ?? path;
  const resolvedCwd = resolvePathForPolicy(cwd) ?? cwd;

  // For paths inside the project: use relative path for matching.
  if (isInside(resolved, resolvedCwd)) {
    return matchesProtectedPath(
      relative(resolvedCwd, resolved),
      protectedPaths,
    );
  }

  // For paths outside the project: check every path component suffix.
  // This catches writes like ../other-project/.git/config even when cwd
  // doesn't contain the target.
  const normalizedResolved = resolved.replace(/\\/g, "/");
  const segments = normalizedResolved.split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    if (matchesProtectedPath(segments.slice(i).join("/"), protectedPaths)) {
      return true;
    }
  }
  return false;
}

export function isSafetyControlPath(path: string, cwd: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const file = basename(normalized).toLowerCase();
  if (
    normalized.endsWith("/.pico/automode.json") ||
    normalized.endsWith("/.pico/automode.local.json") ||
    normalized.endsWith("/automode.json") ||
    normalized.endsWith("/auto-mode.json")
  ) {
    return true;
  }
  if (normalized.includes("/.pico/extensions/") && file.includes("auto")) {
    return true;
  }
  if (normalized.includes("/.pico/") && file.startsWith("automode")) return true;
  if (
    normalized.includes("/pi-automode/") ||
    (isInside(path, cwd) && file.includes("auto-mode"))
  ) {
    return true;
  }
  return false;
}

export function shellPathTokenToPath(
  token: string,
  cwd: string,
): string | undefined {
  let value = token.trim();
  if (!value || value === "-" || value.startsWith("&")) return undefined;
  value = value
    .replace(/^\$HOME(?=\/|$)/, HOME)
    .replace(/^\$\{HOME\}(?=\/|$)/, HOME);
  if (value.startsWith("~/")) value = resolve(HOME, value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export function isProfileOrAuthorizedKeysPath(
  path: string,
): string | undefined {
  if (PROFILE_FILES.has(path)) {
    return "shell profile modification is hard-denied";
  }
  if (path === resolve(HOME, ".ssh/authorized_keys")) {
    return "SSH authorized_keys modification is hard-denied";
  }
  return undefined;
}
