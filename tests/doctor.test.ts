import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDoctorReport, doctorExtension, migrateConfigYmlSafetyKeys } from "../src/extensions/doctor/index.ts";
import { publishExtensionEvent } from "../src/extensions/events.ts";
import { detectMissingDefaultModel } from "../src/extensions/doctor/config-scan.ts";
import {
  allowProjectHooks,
  allowProjectMcp,
  readSafetySettings,
} from "../src/extensions/policy.ts";

const savedEnv = {
  home: process.env.PICO_HOME,
  plan: process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL,
  lsp: process.env.PICO_ALLOW_LSP_FORMAT_ON_WRITE,
  hooks: process.env.PICO_ENABLE_PROJECT_HOOKS,
  mcp: process.env.PICO_ENABLE_PROJECT_MCP,
};

afterEach(() => {
  if (savedEnv.home === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = savedEnv.home;
  if (savedEnv.plan === undefined) delete process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL;
  else process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL = savedEnv.plan;
  if (savedEnv.lsp === undefined) delete process.env.PICO_ALLOW_LSP_FORMAT_ON_WRITE;
  else process.env.PICO_ALLOW_LSP_FORMAT_ON_WRITE = savedEnv.lsp;
  if (savedEnv.hooks === undefined) delete process.env.PICO_ENABLE_PROJECT_HOOKS;
  else process.env.PICO_ENABLE_PROJECT_HOOKS = savedEnv.hooks;
  if (savedEnv.mcp === undefined) delete process.env.PICO_ENABLE_PROJECT_MCP;
  else process.env.PICO_ENABLE_PROJECT_MCP = savedEnv.mcp;
});

test("buildDoctorReport shows safety switches and capabilities", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-home-"));
  process.env.PICO_HOME = home;
  process.env.PICO_ENABLE_PROJECT_HOOKS = "1";
  delete process.env.PICO_ENABLE_PROJECT_MCP;

  try {
    const report = buildDoctorReport("/repo");

    expect(report).toContain("pico doctor");
    expect(report).toContain("cwd: /repo");
    expect(report).toContain("enableProjectHooks: enabled (env; env PICO_ENABLE_PROJECT_HOOKS)");
    expect(report).toContain("enableProjectMcp: disabled (default; env PICO_ENABLE_PROJECT_MCP)");
    expect(report).toContain("Project Code Exec (high)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("safety settings are read from settings.json and env overrides them", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-home-"));
  process.env.PICO_HOME = home;
  delete process.env.PICO_ENABLE_PROJECT_HOOKS;
  process.env.PICO_ENABLE_PROJECT_MCP = "0";
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      safety: {
        enableProjectHooks: true,
        enableProjectMcp: true,
      },
    }));

    expect(readSafetySettings()).toMatchObject({
      enableProjectHooks: true,
      enableProjectMcp: true,
    });
    expect(allowProjectHooks()).toBe(true);
    expect(allowProjectMcp()).toBe(false);

    const report = buildDoctorReport("/repo");
    expect(report).toContain("enableProjectHooks: enabled (settings; env PICO_ENABLE_PROJECT_HOOKS)");
    expect(report).toContain("enableProjectMcp: disabled (env; env PICO_ENABLE_PROJECT_MCP)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor extension registers /doctor and sends a visible report", async () => {
  const commands = new Map<string, any>();
  const messages: any[] = [];
  const fakePi = {
    on: () => {},
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    sendMessage: (message: any) => messages.push(message),
  };

  doctorExtension(fakePi as any);
  await commands.get("doctor").handler("", { cwd: "/repo/app", hasUI: true });

  expect(messages).toHaveLength(1);
  expect(messages[0].customType).toBe("pico.doctor");
  expect(messages[0].display).toBe(true);
  expect(messages[0].content).toContain("cwd: /repo/app");
});

// ---- config.yml dual-track detection (P0) --------------------------------

import {
  detectConfigYmlModelConflicts,
  detectConfigYmlSafetyConflicts,
  detectReasoningCompatIssues,
  formatConfigYmlConflictLines,
  parseConfigYmlSafetyBlock,
  scanModelsJson,
} from "../src/extensions/doctor/config-scan.ts";

