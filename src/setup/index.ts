import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { spawnSync } from "node:child_process";
import { picoHome, picoHooksConfigPath, picoLspConfigPath, picoMcpConfigPath, picoSubagentConfigPath, picoAutomodeConfigPath, picoModelsPath, picoSettingsPath } from "../extensions/paths.ts";
import { migrateLegacyUserConfigs } from "../extensions/config-migrate.ts";
import type { Settings } from "../extensions/settings.ts";

export type SetupSection = "model" | "tools" | "safety" | "ui" | "memory" | "lsp" | "hooks" | "mcp" | "integrations" | "env";
export type SetupLanguage = "zh" | "en";

export interface SetupCliOptions {
  section?: SetupSection;
  nonInteractive: boolean;
  reset: boolean;
  help: boolean;
  quick: boolean;
  reconfigure: boolean;
  error?: string;
}

interface ProviderChoice {
  id: string;
  label: string;
  envName?: string;
  defaultModel: string;
  /** Marked "recommended" in the provider menu so first-time users have a default. */
  recommended?: boolean;
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

export interface SetupIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Question surface a setup section talks to.
 *
 * Sections depend on this interface rather than the readline implementation so
 * they can be driven by a scripted prompter in tests.
 */
export interface SetupPrompter {
  readonly language: SetupLanguage;
  text(question: string, defaultValue?: string): Promise<string>;
  optionalSecret(question: string, currentConfigured: boolean): Promise<string | undefined>;
  optionalValue(question: string, defaultValue?: string): Promise<string | undefined>;
  yesNo(question: string, defaultValue: boolean): Promise<boolean>;
  choice(question: string, choices: string[], defaultIndex?: number): Promise<number>;
}

/**
 * External command surface used by the integrations section.
 *
 * Behind an interface because the default implementation shells out — the
 * install paths run `curl … | sh`, which tests must never execute.
 */
export interface SetupShell {
  commandExists(command: string): boolean;
  runInstall(command: string): { ok: boolean; output: string };
  run(args: string[]): { ok: boolean; output: string };
}

interface SetupSectionMeta {
  key: SetupSection;
  title: string;
  summary: (settings: JsonObject) => string | undefined;
  isConfigured: (settings: JsonObject) => boolean;
}

const SETUP_SECTIONS: SetupSection[] = ["model", "tools", "safety", "ui", "memory", "lsp", "hooks", "mcp", "integrations", "env"];

/** Ponytail 内置扩展的运行时模式（与 src/extensions/ponytail/config.ts RUNTIME_MODES 对齐）。 */
const PONYTAIL_MODES = ["off", "lite", "full", "ultra"];

/**
 * Sections a first-time user needs before they can start chatting. Everything
 * else is advanced and gated behind a single yes/no prompt in the interactive
 * flow, so `pico setup` stays a 2-step experience for beginners.
 */
const QUICK_SECTIONS: SetupSection[] = ["model", "ui"];
const ADVANCED_SECTIONS: SetupSection[] = ["tools", "safety", "memory", "lsp", "hooks", "mcp", "integrations", "env"];

const KNOWN_PROVIDERS: ProviderChoice[] = [
  { id: "anthropic", label: "Anthropic", envName: "ANTHROPIC_API_KEY", defaultModel: "claude-opus-4-8", recommended: true },
  { id: "openai", label: "OpenAI", envName: "OPENAI_API_KEY", defaultModel: "gpt-5.5" },
  { id: "google", label: "Google Gemini", envName: "GEMINI_API_KEY", defaultModel: "gemini-3.1-pro-preview" },
  { id: "openrouter", label: "OpenRouter", envName: "OPENROUTER_API_KEY", defaultModel: "moonshotai/kimi-k2.6" },
];

/** Single source of truth: env keys setup owns, in the order the env menu lists them. */
const ENV_KEYS_MANAGED_BY_SETUP = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "TAVILY_API_KEY",
  "PICO_SEARCH_PROVIDER",
  "PICO_VISION_PROVIDER",
  "PICO_VISION_MODEL",
  "PICO_MEMORY_DB",
  "PICO_MEMORY_DENY",
  "CODEGRAPH_TELEMETRY",
  "PICO_RTK",
];

const MEMORY_BACKENDS = ["builtin", "holographic"] as const;
const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "PreSessionEnd", "PostUserMessage"] as const;

/**
 * Menu labels that explain each raw id in one line. A first-time user should
 * not have to know what "holographic" or "PreToolUse" mean to make a choice.
 */
const MEMORY_BACKEND_LABELS: Record<SetupLanguage, [string, string]> = {
  en: [
    "builtin (local SQLite; stable)",
    "holographic (experimental semantic retrieval; demo stage)",
  ],
  zh: [
    "builtin（本地 SQLite；稳定）",
    "holographic（实验性语义检索；demo 阶段）",
  ],
};

const HOOK_EVENT_LABELS: Record<SetupLanguage, string[]> = {
  en: [
    "PreToolUse (before a tool runs; can block)",
    "PostToolUse (after a tool runs)",
    "PreSessionEnd (before the session closes)",
    "PostUserMessage (after you send a message)",
  ],
  zh: [
    "PreToolUse（工具调用前执行；可阻断）",
    "PostToolUse（工具调用后执行）",
    "PreSessionEnd（会话结束前执行）",
    "PostUserMessage（收到你的消息后执行）",
  ],
};

const API_COMPAT_LABELS: Record<SetupLanguage, string[]> = {
  en: [
    "openai-completions (OpenAI-compatible /chat/completions)",
    "openai-responses (OpenAI Responses API)",
    "anthropic-messages (Anthropic Messages API)",
    "google-generative-ai (Google Gemini API)",
  ],
  zh: [
    "openai-completions（OpenAI 兼容的 /chat/completions 接口）",
    "openai-responses（OpenAI Responses 接口）",
    "anthropic-messages（Anthropic Messages 接口）",
    "google-generative-ai（Google Gemini 接口）",
  ],
};

/**
 * Where a beginner can obtain an API key for each known provider, shown
 * inside the key prompt — "ANTHROPIC_API_KEY:" means nothing to a first-time
 * user, "platform.anthropic.com" does.
 */
const PROVIDER_KEY_HINTS: Record<SetupLanguage, Record<string, string>> = {
  en: {
    anthropic: "create at platform.anthropic.com → API keys",
    openai: "create at platform.openai.com → API keys",
    google: "create at aistudio.google.com → Get API key",
    openrouter: "create at openrouter.ai → Keys",
  },
  zh: {
    anthropic: "在 platform.anthropic.com → API keys 创建",
    openai: "在 platform.openai.com → API keys 创建",
    google: "在 aistudio.google.com → Get API key 创建",
    openrouter: "在 openrouter.ai → Keys 创建",
  },
};

const SAFETY_DEFAULTS = {
  allowUnattendedPlanApproval: false,
  allowLspFormatOnWrite: false,
  enableProjectHooks: false,
  enableProjectMcp: false,
};

const SETUP_SECTION_META: SetupSectionMeta[] = [
  {
    key: "model",
    title: "Model & Provider",
    summary: summarizeModelSection,
    isConfigured: hasModelSection,
  },
  {
    key: "tools",
    title: "Tools",
    summary: summarizeToolsSection,
    isConfigured: hasToolsSection,
  },
  {
    key: "safety",
    title: "Safety",
    summary: summarizeSafetySection,
    isConfigured: hasSafetySection,
  },
  {
    key: "ui",
    title: "UI",
    summary: summarizeUiSection,
    isConfigured: hasUiSection,
  },
  {
    key: "memory",
    title: "Memory",
    summary: summarizeMemorySection,
    isConfigured: hasMemorySection,
  },
  {
    key: "lsp",
    title: "LSP",
    summary: summarizeLspSection,
    isConfigured: hasLspSection,
  },
  {
    key: "hooks",
    title: "Hooks",
    summary: summarizeHooksSection,
    isConfigured: hasHooksSection,
  },
  {
    key: "mcp",
    title: "MCP",
    summary: summarizeMcpSection,
    isConfigured: hasMcpSection,
  },
  {
    key: "integrations",
    title: "Integrations",
    summary: summarizeIntegrationsSection,
    isConfigured: hasIntegrationsSection,
  },
  {
    key: "env",
    title: "Environment",
    summary: summarizeEnvSection,
    isConfigured: hasEnvSection,
  },
];

