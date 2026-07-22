import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { srcodeHome, srcodeModelsPath, srcodeSettingsPath } from "../extensions/paths.ts";
import type { Settings } from "../extensions/settings.ts";

export type SetupSection = "model" | "tools" | "safety" | "ui";
type SetupLanguage = "zh" | "en";

export interface SetupCliOptions {
  section?: SetupSection;
  nonInteractive: boolean;
  reset: boolean;
  help: boolean;
  error?: string;
}

interface ProviderChoice {
  id: string;
  label: string;
  envName?: string;
  defaultModel: string;
}

interface CustomProviderConfig {
  id: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  apiKey: string;
  model: string;
}

interface JsonObject {
  [key: string]: unknown;
}

interface SetupIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

const SETUP_SECTIONS: SetupSection[] = ["model", "tools", "safety", "ui"];

const KNOWN_PROVIDERS: ProviderChoice[] = [
  { id: "anthropic", label: "Anthropic", envName: "ANTHROPIC_API_KEY", defaultModel: "claude-opus-4-8" },
  { id: "openai", label: "OpenAI", envName: "OPENAI_API_KEY", defaultModel: "gpt-5.5" },
  { id: "google", label: "Google Gemini", envName: "GEMINI_API_KEY", defaultModel: "gemini-3.1-pro-preview" },
  { id: "openrouter", label: "OpenRouter", envName: "OPENROUTER_API_KEY", defaultModel: "moonshotai/kimi-k2.6" },
];

const ENV_KEYS_MANAGED_BY_SETUP = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "TAVILY_API_KEY",
  "SRCODE_SEARCH_PROVIDER",
  "SRCODE_VISION_PROVIDER",
  "SRCODE_VISION_MODEL",
]);

const SAFETY_DEFAULTS = {
  allowUnattendedPlanApproval: false,
  allowLspFormatOnWrite: false,
  enableProjectHooks: false,
  enableProjectMcp: false,
};

