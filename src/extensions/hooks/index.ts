/**
 * pico hooks extension — wires the file-driven hook config into pi's
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
 * block the tool (PreToolUse + blocking) or surface a warning to the TUI via
 * ctx.ui.notify — deliberately NOT a session custom message: pi projects
 * every custom_message into the model context (display only controls TUI
 * rendering), so hook internals (command text, file paths) would reach the
 * model and read as "sandbox injection" (D13-F2).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { type Hook, loadHooks, drainHookConfigErrors } from "./config.ts";
import { type HookVars, runHook } from "./runner.ts";
import { allowProjectHooks } from "../policy.ts";
import { log } from "../logging.ts";

export { type Hook } from "./config.ts";

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
  run: (hook: Hook, vars: HookVars, cwd?: string) => Promise<{
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
    let cached: { cwd: string; hooks: Hook[] } | undefined;
    function hooks(): Hook[] {
      const cwd = cwdFn();
      // Invalidate when the working directory changes so a session switch to
      // another project never keeps the previous project's hooks active.
      if (cached && cached.cwd === cwd) return cached.hooks;
      cached = { cwd, hooks: load(cwd) };
      return cached.hooks;
    }

    /**
     * Surface a hook notice to the user only — never into the model context.
     * pi injects every `custom_message` (sendMessage) into the LLM context;
     * the `display` flag only controls TUI rendering. `ctx.ui.notify` is
     * TUI-only and creates no session entry, so hook internals (command
     * text, paths) stay out of the model's view. Headless runs fall back to
     * stderr so CI/batch logs remain informative.
     */
    function notice(
      ctx: ExtensionContext | undefined,
      content: string,
      level: "info" | "warning" | "error" = "warning",
    ): void {
      try {
        if (ctx?.hasUI) {
          ctx.ui.notify(content, level);
        } else {
          // log.warn always emits the `[pico hooks] ` prefix — strip any
          // prefix already carried by the content to avoid doubling it.
          const body = content.replace(/^\[pico hooks\] /, "");
          log.warn("hooks", body);
        }
      } catch {
        // non-TUI mode may drop notify
      }
    }

    pi.on("session_start", async (_event, ctx) => {
      try {
        // hooks() is otherwise lazy (first tool call), so a session_start
        // drain would find nothing (D13-F1). Load eagerly — this warms the
        // cache and lets the drain actually surface malformed-config errors
        // through the TUI channel instead of raw stderr.
        hooks();
        for (const message of drainHookConfigErrors()) {
          notice(ctx, message, "warning");
        }
      } catch {
        // best-effort
      }
      // 2.2.3: a project hooks.json that is silently ignored looks like a
      // broken security setup — tell the user the safety switch is off and
      // how to enable it (mirrors the project MCP/LSP pattern).
      try {
        const projectPath = join(ctx.cwd ?? cwdFn(), ".pico", "hooks.json");
        if (existsSync(projectPath) && !allowProjectHooks()) {
          notice(
            ctx,
            "检测到项目 hooks 配置（.pico/hooks.json），但当前被安全策略禁用。运行 /doctor 查看如何开启（PICO_ENABLE_PROJECT_HOOKS）。",
            "warning",
          );
        }
      } catch {
        // best-effort hint
      }
    });

    pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
      const matching = hooks().filter((h) => matches(h, "PreToolUse", event.toolName));
      if (matching.length === 0) return {};

      const vars: HookVars = {
        FILE: extractFilePath(event.input as Record<string, unknown>) ?? "",
        TOOL: event.toolName,
      };

      for (const hook of matching) {
        const blocking = hook.blocking ?? true;
        // 2.5.8: a blocking hook with a long timeout looks like a dead tool
        // call — say it is running before the subprocess spins up. notify is
        // TUI-only: the message must not enter the model context (D13-F2).
        if (blocking && (hook.timeoutMs ?? 30_000) >= 10_000) {
          notice(
            ctx,
            `Waiting for PreToolUse hook \`${hook.command}\` (timeout ${(hook.timeoutMs ?? 30_000) / 1000}s)…`,
            "info",
          );
        }
        const res = await run(hook, vars, cwdFn());
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
          notice(ctx, `PreToolUse hook \`${hook.command}\` failed (${res.timedOut ? "timeout" : `exit ${res.exitCode}`}); not blocking (blocking=false)`);
        }
      }
      return {};
    });

    pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
      const matching = hooks().filter((h) => matches(h, "PostToolUse", event.toolName));
      if (matching.length === 0) return {};

      const vars: HookVars = {
        FILE: extractFilePath(event.input) ?? "",
        TOOL: event.toolName,
      };

      for (const hook of matching) {
        const res = await run(hook, vars, cwdFn());
        if (res.timedOut || res.exitCode !== 0) {
          const why = res.timedOut ? "timeout" : `exit ${res.exitCode}`;
          notice(ctx, `PostToolUse hook \`${hook.command}\` ${why}`);
        }
      }
      return {};
    });

    pi.on("turn_end", async (event, ctx: ExtensionContext) => {
      const matching = hooks().filter((h) => h.event === "PostUserMessage");
      if (matching.length === 0) return;

      const vars: HookVars = {
        TURN: String(event.turnIndex ?? ""),
      };

      for (const hook of matching) {
        // 2.5.8: a slow PostUserMessage hook must not block the UI after
        // every user message — run it in the background.
        void run(hook, vars, cwdFn()).then((res) => {
          if (res.timedOut || res.exitCode !== 0) {
            const why = res.timedOut ? "timeout" : `exit ${res.exitCode}`;
            notice(ctx, `PostUserMessage hook \`${hook.command}\` ${why}`);
          }
        }).catch((err) => {
          notice(ctx, `PostUserMessage hook \`${hook.command}\` failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    });

    pi.on("session_shutdown", async () => {
      const matching = hooks().filter((h) => h.event === "PreSessionEnd");
      if (matching.length === 0) return;

      // Run in parallel with a total budget: serial execution could stall
      // session teardown for the SUM of all hook timeouts.
      const budgetMs = 30_000;
      const work = Promise.allSettled(
        matching.map(async (hook) => {
          const res = await run(hook, {}, cwdFn());
          if (res.timedOut || res.exitCode !== 0) {
            // Session is going away — the notify channel may not deliver
            // anywhere useful, so just log to stderr.
            const why = res.timedOut ? "timeout" : `exit ${res.exitCode}`;
            try {
              log.warn("hooks", `PreSessionEnd hook \`${hook.command}\` ${why}`);
            } catch {}
          }
        }),
      );
      // The race's own timer must be cleared once work settles, or the event
      // loop stays alive for the full budget after a fast teardown.
      let raceTimer: ReturnType<typeof setTimeout> | undefined;
      const budget = setTimeout(() => {}, budgetMs);
      budget.unref?.();
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          raceTimer = setTimeout(resolve, budgetMs);
          raceTimer.unref?.();
        }),
      ]);
      clearTimeout(budget);
      if (raceTimer) clearTimeout(raceTimer);
    });
  };
}

/** Production extension: loads from disk, runs via Bun.spawn. */
export const hooksExtension: ExtensionFactory = createHooksExtension({
  load: loadHooks,
  run: runHook,
});
