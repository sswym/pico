import { SCOPE_GLOBAL, SCOPE_PROJECT, type Scope } from "./schema.ts";

export interface ScopeQueryOptions {
  scope?: Scope;
  cwd?: string;
}

export function projectScopeKey(cwd: string): string {
  return `${SCOPE_PROJECT}:${cwd}`;
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
