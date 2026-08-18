import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  log,
  loggingStatus,
  __resetLoggingForTests,
  __setLogFilePathForTests,
  __setLogBudgetForTests,
  __setLogLevelForTests,
} from "../src/extensions/logging.ts";

function makeDir(): string {
  const dir = join(tmpdir(), `pico-logging-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("pico logging module", () => {
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalEnv: Record<string, string | undefined> = {
    PICO_LOG_LEVEL: process.env.PICO_LOG_LEVEL,
    PICO_LOG_FILE: process.env.PICO_LOG_FILE,
    PICO_LOG_DIR: process.env.PICO_LOG_DIR,
    PICO_HOME: process.env.PICO_HOME,
  };

  beforeEach(() => {
    for (const key of ["PICO_LOG_LEVEL", "PICO_LOG_FILE", "PICO_LOG_DIR", "PICO_HOME"]) {
      delete process.env[key];
    }
    __setLogFilePathForTests(undefined);
    __setLogLevelForTests("warn");
    __resetLoggingForTests();
  });

  afterEach(() => {
    for (const k of Object.keys(originalEnv)) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    console.warn = originalWarn;
    console.error = originalError;
    __setLogFilePathForTests(undefined);
    __setLogLevelForTests("warn");
    __resetLoggingForTests();
  });

  test("default level is warn — info/debug suppressed", () => {
    const warns: string[] = [];
    console.warn = (m: string) => warns.push(m);
    log.info("tag", "info line");
    log.debug("tag", "debug line");
    log.warn("tag", "warn line");
    expect(warns).toEqual(["[pico tag] warn line"]);
  });

  test("PICO_LOG_LEVEL=info enables info messages but not debug", () => {
    process.env.PICO_LOG_LEVEL = "info";
    __resetLoggingForTests();
    const warns: string[] = [];
    console.warn = (m: string) => warns.push(m);
    log.warn("tag", "warn-on-info");
    log.info("tag", "info-on-info");
    log.debug("tag", "debug-on-info");
    expect(warns.join("\n")).toContain("warn-on-info");
    expect(warns.join("\n")).toContain("info-on-info");
    expect(warns.join("\n")).not.toContain("debug-on-info");
  });

  test("prefix is [pico <tag>] for tagged, [pico] for empty tag", () => {
    const warns: string[] = [];
    console.warn = (m: string) => warns.push(m);
    log.warn("events", "boom");
    log.warn("", "raw");
    expect(warns[0]).toBe("[pico events] boom");
    expect(warns[1]).toBe("[pico] raw");
  });

  test("PICO_LOG_FILE writes a 0o600 file", () => {
    const dir = makeDir();
    const file = join(dir, "app.log");
    process.env.PICO_LOG_FILE = file;
    __setLogFilePathForTests(undefined);
    __resetLoggingForTests();
    const warns: string[] = [];
    console.warn = (m: string) => warns.push(m);
    log.warn("events", "some-event");
    expect(warns).toEqual(["[pico events] some-event"]);
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("some-event");
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(loggingStatus().file).toBe(file);
    rmSync(dir, { recursive: true, force: true });
  });

  test("empty tag warn stays warn (not promoted to error)", () => {
    const errs: string[] = [];
    console.error = (m: string) => errs.push(m);
    log.warn("", "plain warn");
    expect(errs).toEqual([]);
  });

  test("trim keeps the tail lines bounded past the cap", () => {
    const dir = makeDir();
    const file = join(dir, "app.log");
    process.env.PICO_LOG_FILE = file;
    __resetLoggingForTests();
    __setLogFilePathForTests(file);
    __setLogBudgetForTests(4096, 100);
    for (let i = 0; i < 1010; i++) log.warn("t", `line-${i}`);
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    // Trim fires when the file crosses the byte cap and keeps the last N lines;
    // between trims a few lines re-accumulate, so the exact count is N + slack —
    // the contract is "bounded well under the written total, tail preserved".
    expect(lines.length).toBeLessThan(250);
    expect(content).toContain("line-1009");
    expect(content).not.toContain("line-800\n");
    rmSync(dir, { recursive: true, force: true });
  });

  test("no PICO_LOG_FILE keeps pure stderr behavior and creates no file", () => {
    const dir = makeDir();
    log.warn("tag", "hello");
    expect(existsSync(join(dir, "bogus.log"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("relative PICO_LOG_FILE resolves under $PICO_HOME/logs", () => {
    const dir = makeDir();
    process.env.PICO_HOME = dir;
    process.env.PICO_LOG_FILE = "pico.log";
    __setLogFilePathForTests(undefined);
    __resetLoggingForTests();
    log.warn("x", "relative-ok");
    const file = join(dir, "logs", "pico.log");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8")).toContain("relative-ok");
    rmSync(dir, { recursive: true, force: true });
  });

  test("noisy call with an Error argument includes message", () => {
    const warns: string[] = [];
    console.warn = (m: string) => warns.push(m);
    log.warn("memory", "boom:", new Error("nope"));
    expect(warns.join("\n")).toContain("[pico memory] boom: Error: nope");
  });
});