const TEXT = {
  en: {
    setupTitle: "pico setup",
    introFirstLine: "This wizard configures what pico needs to start: pick a model provider and paste an API key. Pressing Enter throughout picks the recommended options.",
    introAdvancedHint: "Advanced options (search, safety, memory, LSP, hooks, MCP, integrations, env) can be skipped and configured later with `pico setup`.",
    advancedSetupQuestion: "Continue to advanced options? (tools, safety, memory, LSP, hooks, MCP, integrations, env — most users can skip; configurable anytime later)",
    languageQuestion: "Choose setup language",
    languageChoices: ["中文", "English"],
    menuHint: "↑/↓ or j/k to move (or a number key), Enter to confirm, Esc to keep current",
    introExitHint: "Press Enter throughout to take the recommended options; Ctrl+C exits anytime — completed steps are kept.",
    settings: "settings",
    modelHeader: "Model & Provider",
    providerQuestion: "Default provider",
    customProvider: "Custom provider (local models, e.g. Ollama)",
    skipModel: "Skip for now (configure later)",
    defaultModel: "Default model (Enter to use the recommended one)",
    providerId: "Provider id (e.g. local)",
    baseUrl: "Base URL",
    apiKey: "API key value or env reference",
    modelId: "Model id (e.g. qwen2.5-coder:7b)",
    apiCompatibility: "API compatibility",
    toolsHeader: "Tools",
    webSearchProvider: "Web search provider (used when the agent searches the web)",
    searchChoices: [
      "Hybrid/auto (Exa plus Tavily when key is configured)",
      "Exa only",
      "Tavily only",
    ],
    configureVision: "Configure auxiliary vision model? (for image understanding; optional)",
    visionProvider: "Vision provider",
    visionModel: "Vision model",
    safetyHeader: "Safety",
    projectHooks: "Enable project .pico/hooks.json shell hooks? (per-project automation; most users can leave off)",
    projectMcp: "Enable project .pico/mcp-servers.json MCP servers? (extra tools defined by a project; optional)",
    lspFormat: "Allow LSP format-on-write after edits? (auto-formats files; can be enabled later)",
    unattendedPlan: "Allow non-interactive plan approvals? (automation only; keep off for normal use)",
    uiHeader: "UI",
    responseLanguage: "Response language",
    uiQuietStartup: "Quiet startup (hide the resource listing and startup toasts)?",
    memoryHeader: "Memory",
    memoryBackend: "Memory backend",
    memoryDeny: "Memory deny patterns (comma-separated regex fragments, e.g. password,secret-.*; empty = no restriction)",
    lspHeader: "LSP",
    lspFormatOnWrite: "User LSP formatOnWrite?",
    lspIdleTimeout: "User LSP idle timeout in milliseconds (600000 = 10 minutes; empty keeps the default)",
    lspConfig: "LSP config",
    hooksHeader: "Hooks",
    hookConfig: "User hooks config",
    createHook: "Add a user hook?",
    hookEvent: "Hook event",
    hookTool: "Tool name filter",
    hookCommand: "Shell command",
    hookBlocking: "Block PreToolUse when command fails?",
    mcpHeader: "MCP",
    mcpConfig: "User MCP config",
    createMcp: "Add a user MCP server?",
    mcpName: "MCP server name",
    mcpCommand: "MCP server command",
    mcpArgs: "MCP server args (space-separated)",
    integrationsHeader: "Integrations",
    codegraphEnable: "Enable CodeGraph semantic code graph?",
    codegraphInstall: "codegraph was not found on PATH. Install CodeGraph CLI now?",
    codegraphMcp: "Write pico user MCP config for CodeGraph?",
    codegraphInitProject: "Initialize CodeGraph for the current project now?",
    codegraphTelemetryOff: "Disable CodeGraph telemetry for pico MCP server?",
    rtkEnable: "Enable RTK shell output compression?",
    rtkInstall: "rtk was not found on PATH. Install RTK CLI now?",
    rtkMode: "RTK integration mode",
    rtkModeChoices: ["spawnHook (auto-rewrite bash commands)", "instructionsOnly (settings only)"],
    ponytailEnable: "Enable the Ponytail lazy-dev ruleset (built-in)?",
    ponytailMode: "Ponytail intensity level",
    ponytailModeChoices: ["off (disabled)", "lite", "full (recommended)", "ultra"],
    ponytailQuiet: "Silence the Ponytail startup toast?",
    installSkipped: "install skipped; install the CLI manually before using this integration",
    installFailed: "install failed",
    envHeader: "Environment",
    envKey: "Environment variable key",
    envValue: "Environment variable value",
    addEnv: "Add or update a settings env variable?",
    leaveKeep: "leave empty to keep current",
    leaveSkip: "leave empty to skip",
    invalidYesNo: "Please enter y or n.",
    nonInteractiveError: "error: pico setup needs an interactive terminal. Use --non-interactive for defaults.",
    quickDone: "Basic setup complete",
    sectionSaved: "saved",
    testConnection: "Test the connection with this API key?",
    connectionOk: "Connection OK — the provider accepted this API key.",
    connectionFailed: "Connection failed (check that the API key was copied completely; re-run pico setup to fix): ",
    complete: "pico setup complete",
    models: "models",
    defaultModelSummary: "default model",
    settingsEnv: "settings env",
    memory: "memory",
    vision: "vision",
    lspConfigSummary: "LSP config",
    hooksConfigSummary: "hooks config",
    mcpConfigSummary: "MCP config",
    integrationsSummary: "integrations",
    customProviders: "custom providers",
    nextStep: "Run `pico` to start chatting. Re-run `pico setup` anytime to change these settings, or use /doctor to inspect the active settings.",
  },
  zh: {
    setupTitle: "pico 设置",
    introFirstLine: "本向导会帮你完成 pico 的必需配置：选择一个模型提供商并填入 API key，之后就能开始对话。全程按回车即可使用推荐选项。",
    introAdvancedHint: "高级选项（工具、安全、记忆、LSP、Hooks、MCP、集成、环境变量）均可跳过，之后随时运行 `pico setup` 补充。",
    advancedSetupQuestion: "是否继续配置高级选项？（工具、安全、记忆、LSP、Hooks、MCP、集成、环境变量；大多数用户可直接跳过，之后随时可补）",
    languageQuestion: "选择设置界面语言",
    languageChoices: ["中文", "English"],
    menuHint: "↑↓ 或 j/k 选择（也可按数字键），Enter 确认，Esc 保留当前",
    introExitHint: "全程按回车即可使用推荐选项；按 Ctrl+C 可随时退出，已完成的步骤会保留。",
    settings: "设置文件",
    modelHeader: "模型与提供商",
    providerQuestion: "默认提供商",
    customProvider: "自定义提供商（本地模型，如 Ollama）",
    skipModel: "暂时跳过（之后可随时配置）",
    defaultModel: "默认模型（直接回车使用推荐模型）",
    providerId: "标识名（如 local）",
    baseUrl: "Base URL",
    apiKey: "API key 值或环境变量引用",
    modelId: "模型名（如 qwen2.5-coder:7b）",
    apiCompatibility: "API 兼容类型",
    toolsHeader: "工具",
    webSearchProvider: "网页搜索提供商（agent 搜索网页时使用）",
    searchChoices: [
      "混合/自动（配置 Tavily key 时同时使用 Exa 和 Tavily）",
      "仅 Exa",
      "仅 Tavily",
    ],
    configureVision: "配置辅助视觉模型？（用于分析截图与图片；可选）",
    visionProvider: "视觉模型提供商",
    visionModel: "视觉模型",
    safetyHeader: "安全开关",
    projectHooks: "启用项目 .pico/hooks.json shell hooks？（项目级自动化命令；大多数用户可保持关闭）",
    projectMcp: "启用项目 .pico/mcp-servers.json MCP 服务器？（项目定义的额外工具；可选）",
    lspFormat: "允许 LSP 在写入后自动格式化？（自动整理代码格式；可稍后开启）",
    unattendedPlan: "允许非交互模式自动批准计划？（仅自动化场景需要；日常使用保持关闭）",
    uiHeader: "界面",
    responseLanguage: "pico 回复语言",
    uiQuietStartup: "安静启动（隐藏资源清单与启动提示）？",
    memoryHeader: "记忆",
    memoryBackend: "记忆 backend",
    memoryDeny: "记忆拒写模式（逗号分隔的正则片段，例：password,secret-.*；留空表示不限制）",
    lspHeader: "LSP",
    lspFormatOnWrite: "用户级 LSP formatOnWrite？",
    lspIdleTimeout: "用户级 LSP 空闲超时（毫秒；600000 = 10 分钟，留空使用默认）",
    lspConfig: "LSP 配置文件",
    hooksHeader: "Hooks",
    hookConfig: "用户级 hooks 配置文件",
    createHook: "添加用户级 hook？",
    hookEvent: "Hook 事件",
    hookTool: "工具名过滤",
    hookCommand: "Shell 命令",
    hookBlocking: "PreToolUse 命令失败时阻断？",
    mcpHeader: "MCP",
    mcpConfig: "用户级 MCP 配置文件",
    createMcp: "添加用户级 MCP server？",
    mcpName: "MCP server 名称",
    mcpCommand: "MCP server 命令",
    mcpArgs: "MCP server 参数（空格分隔）",
    integrationsHeader: "集成",
    codegraphEnable: "启用 CodeGraph 语义代码图？",
    codegraphInstall: "PATH 中未找到 codegraph。现在安装 CodeGraph CLI？",
    codegraphMcp: "写入 pico 用户级 CodeGraph MCP 配置？",
    codegraphInitProject: "现在为当前项目初始化 CodeGraph？",
    codegraphTelemetryOff: "为 pico MCP server 关闭 CodeGraph telemetry？",
    rtkEnable: "启用 RTK shell 输出压缩？",
    rtkInstall: "PATH 中未找到 rtk。现在安装 RTK CLI？",
    rtkMode: "RTK 集成模式",
    rtkModeChoices: ["spawnHook（自动改写 bash 命令）", "instructionsOnly（只写设置）"],
    ponytailEnable: "启用内置 Ponytail 懒惰开发规则？",
    ponytailMode: "Ponytail 强度级别",
    ponytailModeChoices: ["off（关闭）", "lite", "full（推荐）", "ultra"],
    ponytailQuiet: "静默 Ponytail 启动提示？",
    installSkipped: "安装已跳过；使用该集成前请手动安装 CLI",
    installFailed: "安装失败",
    envHeader: "环境变量",
    envKey: "环境变量名",
    envValue: "环境变量值",
    addEnv: "添加或更新 settings env 变量？",
    leaveKeep: "留空保留当前值",
    leaveSkip: "留空跳过",
    invalidYesNo: "请输入 y 或 n。",
    nonInteractiveError: "error: pico setup 需要交互式终端。可使用 --non-interactive 写入默认配置。",
    quickDone: "基础配置完成",
    sectionSaved: "已保存",
    testConnection: "用这个 API key 测试连接？",
    connectionOk: "连接成功——提供商已接受该 API key。",
    connectionFailed: "连接失败（请检查 API key 是否复制完整；可重跑 pico setup 修改）：",
    complete: "pico 设置完成",
    models: "模型配置",
    defaultModelSummary: "默认模型",
    settingsEnv: "settings env",
    memory: "记忆",
    vision: "视觉模型",
    lspConfigSummary: "LSP 配置",
    hooksConfigSummary: "hooks 配置",
    mcpConfigSummary: "MCP 配置",
    integrationsSummary: "集成",
    customProviders: "自定义提供商",
    nextStep: "运行 `pico` 开始对话。之后随时运行 `pico setup` 修改配置，或使用 /doctor 检查当前设置。",
  },
} satisfies Record<SetupLanguage, Record<string, string | string[]>>;

