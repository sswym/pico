import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateCurrentSettings,
  validateSettingsObject,
} from "../src/extensions/settings-schema.ts";

const savedHome = process.env.PICO_HOME;

afterEach(() => {
  if (savedHome === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = savedHome;
});

test("a fully valid settings object reports no issues", () => {
  const result = validateSettingsObject({
    safety: {
      enableProjectHooks: true,
      enableProjectMcp: false,
      enableProjectLsp: true,
      allowUnattendedPlanApproval: false,
      allowLspFormatOnWrite: true,
    },
    language: "简体中文",
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-8",
    integrations: {
      rtk: { enabled: true, mode: "spawnHook", command: "rtk" },
    },
    memory: { backend: "builtin", temporalDecayHalfLifeDays: 90 },
  });

  expect(result.valid).toBe(true);
  expect(result.issues).toEqual([]);
});

test("a non-boolean safety field yields one issue and does not veto sibling fields", () => {
  const result = validateSettingsObject({
    safety: { enableProjectHooks: "yes" },
    language: "简体中文",
  });

  expect(result.valid).toBe(false);
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0]!.key).toBe("safety.enableProjectHooks");
  // The legal language field must not produce a second issue (isolation).
  expect(result.issues[0]!.message).toContain("boolean");
});

test("every safety switch is type-checked", () => {
  const result = validateSettingsObject({
    safety: {
      enableProjectMcp: 1,
      enableProjectLsp: "true",
      allowUnattendedPlanApproval: null,
      allowLspFormatOnWrite: {},
    },
  });

  expect(result.valid).toBe(false);
  const keys = result.issues.map((issue) => issue.key);
  expect(keys).toContain("safety.enableProjectMcp");
  expect(keys).toContain("safety.enableProjectLsp");
  expect(keys).toContain("safety.allowUnattendedPlanApproval");
  expect(keys).toContain("safety.allowLspFormatOnWrite");
});

test("a non-object safety namespace is one issue", () => {
  const result = validateSettingsObject({ safety: "on" });

  expect(result.valid).toBe(false);
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0]!.key).toBe("safety");
  expect(result.issues[0]!.expected).toBe("object");
});

test("language with a newline is an issue", () => {
  const result = validateSettingsObject({ language: "English\nрусский" });

  expect(result.valid).toBe(false);
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0]!.key).toBe("language");
  expect(result.issues[0]!.message).toContain("newline");
});

test("language longer than 64 chars after trimming is an issue", () => {
  const result = validateSettingsObject({ language: "x".repeat(65) });

  expect(result.valid).toBe(false);
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0]!.key).toBe("language");
  expect(result.issues[0]!.message).toContain("64");
});

test("language that is empty after trimming is an issue", () => {
  const result = validateSettingsObject({ language: "   " });

  expect(result.valid).toBe(false);
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0]!.key).toBe("language");
});

test("language that is not a string is an issue", () => {
  const result = validateSettingsObject({ language: 42 });

  expect(result.valid).toBe(false);
  expect(result.issues[0]!.key).toBe("language");
  expect(result.issues[0]!.message).toContain("string");
});

test("a string integrations.rtk.enabled is an issue with a dotted key", () => {
  const result = validateSettingsObject({
    integrations: { rtk: { enabled: "yes", mode: "spawnHook", command: "rtk" } },
  });

  expect(result.valid).toBe(false);
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0]!.key).toBe("integrations.rtk.enabled");
});

test("a non-object integrations.rtk is one issue", () => {
  const result = validateSettingsObject({ integrations: { rtk: "rtk" } });

  expect(result.valid).toBe(false);
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0]!.key).toBe("integrations.rtk");
  expect(result.issues[0]!.expected).toBe("object");
});

test("memory fields actually consumed by provider-manager are type-checked", () => {
  const result = validateSettingsObject({
    memory: { backend: 7, temporalDecayHalfLifeDays: "90" },
  });

  expect(result.valid).toBe(false);
  expect(result.issues.map((issue) => issue.key)).toEqual([
    "memory.backend",
    "memory.temporalDecayHalfLifeDays",
  ]);
});

