import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleSignal, signalsExtension, __resetSignalsForTests } from "../src/extensions/signals.ts";

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

describe("signals extension", () => {
  test("factory registers handlers once and tracks the session ctx", () => {
    const handlers: Record<string, Array<(e?: unknown) => void>> = {};
    const pi = {
      on: (event: string, handler: (e?: unknown) => void) => {
        (handlers[event] ??= []).push(handler);
      },
    } as never;
    signalsExtension(pi as never);

    const sessionStart = handlers["session_start"]![0]! as (e: unknown, ctx: unknown) => void;
    const fake = makeFakeCtx();
    sessionStart(undefined, fake.ctx);
    // Second factory run (simulated /reload) must not stack a third listener
    // — hard to observe directly, but the module flag makes re-entry a no-op;
    // calling the factory again must not throw.
    signalsExtension(pi as never);
    signalsExtension(pi as never);
    expect(handlers["session_start"]!.length).toBe(1);

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