export function parseSetupArgs(args: string[]): SetupCliOptions | undefined {
  if (args[0] !== "setup") return undefined;

  const options: SetupCliOptions = {
    nonInteractive: false,
    reset: false,
    help: false,
    quick: false,
    reconfigure: false,
  };

  for (const arg of args.slice(1)) {
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--non-interactive") {
      options.nonInteractive = true;
    } else if (arg === "--reset") {
      options.reset = true;
    } else if (arg === "--quick") {
      options.quick = true;
    } else if (arg === "--reconfigure") {
      options.reconfigure = true;
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
    "Usage: pico setup [model|tools|safety|ui|memory|lsp|hooks|mcp|integrations|env] [--non-interactive] [--reset] [--quick] [--reconfigure]",
    "",
    "Interactive setup wizard for pico. A plain `pico setup` walks the quick",
    "flow (model + UI) first; advanced sections follow when you accept the",
    "prompt. Use `pico setup <section>` to configure a single section.",
    "",
    "Sections:",
    "  model   Configure default provider/model, API key env, or a custom provider",
    "  tools   Configure web search and auxiliary vision model",
    "  safety  Configure pico safety switches",
    "  ui      Configure response language",
    "  memory  Configure memory backend and memory-related env",
    "  lsp     Configure user LSP options",
    "  hooks   Configure user hooks file and project hook safety switch",
    "  mcp     Configure user MCP servers file and project MCP safety switch",
    "  integrations  Configure optional CodeGraph and RTK integrations",
    "  env     Configure settings.json env variables hydrated at startup",
    "",
    "Options:",
    "  --non-interactive  Write safe defaults and import existing environment values",
    "  --reset            Remove setup-managed settings from settings.json",
    "  --quick            Skip already-configured sections",
    "  --reconfigure      Force every section to run again",
    "  -h, --help         Show this help",
  ].join("\n");
}

export interface SetupSectionPlan {
  quick: SetupSection[];
  advanced: SetupSection[];
}

/**
 * Decides which sections an interactive `pico setup` run offers.
 *
 * - `pico setup <section>` → exactly that section.
 * - Otherwise the quick flow (model + ui) runs first; the advanced sections
 *   are offered only after the user accepts the gate prompt, which is asked
 *   once the quick flow has given a first-time user context.
 */
