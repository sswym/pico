/**
 * srcode hooks extension — wires the file-driven hook config into pi's
 * tool & session lifecycle.
 *
 * Events handled:
 *  - tool_call           → PreToolUse  (can block when hook.blocking !== false)
 *  - tool_result         → PostToolUse (warn-only on failure)
 *  - turn_end            → PostUserMessage (rough mapping; pi has no
 *                          dedicated post-user-message event)
 *  - session_shutdown    → PreSessionEnd
 *
 * Placeholder substitution pulls $FILE from the tool input (`path` for
 * built-in read/edit/write, or `file_path`/`path` for custom tools), $TOOL
 * from `event.toolName`, and $TURN from `turn_end.turnIndex`.
 *
 * Errors inside hook execution never escape. On runner failure we either
 * block the tool (PreToolUse + blocking) or emit a `srcode.hook.warn`
 * custom message.
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { type Hook, loadHooks } from "./config.ts";
import { type HookVars, runHook } from "./runner.ts";

export { loadHooks, type Hook } from "./config.ts";
export { runHook, substitute } from "./runner.ts";

function extractFilePath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const fp = input.file_path;
  if (typeof fp === "string" && fp.length > 0) return fp;
  const p = input.path;
  if (typeof p === "string" && p.length > 0) return p;
  return undefined;
}

function matches(hook: Hook, event: Hook["event"], toolName: string | undefined): boolean {
  if (hook.event !== event) return false;
  if (event === "PreToolUse" || event === "PostToolUse") {
    if (hook.tool && hook.tool !== toolName) return false;
  }
  return true;
}

/**
 * Dependency-injected factory. Production code uses `hooksExtension` below
 * which wires up the real loader & runner; tests pass their own.
 */
export function createHooksExtension(deps: {
  load: (cwd: string) => Hook[];
  run: (hook: Hook, vars: HookVars) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>;
  cwd?: () => string;
}): ExtensionFactory {
  const { load, run } = deps;
  const cwdFn = deps.cwd ?? (() => process.cwd());

  return (pi: ExtensionAPI) => {
    let cached: Hook[] | undefined;
    function hooks(): Hook[] {
      if (!cached) cached = load(cwdFn());
      return cached;
    }

    function warn(content: string): void {
      try {
        pi.sendMessage({
          customType: "srcode.hook.warn",
          content,
          display: true,
        });
      } catch {
        // non-TUI mode may drop custom messages
      }
      // Surface to stderr too — useful for non-interactive runs / CI.
      try {
        console.warn(`[srcode hooks] ${content}`);
      } catch {}
    }

    pi.on("tool_call", async (event: ToolCallEvent) => {
      const matching = hooks().filter((h) => matches(h, "PreToolUse", event.toolName));
      if (matching.length === 0) return {};

      const vars: HookVars = {
        FILE: extractFilePath(event.input as Record<string, unknown>) ?? "",
        TOOL: event.toolName,
      };

      for (const hook of matching) {
        const res = await run(hook, vars);
        const blocking = hook.blocking ?? true;
        const failed = res.timedOut || res.exitCode !== 0;
        if (failed && blocking) {
          const why = res.timedOut
            ? `timed out after ${hook.timeoutMs ?? 30000}ms`
            : `exit ${res.exitCode}`;
          const detail = (res.stderr || res.stdout || "").trim();
          const reason = detail.length > 0
            ? `PreToolUse hook \`${hook.command}\` ${why}: ${detail}`
            : `PreToolUse hook \`${hook.command}\` ${why}`;
          return { block: true, reason };
        }
        if (failed) {
          warn(`PreToolUse hook \`${hook.command}\` failed (${res.timedOut ? "timeout" : `exit ${res.exitCode}`}); not blocking (blocking=false)`);
        }
      }
      return {};
    });

    pi.on("tool_result", async (event: ToolResultEvent) => {
      const matching = hooks().filter((h) => matches(h, "PostToolUse", event.toolName));
      if (matching.length === 0) return {};

      const vars: HookVars = {
        FILE: extractFilePath(event.input) ?? "",
        TOOL: event.toolName,
      };

      for (const hook of matching) {
        const res = await run(hook, vars);
        if (res.timedOut || res.exitCode !== 0) {
          const why = res.timedOut ? "timeout" : `exit ${res.exitCode}`;
          warn(`PostToolUse hook \`${hook.command}\` ${why}`);
        }
      }
      return {};
    });

    pi.on("turn_end", async (event) => {
      const matching = hooks().filter((h) => h.event === "PostUserMessage");
      if (matching.length === 0) return;

      const vars: HookVars = {
        TURN: String(event.turnIndex ?? ""),
      };

      for (const hook of matching) {
        const res = await run(hook, vars);
        if (res.timedOut || res.exitCode !== 0) {
          const why = res.timedOut ? "timeout" : `exit ${res.exitCode}`;
          warn(`PostUserMessage hook \`${hook.command}\` ${why}`);
        }
      }
    });

    pi.on("session_shutdown", async () => {
      const matching = hooks().filter((h) => h.event === "PreSessionEnd");
      if (matching.length === 0) return;

      for (const hook of matching) {
        const res = await run(hook, {});
        if (res.timedOut || res.exitCode !== 0) {
          // Session is going away — sendMessage may not deliver anywhere
          // useful, so just log to stderr.
          const why = res.timedOut ? "timeout" : `exit ${res.exitCode}`;
          try {
            console.warn(`[srcode hooks] PreSessionEnd hook \`${hook.command}\` ${why}`);
          } catch {}
        }
      }
    });
  };
}

/** Production extension: loads from disk, runs via Bun.spawn. */
export const hooksExtension: ExtensionFactory = createHooksExtension({
  load: loadHooks,
  run: runHook,
});