const TEXT = {
  en: {
    setupTitle: "srcode setup",
    languageQuestion: "Choose setup language",
    languageChoices: ["中文", "English"],
    menuHint: "Use Up/Down or j/k, Enter to select, Esc to keep current",
    home: "home",
    settings: "settings",
    modelHeader: "Model & Provider",
    providerQuestion: "Default provider",
    customProvider: "Custom OpenAI-compatible provider",
    skipModel: "Skip model configuration",
    defaultModel: "Default model",
    providerId: "Provider id",
    baseUrl: "Base URL",
    apiKey: "API key value or env reference",
    modelId: "Model id",
    apiCompatibility: "API compatibility",
    toolsHeader: "Tools",
    webSearchProvider: "Web search provider",
    searchChoices: [
      "Hybrid/auto (Exa plus Tavily when key is configured)",
      "Exa only",
      "Tavily only",
    ],
    configureVision: "Configure auxiliary vision model?",
    visionProvider: "Vision provider",
    visionModel: "Vision model",
    safetyHeader: "Safety",
    projectHooks: "Enable project .srcode/hooks.json shell hooks?",
    projectMcp: "Enable project .srcode/mcp-servers.json MCP servers?",
    lspFormat: "Allow LSP format-on-write after edits?",
    unattendedPlan: "Allow non-interactive plan approvals?",
    uiHeader: "UI",
    responseLanguage: "Response language",
    leaveKeep: "leave empty to keep current",
    leaveSkip: "leave empty to skip",
    invalidYesNo: "Please enter y or n.",
    nonInteractiveError: "error: srcode setup needs an interactive terminal. Use --non-interactive for defaults.",
    complete: "srcode setup complete",
    models: "models",
    defaultModelSummary: "default model",
    settingsEnv: "settings env",
    vision: "vision",
    customProviders: "custom providers",
    nextStep: "Run srcode to start, or use /doctor inside srcode to inspect the active settings.",
  },
  zh: {
    setupTitle: "srcode 设置",
    languageQuestion: "选择设置界面语言",
    languageChoices: ["中文", "English"],
    menuHint: "使用上下方向键或 j/k 移动，Enter 选择，Esc 保留当前项",
    home: "数据目录",
    settings: "设置文件",
    modelHeader: "模型与提供商",
    providerQuestion: "默认提供商",
    customProvider: "自定义 OpenAI 兼容提供商",
    skipModel: "跳过模型配置",
    defaultModel: "默认模型",
    providerId: "提供商 ID",
    baseUrl: "Base URL",
    apiKey: "API key 值或环境变量引用",
    modelId: "模型 ID",
    apiCompatibility: "API 兼容类型",
    toolsHeader: "工具",
    webSearchProvider: "网页搜索提供商",
    searchChoices: [
      "混合/自动（配置 Tavily key 时同时使用 Exa 和 Tavily）",
      "仅 Exa",
      "仅 Tavily",
    ],
    configureVision: "配置辅助视觉模型？",
    visionProvider: "视觉模型提供商",
    visionModel: "视觉模型",
    safetyHeader: "安全开关",
    projectHooks: "启用项目 .srcode/hooks.json shell hooks？",
    projectMcp: "启用项目 .srcode/mcp-servers.json MCP 服务器？",
    lspFormat: "允许 LSP 在写入后自动格式化？",
    unattendedPlan: "允许非交互模式自动批准计划？",
    uiHeader: "界面",
    responseLanguage: "agent 回复语言",
    leaveKeep: "留空保留当前值",
    leaveSkip: "留空跳过",
    invalidYesNo: "请输入 y 或 n。",
    nonInteractiveError: "error: srcode setup 需要交互式终端。可使用 --non-interactive 写入默认配置。",
    complete: "srcode 设置完成",
    models: "模型配置",
    defaultModelSummary: "默认模型",
    settingsEnv: "settings env",
    vision: "视觉模型",
    customProviders: "自定义提供商",
    nextStep: "运行 srcode 启动；也可以在 srcode 内使用 /doctor 检查当前设置。",
  },
} satisfies Record<SetupLanguage, Record<string, string | string[]>>;

export function parseSetupArgs(args: string[]): SetupCliOptions | undefined {
  if (args[0] !== "setup") return undefined;

  const options: SetupCliOptions = {
    nonInteractive: false,
    reset: false,
    help: false,
  };

  for (const arg of args.slice(1)) {
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--non-interactive") {
      options.nonInteractive = true;
    } else if (arg === "--reset") {
      options.reset = true;
    } else if (SETUP_SECTIONS.includes(arg as SetupSection)) {
      if (options.section) options.error = `setup section can only be provided once: ${arg}`;
      else options.section = arg as SetupSection;
    } else {
      options.error = `unknown setup argument: ${arg}`;
    }
  }

  return options;
}

export function setupUsage(): string {
  return [
    "Usage: srcode setup [model|tools|safety|ui] [--non-interactive] [--reset]",
    "",
    "Interactive setup wizard for srcode.",
    "",
    "Sections:",
    "  model   Configure default provider/model, API key env, or a custom provider",
    "  tools   Configure web search and auxiliary vision model",
    "  safety  Configure srcode safety switches",
    "  ui      Configure response language",
    "",
    "Options:",
    "  --non-interactive  Write safe defaults and import existing environment values",
    "  --reset            Remove setup-managed settings from settings.json",
    "  -h, --help         Show this help",
  ].join("\n");
}