export function planSetupSections(
  options: Pick<SetupCliOptions, "quick" | "reconfigure">,
  section: SetupSection | undefined,
): SetupSectionPlan {
  if (section) return { quick: [section], advanced: [] };
  return { quick: [...QUICK_SECTIONS], advanced: [...ADVANCED_SECTIONS] };
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
  if (options.section && !SETUP_SECTION_META.some((meta) => meta.key === options.section)) {
    // Unknown section names used to be silently ignored (summary printed,
    // exit 0) — fail loudly so CI scripts catch typos.
    writeLine(io, `error: unknown section "${options.section}"\n\n${setupUsage()}`);
    return 1;
  }
  if (options.reset) {
    const damaged = firstDamagedConfigPath();
    if (damaged) {
      writeLine(io, `error: refusing to reset — ${damaged} is malformed JSON. Fix or remove it manually, then re-run.`);
      return 1;
    }
    resetSetupConfig();
    writeLine(io, `pico setup reset complete\nsettings: ${picoSettingsPath()}`);
    return 0;
  }
  const damagedConfig = firstDamagedConfigPath();
  if (damagedConfig) {
    writeLine(io, `error: refusing to run setup — ${damagedConfig} is malformed JSON and would be overwritten, losing API keys / safety config. Fix or remove it manually, then re-run.`);
    return 1;
  }
  // 2026-08 配置收敛：setup 运行前把遗留独立配置文件（~/.pico/hooks.json 等）
  // 迁入 settings.json 命名空间（幂等；损坏文件跳过）。此后所有读写统一走
  // settings.json，避免再次出现"改哪一处生效"的多入口困惑。
  const migrated = migrateLegacyUserConfigs();
  if (migrated.length > 0) {
    writeLine(io, `migrated legacy config into settings.json: ${migrated.join(", ")}`);
  }
  if (options.nonInteractive) {
    applyNonInteractiveDefaults();
    writeLine(io, buildSetupSummary(readJson(picoSettingsPath()), readJson(picoModelsPath()), "en"));
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
    const prompt = new ReadlinePrompter(io, language);
    const text = TEXT[language];

    printSetupIntro(io, language);

    const { quick, advanced } = planSetupSections(options, options.section);
    // The gate comes after the quick flow so a first-time user has context
    // ("basic config done") before being offered jargon-heavy sections.
    await runSectionsWithSkip(quick, prompt, io, options);
    if (!options.section) {
      writeLine(io, "");
      writeLine(io, styler(io).success(`✓ ${text.quickDone}`));
      if (await prompt.yesNo(text.advancedSetupQuestion, options.reconfigure)) {
        await runSectionsWithSkip(advanced, prompt, io, options);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(io, message);
    return 130;
  }

  writeLine(io, "");
  writeLine(io, buildSetupSummary(readJson(picoSettingsPath()), readJson(picoModelsPath()), language, supportsColor(io)));
  return 0;
}

class ReadlinePrompter implements SetupPrompter {
  constructor(
    private readonly io: SetupIo,
    readonly language: SetupLanguage,
  ) {}

  private get style(): Styled {
    return styler(this.io);
  }

  async text(question: string, defaultValue = ""): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    return await withReadline(this.io, async (rl) => {
      const answer = await rl.question(this.style.question(`${question}${suffix}: `));
      return sanitizeInput(answer).trim() || defaultValue;
    });
  }

  async optionalSecret(question: string, currentConfigured: boolean): Promise<string | undefined> {
    const text = TEXT[this.language];
    const suffix = currentConfigured ? ` [${text.leaveKeep}]` : ` [${text.leaveSkip}]`;
    const value = await readSecret(this.io, this.style.question(`${question}${suffix}: `));
    return value.length > 0 ? value : undefined;
  }

  async optionalValue(question: string, defaultValue?: string): Promise<string | undefined> {
    const suffix = defaultValue ? ` [${defaultValue}]` : ` [${TEXT[this.language].leaveSkip}]`;
    return await withReadline(this.io, async (rl) => {
      const answer = await rl.question(this.style.question(`${question}${suffix}: `));
      const value = sanitizeInput(answer).trim();
      if (value.length > 0) return value;
      return defaultValue === undefined ? undefined : defaultValue;
    });
  }

  async yesNo(question: string, defaultValue: boolean): Promise<boolean> {
    const suffix = defaultValue ? "Y/n" : "y/N";
    while (true) {
      const answer = await withReadline(this.io, async (rl) => (
        sanitizeInput(await rl.question(this.style.question(`${question} [${suffix}]: `))).trim().toLowerCase()
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

/**
 * Masked secret entry: echoes `*` per character so a pasted API key never
 * scrolls into terminal history. Raw-mode keypress loop like runChoiceMenu —
 * Enter confirms, Ctrl+C aborts, a lone Esc skips (empty), Backspace edits.
 */
function readSecret(io: SetupIo, question: string): Promise<string> {
  const input = io.input as NodeJS.ReadStream;
  const output = io.output;
  return new Promise<string>((resolve, reject) => {
    const previousRaw = input.isRaw;
    let buffer = "";
    let escRemaining = 0;
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode?.(previousRaw ?? false);
      output.write("\x1b[?25h");
    };
    const finish = () => {
      cleanup();
      output.write("\n");
      resolve(buffer);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString("utf-8");
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return;
        }
        if (ch === "\u0003") {
          fail(new Error("Setup cancelled"));
          return;
        }
        if (ch === "\x7f" || ch === "\b") {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        if (ch === "\x1b") {
          // Escape starts an arrow/keypad sequence; swallow its remaining bytes.
          escRemaining = 2;
          continue;
        }
        if (escRemaining > 0) {
          escRemaining--;
          continue;
        }
        buffer += ch;
        output.write("*");
      }
      if (escRemaining > 0) {
        // A lone Esc with nothing following it — treat as skip.
        escRemaining = 0;
        finish();
      }
    };

    try {
      output.write("\x1b[?25l");
      input.setRawMode?.(true);
      input.resume();
      input.on("data", onData);
      output.write(question);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
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
  const style = styler(io);
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
      style.question(question),
      ...choices.map((choice, index) => {
        const row = ` ${index === selected ? "●" : "○"} ${choice}`;
        return index === selected ? style.success(row) : row;
      }),
      style.dim(`  ${TEXT[language].menuHint}`),
    ];
    output.write(lines.join("\n") + "\n");
    renderedLines = lines.length;
  };

  return await new Promise<number>((resolve, reject) => {
    const previousRaw = input.isRaw;
    let escTimer: ReturnType<typeof setTimeout> | undefined;
    const clearEscTimer = () => {
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = undefined;
      }
    };
    const cleanup = () => {
      clearEscTimer();
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
    let pending = "";
    const onData = (chunk: Buffer | string) => {
      pending += chunk.toString("utf-8");
      // A lone ESC may be the first byte of an arrow sequence split across
      // chunks — wait a short window for the rest before treating it as a
      // cancel. Without the timeout a standalone Esc press ("keep current")
      // hangs the menu forever and swallows the next keystroke.
      if (pending === "\x1b") {
        clearEscTimer();
        escTimer = setTimeout(() => {
          clearEscTimer();
          finish(defaultIndex);
        }, 60);
        return;
      }
      clearEscTimer();
      const key = pending;
      pending = "";
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

async function runSectionsWithSkip(
  keys: SetupSection[],
  prompt: SetupPrompter,
  io: SetupIo,
  options: SetupCliOptions,
): Promise<void> {
  const text = TEXT[prompt.language];
  // An explicit `pico setup <section>` is an unambiguous request — run it
  // without the reconfigure gate. The gate belongs to the full-wizard flow.
  const gateEnabled = options.section === undefined;
  for (const key of keys) {
    const meta = getSectionMeta(key);
    if (!meta) continue;
    const title = sectionTitle(key, prompt.language);
    const settings = readJson(picoSettingsPath());
    const summary = meta.summary(settings);
    const configured = meta.isConfigured(settings) && summary !== undefined;
    if (configured && !options.reconfigure && gateEnabled) {
      // Hermes-style skip gate: already-configured sections show what they
      // hold and offer to be redone, defaulting to skip — re-running `pico
      // setup` on a working install stops nagging about every section.
      if (options.quick) {
        printSectionSummary(io, title, summary);
        continue;
      }
      const question = prompt.language === "zh"
        ? `重新配置${title}？（当前：${summary}）`
        : `Reconfigure ${title}? (currently: ${summary})`;
      if (!(await prompt.yesNo(question, false))) {
        printSectionSummary(io, title, summary);
        continue;
      }
    }
    await runSection(key, prompt, io);
    writeLine(io, "");
    writeLine(io, styler(io).success(`✓ ${title} ${text.sectionSaved}`));
  }
}

export async function runSection(
  section: SetupSection,
  prompt: SetupPrompter,
  io: SetupIo,
  shell: SetupShell = defaultShell,
): Promise<void> {
  if (section === "model") await runModelSetup(prompt, io);
  if (section === "tools") await runToolsSetup(prompt, io);
  if (section === "safety") await runSafetySetup(prompt, io);
  if (section === "ui") await runUiSetup(prompt, io);
  if (section === "memory") await runMemorySetup(prompt, io);
  if (section === "lsp") await runLspSetup(prompt, io);
  if (section === "hooks") await runHooksSetup(prompt, io);
  if (section === "mcp") await runMcpSetup(prompt, io);
  if (section === "integrations") await runIntegrationsSetup(prompt, io, shell);
  if (section === "env") await runEnvSetup(prompt, io);
}

function getSectionMeta(section: SetupSection): SetupSectionMeta | undefined {
  return SETUP_SECTION_META.find((item) => item.key === section);
}

/** Localized section name — SETUP_SECTION_META titles are English-only. */
function sectionTitle(key: SetupSection, language: SetupLanguage): string {
  const text = TEXT[language];
  switch (key) {
    case "model": return text.modelHeader;
    case "tools": return text.toolsHeader;
    case "safety": return text.safetyHeader;
    case "ui": return text.uiHeader;
    case "memory": return text.memoryHeader;
    case "lsp": return text.lspHeader;
    case "hooks": return text.hooksHeader;
    case "mcp": return text.mcpHeader;
    case "integrations": return text.integrationsHeader;
    case "env": return text.envHeader;
  }
}

function printSetupIntro(io: SetupIo, language: SetupLanguage): void {
  const text = TEXT[language];
  const s = styler(io);
  const title = `⚙ ${text.setupTitle}`;
  const content = [text.introFirstLine, text.introAdvancedHint, text.introExitHint]
    .flatMap((line) => wrapLine(line, SETUP_BANNER_WIDTH - 4));
  const width = SETUP_BANNER_WIDTH;
  const border = "─".repeat(width - 2);
  const pad = (line: string) => `│ ${line}${" ".repeat(Math.max(0, width - 4 - displayWidth(line)))} │`;
  writeLine(io, s.banner(`┌${border}┐`));
  writeLine(io, s.banner(s.bold(pad(title))));
  writeLine(io, s.banner(pad("")));
  for (const line of content) writeLine(io, s.banner(pad(line)));
  writeLine(io, s.banner(`└${border}┘`));
  writeLine(io, "");
}

function printSectionSummary(io: SetupIo, title: string, summary: string): void {
  writeLine(io, styler(io).success(`✓ ${title}: ${summary}`));
}

async function runModelSetup(prompt: SetupPrompter, io: SetupIo): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.modelHeader);
  const settings = readJson(picoSettingsPath()) as Settings;
  const choices = [
    ...KNOWN_PROVIDERS.map((p) => recommend(prompt.language, p.label, p.recommended ?? false)),
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
    const hint = PROVIDER_KEY_HINTS[prompt.language][provider.id];
    const question = hint
      ? `${provider.label} API key ${prompt.language === "zh" ? "（" : "("}${hint}${prompt.language === "zh" ? "）" : ")"}`
      : `${provider.label} API key`;
    const value = await prompt.optionalSecret(question, typeof current === "string" && current.length > 0);
    if (value) setSettingsEnv(settings, provider.envName, value);
    const effectiveKey = readSettingsEnv(settings)[provider.envName] ?? process.env[provider.envName];
    if (typeof effectiveKey === "string" && effectiveKey.length > 0) {
      // A freshly typed key is exactly when a paste error would slip through —
      // default the connection test to yes. An existing key the user kept is
      // already known to work, so default it to no.
      const testDefault = value !== undefined;
      if (await prompt.yesNo(text.testConnection, testDefault)) {
        const result = await testProviderConnection(provider.id, effectiveKey);
        if (result.ok) writeLine(io, styler(io).success(text.connectionOk));
        else writeLine(io, styler(io).error(`${text.connectionFailed}${result.detail}`));
      }
    }
  }
  writeJson(picoSettingsPath(), settings);
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

  const settings = readJson(picoSettingsPath()) as Settings;
  settings.defaultProvider = config.id;
  settings.defaultModel = config.model;
  writeJson(picoSettingsPath(), settings);
}

async function chooseApi(prompt: SetupPrompter): Promise<CustomProviderConfig["api"]> {
  const apis: Array<CustomProviderConfig["api"]> = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ];
  return apis[await prompt.choice(TEXT[prompt.language].apiCompatibility, API_COMPAT_LABELS[prompt.language])]!;
}

async function runToolsSetup(prompt: SetupPrompter, io: SetupIo): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.toolsHeader);
  const settings = readJson(picoSettingsPath()) as Settings;
  const env = readSettingsEnv(settings);

  const searchIndex = await prompt.choice(
    text.webSearchProvider,
    text.searchChoices.map((choice, i) => (i === 0 ? recommend(prompt.language, choice, true) : choice)),
    env.PICO_SEARCH_PROVIDER === "exa" ? 1 : env.PICO_SEARCH_PROVIDER === "tavily" ? 2 : 0,
  );
  if (searchIndex === 0) delete env.PICO_SEARCH_PROVIDER;
  else env.PICO_SEARCH_PROVIDER = searchIndex === 1 ? "exa" : "tavily";

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
  writeJson(picoSettingsPath(), settings);
}

async function runSafetySetup(prompt: SetupPrompter, io: SetupIo): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.safetyHeader);
  const settings = readJson(picoSettingsPath()) as Settings;
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
  writeJson(picoSettingsPath(), settings);
}

async function runUiSetup(prompt: SetupPrompter, io: SetupIo): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.uiHeader);
  const settings = readJson(picoSettingsPath()) as Settings;
  const defaultLanguage = prompt.language === "zh" ? "简体中文" : "English";
  settings.language = await prompt.text(text.responseLanguage, stringSetting(settings.language) ?? defaultLanguage);
  settings.quietStartup = await prompt.yesNo(text.uiQuietStartup, booleanSetting(settings.quietStartup, false));
  writeJson(picoSettingsPath(), settings);
}

