/**
 * RTK integration.
 *
 * RTK is an optional external binary that rewrites noisy shell commands to
 * compact equivalents (`git status` -> `rtk git status`, etc.). The rewrite
 * rules live in RTK itself; srcode only delegates to `rtk rewrite` before the
 * built-in bash tool runs.
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

export type RtkVerdict = "allow" | "passthrough" | "deny" | "ask" | "unavailable";

export interface RtkRewriteResult {
  verdict: RtkVerdict;
  command?: string;
  reason?: string;
}

export interface RtkDeps {
  rewrite: (command: string) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
  }>;
  warn?: (message: string) => void;
}

export interface RtkExtensionOptions {
  /** Default true. */
  enabled?: boolean;
  /** Default false. */
  verbose?: boolean;
}

const REWRITE_TIMEOUT_MS = 2_000;

export async function runRtkRewrite(command: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    proc = Bun.spawn(["rtk", "rewrite", command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const child = proc;
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, REWRITE_TIMEOUT_MS);

    const exitCode = await child.exited;
    if (timer) clearTimeout(timer);
    timer = undefined;

    if (timedOut) {
      return { exitCode: -1, stdout: "", stderr: "rtk rewrite timed out", timedOut };
    }

    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    return {
      exitCode: typeof exitCode === "number" ? exitCode : -1,
      stdout,
      stderr,
      timedOut,
    };
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

export function interpretRtkRewrite(command: string, result: {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}): RtkRewriteResult {
  const rewritten = result.stdout.trim();

  if (result.exitCode === 0) {
    return rewritten.length > 0 && rewritten !== command
      ? { verdict: "allow", command: rewritten }
      : { verdict: "passthrough" };
  }

  if (result.exitCode === 1) {
    return { verdict: "passthrough" };
  }

  if (result.exitCode === 2) {
    return { verdict: "deny", reason: "RTK deny rule matched" };
  }

  if (result.exitCode === 3) {
    return rewritten.length > 0 && rewritten !== command
      ? { verdict: "ask", command: rewritten }
      : { verdict: "passthrough" };
  }

  const reason = result.timedOut
    ? "rtk rewrite timed out"
    : (result.stderr.trim() || `rtk rewrite exited ${result.exitCode}`);
  return { verdict: "unavailable", reason };
}

function isBashCommand(event: ToolCallEvent): event is ToolCallEvent & {
  toolName: "bash";
  input: { command: string; timeout?: number };
} {
  return event.toolName === "bash"
    && typeof (event.input as { command?: unknown }).command === "string";
}

function notify(pi: ExtensionAPI, message: string, level: "info" | "warning" = "info"): void {
  try {
    pi.sendMessage({
      customType: "srcode.rtk",
      content: message,
      display: true,
    });
  } catch {
    // Non-TUI runs may ignore custom messages.
  }
  try {
    console[level === "warning" ? "warn" : "log"](`[srcode rtk] ${message}`);
  } catch {}
}

export function createRtkExtension(
  deps: RtkDeps = { rewrite: runRtkRewrite },
  options: RtkExtensionOptions = {},
): ExtensionFactory {
  const enabled = options.enabled ?? process.env.SRCODE_RTK !== "0";
  const verbose = options.verbose ?? process.env.SRCODE_RTK_VERBOSE === "1";

  return (pi: ExtensionAPI) => {
    let status: RtkRewriteResult | undefined;

    pi.registerCommand("rtk", {
      description: "Show RTK shell-command rewrite status",
      handler: async (_args, ctx) => {
        if (!enabled) {
          ctx.ui.notify("RTK rewrite: disabled (SRCODE_RTK=0)", "warning");
          return;
        }
        const probe = interpretRtkRewrite("git status", await deps.rewrite("git status"));
        status = probe;
        const lines = ["srcode RTK"];
        if (probe.verdict === "allow" || probe.verdict === "ask") {
          lines.push("status: available");
          lines.push(`example: git status -> ${probe.command}`);
        } else if (probe.verdict === "passthrough") {
          lines.push("status: available, but probe was not rewritten");
        } else {
          lines.push(`status: ${probe.verdict}`);
          if (probe.reason) lines.push(`reason: ${probe.reason}`);
        }
        ctx.ui.notify(lines.join("\n"), probe.verdict === "unavailable" ? "warning" : "info");
      },
    });

    pi.on("tool_call", async (event) => {
      if (!enabled || !isBashCommand(event)) return {};

      const original = event.input.command;
      const rewrite = interpretRtkRewrite(original, await deps.rewrite(original));
      status = rewrite;

      if (rewrite.verdict === "deny") {
        return { block: true, reason: rewrite.reason ?? "RTK deny rule matched" };
      }

      if (rewrite.verdict === "allow" && rewrite.command) {
        event.input.command = rewrite.command;
        if (verbose) {
          notify(pi, `rewrote: ${original} -> ${rewrite.command}`);
        }
        return {};
      }

      // "ask" means RTK is unsure. Do NOT silently swap the command the user
      // already approved — surface the suggestion and run the original as-is.
      if (rewrite.verdict === "ask" && rewrite.command) {
        notify(pi, `suggests: ${original} -> ${rewrite.command} (running original; rewrite not applied)`);
        return {};
      }

      if (rewrite.verdict === "unavailable" && verbose) {
        deps.warn?.(rewrite.reason ?? "rtk unavailable");
        notify(pi, rewrite.reason ?? "rtk unavailable", "warning");
      }

      return {};
    });

    pi.on("session_start", () => {
      status = undefined;
    });
  };
}

export const rtkExtension: ExtensionFactory = createRtkExtension();

export default rtkExtension;
