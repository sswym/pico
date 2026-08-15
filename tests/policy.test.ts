/**
 * policy.ts tests — safety-flag resolution.
 *
 * policy.ts is the trust boundary for project-scoped hooks and MCP servers.
 * These tests lock in the precedence rule the whole safety model relies on:
 * env var > settings.json > default(off), in both directions.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSettings } from "../src/extensions/settings.ts";
import { writeCustomProvider } from "../src/setup/index.ts";
import {
  allowProjectHooks,
  allowProjectMcp,
  envFlag,
  safetyFlagSource,
} from "../src/extensions/policy.ts";

const ENV_KEYS = [
  "PICO_HOME",
  "PICO_ENABLE_PROJECT_HOOKS",
  "PICO_ENABLE_PROJECT_MCP",
];
let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), "pico-policy-"));
  process.env.PICO_HOME = home;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try { rmSync(home, { recursive: true, force: true }); } catch { }
});

test("envFlag parses common truthy/falsy spellings", () => {
  for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) {
    process.env.PICO_ENABLE_PROJECT_HOOKS = v;
    expect(envFlag("PICO_ENABLE_PROJECT_HOOKS")).toBe(true);
  }
  for (const v of ["0", "false", "no", "off"]) {
    process.env.PICO_ENABLE_PROJECT_HOOKS = v;
    expect(envFlag("PICO_ENABLE_PROJECT_HOOKS")).toBe(false);
  }
  process.env.PICO_ENABLE_PROJECT_HOOKS = "maybe";
  expect(envFlag("PICO_ENABLE_PROJECT_HOOKS")).toBeUndefined();
  delete process.env.PICO_ENABLE_PROJECT_HOOKS;
  expect(envFlag("PICO_ENABLE_PROJECT_HOOKS")).toBeUndefined();
});

test("defaults to disabled when neither env nor settings are set", () => {
  expect(allowProjectHooks()).toBe(false);
  expect(allowProjectMcp()).toBe(false);
  expect(safetyFlagSource("PICO_ENABLE_PROJECT_HOOKS", "enableProjectHooks")).toBe("default");
});

test("settings.json enables the flag when env is absent", () => {
  writeSettings({ safety: { enableProjectHooks: true } });
  expect(allowProjectHooks()).toBe(true);
  expect(safetyFlagSource("PICO_ENABLE_PROJECT_HOOKS", "enableProjectHooks")).toBe("settings");
});

test("env overrides settings.json in both directions", () => {
  writeSettings({ safety: { enableProjectHooks: true, enableProjectMcp: false } });

  // env=0 must override settings=true (disable a setting-enabled flag).
  process.env.PICO_ENABLE_PROJECT_HOOKS = "0";
  expect(allowProjectHooks()).toBe(false);
  expect(safetyFlagSource("PICO_ENABLE_PROJECT_HOOKS", "enableProjectHooks")).toBe("env");

  // env=1 must override settings=false (enable a setting-disabled flag).
  process.env.PICO_ENABLE_PROJECT_MCP = "1";
  expect(allowProjectMcp()).toBe(true);
  expect(safetyFlagSource("PICO_ENABLE_PROJECT_MCP", "enableProjectMcp")).toBe("env");
});

test("safety string booleans are treated as disabled with a warning", () => {
  writeSettings({ safety: { enableProjectHooks: "true" } });
  // String "true" is not a boolean: the flag stays on its default (false)
  // and the source reports default — no silent "enabled".
  expect(safetyFlagSource("PICO_ENABLE_PROJECT_HOOKS", "enableProjectHooks")).toBe("default");
  // Real booleans still resolve normally.
  writeSettings({ safety: { enableProjectHooks: true } });
  expect(safetyFlagSource("PICO_ENABLE_PROJECT_HOOKS", "enableProjectHooks")).toBe("settings");
});

test("writeSettings repairs a pre-existing wide-mode settings.json to 0600", () => {
  const agentDir = join(home, "agent");
  mkdirSync(agentDir, { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  // { mode: 0o600 } only applies on first creation — a file pre-existing at
  // 0664 (left by an older version / concurrent writer) must be tightened on
  // write, or the env stanza / apiKey stays group-readable.
  writeFileSync(settingsPath, JSON.stringify({ safety: { enableProjectHooks: true } }));
  chmodSync(settingsPath, 0o664);
  expect(statSync(settingsPath).mode & 0o777).toBe(0o664);

  writeSettings({ safety: { enableProjectHooks: true } });

  expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
});

test("writeCustomProvider repairs a pre-existing wide-mode models.json to 0600", () => {
  const agentDir = join(home, "agent");
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = join(agentDir, "models.json");
  // models.json holds per-provider apiKey — a pre-existing 0664 file must be
  // tightened on write, not just on first creation.
  writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
  chmodSync(modelsPath, 0o664);
  expect(statSync(modelsPath).mode & 0o777).toBe(0o664);

  writeCustomProvider({
    id: "local",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    apiKey: "ollama",
    model: "qwen2.5-coder:7b",
  });

  expect(statSync(modelsPath).mode & 0o777).toBe(0o600);
});