const REAL_STYLE_CONFIG_YML = `env:
  TAVILY_API_KEY: tvly-test
auxiliary:
  vision:
    provider: zen-openai
    model: mimo-v2.5-free
theme:
  dark: claude-code-dark
defaultThinkingLevel: high
quietStartup: true
defaultProvider: zen-openai
defaultModel: deepseek-v4-flash-free
language: 简体中文
defaultProjectTrust: ask
safety:
  allowUnattendedPlanApproval: true
  allowLspFormatOnWrite: true
  enableProjectHooks: false
  enableProjectMcp: true
memory:
  backend: builtin
integrations:
  codegraph:
    enabled: true
`;

test("parseConfigYmlSafetyBlock parses the real-world config.yml safety block", () => {
  const block = parseConfigYmlSafetyBlock(REAL_STYLE_CONFIG_YML);
  expect(block).toEqual({
    allowUnattendedPlanApproval: true,
    allowLspFormatOnWrite: true,
    enableProjectHooks: false,
    enableProjectMcp: true,
  });
});

test("parseConfigYmlSafetyBlock returns null without a safety block", () => {
  expect(parseConfigYmlSafetyBlock("theme:\n  dark: retro\n")).toBeNull();
  expect(parseConfigYmlSafetyBlock("safety: {}\n")).toEqual({});
  expect(parseConfigYmlSafetyBlock("")).toBeNull();
});

test("detectConfigYmlSafetyConflicts flags keys that differ from settings.json", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-conflict-"));
  process.env.PICO_HOME = home;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    // settings.json has NO safety section — the config.yml values are inert.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "claude-code-dark" }));
    writeFileSync(join(agentDir, "config.yml"), REAL_STYLE_CONFIG_YML);

    const conflicts = detectConfigYmlSafetyConflicts();
    // Only keys whose config.yml value differs from the effective value are
    // reported — the false-valued key matches the default and is inert harmlessly.
    expect(conflicts.length).toBe(3);
    expect(conflicts.find((c) => c.key === "allowUnattendedPlanApproval")).toEqual({
      key: "allowUnattendedPlanApproval",
      configYmlValue: true,
      effectiveValue: false,
    });
    expect(conflicts.find((c) => c.key === "enableProjectMcp")).toBeDefined();

    const lines = formatConfigYmlConflictLines();
    expect(lines.join("\n")).toContain("config.yml safety keys are IGNORED by pico");
    expect(lines.join("\n")).toContain('Move it to settings.json "safety"');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("migrateConfigYmlSafetyKeys copies inert config.yml values into settings.json once", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-migrate-"));
  process.env.PICO_HOME = home;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "claude-code-dark" }));
    writeFileSync(join(agentDir, "config.yml"), REAL_STYLE_CONFIG_YML);

    const migrated = migrateConfigYmlSafetyKeys();
    expect(migrated.sort()).toEqual(["allowLspFormatOnWrite", "allowUnattendedPlanApproval", "enableProjectMcp"]);

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    expect(settings.safety).toEqual({
      allowUnattendedPlanApproval: true,
      allowLspFormatOnWrite: true,
      enableProjectMcp: true,
    });
    expect(settings.theme).toBe("claude-code-dark"); // unrelated keys preserved

    // Idempotent: second run migrates nothing and the conflict is gone.
    expect(migrateConfigYmlSafetyKeys()).toEqual([]);
    expect(detectConfigYmlSafetyConflicts()).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("migrateConfigYmlSafetyKeys skips env-pinned and settings-pinned keys", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-migrate2-"));
  process.env.PICO_HOME = home;
  const savedPlan = process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    // settings.json explicitly pins allowLspFormatOnWrite=false; env pins
    // allowUnattendedPlanApproval — neither should be overwritten.
    process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL = "1";
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ safety: { allowLspFormatOnWrite: false } }),
    );
    writeFileSync(join(agentDir, "config.yml"), REAL_STYLE_CONFIG_YML);

    const migrated = migrateConfigYmlSafetyKeys();
    // enableProjectMcp (true in config.yml) is the only unpinned key.
    expect(migrated).toEqual(["enableProjectMcp"]);

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    expect(settings.safety.allowLspFormatOnWrite).toBe(false); // user pin kept
    expect(settings.safety.allowUnattendedPlanApproval).toBeUndefined(); // env-pinned, not persisted
    expect(settings.safety.enableProjectMcp).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (savedPlan === undefined) delete process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL;
    else process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL = savedPlan;
  }
});

