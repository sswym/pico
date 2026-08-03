import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  picoAgentHome,
  picoHolographicMemoryPath,
  picoHome,
  picoInputHistoryPath,
  picoLspConfigPath,
  picoMcpConfigPath,
  picoMemoryDbPath,
  picoModelsPath,
  picoSessionDir,
  picoSettingsPath,
} from "../src/extensions/paths.ts";

const originalHome = process.env.PICO_HOME;
const originalMemoryDb = process.env.PICO_MEMORY_DB;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = originalHome;
  if (originalMemoryDb === undefined) delete process.env.PICO_MEMORY_DB;
  else process.env.PICO_MEMORY_DB = originalMemoryDb;
});

test("pico path helpers honor PICO_HOME", () => {
  process.env.PICO_HOME = "/tmp/pico-custom-home";
  delete process.env.PICO_MEMORY_DB;

  expect(picoHome()).toBe("/tmp/pico-custom-home");
  expect(picoAgentHome()).toBe(join("/tmp/pico-custom-home", "agent"));
  expect(picoSessionDir()).toBe(join("/tmp/pico-custom-home", "agent", "sessions"));
  expect(picoSettingsPath()).toBe(join("/tmp/pico-custom-home", "agent", "settings.json"));
  expect(picoModelsPath()).toBe(join("/tmp/pico-custom-home", "agent", "models.json"));
  expect(picoInputHistoryPath()).toBe(join("/tmp/pico-custom-home", "agent", "input-history.jsonl"));
  expect(picoMemoryDbPath()).toBe(join("/tmp/pico-custom-home", "memory.db"));
  expect(picoMcpConfigPath()).toBe(join("/tmp/pico-custom-home", "mcp-servers.json"));
  expect(picoLspConfigPath()).toBe(join("/tmp/pico-custom-home", "lsp.json"));
});

test("PICO_MEMORY_DB overrides memory database path only", () => {
  process.env.PICO_HOME = "/tmp/pico-custom-home";
  process.env.PICO_MEMORY_DB = "/tmp/memory.db";

  expect(picoMemoryDbPath()).toBe("/tmp/memory.db");
  expect(picoSettingsPath()).toBe(join("/tmp/pico-custom-home", "agent", "settings.json"));
});

test("picoHome expands ~ and resolves relative PICO_HOME", () => {
  process.env.PICO_HOME = "~/custom";
  expect(picoHome()).toBe(join(homedir(), "custom"));

  process.env.PICO_HOME = "relative/pico";
  expect(picoHome()).toBe(resolve("relative/pico"));
});

test("empty PICO_HOME falls back to the default home", () => {
  process.env.PICO_HOME = "";
  expect(picoHome()).toBe(join(homedir(), ".pico"));
});

test("PICO_MEMORY_DB never overrides the holographic (JSON) memory path", () => {
  process.env.PICO_HOME = "/tmp/pico-custom-home";
  process.env.PICO_MEMORY_DB = "/tmp/memory.db";
  delete process.env.PICO_HOLOGRAPHIC_MEMORY_PATH;

  expect(picoHolographicMemoryPath()).toBe(join("/tmp/pico-custom-home", "holographic-memory.json"));

  process.env.PICO_HOLOGRAPHIC_MEMORY_PATH = "/tmp/holo.json";
  expect(picoHolographicMemoryPath()).toBe("/tmp/holo.json");
});