export async function runSetupCommand(options: SetupCliOptions, io: SetupIo = {
  input: defaultInput,
  output: defaultOutput,
}): Promise<number> {
  if (options.help) {
    writeLine(io, setupUsage());
    return options.error ? 1 : 0;
  }
  if (options.error) {
    writeLine(io, `error: ${options.error}\n\n${setupUsage()}`);
    return 1;
  }
  if (options.reset) {
    resetSetupConfig();
    writeLine(io, `srcode setup reset complete\nsettings: ${srcodeSettingsPath()}`);
    return 0;
  }
  if (options.nonInteractive) {
    applyNonInteractiveDefaults();
    writeLine(io, buildSetupSummary(readJson(srcodeSettingsPath()), readJson(srcodeModelsPath()), "en"));
    return 0;
  }
  if (!isInteractive(io)) {
    writeLine(io, TEXT.en.nonInteractiveError);
    return 1;
  }

  let language: SetupLanguage = "zh";
  try {
    language = await chooseSetupLanguage(io);
    io.output.write("\x1b[2J\x1b[H");
    const prompt = new SetupPrompter(io, language);
    const text = TEXT[language];
    printHeader(io, text.setupTitle);
    writeLine(io, `${text.home}: ${srcodeHome()}`);
    writeLine(io, `${text.settings}: ${srcodeSettingsPath()}`);
    writeLine(io, "");

    if (options.section) {
      await runSection(options.section, prompt, io);
    } else {
      for (const section of SETUP_SECTIONS) {
        await runSection(section, prompt, io);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(io, message);
    return 130;
  }

  writeLine(io, "");
  writeLine(io, buildSetupSummary(readJson(srcodeSettingsPath()), readJson(srcodeModelsPath()), language));
  return 0;
}

class SetupPrompter {
  constructor(
    private readonly io: SetupIo,
    readonly language: SetupLanguage,
  ) {}

  async text(question: string, defaultValue = ""): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    return await withReadline(this.io, async (rl) => {
      const answer = await rl.question(`${question}${suffix}: `);
      return sanitizeInput(answer).trim() || defaultValue;
    });
  }

  async optionalSecret(question: string, currentConfigured: boolean): Promise<string | undefined> {
    const text = TEXT[this.language];
    const suffix = currentConfigured ? ` [${text.leaveKeep}]` : ` [${text.leaveSkip}]`;
    return await withReadline(this.io, async (rl) => {
      const answer = await rl.question(`${question}${suffix}: `);
      const value = sanitizeInput(answer).trim();
      return value.length > 0 ? value : undefined;
    });
  }

  async yesNo(question: string, defaultValue: boolean): Promise<boolean> {
    const suffix = defaultValue ? "Y/n" : "y/N";
    while (true) {
      const answer = await withReadline(this.io, async (rl) => (
        sanitizeInput(await rl.question(`${question} [${suffix}]: `)).trim().toLowerCase()
      ));
      if (!answer) return defaultValue;
      if (["y", "yes"].includes(answer)) return true;
      if (["n", "no"].includes(answer)) return false;
      writeLine(this.io, TEXT[this.language].invalidYesNo);
    }
  }

  async choice(question: string, choices: string[], defaultIndex = 0): Promise<number> {
    return await runChoiceMenu(this.io, question, choices, defaultIndex, this.language);
  }

}

async function chooseSetupLanguage(io: SetupIo): Promise<SetupLanguage> {
  const index = await runChoiceMenu(
    io,
    TEXT.zh.languageQuestion,
    TEXT.zh.languageChoices,
    0,
    "zh",
  );
  return index === 1 ? "en" : "zh";
}

async function withReadline<T>(io: SetupIo, fn: (rl: ReturnType<typeof createInterface>) => Promise<T>): Promise<T> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

async function runChoiceMenu(
  io: SetupIo,
  question: string,
  choices: readonly string[],
  defaultIndex: number,
  language: SetupLanguage,
): Promise<number> {
  const input = io.input as NodeJS.ReadStream;
  const output = io.output;
  let selected = clampIndex(defaultIndex, choices.length);
  let renderedLines = 0;

  const render = () => {
    if (renderedLines > 0) {
      output.write(`\x1b[${renderedLines}A`);
      for (let i = 0; i < renderedLines; i++) {
        output.write("\x1b[2K\r");
        if (i < renderedLines - 1) output.write("\x1b[1B");
      }
      output.write(`\x1b[${renderedLines - 1}A`);
    }

    const lines = [
      question,
      ...choices.map((choice, index) => {
        const cursor = index === selected ? ">" : " ";
        const marker = index === selected ? "*" : " ";
        return ` ${cursor} ${marker} ${choice}`;
      }),
      `  ${TEXT[language].menuHint}`,
    ];
    output.write(lines.join("\n") + "\n");
    renderedLines = lines.length;
  };

  return await new Promise<number>((resolve, reject) => {
    const previousRaw = input.isRaw;
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode?.(previousRaw ?? false);
      output.write("\x1b[?25h");
    };
    const finish = (value: number) => {
      cleanup();
      output.write("\n");
      resolve(value);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const key = chunk.toString("utf-8");
      if (key === "\u0003") {
        fail(new Error("Setup cancelled"));
        return;
      }
      if (key === "\r" || key === "\n") {
        finish(selected);
        return;
      }
      if (key === "\x1b") {
        finish(defaultIndex);
        return;
      }
      if (key === "\x1b[A" || key === "k") {
        selected = selected <= 0 ? choices.length - 1 : selected - 1;
        render();
        return;
      }
      if (key === "\x1b[B" || key === "j") {
        selected = selected >= choices.length - 1 ? 0 : selected + 1;
        render();
        return;
      }
      const numeric = Number.parseInt(key, 10);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
        selected = numeric - 1;
        render();
      }
    };

    try {
      output.write("\x1b[?25l");
      input.setRawMode?.(true);
      input.resume();
      input.on("data", onData);
      render();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function runSection(section: SetupSection, prompt: SetupPrompter, io: SetupIo): Promise<void> {
  if (section === "model") await runModelSetup(prompt, io);
  if (section === "tools") await runToolsSetup(prompt, io);
  if (section === "safety") await runSafetySetup(prompt, io);
  if (section === "ui") await runUiSetup(prompt, io);
}

async function runModelSetup(prompt: SetupPrompter, io: SetupIo): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.modelHeader);
  const settings = readJson(srcodeSettingsPath()) as Settings;
  const choices = [
    ...KNOWN_PROVIDERS.map((p) => `${p.label} (${p.id})`),
    text.customProvider,
    text.skipModel,
  ];
  const currentProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : "";
  const defaultIndex = Math.max(0, KNOWN_PROVIDERS.findIndex((p) => p.id === currentProvider));
  const index = await prompt.choice(text.providerQuestion, choices, defaultIndex);
  const provider = KNOWN_PROVIDERS[index];
  if (!provider) {
    if (index === KNOWN_PROVIDERS.length) {
      await configureCustomProvider(prompt);
    }
    return;
  }

  const model = await prompt.text(text.defaultModel, stringSetting(settings.defaultModel) ?? provider.defaultModel);
  settings.defaultProvider = provider.id;
  settings.defaultModel = model;

  if (provider.envName) {
    const current = readSettingsEnv(settings)[provider.envName] ?? process.env[provider.envName];
    const value = await prompt.optionalSecret(`${provider.envName}`, typeof current === "string" && current.length > 0);
    if (value) setSettingsEnv(settings, provider.envName, value);
  }
  writeJson(srcodeSettingsPath(), settings);
}

async function configureCustomProvider(prompt: SetupPrompter): Promise<void> {
  const text = TEXT[prompt.language];
  const config: CustomProviderConfig = {
    id: await prompt.text(text.providerId, "local"),
    baseUrl: await prompt.text(text.baseUrl, "http://localhost:11434/v1"),
    api: await chooseApi(prompt),
    apiKey: await prompt.text(text.apiKey, "ollama"),
    model: await prompt.text(text.modelId, "qwen2.5-coder:7b"),
  };
  writeCustomProvider(config);

  const settings = readJson(srcodeSettingsPath()) as Settings;
  settings.defaultProvider = config.id;
  settings.defaultModel = config.model;
  writeJson(srcodeSettingsPath(), settings);
}

async function chooseApi(prompt: SetupPrompter): Promise<CustomProviderConfig["api"]> {
  const apis: Array<CustomProviderConfig["api"]> = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ];
  return apis[await prompt.choice(TEXT[prompt.language].apiCompatibility, apis)]!;
}