test("buildDoctorReport surfaces LSP init failures after lsp_status event", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-lsp-"));
  process.env.PICO_HOME = home;
  try {
    const pi = {
      on: () => {},
      registerCommand: () => {},
    } as never;
    doctorExtension(pi);
    publishExtensionEvent("lsp_status", {
      failures: [{ server: "typescript-language-server", at: Date.now(), message: "Could not find a valid TypeScript installation" }],
    });

    const report = buildDoctorReport(home);
    expect(report).toContain("LSP:");
    expect(report).toContain("typescript-language-server: init failed");
    expect(report).toContain("Could not find a valid TypeScript installation");

    // A clean snapshot clears the section back to the neutral line.
    publishExtensionEvent("lsp_status", { failures: [] });
    expect(buildDoctorReport(home)).toContain("no init failures recorded");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("detectConfigYmlSafetyConflicts is empty when settings match config.yml", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-noconflict-"));
  process.env.PICO_HOME = home;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        safety: {
          allowUnattendedPlanApproval: true,
          allowLspFormatOnWrite: true,
          enableProjectHooks: false,
          enableProjectMcp: true,
        },
      }),
    );
    writeFileSync(join(agentDir, "config.yml"), REAL_STYLE_CONFIG_YML);

    expect(detectConfigYmlSafetyConflicts()).toEqual([]);
    expect(formatConfigYmlConflictLines()).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanModelsJson finds reasoning models and compat flags", () => {
  const modelsJson = JSON.stringify({
    providers: {
      "zen-openai": {
        baseUrl: "http://localhost:4096/v1",
        api: "openai-completions",
        compat: { supportsDeveloperRole: false },
        models: [
          { id: "deepseek-v4-flash-free", reasoning: true },
          { id: "plain-model", reasoning: false },
        ],
      },
      other: {
        models: [
          {
            id: "m2",
            reasoning: true,
            compat: { requiresReasoningContentOnAssistantMessages: true },
          },
        ],
      },
    },
  });

  const providers = scanModelsJson(modelsJson);
  const zen = providers.find((p) => p.name === "zen-openai");
  expect(zen).toBeDefined();
  expect(zen!.reasoningModels).toEqual(["deepseek-v4-flash-free"]);
  expect(zen!.hasCompat).toBe(false);

  const other = providers.find((p) => p.name === "other");
  expect(other!.reasoningModels).toEqual(["m2"]);
  expect(other!.hasCompat).toBe(true);
});

test("detectReasoningCompatIssues reports models missing the compat flag", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-compat-"));
  process.env.PICO_HOME = home;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "zen-openai": {
            models: [
              { id: "deepseek-v4-flash-free", reasoning: true },
              { id: "plain", reasoning: false },
            ],
          },
        },
      }),
    );

    const issues = detectReasoningCompatIssues();
    expect(issues).toEqual([
      { provider: "zen-openai", model: "deepseek-v4-flash-free", hasCompatFlag: false },
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildDoctorReport includes model summary and version", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-report-"));
  process.env.PICO_HOME = home;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "zen-openai", defaultModel: "deepseek-v4-flash-free" }),
    );

    const report = buildDoctorReport("/repo");
    expect(report).toContain("Model:");
    expect(report).toContain("provider: zen-openai");
    expect(report).toContain("model: deepseek-v4-flash-free");
    expect(report).toContain("pico v");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("detectConfigYmlModelConflicts flags default provider/model drift", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-models-"));
  process.env.PICO_HOME = home;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "config.yml"),
      "env:\n  TAVILY_API_KEY: x\nsafety:\n  enableProjectHooks: false\ndefaultProvider: zen-openai\ndefaultModel: deepseek-v4-flash-free\n",
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "kevimllm", defaultModel: "deepseek-v4-flash" }),
    );

    const conflicts = detectConfigYmlModelConflicts();
    expect(conflicts).toEqual([
      { key: "defaultProvider", configYmlValue: "zen-openai", settingsValue: "kevimllm" },
      { key: "defaultModel", configYmlValue: "deepseek-v4-flash-free", settingsValue: "deepseek-v4-flash" },
    ]);

    const report = buildDoctorReport("/repo");
    expect(report).toContain("config.yml model selection is IGNORED");
    expect(report).toContain("defaultProvider: config.yml=zen-openai but settings.json=kevimllm");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("detectConfigYmlModelConflicts is empty when configs agree or keys are absent", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-models-ok-"));
  process.env.PICO_HOME = home;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "config.yml"), "defaultProvider: kevimllm\ndefaultModel: deepseek-v4-flash\n");
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "kevimllm", defaultModel: "deepseek-v4-flash" }),
    );
    expect(detectConfigYmlModelConflicts()).toEqual([]);

    writeFileSync(join(agentDir, "config.yml"), "safety:\n  enableProjectHooks: false\n");
    expect(detectConfigYmlModelConflicts()).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("session_start notifies once on model config conflicts", async () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-notify-"));
  process.env.PICO_HOME = home;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "config.yml"), "defaultProvider: zen-openai\n");
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "kevimllm", defaultModel: "deepseek-v4-flash" }),
    );
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          kevimllm: {
            models: [{ id: "deepseek-v4-flash", reasoning: true, compat: { requiresReasoningContentOnAssistantMessages: true } }],
          },
        },
      }),
    );

    const notifications: Array<{ message: string; type?: string }> = [];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const fakePi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
      registerCommand: () => {},
    };
    doctorExtension(fakePi as never);
    await handlers.get("session_start")!({}, {
      hasUI: true,
      ui: {
        notify: (message: string, type?: string) => notifications.push({ message, type }),
      },
    } as never);

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.type).toBe("warning");
    expect(notifications[0]!.message).toContain("defaultProvider");
    // With a compat-flagged default model, no second advisory fires.
    expect(notifications[0]!.message).not.toContain("requiresReasoningContentOnAssistantMessages");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("session_start notifies on config.yml safety conflicts (ignored switches)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-safety-notify-"));
  process.env.PICO_HOME = home;
  const realWrite = process.stderr.write.bind(process.stderr);
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "config.yml"), "safety:\n  allowUnattendedPlanApproval: true\n");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "x", defaultModel: "y" }));

    const stderr = new Map<boolean, string[]>();
    process.stderr.write = ((chunk: unknown) => {
      stderr.set(true, [...(stderr.get(true) ?? []), String(chunk)]);
      return true;
    }) as typeof process.stderr.write;
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const fakePi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
      registerCommand: () => {},
    };
    doctorExtension(fakePi as never);
    await handlers.get("session_start")!({}, { hasUI: false, ui: {} } as never);

    const written = stderr.get(true)?.join("") ?? "";
    expect(written).toContain("safety");
    expect(written).toContain("allowUnattendedPlanApproval");
  } finally {
    process.stderr.write = realWrite;
    rmSync(home, { recursive: true, force: true });
  }
});

