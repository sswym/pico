/**
 * config-migrate unit tests — legacy user-config migration into settings.json
 * namespaces (2026-08 config consolidation).
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hasUserNamespace,
  legacyUserConfigPaths,
  migrateLegacyUserConfigs,
} from "../src/extensions/config-migrate.ts";

const savedHome = process.env.PICO_HOME;
let home: string;

afterEach(() => {
  if (savedHome === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = savedHome;
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

function useTempHome(): string {
  home = mkdtempSync(join(tmpdir(), "pico-migrate-"));
  process.env.PICO_HOME = home;
  mkdirSync(join(home, "agent"), { recursive: true });
  return home;
}

test("migrateLegacyUserConfigs moves all four legacy files into settings.json and deletes them", () => {
  useTempHome();
  writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: [{ event: "PreToolUse", command: "echo hi" }] }));
  writeFileSync(join(home, "mcp-servers.json"), JSON.stringify({ mcpServers: { docs: { command: "docs" } } }));
  writeFileSync(join(home, "lsp.json"), JSON.stringify({ formatOnWrite: true }));
  writeFileSync(join(home, "subagent.json"), JSON.stringify({ defaults: { model: "m" } }));

  const migrated = migrateLegacyUserConfigs();
  expect(migrated).toHaveLength(4);
  expect(existsSync(join(home, "hooks.json"))).toBe(false);
  expect(existsSync(join(home, "mcp-servers.json"))).toBe(false);
  expect(existsSync(join(home, "lsp.json"))).toBe(false);
  expect(existsSync(join(home, "subagent.json"))).toBe(false);

  const settings = JSON.parse(readFileSync(join(home, "agent", "settings.json"), "utf8"));
  expect(settings.hooks.hooks).toHaveLength(1);
  expect(settings.mcpServers.mcpServers.docs.command).toBe("docs");
  expect(settings.lsp.formatOnWrite).toBe(true);
  expect(settings.subagent.defaults.model).toBe("m");
  expect(hasUserNamespace("hooks")).toBe(true);
});

test("migrateLegacyUserConfigs is idempotent", () => {
  useTempHome();
  writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: [] }));

  expect(migrateLegacyUserConfigs()).toHaveLength(1);
  expect(migrateLegacyUserConfigs()).toEqual([]);
});

test("migrateLegacyUserConfigs keeps the namespace as authority and cleans leftover files", () => {
  useTempHome();
  writeFileSync(join(home, "agent", "settings.json"), JSON.stringify({
    hooks: { hooks: [{ event: "PostToolUse", command: "echo ns" }] },
  }));
  // Stale legacy file from a pre-consolidation run.
  writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: [{ event: "PreToolUse", command: "echo legacy" }] }));

  const migrated = migrateLegacyUserConfigs();
  expect(migrated).toEqual([]); // nothing new migrated
  expect(existsSync(join(home, "hooks.json"))).toBe(false); // leftover cleaned
  const settings = JSON.parse(readFileSync(join(home, "agent", "settings.json"), "utf8"));
  expect(settings.hooks.hooks[0]!.event).toBe("PostToolUse"); // namespace untouched
});

test("migrateLegacyUserConfigs skips damaged legacy files", () => {
  useTempHome();
  writeFileSync(join(home, "hooks.json"), "{not json");
  writeFileSync(join(home, "mcp-servers.json"), JSON.stringify({ mcpServers: {} }));

  const migrated = migrateLegacyUserConfigs();
  expect(migrated).toHaveLength(1); // only mcp-servers migrated
  expect(existsSync(join(home, "hooks.json"))).toBe(true); // damaged file preserved
  expect(hasUserNamespace("hooks")).toBe(false);
  expect(hasUserNamespace("mcpServers")).toBe(true);
});

test("migrateLegacyUserConfigs refuses to touch a damaged settings.json", () => {
  useTempHome();
  writeFileSync(join(home, "agent", "settings.json"), "{broken");
  writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: [] }));

  expect(migrateLegacyUserConfigs()).toEqual([]);
  expect(existsSync(join(home, "hooks.json"))).toBe(true); // untouched
});

test("legacyUserConfigPaths lists the four consolidated files", () => {
  useTempHome();
  const paths = legacyUserConfigPaths();
  expect(paths.map((p) => p.key)).toEqual(["hooks", "mcpServers", "lsp", "subagent"]);
  expect(paths.find((p) => p.key === "subagent")!.path).toBe(join(home, "subagent.json"));
});