test("empty-string defaultProvider/defaultModel are issues, non-strings too", () => {
  const result = validateSettingsObject({
    defaultProvider: "",
    defaultModel: 42,
  });

  expect(result.valid).toBe(false);
  expect(result.issues.map((issue) => issue.key)).toEqual([
    "defaultProvider",
    "defaultModel",
  ]);
});

test("unknown fields (env stanza, provider configs) are never reported", () => {
  const result = validateSettingsObject({
    env: { ANTHROPIC_API_KEY: "sk-ant-test", PICO_SEARCH_PROVIDER: "tavily" },
    auxiliary: { vision: { provider: "openai", model: "gpt-4o-mini" } },
    customProvider: { anything: true },
    theme: { dark: "claude-code-dark" },
  });

  expect(result.valid).toBe(true);
  expect(result.issues).toEqual([]);
});

test("a top-level non-object yields exactly one issue keyed 'settings'", () => {
  for (const bad of [[1, 2, 3], "not-an-object", null, 42]) {
    const result = validateSettingsObject(bad);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.key).toBe("settings");
    expect(result.issues[0]!.expected).toBe("object");
  }
});

test("invalidValue is always JSON-serializable", () => {
  const cases = [
    { safety: { enableProjectHooks: "yes" } },
    { language: "x".repeat(65) },
    { integrations: { rtk: { enabled: { nested: true } } } },
    { memory: { temporalDecayHalfLifeDays: "90" } },
    [1, 2, 3],
    null,
  ];
  for (const input of cases) {
    for (const issue of validateSettingsObject(input).issues) {
      expect(issue.invalidValue).toBeDefined();
      // Round-trip must succeed and be lossless → plain JSON value.
      expect(JSON.parse(JSON.stringify(issue.invalidValue))).toEqual(issue.invalidValue);
    }
  }
});

test("validateCurrentSettings is valid when no settings file exists", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-settings-schema-home-"));
  process.env.PICO_HOME = home;
  try {
    const result = validateCurrentSettings();
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("validateCurrentSettings validates a settings file on disk", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-settings-schema-home-"));
  process.env.PICO_HOME = home;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      safety: { enableProjectHooks: "yes" },
      language: "简体中文",
    }));

    const result = validateCurrentSettings();
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.key).toBe("safety.enableProjectHooks");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("httpIdleTimeoutMs accepts valid timeout forms", () => {
  for (const value of [30_000, 0, "60000", "disabled"]) {
    const result = validateSettingsObject({ httpIdleTimeoutMs: value });
    expect(result.valid, `value: ${String(value)}`).toBe(true);
    expect(result.issues).toEqual([]);
  }
});

test("httpIdleTimeoutMs rejects invalid timeout forms", () => {
  const cases = [-1, Number.NaN, Infinity, "", "5 min", true, { ms: 100 }];
  for (const value of cases) {
    const result = validateSettingsObject({ httpIdleTimeoutMs: value });
    expect(result.valid, `value: ${String(value)}`).toBe(false);
    expect(result.issues[0]!.key).toBe("httpIdleTimeoutMs");
  }
});

test("new user-config namespaces are validated at top level", () => {
  const valid = {
    hooks: { hooks: [] },
    mcpServers: { mcpServers: {} },
    lsp: { formatOnWrite: false, idleTimeoutMs: 100 },
    subagent: { defaults: {} },
  };
  expect(validateSettingsObject(valid).valid).toBe(true);
  expect(validateSettingsObject(valid).issues).toEqual([]);

  expect(validateSettingsObject({ hooks: [] }).valid).toBe(false);
  expect(validateSettingsObject({ hooks: { hooks: "x" } }).valid).toBe(false);
  expect(validateSettingsObject({ mcpServers: { mcpServers: [] } }).valid).toBe(false);
  expect(validateSettingsObject({ lsp: { formatOnWrite: "yes" } }).valid).toBe(false);
  expect(validateSettingsObject({ subagent: { spawns: "x" } }).valid).toBe(false);
});