async function runToolsSetup(prompt: SetupPrompter, io: SetupIo): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.toolsHeader);
  const settings = readJson(srcodeSettingsPath()) as Settings;
  const env = readSettingsEnv(settings);

  const searchIndex = await prompt.choice(
    text.webSearchProvider,
    text.searchChoices,
    env.SRCODE_SEARCH_PROVIDER === "exa" ? 1 : env.SRCODE_SEARCH_PROVIDER === "tavily" ? 2 : 0,
  );
  if (searchIndex === 0) delete env.SRCODE_SEARCH_PROVIDER;
  else env.SRCODE_SEARCH_PROVIDER = searchIndex === 1 ? "exa" : "tavily";

  const tavily = await prompt.optionalSecret("TAVILY_API_KEY", typeof env.TAVILY_API_KEY === "string" && env.TAVILY_API_KEY.length > 0);
  if (tavily) env.TAVILY_API_KEY = tavily;

  if (await prompt.yesNo(text.configureVision, hasVisionSettings(settings))) {
    const auxiliary = objectSetting(settings.auxiliary);
    const vision = objectSetting(auxiliary.vision);
    vision.provider = await prompt.text(text.visionProvider, stringSetting(vision.provider) ?? stringSetting(settings.defaultProvider) ?? "openai");
    vision.model = await prompt.text(text.visionModel, stringSetting(vision.model) ?? stringSetting(settings.defaultModel) ?? "gpt-4o-mini");
    auxiliary.vision = vision;
    settings.auxiliary = auxiliary;
  }

  settings.env = env;
  writeJson(srcodeSettingsPath(), settings);
}