async function runMemorySetup(prompt: SetupPrompter, io: SetupIo): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.memoryHeader);
  const settings = readJson(picoSettingsPath()) as Settings;
  const memory = objectSetting(settings.memory);
  const currentBackend = stringSetting(memory.backend) ?? "builtin";
  const backendIndex = Math.max(0, MEMORY_BACKENDS.indexOf(currentBackend as typeof MEMORY_BACKENDS[number]));
  const [builtinLabel, holographicLabel] = MEMORY_BACKEND_LABELS[prompt.language];
  const backendChoices = [recommend(prompt.language, builtinLabel, true), holographicLabel];
  memory.backend = MEMORY_BACKENDS[await prompt.choice(text.memoryBackend, backendChoices, backendIndex)]!;
  settings.memory = memory;

  const env = readSettingsEnv(settings);
  const deny = await prompt.optionalValue(text.memoryDeny, env.PICO_MEMORY_DENY ?? process.env.PICO_MEMORY_DENY);
  if (deny !== undefined) setOrDelete(env, "PICO_MEMORY_DENY", deny);
  const dbPath = await prompt.optionalValue("PICO_MEMORY_DB", env.PICO_MEMORY_DB ?? process.env.PICO_MEMORY_DB);
  if (dbPath !== undefined) setOrDelete(env, "PICO_MEMORY_DB", dbPath);
  settings.env = env;
  writeJson(picoSettingsPath(), settings);
}

async function runLspSetup(prompt: SetupPrompter, io: SetupIo): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.lspHeader);
  writeLine(io, `${text.lspConfig}: settings.json (lsp)`);
  const settings = readJson(picoSettingsPath()) as Settings;
  const config = objectSetting(settings.lsp);
  config.formatOnWrite = await prompt.yesNo(text.lspFormatOnWrite, booleanSetting(config.formatOnWrite, false));
  const idle = await prompt.text(text.lspIdleTimeout, numberSetting(config.idleTimeoutMs)?.toString() ?? "600000");
  const parsedIdle = Number.parseInt(idle, 10);
  if (Number.isFinite(parsedIdle) && parsedIdle > 0) config.idleTimeoutMs = parsedIdle;
  settings.lsp = config;
  writeJson(picoSettingsPath(), settings);
}

async function runHooksSetup(prompt: SetupPrompter, io: SetupIo): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.hooksHeader);
  writeLine(io, `${text.hookConfig}: settings.json (hooks)`);
  const settings = readJson(picoSettingsPath()) as Settings;
  const safety = { ...SAFETY_DEFAULTS, ...objectSetting(settings.safety) };
  safety.enableProjectHooks = await prompt.yesNo(text.projectHooks, booleanSetting(safety.enableProjectHooks, false));
  settings.safety = safety;

  const config = objectSetting(settings.hooks);
  const hooks = Array.isArray(config.hooks) ? config.hooks.filter((h): h is JsonObject => h && typeof h === "object" && !Array.isArray(h)) : [];
  if (await prompt.yesNo(text.createHook, false)) {
    const event = HOOK_EVENTS[await prompt.choice(text.hookEvent, HOOK_EVENT_LABELS[prompt.language])]!;
    const hook: JsonObject = {
      event,
      command: await prompt.text(text.hookCommand),
    };
    const tool = await prompt.optionalValue(text.hookTool, "");
    if (tool) hook.tool = tool;
    if (event === "PreToolUse") hook.blocking = await prompt.yesNo(text.hookBlocking, true);
    hooks.push(hook);
  }
  config.hooks = hooks;
  settings.hooks = config;
  writeJson(picoSettingsPath(), settings);
}

