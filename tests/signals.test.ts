import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  handleSignal,
  signalsExtension,
  __getCurrentCtxForTests,
  __resetSignalsForTests,
} from "../src/extensions/signals.ts";

function makeFakeCtx(overrides: { idle?: boolean } = {}) {
  const calls: { abort: number; shutdown: number; notify: string[] } = { abort: 0, shutdown: 0, notify: [] };
  return {
    calls,
    ctx: {
      isIdle: () => overrides.idle ?? true,
      abort: () => {
        calls.abort++;
      },
      shutdown: () => {
        calls.shutdown++;
      },
      ui: {
        notify: (message: string) => {
          calls.notify.push(message);
        },
      },
    } as unknown as ExtensionContext,
  };
}

function makeFakePi() {
  const handlers: Record<string, Array<(e?: unknown, ctx?: unknown) => void>> = {};
  return {
    handlers,
    pi: {
      on: (event: string, handler: (e?: unknown, ctx?: unknown) => void) => {
        (handlers[event] ??= []).push(handler);
      },
    } as never,
  };
}

describe("signals extension", () => {
  test("process signal handlers are registered once across factory re-runs", () => {
    const { pi: pi1 } = makeFakePi();
    const sigintBefore = process.listeners("SIGINT").length;
    const sigtermBefore = process.listeners("SIGTERM").length;
    signalsExtension(pi1);
    expect(process.listeners("SIGINT").length).toBe(sigintBefore + 1);
    expect(process.listeners("SIGTERM").length).toBe(sigtermBefore + 1);

    // Simulated /reload: the factory re-runs, but the process-level wiring
    // must not stack (AGENTS.md: reload must not double SIGINT handlers).
    const { pi: pi2 } = makeFakePi();
    signalsExtension(pi2);
    expect(process.listeners("SIGINT").length).toBe(sigintBefore + 1);
    expect(process.listeners("SIGTERM").length).toBe(sigtermBefore + 1);

    __resetSignalsForTests();
  });

  test("reload: factory re-run re-subscribes on the new api so SIGINT still cancels", () => {
    const { handlers: handlers1, pi: pi1 } = makeFakePi();
    const { handlers: handlers2, pi: pi2 } = makeFakePi();

    // First factory run (startup): subscribes on api1.
    signalsExtension(pi1);
    expect(handlers1["session_start"]!.length).toBe(1);
    expect(handlers1["session_shutdown"]!.length).toBe(1);

    // Session starts on the old api.
    const oldCtx = makeFakeCtx({ idle: false });
    handlers1["session_start"]![0]!(undefined, oldCtx.ctx);
    expect(__getCurrentCtxForTests()).toBe(oldCtx.ctx);

    // /reload teardown: session_shutdown clears the ctx…
    handlers1["session_shutdown"]![0]!();
    expect(__getCurrentCtxForTests()).toBe(null);

    // …then the factory re-runs against a FRESH ExtensionAPI. It must
    // subscribe on the new api even though process handlers are already
    // registered (before the fix the once-guard skipped this, so the new api
    // had no session_start handler and currentCtx stayed null forever).
    signalsExtension(pi2);
    expect(handlers2["session_start"]!.length).toBe(1);
    expect(handlers2["session_shutdown"]!.length).toBe(1);

    const newCtx = makeFakeCtx({ idle: false });
    handlers2["session_start"]![0]!(undefined, newCtx.ctx);
    expect(__getCurrentCtxForTests()).toBe(newCtx.ctx);

    // SIGINT driven exactly like the process.on closure does (module-level
    // currentCtx) must cancel the reloaded run — not fall through to exit(130).
    handleSignal("SIGINT", __getCurrentCtxForTests());
    expect(newCtx.calls.abort).toBe(1);
    expect(newCtx.calls.shutdown).toBe(0);

    __resetSignalsForTests();
  });

  test("SIGINT while busy aborts the current run instead of exiting", () => {
    const fake = makeFakeCtx({ idle: false });
    handleSignal("SIGINT", fake.ctx);
    expect(fake.calls.abort).toBe(1);
    expect(fake.calls.shutdown).toBe(0);
    expect(fake.calls.notify.some((m) => m.includes("SIGINT"))).toBe(true);
    __resetSignalsForTests();
  });

  test("SIGINT while idle triggers graceful shutdown", () => {
    const fake = makeFakeCtx({ idle: true });
    handleSignal("SIGINT", fake.ctx);
    expect(fake.calls.abort).toBe(0);
    expect(fake.calls.shutdown).toBe(1);
    __resetSignalsForTests();
  });

  test("SIGTERM always triggers graceful shutdown, even mid-run", () => {
    const fake = makeFakeCtx({ idle: false });
    handleSignal("SIGTERM", fake.ctx);
    expect(fake.calls.abort).toBe(0);
    expect(fake.calls.shutdown).toBe(1);
    __resetSignalsForTests();
  });

  test("second SIGINT within the window forces shutdown even while busy", () => {
    const fake = makeFakeCtx({ idle: false });
    handleSignal("SIGINT", fake.ctx);
    expect(fake.calls.abort).toBe(1);
    handleSignal("SIGINT", fake.ctx);
    expect(fake.calls.shutdown).toBe(1);
    expect(fake.calls.abort).toBe(1); // no second abort — the exit request wins
    __resetSignalsForTests();
  });

  test("null ctx (no session yet) falls back to process.exit(130)", () => {
    const fake = makeFakeCtx();
    const origExit = process.exit;
    let exitCode: number | null = null;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`exit(${code})`);
    }) as never;
    try {
      expect(() => handleSignal("SIGINT", null)).toThrow("exit(130)");
      expect(exitCode ?? -1).toBe(130);
    } finally {
      process.exit = origExit;
    }
    expect(fake.calls.shutdown).toBe(0);
    __resetSignalsForTests();
  });
});