async function runSafetySetup(prompt: SetupPrompter, io: SetupIo): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.safetyHeader);
  const settings = readJson(srcodeSettingsPath()) as Settings;
  const safety = { ...SAFETY_DEFAULTS, ...objectSetting(settings.safety) };

  safety.enableProjectHooks = await prompt.yesNo(
    text.projectHooks,
    booleanSetting(safety.enableProjectHooks, false),
  );
  safety.enableProjectMcp = await prompt.yesNo(
    text.projectMcp,
    booleanSetting(safety.enableProjectMcp, false),
  );
  safety.allowLspFormatOnWrite = await prompt.yesNo(
    text.lspFormat,
    booleanSetting(safety.allowLspFormatOnWrite, false),
  );
  safety.allowUnattendedPlanApproval = await prompt.yesNo(
    text.unattendedPlan,
    booleanSetting(safety.allowUnattendedPlanApproval, false),
  );

  settings.safety = safety;
  writeJson(srcodeSettingsPath(), settings);
}

async function runUiSetup(prompt: SetupPrompter, io: SetupIo): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.uiHeader);
  const settings = readJson(srcodeSettingsPath()) as Settings;
  const defaultLanguage = prompt.language === "zh" ? "简体中文" : "English";
  settings.language = await prompt.text(text.responseLanguage, stringSetting(settings.language) ?? defaultLanguage);
  writeJson(srcodeSettingsPath(), settings);
}

export function applyNonInteractiveDefaults(): void {
  const settings = readJson(srcodeSettingsPath()) as Settings;
  settings.language ??= "简体中文";
  settings.safety = { ...SAFETY_DEFAULTS, ...objectSetting(settings.safety) };

  const env = readSettingsEnv(settings);
  for (const key of ENV_KEYS_MANAGED_BY_SETUP) {
    if (typeof process.env[key] === "string" && process.env[key]!.length > 0 && typeof env[key] !== "string") {
      env[key] = process.env[key]!;
    }
  }
  settings.env = env;
  writeJson(srcodeSettingsPath(), settings);
}

