/**
 * pico hooks — config loader.
 *
 * Hook config is JSON, merged from two layers when project hooks are
 * explicitly enabled (later layer appended after the earlier; duplicates
 * collapsed by `event|tool|command`):
 *   1) ~/.pico/hooks.json (or $PICO_HOME/pico/hooks.json)
 *   2) <cwd>/.pico/hooks.json (requires PICO_ENABLE_PROJECT_HOOKS=1)
 *
 * Missing files are not an error. Malformed JSON / wrong shape is logged
 * once per path and the layer is skipped — we never throw out of
 * `loadHooks`, hooks are best-effort decoration around tool calls.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { picoHome } from "../paths.ts";
import { allowProjectHooks } from "../policy.ts";

export type HookEvent = "PreToolUse" | "PostToolUse" | "PreSessionEnd" | "PostUserMessage";

export interface Hook {
  event: HookEvent;
  /** Match the tool name exactly. Only meaningful for PreToolUse / PostToolUse. */
  tool?: string;
  /** Shell command. Supports $FILE / $TOOL / $TURN substitution. */
  command: string;
  /** Default 30000, capped at 120000. */
  timeoutMs?: number;
  /**
   * PreToolUse only. When true (default), a non-zero exit blocks the tool
   * call. Has no effect on the other events.
   */
  blocking?: boolean;
}

const VALID_EVENTS: ReadonlySet<HookEvent> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PreSessionEnd",
  "PostUserMessage",
]);

const TIMEOUT_DEFAULT = 30_000;
const TIMEOUT_MAX = 120_000;

const warnedPaths = new Set<string>();
/** Config errors accumulated since the last drain — surfaced to the TUI at
 *  session_start (2.5.8): a malformed security-hook config must not vanish
 *  into stderr where TUI users never see it. */
const recentErrors: string[] = [];

function warnOnce(path: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const line = `[pico hooks] ignoring ${path}: ${msg}`;
  console.warn(line);
  recentErrors.push(line);
  if (warnedPaths.has(path)) return;
  warnedPaths.add(path);
}

/** Return and clear the accumulated config errors. */
export function drainHookConfigErrors(): string[] {
  return recentErrors.splice(0);
}

/** Reset the once-per-path warning cache. Test-only. */
export function __resetWarnedPaths(): void {
  warnedPaths.clear();
  recentErrors.length = 0;
}

export function hookConfigPaths(cwd: string): string[] {
  return [
    join(picoHome(), "hooks.json"),
    join(resolve(cwd), ".pico", "hooks.json"),
  ];
}

function normalize(raw: unknown, sourcePath: string): Hook[] {
  if (!raw || typeof raw !== "object") {
    warnOnce(sourcePath, new Error("expected an object with `hooks` array"));
    return [];
  }
  const list = (raw as { hooks?: unknown }).hooks;
  if (!Array.isArray(list)) {
    warnOnce(sourcePath, new Error("`hooks` is not an array"));
    return [];
  }
  const out: Hook[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") {
      warnOnce(`${sourcePath}#${i}`, new Error(`hook entry ${i} is not an object; skipped`));
      continue;
    }
    const obj = item as Record<string, unknown>;
    const event = obj.event;
    if (typeof event !== "string" || !VALID_EVENTS.has(event as HookEvent)) {
      warnOnce(`${sourcePath}#${i}`, new Error(`hook entry ${i} has invalid event; skipped`));
      continue;
    }
    const command = obj.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      warnOnce(`${sourcePath}#${i}`, new Error(`hook entry ${i} has no valid command; skipped`));
      continue;
    }
    const hook: Hook = { event: event as HookEvent, command };
    if (typeof obj.tool === "string" && obj.tool.length > 0) hook.tool = obj.tool;
    if (typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0) {
      hook.timeoutMs = Math.min(obj.timeoutMs, TIMEOUT_MAX);
    }
    if (typeof obj.blocking === "boolean") hook.blocking = obj.blocking;
    out.push(hook);
  }
  return out;
}

function loadOne(path: string): Hook[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return normalize(raw, path);
  } catch (err) {
    warnOnce(path, err);
    return [];
  }
}

function dedupeKey(h: Hook): string {
  return `${h.event}|${h.tool ?? ""}|${h.command}`;
}

/**
 * Load and merge hooks for the given working directory. Home layer runs
 * first; cwd layer is appended afterwards when PICO_ENABLE_PROJECT_HOOKS=1.
 * Order is preserved within each layer, and duplicates (same event+tool+
 * command) keep the LAST occurrence — so a project layer can deliberately
 * override a home-layer hook with the same key (2.5.8).
 */
export function loadHooks(cwd: string): Hook[] {
  const [homePath, cwdPath] = hookConfigPaths(cwd);
  // 2.2.3: a project hooks.json that is silently ignored looks like a broken
  // security setup — note it (drained & surfaced at session_start).
  if (!allowProjectHooks() && existsSync(cwdPath!)) {
    const line = "[pico hooks] 检测到项目 hooks 配置（.pico/hooks.json），但当前被安全策略禁用（PICO_ENABLE_PROJECT_HOOKS 未开启）。";
    recentErrors.push(line);
    console.warn(line);
  }
  const merged = [
    ...loadOne(homePath!),
    ...(allowProjectHooks() ? loadOne(cwdPath!) : []),
  ];

  // Keep the LAST occurrence of each dedupe key (project layer may
  // deliberately override a home hook with the same event+tool+command).
  const seen = new Set<string>();
  const out: Hook[] = [];
  for (let i = merged.length - 1; i >= 0; i--) {
    const h = merged[i]!;
    const k = dedupeKey(h);
    if (seen.has(k)) continue;
    seen.add(k);
    out.unshift({
      ...h,
      timeoutMs: h.timeoutMs ?? TIMEOUT_DEFAULT,
      blocking: h.blocking ?? true,
    });
  }
  return out;
}
