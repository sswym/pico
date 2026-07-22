import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  srcodeAgentHome,
  srcodeHome,
  srcodeInputHistoryPath,
  srcodeLspConfigPath,
  srcodeMcpConfigPath,
  srcodeMemoryDbPath,
  srcodeModelsPath,
  srcodeSessionDir,
  srcodeSettingsPath,
} from "../src/extensions/paths.ts";

const originalHome = process.env.SRCODE_HOME;
const originalMemoryDb = process.env.SRCODE_MEMORY_DB;

afterEach(() => {
  if (originalHome === undefined) delete process.env.SRCODE_HOME;
  else process.env.SRCODE_HOME = originalHome;
  if (originalMemoryDb === undefined) delete process.env.SRCODE_MEMORY_DB;
  else process.env.SRCODE_MEMORY_DB = originalMemoryDb;
});

test("srcode path helpers honor SRCODE_HOME", () => {
  process.env.SRCODE_HOME = "/tmp/srcode-custom-home";
  delete process.env.SRCODE_MEMORY_DB;

  expect(srcodeHome()).toBe("/tmp/srcode-custom-home");
  expect(srcodeAgentHome()).toBe(join("/tmp/srcode-custom-home", "agent"));
  expect(srcodeSessionDir()).toBe(join("/tmp/srcode-custom-home", "agent", "sessions"));
  expect(srcodeSettingsPath()).toBe(join("/tmp/srcode-custom-home", "agent", "settings.json"));
  expect(srcodeModelsPath()).toBe(join("/tmp/srcode-custom-home", "agent", "models.json"));
  expect(srcodeInputHistoryPath()).toBe(join("/tmp/srcode-custom-home", "agent", "input-history.jsonl"));
  expect(srcodeMemoryDbPath()).toBe(join("/tmp/srcode-custom-home", "memory.db"));
  expect(srcodeMcpConfigPath()).toBe(join("/tmp/srcode-custom-home", "mcp-servers.json"));
  expect(srcodeLspConfigPath()).toBe(join("/tmp/srcode-custom-home", "lsp.json"));
});

test("SRCODE_MEMORY_DB overrides memory database path only", () => {
  process.env.SRCODE_HOME = "/tmp/srcode-custom-home";
  process.env.SRCODE_MEMORY_DB = "/tmp/memory.db";

  expect(srcodeMemoryDbPath()).toBe("/tmp/memory.db");
  expect(srcodeSettingsPath()).toBe(join("/tmp/srcode-custom-home", "agent", "settings.json"));
});
