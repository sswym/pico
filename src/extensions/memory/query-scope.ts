import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { SCOPE_GLOBAL, SCOPE_PROJECT, type Scope } from "./schema.ts";

export interface ScopeQueryOptions {
  scope?: Scope;
  cwd?: string;
}

/** Marker files that identify a directory as a project root. */
function isProjectRoot(dir: string): boolean {
  return existsSync(join(dir, ".git")) || existsSync(join(dir, "package.json"));
}

/**
 * Normalize a cwd into a stable project identity:
 * 1. realpath (resolves symlinks) — symlinked checkouts must not fragment.
 * 2. walk up to the nearest project root (.git / package.json), bounded to
 *    avoid escaping into unrelated directories; sessions started in a
 *    project subdirectory share the parent project's memory.
 * 3. strip trailing slashes.
 */
export function normalizeProjectCwd(cwd: string): string {
  let resolved = cwd;
  try {
    resolved = realpathSync(cwd);
  } catch {
    // realpath can fail for synthetic paths (virtual FS, deleted dir);
    // fall back to the raw path.
  }
  if (isProjectRoot(resolved)) return resolved;
  let dir = resolved;
  for (let depth = 0; depth < 4 && dir.length > 1; depth++) {
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    if (!parent || parent === dir) break;
    dir = parent;
    if (isProjectRoot(dir)) {
      resolved = dir;
      break;
    }
  }
  while (resolved.length > 1 && resolved.endsWith("/")) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

export function projectScopeKey(cwd: string): string {
  return `${SCOPE_PROJECT}:${normalizeProjectCwd(cwd)}`;
}

export function scopeFilter(
  opts: ScopeQueryOptions,
  tableAlias = "f",
): {
  clause: string;
  params: string[];
  projectScope?: string;
} {
  if (opts.scope === SCOPE_PROJECT && opts.cwd) {
    const projectScope = projectScopeKey(opts.cwd);
    return {
      clause: `AND (${tableAlias}.scope = ? OR ${tableAlias}.scope = ?)`,
      params: [SCOPE_GLOBAL, projectScope],
      projectScope,
    };
  }
  return {
    clause: `AND ${tableAlias}.scope = ?`,
    params: [opts.scope ?? SCOPE_GLOBAL],
  };
}

export function scoreScopeBoost(score: number, factScope: string, projectScope: string | undefined): number {
  return projectScope && factScope === projectScope ? score * 1.5 : score;
}
