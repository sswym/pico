/**
 * srcode hooks — subprocess runner.
 *
 * Each hook runs as `sh -c <command>` via Bun.spawn so we can hard-kill on
 * timeout. Output streams are decoded as utf8 and truncated to 4 KiB each
 * so a runaway formatter can't blow up the agent's memory.
 *
 * `vars` carries the placeholder values. We substitute literally — no
 * shell quoting magic — so callers should pre-validate that values
 * don't contain shell metacharacters they care about. The placeholder
 * keys are uppercase ($FILE, $TOOL, $TURN, etc.); unknown ones are
 * left as-is.
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

/**
 * Replace `$FOO` style placeholders in `template` from the `vars` map.
 * Missing or undefined keys collapse to the empty string. This keeps the
 * common case (no $TURN known yet) producing a clean command line rather
 * than a literal `$TURN`.
 */
export function substitute(template: string, vars: HookVars): string {
  return template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const v = vars[name];
    return v === undefined ? "" : v;
  });
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
    });
    const child = proc;
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, timeoutMs);

    // Wait for exit FIRST. Reading the streams concurrently with `exited`
    // can hang on SIGKILL'd children: Bun's stream wrappers don't all
    // close on signal, and `new Response(stream).text()` will then sit
    // waiting for the (closed-but-not-EOF) pipe forever.
    const exitCode = await child.exited;
    if (timer) clearTimeout(timer);
    timer = undefined;

    let stdout = "";
    let stderr = "";
    if (!timedOut) {
      stdout = await readAll(child.stdout as ReadableStream<Uint8Array>);
      stderr = await readAll(child.stderr as ReadableStream<Uint8Array>);
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
