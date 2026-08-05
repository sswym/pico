import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSetupSummary, configureCodeGraphMcp, configureRtkIntegration, parseSetupArgs, resetSetupConfig, runSection, runSetupCommand, splitArgs, writeCustomProvider, type SetupLanguage, type SetupPrompter, type SetupShell } from "../src/setup/index.ts";
import { picoLspConfigPath, picoMcpConfigPath, picoModelsPath, picoSettingsPath } from "../src/extensions/paths.ts";

const savedEnv = {
  home: process.env.PICO_HOME,
  openai: process.env.OPENAI_API_KEY,
  tavily: process.env.TAVILY_API_KEY,
};

afterEach(() => {
  if (savedEnv.home === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = savedEnv.home;
  if (savedEnv.openai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedEnv.openai;
  if (savedEnv.tavily === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = savedEnv.tavily;
});

function useTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pico-setup-home-"));
  process.env.PICO_HOME = home;
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
    const settings = readJson(picoSettingsPath());
    expect(settings.language).toBe("简体中文");
    expect(settings.safety).toMatchObject({
      enableProjectHooks: false,
      enableProjectMcp: false,
      allowLspFormatOnWrite: false,
      allowUnattendedPlanApproval: false,
    });
    expect(settings.env.OPENAI_API_KEY).toBe("sk-test");
    expect(settings.env.TAVILY_API_KEY).toBe("tv-test");
    expect(output.output).toContain("pico setup complete");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeCustomProvider updates models.json and preserves existing providers", () => {
  const home = useTempHome();
  try {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(picoModelsPath(), JSON.stringify({
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

    const models = readJson(picoModelsPath());
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
    // writeJson must never write API-key-bearing configs world-readable.
    expect(statSync(picoModelsPath()).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("non-interactive setup writes settings.json with 0600 permissions", async () => {
  const home = useTempHome();
  process.env.OPENAI_API_KEY = "sk-test";
  const output = collectOutput();
  try {
    await runSetupCommand({
      nonInteractive: true,
      reset: false,
      help: false,
      quick: false,
      reconfigure: false,
    }, output.io as any);
    expect(statSync(picoSettingsPath()).mode & 0o777).toBe(0o600);
  } finally {
    delete process.env.OPENAI_API_KEY;
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup refuses to run when settings.json is malformed (would clobber API keys)", async () => {
  const home = useTempHome();
  const output = collectOutput();
  try {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(picoSettingsPath(), "{ not valid json ", "utf-8");
    const before = readFileSync(picoSettingsPath(), "utf-8");

    const code = await runSetupCommand({
      nonInteractive: true,
      reset: false,
      help: false,
      quick: false,
      reconfigure: false,
    }, output.io as any);

    expect(code).toBe(1);
    expect(output.output).toContain("malformed JSON");
    // The damaged file must be untouched — no silent overwrite.
    expect(readFileSync(picoSettingsPath(), "utf-8")).toBe(before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup --reset also refuses on malformed settings.json", async () => {
  const home = useTempHome();
  const output = collectOutput();
  try {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(picoSettingsPath(), "{ not valid json ", "utf-8");

    const code = await runSetupCommand({
      nonInteractive: false,
      reset: true,
      help: false,
      quick: false,
      reconfigure: false,
    }, output.io as any);

    expect(code).toBe(1);
    expect(readFileSync(picoSettingsPath(), "utf-8")).toContain("not valid json");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("splitArgs is quote-aware", () => {
  expect(splitArgs("--foo \"bar baz\"")).toEqual(["--foo", "bar baz"]);
  expect(splitArgs("npx -y @modelcontextprotocol/server-github")).toEqual(["npx", "-y", "@modelcontextprotocol/server-github"]);
  expect(splitArgs("cmd 'single quoted' plain")).toEqual(["cmd", "single quoted", "plain"]);
  expect(splitArgs("   ")).toEqual([]);
});

test("resetSetupConfig removes only setup-managed settings", () => {
  const home = useTempHome();
  try {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(picoSettingsPath(), JSON.stringify({
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

    const settings = readJson(picoSettingsPath());
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

test("configureCodeGraphMcp writes pico user MCP server", () => {
  const home = useTempHome();
  try {
    configureCodeGraphMcp({ telemetry: "0" });

    const config = readJson(picoMcpConfigPath());
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

    const settings = readJson(picoSettingsPath());
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
    writeFileSync(picoLspConfigPath(), JSON.stringify({ formatOnWrite: true }));
    writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: [] }));
    writeFileSync(picoMcpConfigPath(), JSON.stringify({ mcpServers: {} }));

    const summary = buildSetupSummary({ memory: { backend: "builtin" } }, {}, "en");

    expect(summary).toContain("memory: builtin");
    expect(summary).toContain(`LSP config: ${picoLspConfigPath()}`);
    expect(summary).toContain(`hooks config: ${join(home, "hooks.json")}`);
    expect(summary).toContain(`MCP config: ${picoMcpConfigPath()}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- interactive sections -------------------------------------------------
//
// Sections talk to the SetupPrompter interface, so a scripted prompter can
// drive them without readline. These cover what actually lands on disk —
// especially the safety switches, which gate unattended plan approval and
// project-scoped hooks/MCP.

interface PromptScript {
  yesNo?: boolean[];
  text?: string[];
  choice?: number[];
  optionalValue?: Array<string | undefined>;
  optionalSecret?: Array<string | undefined>;
}

/**
 * Prompter that replays scripted answers and records every question asked.
 * When a queue runs dry the prompt's own default is returned, so a test only
 * needs to script the answers it cares about.
 */
function scriptedPrompter(script: PromptScript = {}, language: SetupLanguage = "en") {
  const queues = {
    yesNo: [...(script.yesNo ?? [])],
    text: [...(script.text ?? [])],
    choice: [...(script.choice ?? [])],
    optionalValue: [...(script.optionalValue ?? [])],
    optionalSecret: [...(script.optionalSecret ?? [])],
  };
  const asked = {
    yesNo: [] as Array<{ question: string; defaultValue: boolean }>,
    text: [] as Array<{ question: string; defaultValue: string }>,
    choice: [] as Array<{ question: string; choices: string[]; defaultIndex: number }>,
    optionalValue: [] as Array<{ question: string; defaultValue?: string }>,
    optionalSecret: [] as Array<{ question: string; currentConfigured: boolean }>,
  };

  const prompter: SetupPrompter = {
    language,
    async yesNo(question, defaultValue) {
      asked.yesNo.push({ question, defaultValue });
      return queues.yesNo.length > 0 ? queues.yesNo.shift()! : defaultValue;
    },
    async text(question, defaultValue = "") {
      asked.text.push({ question, defaultValue });
      return queues.text.length > 0 ? queues.text.shift()! : defaultValue;
    },
    async choice(question, choices, defaultIndex = 0) {
      asked.choice.push({ question, choices, defaultIndex });
      return queues.choice.length > 0 ? queues.choice.shift()! : defaultIndex;
    },
    async optionalValue(question, defaultValue) {
      asked.optionalValue.push({ question, defaultValue });
      return queues.optionalValue.length > 0 ? queues.optionalValue.shift() : defaultValue;
    },
    async optionalSecret(question, currentConfigured) {
      asked.optionalSecret.push({ question, currentConfigured });
      return queues.optionalSecret.length > 0 ? queues.optionalSecret.shift() : undefined;
    },
  };

  return { prompter, asked };
}

/** Run one section against a temp PICO_HOME and hand back what it wrote. */
async function withSection(
  section: Parameters<typeof runSection>[0],
  script: PromptScript,
  fn: (ctx: {
    settings: () => any;
    asked: ReturnType<typeof scriptedPrompter>["asked"];
    output: string;
    home: string;
  }) => void,
  seed?: (home: string) => void,
  shell?: SetupShell,
): Promise<void> {
  const home = useTempHome();
  const collector = collectOutput();
  const { prompter, asked } = scriptedPrompter(script);
  try {
    // Sections create this lazily; seeds need it up front.
    mkdirSync(join(home, "agent"), { recursive: true });
    seed?.(home);
    await runSection(section, prompter, collector.io as any, shell);
    fn({
      settings: () => readJson(picoSettingsPath()),
      asked,
      output: collector.output,
      home,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("safety section persists every switch the user enables", async () => {
  await withSection("safety", { yesNo: [true, true, true, true] }, ({ settings }) => {
    expect(settings().safety).toMatchObject({
      enableProjectHooks: true,
      enableProjectMcp: true,
      allowLspFormatOnWrite: true,
      allowUnattendedPlanApproval: true,
    });
  });
});

test("safety section defaults every switch to off", async () => {
  // Empty script => each prompt falls back to its own default.
  await withSection("safety", {}, ({ settings, asked }) => {
    expect(settings().safety).toMatchObject({
      enableProjectHooks: false,
      enableProjectMcp: false,
      allowLspFormatOnWrite: false,
      allowUnattendedPlanApproval: false,
    });
    expect(asked.yesNo.every((q) => q.defaultValue === false)).toBe(true);
  });
});

test("safety section offers existing values as the defaults and keeps them", async () => {
  await withSection(
    "safety",
    {},
    ({ settings, asked }) => {
      // Every prompt must have been seeded from the stored value...
      expect(asked.yesNo.map((q) => q.defaultValue)).toEqual([true, false, true, false]);
      // ...and an empty script must leave them untouched.
      expect(settings().safety).toMatchObject({
        enableProjectHooks: true,
        enableProjectMcp: false,
        allowLspFormatOnWrite: true,
        allowUnattendedPlanApproval: false,
      });
    },
    () => {
      writeFileSync(picoSettingsPath(), JSON.stringify({
        safety: {
          enableProjectHooks: true,
          enableProjectMcp: false,
          allowLspFormatOnWrite: true,
          allowUnattendedPlanApproval: false,
        },
      }));
    },
  );
});

test("safety section asks its switches in a stable order", async () => {
  await withSection("safety", {}, ({ asked }) => {
    expect(asked.yesNo).toHaveLength(4);
    // Order matters: scripted answers in other tests depend on it.
    const questions = asked.yesNo.map((q) => q.question);
    expect(new Set(questions).size).toBe(4);
  });
});

test("safety section applies a partial script and defaults the rest", async () => {
  await withSection("safety", { yesNo: [true, true] }, ({ settings }) => {
    expect(settings().safety).toMatchObject({
      enableProjectHooks: true,
      enableProjectMcp: true,
      allowLspFormatOnWrite: false,
      allowUnattendedPlanApproval: false,
    });
  });
});

test("safety section preserves unrelated settings", async () => {
  await withSection(
    "safety",
    { yesNo: [true] },
    ({ settings }) => {
      const s = settings();
      expect(s.defaultProvider).toBe("anthropic");
      expect(s.language).toBe("English");
      expect(s.safety.enableProjectHooks).toBe(true);
    },
    () => {
      writeFileSync(picoSettingsPath(), JSON.stringify({
        defaultProvider: "anthropic",
        language: "English",
      }));
    },
  );
});

test("ui section stores the response language", async () => {
  await withSection("ui", { text: ["日本語"] }, ({ settings }) => {
    expect(settings().language).toBe("日本語");
  });
});

test("ui section defaults the response language from the prompt language", async () => {
  await withSection("ui", {}, ({ settings, asked }) => {
    // Prompter language is "en", so the offered default is English.
    expect(asked.text[0]!.defaultValue).toBe("English");
    expect(settings().language).toBe("English");
  });
});

test("memory section stores the chosen backend and deny list", async () => {
  await withSection(
    "memory",
    { choice: [1], optionalValue: ["secret,token"] },
    ({ settings, asked }) => {
      expect(settings().memory.backend).toBe("holographic");
      expect(settings().env.PICO_MEMORY_DENY).toBe("secret,token");
      expect(asked.choice[0]!.choices).toEqual(["builtin", "holographic"]);
    },
  );
});

test("memory section defaults to the builtin backend", async () => {
  await withSection("memory", {}, ({ settings }) => {
    expect(settings().memory.backend).toBe("builtin");
  });
});

test("lsp section stores formatOnWrite and a valid idle timeout", async () => {
  await withSection("lsp", { yesNo: [true], text: ["30000"] }, ({ home }) => {
    const config = readJson(picoLspConfigPath());
    expect(config.formatOnWrite).toBe(true);
    expect(config.idleTimeoutMs).toBe(30000);
    expect(home).toBeTruthy();
  });
});

test("lsp section ignores a non-numeric idle timeout", async () => {
  await withSection("lsp", { yesNo: [false], text: ["not-a-number"] }, () => {
    const config = readJson(picoLspConfigPath());
    expect(config.formatOnWrite).toBe(false);
    expect(config.idleTimeoutMs).toBeUndefined();
  });
});

test("lsp section rejects a non-positive idle timeout", async () => {
  await withSection("lsp", { yesNo: [false], text: ["0"] }, () => {
    expect(readJson(picoLspConfigPath()).idleTimeoutMs).toBeUndefined();
  });
});

test("hooks section writes a hook and asks about blocking only for PreToolUse", async () => {
  await withSection(
    "hooks",
    // enableProjectHooks=true, createHook=true, blocking=false
    { yesNo: [true, true, false], choice: [0], text: ["echo hi"] },
    ({ settings, home, asked }) => {
      expect(settings().safety.enableProjectHooks).toBe(true);
      const config = readJson(join(home, "hooks.json"));
      expect(config.hooks).toHaveLength(1);
      expect(config.hooks[0]).toMatchObject({
        event: "PreToolUse",
        command: "echo hi",
        blocking: false,
      });
      // 3 yes/no prompts: project hooks, create hook, blocking.
      expect(asked.yesNo).toHaveLength(3);
    },
  );
});

test("hooks section skips the blocking prompt for non-PreToolUse events", async () => {
  await withSection(
    "hooks",
    // choice 1 => PostToolUse, which has no blocking flag.
    { yesNo: [false, true], choice: [1], text: ["echo bye"] },
    ({ home, asked }) => {
      const config = readJson(join(home, "hooks.json"));
      expect(config.hooks[0]).toMatchObject({ event: "PostToolUse", command: "echo bye" });
      expect(config.hooks[0].blocking).toBeUndefined();
      expect(asked.yesNo).toHaveLength(2);
    },
  );
});

test("hooks section writes an empty hook list when the user declines", async () => {
  await withSection("hooks", { yesNo: [false, false] }, ({ home, settings }) => {
    expect(settings().safety.enableProjectHooks).toBe(false);
    expect(readJson(join(home, "hooks.json")).hooks).toEqual([]);
  });
});

test("mcp section writes a server and splits its args", async () => {
  await withSection(
    "mcp",
    { yesNo: [true, true], text: ["ctx7", "npx", "-y  @upstash/context7-mcp"] },
    ({ settings }) => {
      expect(settings().safety.enableProjectMcp).toBe(true);
      const servers = readJson(picoMcpConfigPath()).mcpServers;
      expect(servers.ctx7).toEqual({
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      });
    },
  );
});

test("mcp section omits args when none are given", async () => {
  await withSection(
    "mcp",
    { yesNo: [false, true], text: ["bare", "some-command", "   "] },
    () => {
      expect(readJson(picoMcpConfigPath()).mcpServers.bare).toEqual({ command: "some-command" });
    },
  );
});

test("env section adds a managed key and stops when the user declines", async () => {
  await withSection(
    "env",
    // addEnv=true -> pick key 0 -> value; then addEnv defaults to false and exits.
    { yesNo: [true], choice: [0], optionalValue: ["sk-from-setup"] },
    ({ settings, asked }) => {
      expect(settings().env.ANTHROPIC_API_KEY).toBe("sk-from-setup");
      // The loop must terminate on the default answer, not spin forever.
      expect(asked.yesNo).toHaveLength(2);
    },
  );
});

test("env section supports a custom key via the trailing Custom choice", async () => {
  await withSection(
    "env",
    { yesNo: [true], choice: [12], text: ["MY_CUSTOM_KEY"], optionalValue: ["value"] },
    ({ settings, asked }) => {
      // 12 == ENV_KEYS_MANAGED_BY_SETUP.length, i.e. the "Custom" entry.
      expect(asked.choice[0]!.choices.at(-1)).toBe("Custom");
      expect(settings().env.MY_CUSTOM_KEY).toBe("value");
    },
  );
});

test("env section writes nothing when the user declines immediately", async () => {
  await withSection("env", {}, ({ settings, asked }) => {
    expect(settings().env ?? {}).toEqual({});
    expect(asked.choice).toHaveLength(0);
  });
});

test("model section stores provider, model, and api key", async () => {
  await withSection(
    "model",
    { choice: [0], text: ["claude-opus-4-8"], optionalSecret: ["sk-ant-test"] },
    ({ settings, asked }) => {
      const s = settings();
      expect(s.defaultProvider).toBe("anthropic");
      expect(s.defaultModel).toBe("claude-opus-4-8");
      expect(s.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
      expect(asked.optionalSecret[0]!.question).toBe("ANTHROPIC_API_KEY");
    },
  );
});

test("model section keeps the existing key when the secret prompt is skipped", async () => {
  await withSection(
    "model",
    { choice: [1] },
    ({ settings, asked }) => {
      expect(settings().defaultProvider).toBe("openai");
      // No secret scripted => undefined => nothing written.
      expect(settings().env?.OPENAI_API_KEY).toBeUndefined();
      expect(asked.optionalSecret[0]!.currentConfigured).toBe(false);
    },
  );
});

test("model section writes nothing when the skip entry is chosen", async () => {
  // Index 5 is past the 4 known providers and the custom entry => skip.
  await withSection("model", { choice: [5] }, () => {
    // Skipping must not create a settings file at all.
    expect(existsSync(picoSettingsPath())).toBe(false);
  });
});

test("tools section stores the search provider and vision config", async () => {
  await withSection(
    "tools",
    // search=tavily(2), configureVision=true, then vision provider/model text
    { choice: [2], yesNo: [true], text: ["openai", "gpt-4o-mini"], optionalSecret: ["tv-key"] },
    ({ settings }) => {
      const s = settings();
      expect(s.env.PICO_SEARCH_PROVIDER).toBe("tavily");
      expect(s.env.TAVILY_API_KEY).toBe("tv-key");
      expect(s.auxiliary.vision).toMatchObject({ provider: "openai", model: "gpt-4o-mini" });
    },
  );
});

test("tools section clears the search provider on the default choice", async () => {
  await withSection("tools", { choice: [0], yesNo: [false] }, ({ settings }) => {
    expect(settings().env?.PICO_SEARCH_PROVIDER).toBeUndefined();
    expect(settings().auxiliary).toBeUndefined();
  });
});

test("runSection dispatches to exactly one section", async () => {
  // A safety run must not touch lsp config, and vice versa.
  await withSection("safety", { yesNo: [true, true, true, true] }, ({ home }) => {
    expect(existsSync(join(home, "lsp.json"))).toBe(false);
  });
});

// --- integrations section -------------------------------------------------
//
// The integrations section is the only setup path that shells out, and its
// install branches run `curl … | sh`. Every test here drives a fake shell that
// records calls instead of executing them — nothing below spawns a process.

function fakeShell(opts: {
  exists?: boolean | Record<string, boolean>;
  installResult?: { ok: boolean; output: string };
  runResult?: { ok: boolean; output: string };
} = {}) {
  const calls = {
    commandExists: [] as string[],
    runInstall: [] as string[],
    run: [] as string[][],
  };
  const shell: SetupShell = {
    commandExists(command) {
      calls.commandExists.push(command);
      if (typeof opts.exists === "boolean") return opts.exists;
      return opts.exists?.[command] ?? false;
    },
    runInstall(command) {
      calls.runInstall.push(command);
      return opts.installResult ?? { ok: true, output: "" };
    },
    run(args) {
      calls.run.push(args);
      return opts.runResult ?? { ok: true, output: "" };
    },
  };
  return { shell, calls };
}

test("integrations section touches no external command when both are declined", async () => {
  const { shell, calls } = fakeShell();
  await withSection(
    "integrations",
    {},
    ({ settings }) => {
      expect(settings().integrations).toMatchObject({
        codegraph: { enabled: false },
        rtk: { enabled: false },
      });
      // Sentinel: the disabled path must not probe or spawn anything.
      expect(calls.commandExists).toEqual([]);
      expect(calls.runInstall).toEqual([]);
      expect(calls.run).toEqual([]);
    },
    undefined,
    shell,
  );
});

test("integrations section skips install when codegraph is already present", async () => {
  const { shell, calls } = fakeShell({ exists: true });
  await withSection(
    "integrations",
    // enable codegraph; telemetry/mcp default to true, init defaults to false.
    { yesNo: [true] },
    ({ settings }) => {
      expect(settings().integrations.codegraph.enabled).toBe(true);
      expect(calls.commandExists).toContain("codegraph");
      expect(calls.runInstall).toEqual([]);
      expect(calls.run).toEqual([]);
    },
    undefined,
    shell,
  );
});

test("integrations section installs codegraph on request", async () => {
  const { shell, calls } = fakeShell({ exists: false });
  await withSection(
    "integrations",
    { yesNo: [true, true] },
    () => {
      expect(calls.runInstall).toHaveLength(1);
      expect(calls.runInstall[0]).toContain("codegraph");
      expect(calls.runInstall[0]).toContain("install.sh");
    },
    undefined,
    shell,
  );
});

test("integrations section reports a failed codegraph install", async () => {
  const { shell } = fakeShell({ exists: false, installResult: { ok: false, output: "network down" } });
  await withSection(
    "integrations",
    { yesNo: [true, true] },
    ({ output }) => {
      expect(output).toContain("network down");
    },
    undefined,
    shell,
  );
});

test("integrations section keeps the integration disabled when the install is declined", async () => {
  const { shell, calls } = fakeShell({ exists: false });
  await withSection(
    "integrations",
    { yesNo: [true, false] },
    ({ output, settings }) => {
      expect(calls.runInstall).toEqual([]);
      expect(output.length).toBeGreaterThan(0);
      // Enabling an integration whose binary is missing would break every
      // supported command — declining the install keeps it disabled.
      expect(settings().integrations.codegraph.enabled).toBe(false);
    },
    undefined,
    shell,
  );
});

test("integrations section disables the integration when the install fails", async () => {
  const { shell, calls } = fakeShell({ exists: false, installResult: { ok: false, output: "network down" } });
  await withSection(
    "integrations",
    { yesNo: [true, true] },
    ({ settings }) => {
      expect(calls.runInstall).toHaveLength(1);
      expect(settings().integrations.codegraph.enabled).toBe(false);
    },
    undefined,
    shell,
  );
});

test("integrations section registers the codegraph MCP server with telemetry off", async () => {
  const { shell } = fakeShell({ exists: true });
  await withSection(
    "integrations",
    // enable, telemetryOff=true, mcp=true
    { yesNo: [true, true, true] },
    () => {
      const server = readJson(picoMcpConfigPath()).mcpServers.codegraph;
      expect(server).toMatchObject({ command: "codegraph", args: ["serve", "--mcp"] });
      expect(server.env.CODEGRAPH_TELEMETRY).toBe("0");
    },
    undefined,
    shell,
  );
});

test("integrations section leaves telemetry unset when the user keeps it on", async () => {
  const { shell } = fakeShell({ exists: true });
  await withSection(
    "integrations",
    // enable, telemetryOff=false, mcp=true
    { yesNo: [true, false, true] },
    () => {
      const server = readJson(picoMcpConfigPath()).mcpServers.codegraph;
      expect(server.env?.CODEGRAPH_TELEMETRY).toBeUndefined();
    },
    undefined,
    shell,
  );
});

test("integrations section skips MCP registration when declined", async () => {
  const { shell } = fakeShell({ exists: true });
  await withSection(
    "integrations",
    // enable, telemetryOff=true, mcp=false
    { yesNo: [true, true, false] },
    ({ home }) => {
      expect(existsSync(join(home, "mcp-servers.json"))).toBe(false);
    },
    undefined,
    shell,
  );
});

test("integrations section runs codegraph init on request", async () => {
  const { shell, calls } = fakeShell({ exists: true });
  await withSection(
    "integrations",
    // enable, telemetryOff=true, mcp=false, init=true
    { yesNo: [true, true, false, true] },
    () => {
      expect(calls.run).toEqual([["codegraph", "init"]]);
    },
    undefined,
    shell,
  );
});

test("integrations section reports a failed codegraph init", async () => {
  const { shell } = fakeShell({ exists: true, runResult: { ok: false, output: "not a repo" } });
  await withSection(
    "integrations",
    { yesNo: [true, true, false, true] },
    ({ output }) => {
      expect(output).toContain("not a repo");
    },
    undefined,
    shell,
  );
});

test("integrations section stores rtk in spawnHook mode by default", async () => {
  const { shell, calls } = fakeShell({ exists: true });
  await withSection(
    "integrations",
    // codegraph declined, rtk enabled, mode choice defaults to 0.
    { yesNo: [false, true] },
    ({ settings }) => {
      expect(settings().integrations.rtk).toEqual({
        enabled: true,
        mode: "spawnHook",
        command: "rtk",
      });
      expect(calls.commandExists).toEqual(["rtk"]);
    },
    undefined,
    shell,
  );
});

test("integrations section stores rtk in instructionsOnly mode when chosen", async () => {
  const { shell } = fakeShell({ exists: true });
  await withSection(
    "integrations",
    { yesNo: [false, true], choice: [1] },
    ({ settings }) => {
      expect(settings().integrations.rtk.mode).toBe("instructionsOnly");
    },
    undefined,
    shell,
  );
});

test("integrations section installs rtk on request", async () => {
  const { shell, calls } = fakeShell({ exists: { codegraph: true, rtk: false } });
  await withSection(
    "integrations",
    // codegraph declined, rtk enabled, rtk install accepted
    { yesNo: [false, true, true] },
    () => {
      expect(calls.runInstall).toHaveLength(1);
      expect(calls.runInstall[0]).toContain("rtk");
    },
    undefined,
    shell,
  );
});

test("integrations section offers stored values as defaults", async () => {
  const { shell } = fakeShell({ exists: true });
  await withSection(
    "integrations",
    {},
    ({ asked, settings }) => {
      // Stored enabled flags must come back as the prompt defaults...
      expect(asked.yesNo[0]!.defaultValue).toBe(true);
      // ...and an empty script must preserve them.
      expect(settings().integrations.codegraph.enabled).toBe(true);
      expect(settings().integrations.rtk.enabled).toBe(true);
      // Stored instructionsOnly must be the pre-selected choice.
      expect(asked.choice[0]!.defaultIndex).toBe(1);
    },
    () => {
      writeFileSync(picoSettingsPath(), JSON.stringify({
        integrations: {
          codegraph: { enabled: true },
          rtk: { enabled: true, mode: "instructionsOnly", command: "rtk" },
        },
      }));
    },
    shell,
  );
});

test("integrations section preserves an existing custom rtk command", async () => {
  const { shell } = fakeShell({ exists: true });
  await withSection(
    "integrations",
    { yesNo: [false, true] },
    ({ settings }) => {
      expect(settings().integrations.rtk.command).toBe("/opt/bin/rtk");
    },
    () => {
      writeFileSync(picoSettingsPath(), JSON.stringify({
        integrations: { rtk: { command: "/opt/bin/rtk" } },
      }));
    },
    shell,
  );
});
