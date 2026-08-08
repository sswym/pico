/**
 * signals extension — external SIGINT/SIGTERM handling.
 *
 * Upstream pi handles cancellation through the TUI keybinding (Esc →
 * `ctx.abort()`), but neither pi nor pico registered a `process.on('SIGINT')`
 * handler, so an out-of-band SIGINT (kill from another terminal, tmux
 * teardown, systemd/CI) terminated the whole process immediately — no task
 * cancellation, no session flush, mid-flight tool state lost.
 *
 * This extension bridges the two:
 *   - SIGINT while an agent run is active  → `ctx.abort()` (same semantics as
 *     the Esc keybinding: cancel the turn, kill the running bash child, feed
 *     "Operation aborted" back to the loop). A second SIGINT within 5s forces
 *     a graceful shutdown instead, matching the usual double-ctrl-c habit.
 *   - SIGINT while idle / SIGTERM          → `ctx.shutdown()` (upstream's
 *     graceful "shutdown pi and exit" path, which flushes the session and
 *     lets MCP/session_shutdown cleanup run).
 *
 * The handlers are registered once per process (a `/reload` re-runs the
 * factory; re-adding the same listener would stack duplicates). The ctx
 * reference is refreshed on every session_start so a reloaded session still
 * cancels the right runtime.
 */
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

const DOUBLE_SIGINT_WINDOW_MS = 5_000;

let currentCtx: ExtensionContext | null = null;
let handlersRegistered = false;
let lastSigintAt = 0;

/**
 * Signal entry point — separated from the process.on wiring so tests can
 * drive it directly without delivering real signals to the test runner.
 */
export function handleSignal(signal: "SIGINT" | "SIGTERM", ctx: ExtensionContext | null): void {
  if (signal === "SIGTERM") {
    gracefulShutdown(ctx ?? currentCtx);
    return;
  }

  const now = Date.now();
  const ctxBusy = Boolean(ctx && !ctx.isIdle());
  const doubleSigint = now - lastSigintAt < DOUBLE_SIGINT_WINDOW_MS;
  lastSigintAt = now;

  if (ctxBusy && !doubleSigint) {
    // First SIGINT during a run: cancel the current turn like Esc would.
    try {
      ctx!.abort();
    } catch {
      gracefulShutdown(ctx ?? currentCtx);
      return;
    }
    try {
      ctx!.ui.notify?.("收到 SIGINT：已取消当前任务（再次发送 SIGINT 可退出）", "info");
    } catch {
      // notify is a no-op without a UI — nothing to fall back to on stderr,
      // which would corrupt a TUI screen.
    }
    return;
  }

  // Idle process or a second SIGINT: exit gracefully.
  gracefulShutdown(ctx ?? currentCtx);
}

function gracefulShutdown(ctx: ExtensionContext | null): void {
  if (!ctx) {
    // No session yet (startup) — nothing to flush; conventional exit code.
    process.exit(130);
    return;
  }
  try {
    ctx.shutdown();
  } catch {
    // shutdown threw (e.g. no session yet at startup) — fall back to the
    // conventional signal exit code.
    process.exit(130);
  }
}

export const signalsExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  if (!handlersRegistered) {
    handlersRegistered = true;
    process.on("SIGINT", () => handleSignal("SIGINT", currentCtx));
    process.on("SIGTERM", () => handleSignal("SIGTERM", currentCtx));

    // Handlers close over the module-level `currentCtx`, so a `/reload` that
    // re-runs this factory does not need to re-subscribe — the new session's
    // session_start refreshes the reference.
    pi.on("session_start", (_event, ctx) => {
      currentCtx = ctx;
    });
    pi.on("session_shutdown", () => {
      // Never cancel against a dead session after shutdown.
      currentCtx = null;
    });
  }
};

export function __resetSignalsForTests(): void {
  currentCtx = null;
  lastSigintAt = 0;
}
