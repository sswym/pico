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

/**
 * Locate heredoc body ranges (`<<EOF ... EOF`). Inside them everything is
 * literal text, so placeholders must NOT be substituted — the body may be
 * written verbatim to a file.
 */
function heredocRanges(template: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = template.split("\n");
  const lineStart = new Array<number>(lines.length);
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStart[i] = pos;
    pos += lines[i]!.length + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    const m = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(lines[i]!);
    if (!m) continue;
    const delim = m[1]!;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== delim) j++;
    if (j >= lines.length) continue; // unterminated heredoc — leave untouched
    ranges.push([lineStart[i]! + lines[i]!.length + 1, lineStart[j]!]);
    i = j;
  }
  return ranges;
}

export function substitute(template: string, vars: HookVars): string {
  const heredocs = heredocRanges(template);
  return template.replace(PLACEHOLDER_RE, (match, name: string, offset: number) => {
    const v = vars[name];
    if (v === undefined) return match;
    // Escaped placeholder (`\$FILE`) stays literal.
    let backslashes = 0;
    for (let i = offset - 1; i >= 0 && template[i] === "\\"; i--) backslashes++;
    if (backslashes % 2 === 1) return match;
    // Heredoc bodies are literal text.
    for (const [start, end] of heredocs) {
      if (offset >= start && offset < end) return match;
    }
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
  // Double-quoted values only need `"`, `\`, `$`, backtick escaped. Real
  // newlines stay VERBATIM: POSIX sh does not interpret `\n` inside double
  // quotes, so replacing them with backslash-n would corrupt multi-line
  // $FILE values instead of quoting them.
  if (context === "double") return value.replace(/(["\\$`])/g, "\\$1");
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
  // Read incrementally and stop accumulating at the cap — `new Response(stream).text()`
  // would materialize the whole stream first, so a 120s `yes` run could
  // still accumulate hundreds of MB before truncation.
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let out = "";
  let capped = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (capped) continue;
      out += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(out, "utf8") >= TRUNCATE_BYTES) {
        // Past the cap, keep draining (discarding) instead of cancelling:
        // cancelling the read end makes the writer hit EPIPE/SIGPIPE, so a
        // hook whose output merely exceeded the cap would report a failure
        // exit code (141) for a command that succeeded. A runaway writer is
        // still bounded by the hook timeout, which kills the process group.
        capped = true;
      }
    }
  } catch {
    return "";
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released/cancelled — fine
    }
  }
  return truncate(out + decoder.decode());
}

/**
 * Run `hook.command` with placeholder substitution. Returns exit metadata
 * even on timeout / spawn failure — we never throw out of here.
 */
export async function runHook(hook: Hook, vars: HookVars, cwd?: string): Promise<HookRunResult> {
  const command = substitute(hook.command, vars);
  const timeoutMs = hook.timeoutMs ?? 30_000;

  let timedOut = false;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    proc = Bun.spawn(["sh", "-c", command], {
      cwd: cwd ?? process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // Leader of its own process group so a timeout can kill sh AND its
      // children — otherwise grandchildren (npm/node subprocesses) survive
      // and keep the stdout pipe open forever.
      detached: true,
      // Recursion guard (2.5.8): a hook that invokes `pico` itself would
      // spawn a full nested agent (which may run hooks again — infinite
      // nesting). bin/pico.ts refuses to start under this marker.
      env: { ...process.env, PICO_HOOK_RECURSION_GUARD: "1" },
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