test("detectMissingDefaultModel flags a model absent from models.json and the store", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-missing-model-"));
  process.env.PICO_HOME = home;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "zen-openai", defaultModel: "no-such-model-xyz" }),
    );
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({ providers: { "zen-openai": { models: [{ id: "deepseek-v4-flash-free" }] } } }),
    );
    expect(detectMissingDefaultModel()).toEqual({ provider: "zen-openai", model: "no-such-model-xyz" });
    // The doctor report carries the advisory line.
    expect(buildDoctorReport("/repo")).toContain("Default model zen-openai/no-such-model-xyz not found");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("detectMissingDefaultModel accepts models declared in models-store.json", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-store-model-"));
  process.env.PICO_HOME = home;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "opencode-go", defaultModel: "kimi-k2.6" }),
    );
    writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ "opencode-go": { models: [{ id: "kimi-k2.6" }] } }));
    expect(detectMissingDefaultModel()).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("detectMissingDefaultModel returns null when provider/model is unset", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-no-model-"));
  process.env.PICO_HOME = home;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
    expect(detectMissingDefaultModel()).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildDoctorReport surfaces the request timeout with its source", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-timeout-home-"));
  process.env.PICO_HOME = home;
  try {
    const report = buildDoctorReport("/repo");
    expect(report).toContain("Request timeout:");
    expect(report).toContain("5 min (default; key httpIdleTimeoutMs)");

    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 60_000 }));
    const configured = buildDoctorReport("/repo");
    expect(configured).toContain("1 min (settings.json; key httpIdleTimeoutMs)");

    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 0 }));
    expect(buildDoctorReport("/repo")).toContain("disabled (0 = no timeout; key httpIdleTimeoutMs)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor reports config namespace sources and env mappings", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-home-"));
  process.env.PICO_HOME = home;
  try {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(join(home, "agent", "settings.json"), JSON.stringify({
      hooks: { hooks: [] },
      mcpServers: { mcpServers: {} },
    }));
    const report = buildDoctorReport("/repo");
    expect(report).toContain("Config sources:");
    expect(report).toContain("hooks: settings.json");
    expect(report).toContain("mcpServers: settings.json");
    expect(report).toContain("lsp: legacy file");
    expect(report).toContain("Env ↔ settings:");
    expect(report).toContain("PICO_HOME");
    expect(report).toContain("PICO_RTK");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