async function runMcpSetup(prompt: SetupPrompter, io: SetupIo): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.mcpHeader);
  writeLine(io, `${text.mcpConfig}: settings.json (mcpServers)`);
  const settings = readJson(picoSettingsPath()) as Settings;
  const safety = { ...SAFETY_DEFAULTS, ...objectSetting(settings.safety) };
  safety.enableProjectMcp = await prompt.yesNo(text.projectMcp, booleanSetting(safety.enableProjectMcp, false));
  settings.safety = safety;

  const config = objectSetting(settings.mcpServers);
  const servers = objectSetting(config.mcpServers);
  if (await prompt.yesNo(text.createMcp, false)) {
    const name = await prompt.text(text.mcpName, "local");
    const command = await prompt.text(text.mcpCommand, "npx");
    const args = splitArgs(await prompt.text(text.mcpArgs));
    servers[name] = args.length > 0 ? { command, args } : { command };
  }
  config.mcpServers = servers;
  settings.mcpServers = config;
  writeJson(picoSettingsPath(), settings);
}

async function runIntegrationsSetup(prompt: SetupPrompter, io: SetupIo, shell: SetupShell): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.integrationsHeader);
  const settings = readJson(picoSettingsPath()) as Settings;
  const integrations = objectSetting(settings.integrations);
  const codegraph = objectSetting(integrations.codegraph);
  const rtk = objectSetting(integrations.rtk);

  const enableCodeGraph = await prompt.yesNo(text.codegraphEnable, booleanSetting(codegraph.enabled, false));
  if (enableCodeGraph) {
    if (!shell.commandExists("codegraph")) {
      const install = await prompt.yesNo(text.codegraphInstall, false);
      if (install) {
        const result = shell.runInstall("curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh");
        if (!result.ok) {
          writeLine(io, `${text.installFailed}: ${result.output}`);
          codegraph.enabled = false;
        } else {
          codegraph.enabled = true;
        }
      } else {
        writeLine(io, text.installSkipped);
        // Enabling an integration whose binary is missing turns every
        // supported command into a hard failure — keep it disabled.
        codegraph.enabled = false;
      }
    } else {
      codegraph.enabled = true;
    }
    const disableTelemetry = await prompt.yesNo(text.codegraphTelemetryOff, true);
    if (await prompt.yesNo(text.codegraphMcp, true)) {
      // 内联注册（不调 configureCodeGraphMcp——它会独立读盘写盘，与本节的
      // settings 内存对象互相覆盖，丢掉刚编辑的 integrations）。
      setCodeGraphMcpServer(settings, disableTelemetry ? "0" : undefined);
    }
    if (await prompt.yesNo(text.codegraphInitProject, false)) {
      const result = shell.run(["codegraph", "init"]);
      if (!result.ok) writeLine(io, `${text.installFailed}: ${result.output}`);
    }
  } else {
    codegraph.enabled = false;
  }

  const enableRtk = await prompt.yesNo(text.rtkEnable, booleanSetting(rtk.enabled, false));
  if (enableRtk) {
    if (!shell.commandExists("rtk")) {
      const install = await prompt.yesNo(text.rtkInstall, false);
      if (install) {
        const result = shell.runInstall("curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh");
        if (!result.ok) {
          writeLine(io, `${text.installFailed}: ${result.output}`);
          rtk.enabled = false;
        } else {
          rtk.enabled = true;
        }
      } else {
        writeLine(io, text.installSkipped);
        rtk.enabled = false;
      }
    } else {
      rtk.enabled = true;
    }
    const modeIndex = await prompt.choice(
      text.rtkMode,
      text.rtkModeChoices.map((choice, i) => (i === 0 ? recommend(prompt.language, choice, true) : choice)),
      stringSetting(rtk.mode) === "instructionsOnly" ? 1 : 0,
    );
    rtk.mode = modeIndex === 1 ? "instructionsOnly" : "spawnHook";
    rtk.command = stringSetting(rtk.command) ?? "rtk";
  } else {
    rtk.enabled = false;
  }

  const ponytail = objectSetting(settings.ponytail);
  const ponytailEnabled = await prompt.yesNo(text.ponytailEnable, stringSetting(ponytail.defaultMode) !== "off");
  if (ponytailEnabled) {
    const current = stringSetting(ponytail.defaultMode) ?? "full";
    const modeIndex = Math.max(0, PONYTAIL_MODES.indexOf(current));
    const modeIndexChoice = await prompt.choice(
      text.ponytailMode,
      text.ponytailModeChoices.map((choice, i) => (i === 2 ? recommend(prompt.language, choice, true) : choice)),
      modeIndex,
    );
    ponytail.defaultMode = PONYTAIL_MODES[modeIndexChoice]!;
  } else {
    ponytail.defaultMode = "off";
  }
  ponytail.quietStartup = await prompt.yesNo(text.ponytailQuiet, booleanSetting(ponytail.quietStartup, false));
  settings.ponytail = ponytail;

  integrations.codegraph = codegraph;
  integrations.rtk = rtk;
  settings.integrations = integrations;
  writeJson(picoSettingsPath(), settings);
}

async function runEnvSetup(prompt: SetupPrompter, io: SetupIo): Promise<void> {
  const text = TEXT[prompt.language];
  printHeader(io, text.envHeader);
  const settings = readJson(picoSettingsPath()) as Settings;
  const env = readSettingsEnv(settings);
  writeLine(io, `${text.settingsEnv}: ${Object.keys(env).sort().join(", ") || "(none)"}`);
  while (await prompt.yesNo(text.addEnv, false)) {
    const keyIndex = await prompt.choice(text.envKey, [...ENV_KEYS_MANAGED_BY_SETUP, "Custom"], 0);
    const key = keyIndex === ENV_KEYS_MANAGED_BY_SETUP.length ? await prompt.text(text.envKey) : ENV_KEYS_MANAGED_BY_SETUP[keyIndex]!;
    const value = await prompt.optionalValue(text.envValue, env[key] ?? process.env[key] ?? "");
    if (value !== undefined) setOrDelete(env, key, value);
  }
  settings.env = env;
  writeJson(picoSettingsPath(), settings);
}

function hasModelSection(settings: JsonObject): boolean {
  return typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string";
}

function summarizeModelSection(settings: JsonObject): string | undefined {
  const provider = stringSetting(settings.defaultProvider);
  const model = stringSetting(settings.defaultModel);
  if (!provider || !model) return undefined;
  return `${provider}/${model}`;
}

function hasToolsSection(settings: JsonObject): boolean {
  const env = readSettingsEnv(settings);
  return typeof env.PICO_SEARCH_PROVIDER === "string" || typeof env.TAVILY_API_KEY === "string" || hasVisionSettings(settings as Settings);
}

function summarizeToolsSection(settings: JsonObject): string | undefined {
  const env = readSettingsEnv(settings);
  const bits = [];
  if (typeof env.PICO_SEARCH_PROVIDER === "string") bits.push(`search=${env.PICO_SEARCH_PROVIDER}`);
  if (typeof env.TAVILY_API_KEY === "string") bits.push("tavily=set");
  if (hasVisionSettings(settings as Settings)) {
    const vision = objectSetting(objectSetting(settings.auxiliary).vision);
    bits.push(`vision=${stringSetting(vision.provider)}/${stringSetting(vision.model)}`);
  }
  return bits.length > 0 ? bits.join(", ") : undefined;
}

function hasSafetySection(settings: JsonObject): boolean {
  return typeof settings.safety === "object" && settings.safety !== null;
}

function summarizeSafetySection(settings: JsonObject): string | undefined {
  const safety = objectSetting(settings.safety);
  const bits: string[] = [];
  for (const [key, label] of [
    ["enableProjectHooks", "hooks"],
    ["enableProjectMcp", "mcp"],
    ["allowLspFormatOnWrite", "lsp-format"],
    ["allowUnattendedPlanApproval", "plan"],
  ] as const) {
    if (typeof safety[key] === "boolean") bits.push(`${label}=${safety[key] ? "on" : "off"}`);
  }
  return bits.length > 0 ? bits.join(", ") : undefined;
}

function hasUiSection(settings: JsonObject): boolean {
  return typeof settings.language === "string" || typeof settings.quietStartup === "boolean";
}