export function resetSetupConfig(): void {
  const settings = readJson(srcodeSettingsPath()) as Settings;
  for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel", "language", "auxiliary", "safety"]) {
    delete settings[key];
  }
  const env = readSettingsEnv(settings);
  for (const key of ENV_KEYS_MANAGED_BY_SETUP) delete env[key];
  if (Object.keys(env).length === 0) delete settings.env;
  else settings.env = env;
  writeJson(srcodeSettingsPath(), settings);
}

export function writeCustomProvider(config: CustomProviderConfig): void {
  const models = readJson(srcodeModelsPath());
  const providers = objectSetting(models.providers);
  providers[config.id] = {
    baseUrl: config.baseUrl,
    api: config.api,
    apiKey: config.apiKey,
    compat: config.api === "openai-completions"
      ? { supportsDeveloperRole: false, supportsReasoningEffort: false }
      : undefined,
    models: [{ id: config.model }],
  };
  removeUndefined(providers[config.id] as JsonObject);
  models.providers = providers;
  writeJson(srcodeModelsPath(), models);
}

export function buildSetupSummary(settings: JsonObject, models: JsonObject, language: SetupLanguage = "en"): string {
  const text = TEXT[language];
  const lines = [text.complete];
  lines.push(`${text.settings}: ${srcodeSettingsPath()}`);
  if (existsSync(srcodeModelsPath())) lines.push(`${text.models}: ${srcodeModelsPath()}`);
  const provider = stringSetting(settings.defaultProvider);
  const model = stringSetting(settings.defaultModel);
  if (provider && model) lines.push(`${text.defaultModelSummary}: ${provider}/${model}`);
  const env = readSettingsEnv(settings);
  const envNames = Object.keys(env).sort();
  if (envNames.length > 0) lines.push(`${text.settingsEnv}: ${envNames.join(", ")}`);
  if (hasVisionSettings(settings as Settings)) {
    const vision = objectSetting(objectSetting(settings.auxiliary).vision);
    lines.push(`${text.vision}: ${stringSetting(vision.provider)}/${stringSetting(vision.model)}`);
  }
  if (Object.keys(objectSetting(models.providers)).length > 0) {
    lines.push(`${text.customProviders}: ${Object.keys(objectSetting(models.providers)).sort().join(", ")}`);
  }
  lines.push(text.nextStep);
  return lines.join("\n");
}

function readSettingsEnv(settings: JsonObject): Record<string, string> {
  const raw = objectSetting(settings.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function setSettingsEnv(settings: JsonObject, key: string, value: string): void {
  const env = readSettingsEnv(settings);
  env[key] = value;
  settings.env = env;
}

function hasVisionSettings(settings: Settings): boolean {
  const vision = objectSetting(objectSetting(settings.auxiliary).vision);
  return typeof vision.provider === "string" && typeof vision.model === "string";
}

function readJson(path: string): JsonObject {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
  } catch {
    // Missing or malformed config should not block setup.
  }
  return {};
}

function writeJson(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function objectSetting(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return {};
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanSetting(value: unknown, defaultValue: boolean): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isInteger(index)) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

function removeUndefined(value: JsonObject): void {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
}

function sanitizeInput(value: string): string {
  return value.replace(/\x1b\[\s*200~|\x1b\[\s*201~/g, "");
}

function isInteractive(io: SetupIo): boolean {
  const input = io.input as NodeJS.ReadStream;
  const output = io.output as NodeJS.WriteStream;
  return Boolean(input.isTTY && output.isTTY);
}

function printHeader(io: SetupIo, title: string): void {
  writeLine(io, "");
  writeLine(io, `== ${title} ==`);
}

function writeLine(io: SetupIo, line: string): void {
  io.output.write(`${line}\n`);
}

export function __resetSetupFilesForTests(): void {
  rmSync(srcodeSettingsPath(), { force: true });
  rmSync(srcodeModelsPath(), { force: true });
}
