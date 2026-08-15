import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { basename } from "node:path";

type FooterTui = {
  requestRender?: (force?: boolean) => void;
};

type FooterData = {
  getGitBranch?: () => string | undefined;
  getExtensionStatuses?: () => unknown;
  onBranchChange?: (handler: () => void) => () => void;
};

type FooterFactory = (
  tui: FooterTui,
  theme: Theme,
  footerData: FooterData,
) => Component;

type FooterContext = Pick<ExtensionContext, "model" | "getContextUsage">;

type FooterContextWithCwd = FooterContext & { cwd?: string };

type GitStatus = {
  branch?: string;
  staged: number;
  unstaged: number;
  untracked: number;
};

type GitCache = GitStatus & {
  timestamp: number;
  /** True when the last probe timed out/was killed — longer TTL (2.1.5). */
  failed: boolean;
};

type FooterOptions = {
  getThinkingLevel?: () => string;
};

const GIT_CACHE_TTL_MS = 1200;
/** Negative cache for timed-out git (2.1.5): a slow repo (NFS, index.lock,
 *  huge worktree) previously re-spawned git every 1.2s while streaming —
 *  the timeout result was never cached. A failed probe is cached longer so
 *  the footer stops hammering the repo. */
const GIT_FAIL_TTL_MS = 30_000;
const DOT = " · ";
const PIPE = " | ";
const cachedGitStatusByCwd = new Map<string, GitCache>();
const pendingGitStatusByCwd = new Map<string, Promise<void>>();

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function contextBar(ctx: FooterContext): string {
  const usage = ctx.getContextUsage?.();
  const window = typeof usage?.contextWindow === "number" ? usage.contextWindow : 0;
  if (window > 0) {
    // tokens/percent are null when the usage is unknown (e.g. right after
    // compaction) — show "?" instead of pretending it is zero.
    const tokens = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens)
      ? formatTokens(usage.tokens)
      : "?";
    const percent = typeof usage?.percent === "number" && Number.isFinite(usage.percent)
      ? usage.percent.toFixed(1)
      : "?";
    return `${tokens}/${formatTokens(window)} (${percent}%)`;
  }
  const percent = clampPercent(usage?.percent ?? 0);
  return `${percent}%`;
}

function parseGitStatus(output: string): GitStatus {
  let branch: string | undefined;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      branch = parseGitBranch(line);
      continue;
    }
    const indexStatus = line[0];
    const worktreeStatus = line[1];

    if (indexStatus === "?" && worktreeStatus === "?") {
      untracked++;
      continue;
    }
    if (indexStatus && indexStatus !== " " && indexStatus !== "?") staged++;
    if (worktreeStatus && worktreeStatus !== " ") unstaged++;
  }

  return { branch, staged, unstaged, untracked };
}

function parseGitBranch(line: string): string | undefined {
  const raw = line.slice(3).split("...")[0]?.trim();
  if (!raw || raw === "HEAD") return undefined;
  return raw;
}

function runGitStatus(cwd: string): Promise<GitStatus | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["-C", cwd, "status", "--porcelain", "-b"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let done = false;
    const timeout = setTimeout(() => {
      proc.kill();
      finish(null);
    }, 500);

    function finish(result: GitStatus | null): void {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(result);
    }

    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.on("close", (code) => {
      finish(code === 0 ? parseGitStatus(stdout) : null);
    });
    proc.on("error", () => {
      finish(null);
    });
  });
}

function emptyGitStatus(): GitStatus {
  return { staged: 0, unstaged: 0, untracked: 0 };
}

function getCachedGitStatus(cwd: string, requestRender?: () => void): GitStatus {
  const now = Date.now();
  const cached = cachedGitStatusByCwd.get(cwd);
  if (cached && now - cached.timestamp < (cached.failed ? GIT_FAIL_TTL_MS : GIT_CACHE_TTL_MS)) {
    return cached;
  }

  if (!pendingGitStatusByCwd.has(cwd)) {
    let tracked: Promise<void>;
    tracked = runGitStatus(cwd).then((result) => {
      // A branch-change invalidation may have dropped this request (or a
      // newer one replaced it) while git was running — don't let a stale
      // result repopulate the cache.
      if (pendingGitStatusByCwd.get(cwd) !== tracked) return;
      // 2.1.5: a timed-out git must be cached as a FAILED entry (30s TTL)
      // instead of being retried on the very next render tick — slow repos
      // previously spawned a fresh git process every 1.2s during streaming.
      const next = result
        ? { ...result, timestamp: Date.now(), failed: false }
        : { ...emptyGitStatus(), timestamp: Date.now(), failed: true };
      cachedGitStatusByCwd.set(cwd, next);
      pendingGitStatusByCwd.delete(cwd);
      requestRender?.();
    });
    pendingGitStatusByCwd.set(cwd, tracked);
  }

  return cached ?? emptyGitStatus();
}