function summarizeUiSection(settings: JsonObject): string | undefined {
  const bits: string[] = [];
  const language = stringSetting(settings.language);
  if (language) bits.push(language);
  if (settings.quietStartup === true) bits.push("quiet");
  return bits.length > 0 ? bits.join(", ") : undefined;
}

function hasMemorySection(settings: JsonObject): boolean {
  const memory = objectSetting(settings.memory);
  const env = readSettingsEnv(settings);
  return typeof memory.backend === "string" || typeof env.PICO_MEMORY_DB === "string" || typeof env.PICO_MEMORY_DENY === "string";
}

function summarizeMemorySection(settings: JsonObject): string | undefined {
  const memory = objectSetting(settings.memory);
  const env = readSettingsEnv(settings);
  const bits = [];
  if (typeof memory.backend === "string") bits.push(`backend=${memory.backend}`);
  if (typeof env.PICO_MEMORY_DB === "string") bits.push(`db=${env.PICO_MEMORY_DB}`);
  if (typeof env.PICO_MEMORY_DENY === "string") bits.push("deny=set");
  return bits.length > 0 ? bits.join(", ") : undefined;
}

function hasLspSection(settings: JsonObject): boolean {
  return settings.lsp !== undefined || existsSync(picoLspConfigPath());
}

function summarizeLspSection(settings: JsonObject): string | undefined {
  const config = settings.lsp !== undefined ? objectSetting(settings.lsp) : readJson(picoLspConfigPath());
  const bits: string[] = [];
  if (typeof config.formatOnWrite === "boolean") bits.push(`formatOnWrite=${config.formatOnWrite ? "on" : "off"}`);
  if (typeof config.idleTimeoutMs === "number") bits.push(`idle=${config.idleTimeoutMs}`);
  return bits.length > 0 ? bits.join(", ") : undefined;
}

function hasHooksSection(settings: JsonObject): boolean {
  return settings.hooks !== undefined || existsSync(userHooksPath());
}

function summarizeHooksSection(settings: JsonObject): string | undefined {
  if (settings.hooks !== undefined) return "settings.json:hooks";
  return existsSync(userHooksPath()) ? userHooksPath() : undefined;
}

function hasMcpSection(settings: JsonObject): boolean {
  return settings.mcpServers !== undefined || existsSync(picoMcpConfigPath());
}

function summarizeMcpSection(settings: JsonObject): string | undefined {
  if (settings.mcpServers !== undefined) return "settings.json:mcpServers";
  return existsSync(picoMcpConfigPath()) ? picoMcpConfigPath() : undefined;
}

function hasIntegrationsSection(settings: JsonObject): boolean {
  const integrations = objectSetting(settings.integrations);
  const codegraph = objectSetting(integrations.codegraph);
  const rtk = objectSetting(integrations.rtk);
  const ponytail = objectSetting(settings.ponytail);
  return typeof codegraph.enabled === "boolean" || typeof rtk.enabled === "boolean" || typeof ponytail.defaultMode === "string";
}

function summarizeIntegrationsSection(settings: JsonObject): string | undefined {
  const integrations = objectSetting(settings.integrations);
  const bits: string[] = [];
  const codegraph = objectSetting(integrations.codegraph);
  if (typeof codegraph.enabled === "boolean") bits.push(`codegraph=${codegraph.enabled ? "on" : "off"}`);
  const rtk = objectSetting(integrations.rtk);
  if (typeof rtk.enabled === "boolean") {
    bits.push(`rtk=${rtk.enabled ? stringSetting(rtk.mode) ?? "on" : "off"}`);
  }
  const ponytail = objectSetting(settings.ponytail);
  if (typeof ponytail.defaultMode === "string") bits.push(`ponytail=${ponytail.defaultMode}`);
  return bits.length > 0 ? bits.join(", ") : undefined;
}

function hasEnvSection(settings: JsonObject): boolean {
  return Object.keys(readSettingsEnv(settings)).length > 0;
}

function summarizeEnvSection(settings: JsonObject): string | undefined {
  const keys = Object.keys(readSettingsEnv(settings)).sort();
  return keys.length > 0 ? keys.join(", ") : undefined;
}

export function applyNonInteractiveDefaults(): void {
  const settings = readJson(picoSettingsPath()) as Settings;
  settings.language ??= "简体中文";
  settings.safety = { ...SAFETY_DEFAULTS, ...objectSetting(settings.safety) };

  const env = readSettingsEnv(settings);
  for (const key of ENV_KEYS_MANAGED_BY_SETUP) {
    if (typeof process.env[key] === "string" && process.env[key]!.length > 0 && typeof env[key] !== "string") {
      env[key] = process.env[key]!;
    }
  }
  settings.env = env;
  writeJson(picoSettingsPath(), settings);
}

