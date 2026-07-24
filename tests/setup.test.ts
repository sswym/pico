import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSetupSummary, configureCodeGraphMcp, configureRtkIntegration, parseSetupArgs, resetSetupConfig, runSetupCommand, writeCustomProvider } from "../src/setup/index.ts";
import { srcodeLspConfigPath, srcodeMcpConfigPath, srcodeModelsPath, srcodeSettingsPath } from "../src/extensions/paths.ts";

const savedEnv = {
  home: process.env.SRCODE_HOME,
  openai: process.env.OPENAI_API_KEY,
  tavily: process.env.TAVILY_API_KEY,
};

afterEach(() => {
  if (savedEnv.home === undefined) delete process.env.SRCODE_HOME;
  else process.env.SRCODE_HOME = savedEnv.home;
  if (savedEnv.openai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedEnv.openai;
  if (savedEnv.tavily === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = savedEnv.tavily;
});

function useTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "srcode-setup-home-"));
  process.env.SRCODE_HOME = home;
  return home;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function collectOutput() {
  let output = "";
  return {
    io: {
      input: process.stdin,
      output: {
        write(chunk: string) {
          output += chunk;
          return true;
        },
      },
    },
    get output() {
      return output;
    },
  };
}

test("parseSetupArgs recognizes setup sections and flags", () => {
  expect(parseSetupArgs(["setup", "model", "--non-interactive"])).toMatchObject({
    section: "model",
    nonInteractive: true,
  });
  expect(parseSetupArgs(["setup", "--quick"])).toMatchObject({ quick: true });
  expect(parseSetupArgs(["setup", "--reconfigure"])).toMatchObject({ reconfigure: true });
  expect(parseSetupArgs(["setup", "memory"])?.section).toBe("memory");
  expect(parseSetupArgs(["setup", "lsp"])?.section).toBe("lsp");
  expect(parseSetupArgs(["setup", "hooks"])?.section).toBe("hooks");
  expect(parseSetupArgs(["setup", "mcp"])?.section).toBe("mcp");
  expect(parseSetupArgs(["setup", "integrations"])?.section).toBe("integrations");
  expect(parseSetupArgs(["setup", "env"])?.section).toBe("env");
  expect(parseSetupArgs(["doctor"])).toBeUndefined();
  expect(parseSetupArgs(["setup", "unknown"])?.error).toContain("unknown setup argument");
});

test("non-interactive setup writes safe defaults and imports configured env", async () => {
  const home = useTempHome();
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.TAVILY_API_KEY = "tv-test";
  const output = collectOutput();

  try {
    const code = await runSetupCommand({
      nonInteractive: true,
      reset: false,
      help: false,
      quick: false,
      reconfigure: false,
    }, output.io as any);

    expect(code).toBe(0);
    const settings = readJson(srcodeSettingsPath());
    expect(settings.language).toBe("简体中文");
    expect(settings.safety).toMatchObject({
      enableProjectHooks: false,
      enableProjectMcp: false,
      allowLspFormatOnWrite: false,
      allowUnattendedPlanApproval: false,
    });
    expect(settings.env.OPENAI_API_KEY).toBe("sk-test");
    expect(settings.env.TAVILY_API_KEY).toBe("tv-test");
    expect(output.output).toContain("srcode setup complete");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeCustomProvider updates models.json and preserves existing providers", () => {
  const home = useTempHome();
  try {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(srcodeModelsPath(), JSON.stringify({
      providers: {
        old: { baseUrl: "http://old", api: "openai-completions", apiKey: "old", models: [{ id: "m" }] },
      },
    }));

    writeCustomProvider({
      id: "local",
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKey: "ollama",
      model: "qwen2.5-coder:7b",
    });

    const models = readJson(srcodeModelsPath());
    expect(models.providers.old.models[0].id).toBe("m");
    expect(models.providers.local).toMatchObject({
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKey: "ollama",
      models: [{ id: "qwen2.5-coder:7b" }],
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resetSetupConfig removes only setup-managed settings", () => {
  const home = useTempHome();
  try {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(srcodeSettingsPath(), JSON.stringify({
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      language: "English",
      packages: ["keep-me"],
      env: {
        OPENAI_API_KEY: "remove-me",
        CUSTOM_ENV: "keep-me",
      },
      safety: { enableProjectHooks: true },
      auxiliary: { vision: { provider: "openai", model: "gpt-4o-mini" } },
      memory: { backend: "holographic" },
      integrations: { rtk: { enabled: true } },
    }));

    resetSetupConfig();

    const settings = readJson(srcodeSettingsPath());
    expect(settings.defaultProvider).toBeUndefined();
    expect(settings.defaultModel).toBeUndefined();
    expect(settings.language).toBeUndefined();
    expect(settings.safety).toBeUndefined();
    expect(settings.auxiliary).toBeUndefined();
    expect(settings.memory).toBeUndefined();
    expect(settings.integrations).toBeUndefined();
    expect(settings.packages).toEqual(["keep-me"]);
    expect(settings.env).toEqual({ CUSTOM_ENV: "keep-me" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("configureCodeGraphMcp writes srcode user MCP server", () => {
  const home = useTempHome();
  try {
    configureCodeGraphMcp({ telemetry: "0" });

    const config = readJson(srcodeMcpConfigPath());
    expect(config.mcpServers.codegraph).toEqual({
      command: "codegraph",
      args: ["serve", "--mcp"],
      env: { CODEGRAPH_TELEMETRY: "0" },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("configureRtkIntegration writes integration settings", () => {
  const home = useTempHome();
  try {
    configureRtkIntegration({ enabled: true, mode: "spawnHook", command: "rtk" });

    const settings = readJson(srcodeSettingsPath());
    expect(settings.integrations.rtk).toEqual({
      enabled: true,
      mode: "spawnHook",
      command: "rtk",
    });

    const summary = buildSetupSummary(settings, {}, "en");
    expect(summary).toContain("integrations: rtk=spawnHook");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup summary includes managed config files and memory backend", () => {
  const home = useTempHome();
  try {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(srcodeLspConfigPath(), JSON.stringify({ formatOnWrite: true }));
    writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: [] }));
    writeFileSync(srcodeMcpConfigPath(), JSON.stringify({ mcpServers: {} }));

    const summary = buildSetupSummary({ memory: { backend: "builtin" } }, {}, "en");

    expect(summary).toContain("memory: builtin");
    expect(summary).toContain(`LSP config: ${srcodeLspConfigPath()}`);
    expect(summary).toContain(`hooks config: ${join(home, "hooks.json")}`);
    expect(summary).toContain(`MCP config: ${srcodeMcpConfigPath()}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