function cleanStatus(status: string): string {
  return status.replace(/\s+/g, " ").trim();
}

function compactStatus(status: string): string {
  return cleanStatus(status)
    .replace(/^LSP:\s*typescript-language-server\b/i, "LSP: typescript")
    .replace(/^MCP:\s*(\d+)\s+connected\b/i, "MCP $1 ok")
    // Failed state in the shortest unambiguous form ("!" flags the failure
    // to fitStatuses so it is never silently dropped): "MCP 1 ok 1!" instead
    // of the 12-char "MCP 1 ok 1 failed".
    .replace(/^MCP:\s*(\d+)\s+ok,\s*(\d+)\s+failed\b/i, "MCP $1 ok $2!")
    .replace(/^todos\s+/i, "todo ");
}

function extractStatusText(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value instanceof Map) {
    return Array.from(value.values()).map((item) => String(item));
  }
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).map((item) => String(item));
}

function compactModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-\d+(?:\.\d+)*$/, "")
    .replace(/-latest$/, "");
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(2)}M`;
  return `${Math.round(n / 1000000)}M`;
}

function compactThinkingLevel(level: string | undefined): string {
  if (!level || level === "off") return "";
  const labels: Record<string, string> = {
    minimal: "min",
    medium: "med",
    xhigh: "xhi",
  };
  return `think:${labels[level] ?? level}`;
}

function formatGit(branch: string | undefined, git: GitStatus): string {
  if (!branch) return "";
  const changes: string[] = [];
  if (git.unstaged > 0) changes.push(`*${git.unstaged}`);
  if (git.staged > 0) changes.push(`+${git.staged}`);
  if (git.untracked > 0) changes.push(`?${git.untracked}`);
  return changes.length > 0 ? `⎇ ${branch} ${changes.join(" ")}` : `⎇ ${branch}`;
}

function joinPipe(theme: Theme, parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part, index) => index === 0 ? theme.fg("accent", part) : theme.fg("text", part))
    .join(theme.fg("muted", PIPE));
}

/**
 * Fit a priority-ordered segment list into maxWidth by dropping trailing
 * segments (lowest priority last) before truncating. The left side of the
 * footer used to hard-truncate at the middle of the git/context segments on
 * narrow terminals — dropping them keeps model/think/dir readable.
 */
function fitSegments(theme: Theme, segments: string[], maxWidth: number): string {
  for (let keep = segments.length; keep > 0; keep--) {
    const candidate = joinPipe(theme, segments.slice(0, keep));
    if (visibleWidth(candidate) <= maxWidth) return candidate;
  }
  return truncateToWidth(theme.fg("accent", segments[0] ?? ""), Math.max(0, maxWidth));
}

/**
 * True when a status segment signals a failure. Failure indicators carry the
 * highest information value — a hidden failure looks like all-clear — so
 * fitStatuses must not drop them silently.
 */
function isFailureStatus(status: string): boolean {
  return /failed|fail|!/i.test(status);
}

/**
 * Fit status segments into maxWidth, preserving order (the last segment is
 * the accent-highlighted most-recent one). Non-failure segments are dropped
 * first when space runs out; a failure segment is kept over any number of
 * non-failure ones and ellipsis-truncated rather than dropped (P4:
 * "MCP 1 ok 1 failed" is longer than "MCP 1 ok", so a failed MCP status
 * used to vanish exactly when it mattered most).
 */
function fitStatuses(theme: Theme, statuses: string[], maxWidth: number): string {
  if (statuses.length === 0 || maxWidth <= 0) return "";
  const render = (items: string[]) =>
    items
      .map((item, index, array) => (index === array.length - 1 ? theme.fg("accent", item) : theme.fg("dim", item)))
      .join(theme.fg("muted", DOT));
  const fits = (items: string[]) => visibleWidth(render(items)) <= maxWidth;

  const fitted: string[] = [];
  for (const status of statuses) {
    if (fits([...fitted, status])) {
      fitted.push(status);
      continue;
    }
    if (!isFailureStatus(status)) {
      // The candidate list only grows from here, so later segments can't
      // fit either — keep what fit so far.
      break;
    }
    // A failure segment that does not fit with the current prefix: drop the
    // non-failure segments before it to make room.
    const failures = fitted.filter(isFailureStatus);
    if (fits([...failures, status])) {
      fitted.length = 0;
      fitted.push(...failures, status);
      continue;
    }
    // Even with only failures it still overflows: ellipsis-truncate the
    // failure itself instead of dropping it.
    const remaining = Math.max(0, maxWidth - visibleWidth(render(failures)) - visibleWidth(theme.fg("muted", DOT)));
    fitted.length = 0;
    fitted.push(...failures, truncateToWidth(theme.fg("accent", status), remaining));
    return render(fitted);
  }
  return render(fitted);
}

export function renderClaudeLikeFooterLine(
  width: number,
  ctx: FooterContextWithCwd,
  theme: Theme,
  footerData: FooterData,
  gitStatus?: GitStatus,
  options: FooterOptions = {},
): string {
  const branch = footerData.getGitBranch?.() ?? gitStatus?.branch;
  const git = gitStatus ?? emptyGitStatus();
  const statuses = extractStatusText(footerData.getExtensionStatuses?.())
    .map((status) => compactStatus(status))
    .filter(Boolean)
    .slice(0, 5);
  const model = ctx.model?.id ?? "no-model";
  const project = ctx.cwd ? basename(ctx.cwd) : "pico";
  const gitText = formatGit(branch, git);
  const thinking = compactThinkingLevel(options.getThinkingLevel?.());

  const leftSegments = [
    width < 96 ? compactModel(model) : model,
    thinking,
    `dir ${project}`,
    gitText,
    `◫ ${contextBar(ctx)}`,
  ];
  const minGap = 2;
  // Right-side statuses keep their fit-first behaviour; the left side drops
  // trailing segments (git details, context usage) before truncating.
  const leftMax = Math.max(0, width - minGap - Math.min(20, Math.floor(width * 0.25)));
  const left = fitSegments(theme, leftSegments, leftMax);
  const rightMaxWidth = Math.max(0, width - visibleWidth(left) - minGap);
  const right = fitStatuses(theme, statuses, rightMaxWidth);

  if (!right) {
    return truncateToWidth(left, width);
  }

  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap <= 2) {
    return truncateToWidth(`${left}${theme.fg("muted", DOT)}${right}`, width);
  }
  return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width);
}

export function renderPrimaryStatusLine(
  width: number,
  ctx: FooterContextWithCwd,
  theme: Theme,
  gitStatus?: GitStatus,
  options: FooterOptions = {},
): string {
  const model = ctx.model?.id ?? "no-model";
  const project = ctx.cwd ? basename(ctx.cwd) : "pico";
  const thinking = compactThinkingLevel(options.getThinkingLevel?.());
  const parts = [
    width < 96 ? compactModel(model) : model,
    thinking,
    `dir ${project}`,
    formatGit(gitStatus?.branch, gitStatus ?? emptyGitStatus()),
    `◫ ${contextBar(ctx)} AC`,
  ];
  return fitSegments(theme, parts, width);
}

export function renderExtensionStatusLine(width: number, theme: Theme, footerData: FooterData): string {
  const statuses = extractStatusText(footerData.getExtensionStatuses?.())
    .map((status) => compactStatus(status))
    .filter(Boolean)
    .slice(0, 5);
  return fitStatuses(theme, statuses, width);
}

export function createPrimaryStatusWidget(ctx: FooterContextWithCwd, options: FooterOptions = {}): FooterFactory {
  return (tui, theme) => ({
    render(width: number): string[] {
      const git = getCachedGitStatus(ctx.cwd ?? process.cwd(), () => tui.requestRender?.());
      return [renderPrimaryStatusLine(width, ctx, theme, git, options)];
    },
    invalidate(): void {},
  });
}

export function createClaudeLikeFooter(ctx: FooterContextWithCwd): FooterFactory {
  return (tui, theme, footerData) => {
    const cwd = ctx.cwd ?? process.cwd();
    const unsubscribe = footerData.onBranchChange?.(() => {
      // An external `git checkout` never reaches pi — drop the cached branch
      // (and any in-flight request) for this cwd so the next render refetches
      // instead of serving the pre-checkout branch for the rest of the TTL.
      cachedGitStatusByCwd.delete(cwd);
      pendingGitStatusByCwd.delete(cwd);
      tui.requestRender?.();
    });
    return {
      render(width: number): string[] {
        return [renderExtensionStatusLine(width, theme, footerData)];
      },
      invalidate(): void {},
      dispose(): void {
        unsubscribe?.();
      },
    };
  };
}

export function installClaudeLikeFooter(ctx: ExtensionContext, options: FooterOptions = {}): void {
  const ui = ctx.ui as ExtensionContext["ui"] & {
    setFooter?: (factory: FooterFactory | undefined) => void;
    setWidget?: (key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
  };
  ui.setWidget?.("pico-primary-status", createPrimaryStatusWidget(ctx, options), { placement: "aboveEditor" });
  ui.setFooter?.(createClaudeLikeFooter(ctx));
}

export function __resetFooterStateForTests(): void {
  cachedGitStatusByCwd.clear();
  pendingGitStatusByCwd.clear();
}

export const __test = {
  compactStatus,
  compactThinkingLevel,
  formatGit,
  parseGitStatus,
  cachedGitStatusByCwd,
  pendingGitStatusByCwd,
};