export function resetSetupConfig(): void {
  const settings = readJson(picoSettingsPath()) as Settings;
  for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel", "language", "auxiliary", "safety", "memory", "integrations", "hooks", "mcpServers", "lsp", "subagent", "automode"]) {
    delete settings[key];
  }
  const env = readSettingsEnv(settings);
  for (const key of ENV_KEYS_MANAGED_BY_SETUP) delete env[key];
  if (Object.keys(env).length === 0) delete settings.env;
  else settings.env = env;
  writeJson(picoSettingsPath(), settings);
  // Files managed by the per-section setups must go too, or --reset followed
  // by --quick would still report those sections as "configured" and skip.
  for (const file of [picoLspConfigPath(), picoHooksConfigPath(), picoMcpConfigPath(), picoSubagentConfigPath(), picoAutomodeConfigPath()]) {
    try {
      rmSync(file, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

export function writeCustomProvider(config: CustomProviderConfig): void {
  const models = readJson(picoModelsPath());
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
  writeJson(picoModelsPath(), models);
}

export function configureCodeGraphMcp(options: { telemetry?: string } = {}): void {
  const settings = readJson(picoSettingsPath()) as Settings;
  setCodeGraphMcpServer(settings, options.telemetry);
  writeJson(picoSettingsPath(), settings);
}

/** 在 settings 对象上注册 CodeGraph MCP 服务器（integrations 节与独立入口共用）。 */
function setCodeGraphMcpServer(settings: JsonObject, telemetry: string | undefined): void {
  const config = objectSetting(settings.mcpServers);
  const servers = objectSetting(config.mcpServers);
  const server: JsonObject = {
    command: "codegraph",
    args: ["serve", "--mcp"],
  };
  if (telemetry !== undefined) {
    server.env = { CODEGRAPH_TELEMETRY: telemetry };
  }
  servers.codegraph = server;
  config.mcpServers = servers;
  settings.mcpServers = config;
}

export function configureRtkIntegration(options: { enabled: boolean; mode?: "spawnHook" | "instructionsOnly"; command?: string }): void {
  const settings = readJson(picoSettingsPath()) as Settings;
  const integrations = objectSetting(settings.integrations);
  integrations.rtk = {
    enabled: options.enabled,
    mode: options.mode ?? "spawnHook",
    command: options.command ?? "rtk",
  };
  settings.integrations = integrations;
  writeJson(picoSettingsPath(), settings);
}

export function buildSetupSummary(
  settings: JsonObject,
  models: JsonObject,
  language: SetupLanguage = "en",
  colorEnabled = false,
): string {
  const text = TEXT[language];
  const s = makeStyle(colorEnabled);
  const lines = [s.success(`✓ ${text.complete}`)];
  lines.push(`${text.settings}: ${picoSettingsPath()}`);
  if (existsSync(picoModelsPath())) lines.push(`${text.models}: ${picoModelsPath()}`);
  const provider = stringSetting(settings.defaultProvider);
  const model = stringSetting(settings.defaultModel);
  if (provider && model) lines.push(`${text.defaultModelSummary}: ${provider}/${model}`);
  const env = readSettingsEnv(settings);
  const envNames = Object.keys(env).sort();
  if (envNames.length > 0) lines.push(`${text.settingsEnv}: ${envNames.join(", ")}`);
  const memory = objectSetting(settings.memory);
  if (stringSetting(memory.backend)) lines.push(`${text.memory}: ${stringSetting(memory.backend)}`);
  if (hasVisionSettings(settings as Settings)) {
    const vision = objectSetting(objectSetting(settings.auxiliary).vision);
    lines.push(`${text.vision}: ${stringSetting(vision.provider)}/${stringSetting(vision.model)}`);
  }
  if (settings.lsp !== undefined || existsSync(picoLspConfigPath())) {
    lines.push(`${text.lspConfigSummary}: ${settings.lsp !== undefined ? "settings.json (lsp)" : picoLspConfigPath()}`);
  }
  if (settings.hooks !== undefined || existsSync(userHooksPath())) {
    lines.push(`${text.hooksConfigSummary}: ${settings.hooks !== undefined ? "settings.json (hooks)" : userHooksPath()}`);
  }
  if (settings.mcpServers !== undefined || existsSync(picoMcpConfigPath())) {
    lines.push(`${text.mcpConfigSummary}: ${settings.mcpServers !== undefined ? "settings.json (mcpServers)" : picoMcpConfigPath()}`);
  }
  const integrationsSummary = summarizeIntegrationsSection(settings);
  if (integrationsSummary) lines.push(`${text.integrationsSummary}: ${integrationsSummary}`);
  if (Object.keys(objectSetting(models.providers)).length > 0) {
    lines.push(`${text.customProviders}: ${Object.keys(objectSetting(models.providers)).sort().join(", ")}`);
  }
  lines.push(s.bold(text.nextStep));
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

/**
 * A malformed settings.json/models.json must never be silently overwritten by
 * a setup section's read-modify-write — that would permanently wipe API keys
 * and safety switches (settings.ts documents the same guard). Returns the
 * first damaged (exists but unparseable) path, or null.
 */
function firstDamagedConfigPath(): string | null {
  for (const path of [picoSettingsPath(), picoModelsPath()]) {
    if (!existsSync(path)) continue;
    try {
      JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return path;
    }
  }
  return null;
}

function writeJson(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  const content = JSON.stringify(value, null, 2) + "\n";
  // settings.json / models.json may hold API keys — never world-readable
  // (mirrors extensions' writeSettings 0o600). Atomic tmp+rename so a crash
  // mid-write cannot leave a truncated config that silently resets to
  // defaults and loses the stored keys.
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, { mode: 0o600, encoding: "utf-8" });
  renameSync(tmp, path);
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-c", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function runInstallCommand(command: string): { ok: boolean; output: string } {
  // `curl | sh` installers: without pipefail the exit status is sh's, so a
  // failed download is reported as a successful install. Prefix a guarded
  // shell so curl's failure propagates.
  const guarded = command.includes("|") ? `set -o pipefail; ${command}` : command;
  const result = spawnSync("sh", ["-c", guarded], {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    // `curl | sh` installers can hang on unresponsive sources — bound the wait.
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error && result.signal === "SIGTERM") {
    return { ok: false, output: `${output}\n(command timed out after 120s)`.trim() };
  }
  return { ok: result.status === 0, output };
}

function runCommand(args: string[]): { ok: boolean; output: string } {
  const [command, ...rest] = args;
  if (!command) return { ok: false, output: "missing command" };
  const result = spawnSync(command, rest, {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const defaultShell: SetupShell = {
  commandExists,
  runInstall: runInstallCommand,
  run: runCommand,
};

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

function numberSetting(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function setOrDelete(target: Record<string, string>, key: string, value: string): void {
  if (value.trim().length === 0 || value.trim() === "-") delete target[key];
  else target[key] = value.trim();
}

function userHooksPath(): string {
  return join(picoHome(), "hooks.json");
}

export function splitArgs(value: string): string[] {
  // Quote-aware split: `--foo "bar baz"` must stay one argument.
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    args.push(m[1] ?? m[2] ?? m[3]!);
  }
  return args;
}

/** Appends the "(recommended)" marker used by choice menus. */
function recommend(language: SetupLanguage, label: string, recommended: boolean): string {
  return recommended ? (language === "zh" ? `${label}（推荐）` : `${label} (recommended)`) : label;
}

export interface ProviderModelsRequest {
  url: string;
  headers: Record<string, string>;
}

/** How to list models for each known provider — used to verify an API key. */
const PROVIDER_MODELS_ENDPOINTS: Record<string, (apiKey: string) => ProviderModelsRequest> = {
  anthropic: (apiKey) => ({
    url: "https://api.anthropic.com/v1/models",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  }),
  openai: (apiKey) => ({
    url: "https://api.openai.com/v1/models",
    headers: { Authorization: `Bearer ${apiKey}` },
  }),
  google: (apiKey) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    headers: {},
  }),
  openrouter: (apiKey) => ({
    url: "https://openrouter.ai/api/v1/models",
    headers: { Authorization: `Bearer ${apiKey}` },
  }),
};

export function providerModelsRequest(providerId: string, apiKey: string): ProviderModelsRequest | undefined {
  return PROVIDER_MODELS_ENDPOINTS[providerId]?.(apiKey);
}

/**
 * Verifies an API key against the provider's models/list endpoint. Never
 * throws — the wizard reports the failure inline and continues.
 */
export async function testProviderConnection(
  providerId: string,
  apiKey: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; detail: string }> {
  const request = providerModelsRequest(providerId, apiKey);
  if (!request) return { ok: false, detail: `no models endpoint known for provider "${providerId}"` };
  try {
    const response = await fetch(request.url, {
      method: "GET",
      headers: request.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return { ok: true, detail: `HTTP ${response.status}` };
    const body = (await response.text()).slice(0, 200);
    let detail = `HTTP ${response.status} ${body.trim()}`;
    // Most providers wrap a human-readable reason in JSON — surface just that
    // instead of dumping the whole error object at a beginner.
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string" && parsed.error.message.length > 0) {
        detail = `HTTP ${response.status} ${parsed.error.message}`;
      }
    } catch {
      // Not JSON — keep the raw body.
    }
    return { ok: false, detail };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
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

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RED = "\x1b[31m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_MAGENTA = "\x1b[35m";
const ANSI_CYAN = "\x1b[36m";

/** True when ANSI color output is appropriate (mirrors hermes colors.py). */
function supportsColor(io: SetupIo): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === "dumb") return false;
  return Boolean((io.output as NodeJS.WriteStream).isTTY);
}

interface Styled {
  banner(text: string): string;
  header(text: string): string;
  question(text: string): string;
  success(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
  error(text: string): string;
}

/** ANSI decorator; no-ops when the terminal doesn't support color. */
function makeStyle(enabled: boolean): Styled {
  const paint = (text: string, ...codes: string[]) =>
    enabled ? `${codes.join("")}${text}${ANSI_RESET}` : text;
  return {
    banner: (t) => paint(t, ANSI_MAGENTA),
    header: (t) => paint(t, ANSI_CYAN, ANSI_BOLD),
    question: (t) => paint(t, ANSI_YELLOW),
    success: (t) => paint(t, ANSI_GREEN),
    dim: (t) => paint(t, ANSI_DIM),
    bold: (t) => paint(t, ANSI_BOLD),
    error: (t) => paint(t, ANSI_RED, ANSI_BOLD),
  };
}

function styler(io: SetupIo): Styled {
  return makeStyle(supportsColor(io));
}

/** Display width in terminal columns — CJK characters count double. */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
  return width;
}

/** Break a line so no segment exceeds maxWidth display columns. */
function wrapLine(line: string, maxWidth: number): string[] {
  if (displayWidth(line) <= maxWidth) return [line];
  const out: string[] = [];
  let current = "";
  let width = 0;
  for (const ch of line) {
    const w = ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
    if (width + w > maxWidth && current.length > 0) {
      // Prefer the last space so English words stay intact; CJK (no spaces)
      // falls back to a hard break at any character.
      const lastSpace = current.lastIndexOf(" ");
      if (lastSpace > 0) {
        out.push(current.slice(0, lastSpace));
        current = current.slice(lastSpace + 1) + ch;
        width = displayWidth(current);
        continue;
      }
      out.push(current);
      current = ch;
      width = w;
    } else {
      current += ch;
      width += w;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Banner box fits an 80-column terminal. */
const SETUP_BANNER_WIDTH = 76;

function printHeader(io: SetupIo, title: string): void {
  writeLine(io, "");
  writeLine(io, styler(io).header(`◆ ${title}`));
}

function writeLine(io: SetupIo, line: string): void {
  io.output.write(`${line}\n`);
}
