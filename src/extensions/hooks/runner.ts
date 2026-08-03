/**
 * pico hooks — subprocess runner.
 *
 * Each hook runs as `sh -c <command>` via Bun.spawn so we can hard-kill on
 * timeout. Output streams are decoded as utf8 and truncated to 4 KiB each
 * so a runaway formatter can't blow up the agent's memory.
 *
 * `vars` carries the placeholder values. Values are shell-quoted according
 * to their surrounding quote context before the command is passed to `sh -c`.
 * The placeholder keys are uppercase ($FILE, $TOOL, $TURN, etc.); unknown
 * ones are left untouched so the shell expands real environment variables
 * ($HOME, $PATH, ...) instead of silently collapsing them to empty strings.
 */
import type { Hook } from "./config.ts";

export interface HookRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the timeout fired and we killed the subprocess. */
  timedOut: boolean;
}

export type HookVars = Record<string, string | undefined>;

const TRUNCATE_BYTES = 4 * 1024;
const PLACEHOLDER_RE = /\$([A-Z][A-Z0-9_]*)/g;

export function substitute(template: string, vars: HookVars): string {
  return template.replace(PLACEHOLDER_RE, (match, name: string, offset: number) => {
    const v = vars[name];
    if (v === undefined) return match;
    return quoteForShellContext(String(v), quoteContextAt(template, offset + match.length));
  });
}

type QuoteContext = "none" | "single" | "double";

function quoteContextAt(template: string, endOffset: number): QuoteContext {
  let context: QuoteContext = "none";
  for (let i = 0; i < endOffset; i++) {
    const ch = template[i];
    if (ch === "\\" && context !== "single") {
      i++;
      continue;
    }
    if (ch === "'" && context !== "double") {
      context = context === "single" ? "none" : "single";
    } else if (ch === '"' && context !== "single") {
      context = context === "double" ? "none" : "double";
    }
  }
  return context;
}

function quoteForShellContext(value: string, context: QuoteContext): string {
  if (context === "double") return value.replace(/(["\\$`])/g, "\\$1").replace(/\n/g, "\\n");
  if (context === "single") return value.replace(/'/g, "'\\''");
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function truncate(s: string): string {
  if (s.length <= TRUNCATE_BYTES) return s;
  return `${s.slice(0, TRUNCATE_BYTES)}\n…[truncated]`;
}

async function readAll(stream: ReadableStream<Uint8Array> | undefined | null): Promise<string> {
  if (!stream) return "";
  try {
    return truncate(await new Response(stream).text());
  } catch {
    return "";
  }
}

/**
 * Run `hook.command` with placeholder substitution. Returns exit metadata
 * even on timeout / spawn failure — we never throw out of here.
 */
export async function runHook(hook: Hook, vars: HookVars): Promise<HookRunResult> {
  const command = substitute(hook.command, vars);
  const timeoutMs = hook.timeoutMs ?? 30_000;

  let timedOut = false;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    proc = Bun.spawn(["sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // Leader of its own process group so a timeout can kill sh AND its
      // children — otherwise grandchildren (npm/node subprocesses) survive
      // and keep the stdout pipe open forever.
      detached: true,
    });
    const child = proc;
    timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Process group already gone — fall back to the direct child.
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }
    }, timeoutMs);

    // Drain stdout/stderr CONCURRENTLY with the exit wait. Reading only
    // after `exited` deadlocks any hook that produces more than the pipe
    // buffer (~64KB): the child blocks writing stdout, never exits, and is
    // killed by the timeout instead of finishing normally.
    const stdoutPromise = readAll(child.stdout as ReadableStream<Uint8Array>);
    const stderrPromise = readAll(child.stderr as ReadableStream<Uint8Array>);
    const exitCode = await child.exited;
    if (timer) clearTimeout(timer);
    timer = undefined;

    let stdout = "";
    let stderr = "";
    if (!timedOut) {
      // Normal exit: the pipe is closed, so the concurrent reads finish.
      // After a timeout SIGKILL the streams may never EOF — don't await them.
      stdout = await stdoutPromise;
      stderr = await stderrPromise;
    }
    return { exitCode: typeof exitCode === "number" ? exitCode : -1, stdout, stderr, timedOut };
  } catch (err) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      timedOut,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const HOOK_TRUNCATE_BYTES = TRUNCATE_BYTES;
