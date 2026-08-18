/**
 * /doctor surfaces pico's local safety switches and capability boundaries.
 */
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import pkg from "../../../package.json" with { type: "json" };
import {
  capabilitySummary,
  safetyStatuses,
} from "../policy.ts";
import { picoSettingsPath } from "../paths.ts";
import { legacyUserConfigPaths } from "../config-migrate.ts";
import { readSettings, readSettingsObject, writeSettings, isSettingsDamaged } from "../settings.ts";
import { validateCurrentSettings } from "../settings-schema.ts";
import { ENV_SETTING_MAPPINGS, envSettingEffectiveValue } from "../envmap.ts";
import { subscribeSessionExtensionEvent, type LspStatusEvent } from "../events.ts";
import { loggingStatus } from "../logging.ts";
import { readEvolutionConfig, getState } from "../evolution/state.ts";
import { readManifest } from "../evolution/apply.ts";
import {
  formatConfigYmlConflictLines,
  formatConfigYmlModelConflictLines,
  formatReasoningCompatLines,
  formatMissingDefaultModelLines,
  detectConfigYmlModelConflicts,
  detectConfigYmlSafetyConflicts,
  detectReasoningCompatIssues,
  detectMissingDefaultModel,
  type SafetyKey,
} from "./config-scan.ts";

function enabled(value: boolean): string {
  return value ? "enabled" : "disabled";
}

/** Labels matching upstream's HTTP idle timeout choices. */
const REQUEST_TIMEOUT_LABELS: Array<[number, string]> = [
  [30_000, "30 sec"],
  [60_000, "1 min"],
  [120_000, "2 min"],
  [300_000, "5 min"],
];

/**
 * Effective per-request model timeout. Upstream reads `httpIdleTimeoutMs`
 * from the same settings.json (default 300000ms, 0 = disabled). Surfacing
 * it here keeps the 5-minute silent-wait default visible instead of
 * surprising users when a provider hangs.
 */
function requestTimeoutSummary(): string[] {
  const raw = readSettings().httpIdleTimeoutMs;
  let ms: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    ms = raw;
  } else if (typeof raw === "string" && raw.trim().toLowerCase() === "disabled") {
    ms = 0;
  }
  if (ms === 0) return ["  disabled (0 = no timeout; key httpIdleTimeoutMs)"];
  if (ms === undefined) return ["  5 min (default; key httpIdleTimeoutMs)"];
  const label = REQUEST_TIMEOUT_LABELS.find(([candidate]) => candidate === ms)?.[1] ?? `${ms / 1000} sec`;
  return [`  ${label} (settings.json; key httpIdleTimeoutMs)`];
}

/** Latest lsp_status snapshot (published by the lsp extension). */
let lspFailures: LspStatusEvent["failures"] = [];

function evolutionSummary(): string[] {
  const config = readEvolutionConfig();
  const model = config.provider && config.model
    ? `${config.provider}/${config.model}`
    : "(follows current session model)";
  const evolved = Object.keys(readManifest().skills);
  return [
    `  enabled: ${enabled(config.enabled)} (env PICO_EVOLUTION_ENABLED or settings evolution.enabled)`,
    `  model: ${model}`,
    `  reviewEveryTurns: ${config.reviewEveryTurns}, maxReviewsPerSession: ${config.maxReviewsPerSession}`,
    `  reviews this session: ${getState().reviewsDone}`,
    `  evolved skills: ${evolved.length > 0 ? evolved.join(", ") : "(none)"}`,
    `  privacy: ${config.enabled ? "session content is sent to the review model" : "off"}`,
  ];
}

function modelSummary(): string[] {
  const settings = readSettings();
  const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : "(unset)";
  const model = typeof settings.defaultModel === "string" ? settings.defaultModel : "(unset)";
  return [`  provider: ${provider}`, `  model: ${model}`];
}

export function buildDoctorReport(cwd: string): string {
  const safetyLines = safetyStatuses().map((status) => (
    `  ${status.settingsKey}: ${enabled(status.enabled)} (${status.source}; env ${status.envName})`
  ));
  const settingsValidation = validateCurrentSettings();
  const settingsValidationLines = settingsValidation.valid
    ? ["  ok"]
    : settingsValidation.issues.map((issue) => `  ${issue.key}: ${issue.message}`);
  const lspLines = lspFailures.length > 0
    ? lspFailures.map(
        (f) => `  ${f.server}: init failed — ${f.message} (${new Date(f.at).toISOString()})`,
      )
    : ["  no init failures recorded"];
  return [
    "pico doctor",
    "",
    `cwd: ${cwd}`,
    `settings: ${picoSettingsPath()}`,
    `pico v${(pkg as { version?: string }).version ?? "?"}`,
    "",
    "Model:",
    ...modelSummary(),
    "",
    "Safety switches:",
    ...safetyLines,
    "",
    "Capabilities:",
    capabilitySummary().split("\n").map((line) => `  ${line}`).join("\n"),
    "",
    "Settings validation:",
    ...settingsValidationLines,
    ...formatConfigYmlConflictLines(),
    ...formatConfigYmlModelConflictLines(),
    ...formatReasoningCompatLines(),
    ...formatMissingDefaultModelLines(),
    "",
    "Config sources:",
    ...configSourcesSummary(),
    "",
    "Env ↔ settings:",
    ...envMappingSummary(),
    "",
    "Request timeout:",
    ...requestTimeoutSummary(),
    "",
    "Evolution:",
    ...evolutionSummary(),
    "",
    "Logging:",
    ...loggingSummary(),
    "",
    "LSP:",
    ...lspLines,
  ].join("\n");
}

/** logging.ts 通道状态：级别 + 落盘文件（PICO_LOG_FILE 设置后不为空）。 */
function loggingSummary(): string[] {
  const { level, file, dir } = loggingStatus();
  return [
    `  level: ${level}`,
    `  file: ${file ?? "unset — stderr only"}`,
    `  dir: ${dir}`,
    file
      ? "  (set PICO_LOG_FILE / PICO_LOG_DIR to persist logs; log message volume only, no user content)"
      : "  (set PICO_LOG_FILE=/path or PICO_LOG_FILE=name.log to enable file logging)",
  ];
}

/** 用户级配置来源视图：命名空间（settings.json）激活与否、旧文件遗留。 */
function configSourcesSummary(): string[] {
  const settings = readSettings();
  const lines: string[] = [];
  for (const { key, path } of legacyUserConfigPaths()) {
    const active = settings[key] !== undefined;
    lines.push(`  ${key}: ${active ? "settings.json" : `legacy file (${path})`}`);
  }
  const leftover = legacyUserConfigPaths().filter(({ path }) => existsSync(path));
  if (leftover.length > 0) {
    lines.push(
      `  leftover legacy files (run "pico setup" to migrate): ${leftover.map(({ key }) => key).join(", ")}`,
    );
  }
  return lines;
}

/** env ↔ settings 映射视图：列出全部面向用户的 PICO_* 键与当前生效值。 */
function envMappingSummary(): string[] {
  const settings = readSettings();
  return ENV_SETTING_MAPPINGS.filter((m) => !m.internal).map((m) => {
    const effective = envSettingEffectiveValue(m, settings);
    const settingsHint = m.settingsPath ? ` → settings ${m.settingsPath}` : "";
    return `  ${m.env}=${effective} [${m.precedence}${settingsHint}] ${m.description}`;
  });
}

/**
 * Startup advisory for the "dual config" trap. config.yml vs settings.json
 * model/safety conflicts and a default model missing the reasoning-content
 * compat flag only show up in /doctor — by then the user has already hit a
 * silent surprise (wrong provider, ignored safety switches, 400s on
 * multi-turn calls). Warn once per session instead.
 */
function notifyConfigWarning(ctx: ExtensionContext, message: string): void {
  try {
    if (ctx.hasUI) {
      ctx.ui.notify(message, "warning");
    } else {
      process.stderr.write(`[pico] ${message}\n`);
    }
  } catch {}
}

/**
 * One-shot migration: safety keys the user wrote into the legacy config.yml
 * (which pico ignores) are copied into settings.json's `safety` object when
 * the user has not already pinned that key there or via env. Natural
 * idempotency: after the write, the key's source becomes "settings" and the
 * conflict disappears. Damaged settings.json is never touched.
 */
export function migrateConfigYmlSafetyKeys(): SafetyKey[] {
  if (isSettingsDamaged()) return [];
  const conflicts = detectConfigYmlSafetyConflicts();
  if (conflicts.length === 0) return [];

  const sources: Record<string, "env" | "settings" | "default"> = {};
  for (const status of safetyStatuses()) sources[status.settingsKey] = status.source;
  const settings = readSettings();
  const safety = { ...readSettingsObject("safety") };
  const migrated: SafetyKey[] = [];

  for (const conflict of conflicts) {
    // env/settings already control this key — writing config.yml's value
    // would silently override an explicit user choice (env wins at runtime,
    // but the persisted value would still surprise later).
    if (sources[conflict.key] !== "default") continue;
    safety[conflict.key] = conflict.configYmlValue;
    migrated.push(conflict.key);
  }

  if (migrated.length === 0) return [];
  settings.safety = safety;
  try {
    writeSettings(settings);
  } catch {
    return []; // read-only settings file — keep the advisory path
  }
  return migrated;
}

function startupConfigAdvisories(ctx: ExtensionContext): void {
  if (!isSettingsDamaged()) {
    const settings = readSettings();
    if (typeof settings.defaultProvider !== "string" || settings.defaultProvider.length === 0) {
      // Fresh install — no model configured yet. The conflict advisories all
      // assume a model is set; nudge toward the wizard instead. Upstream
      // falls back to the first available model silently, so without this a
      // first-run user has no idea setup exists.
      try {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "首次使用？运行 `pico setup` 配置默认模型与 API key 后即可开始对话。",
            "info",
          );
        }
      } catch {}
      return;
    }
  }
  const safetyConflicts = detectConfigYmlSafetyConflicts();
  if (safetyConflicts.length > 0) {
    const migrated = migrateConfigYmlSafetyKeys();
    if (migrated.length > 0) {
      notifyConfigWarning(
        ctx,
        `检测到 config.yml 的 safety 开关被 pico 忽略，已将 ${migrated.join("、")} 自动迁移到 settings.json 的 safety 字段（config.yml 原值保留，后续以 settings.json 为准）。运行 /doctor 查看详情。`,
      );
      // Remaining conflicts (env-pinned or settings-pinned keys) still need
      // the advisory below — re-scan to exclude the migrated ones.
      const remaining = detectConfigYmlSafetyConflicts();
      if (remaining.length === 0) return;
    }
    const detail = detectConfigYmlSafetyConflicts()
      .map((c) => `${c.key}（config.yml=${c.configYmlValue}，实际生效=${c.effectiveValue}）`)
      .join("、");
    notifyConfigWarning(
      ctx,
      `配置冲突：config.yml 的 safety 开关被 pico 忽略（实际只认 settings.json 与 env）：${detail}。` +
        "运行 /doctor 查看迁移指引。",
    );
  }
  const modelConflicts = detectConfigYmlModelConflicts();
  if (modelConflicts.length > 0) {
    const keys = modelConflicts.map((c) => c.key).join("、");
    notifyConfigWarning(
      ctx,
      `配置冲突：config.yml 的 ${keys} 与 settings.json 不一致，实际生效 settings.json。运行 /doctor 查看详情。`,
    );
    return;
  }
  const settings = readSettings();
  const issues = detectReasoningCompatIssues();
  const missing = issues.find(
    (issue) =>
      !issue.hasCompatFlag &&
      issue.provider === settings.defaultProvider &&
      issue.model === settings.defaultModel,
  );
  if (!missing) {
    const missingDefault = detectMissingDefaultModel();
    if (missingDefault) {
      const message =
        `默认模型 ${missingDefault.provider}/${missingDefault.model} 未在 models.json / models-store.json 中找到，` +
        "会话将静默回退到第一个可用模型（可能使用意外 provider 并产生费用）。修正 settings.json 的 defaultModel，运行 /doctor 查看详情。";
      try {
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        } else {
          // Non-interactive runs have no notification channel — the batch/CI
          // scenario is exactly where a silent model fallback is dangerous.
          process.stderr.write(`[pico] ${message}\n`);
        }
      } catch {}
    }
    return;
  }
  try {
    ctx.ui.notify(
      `当前默认模型 ${missing.provider}/${missing.model} 缺少 requiresReasoningContentOnAssistantMessages 兼容配置，` +
        "多轮对话可能触发 400 错误。运行 /doctor 查看修复指引。",
      "warning",
    );
  } catch {}
}

export const doctorExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.on("session_start", (_event, ctx) => {
    startupConfigAdvisories(ctx);
  });

  // Cache the LSP init-failure snapshot published by the lsp extension so
  // /doctor can show why a language server did not come up (the startup
  // stderr line is easy to miss). Session-scoped: a /reload re-runs the
  // factory and must not stack duplicate subscriptions.
  subscribeSessionExtensionEvent("lsp_status", (event) => {
    lspFailures = event.failures;
  });

  pi.registerCommand("doctor", {
    description: "Show pico safety switches and capability boundaries",
    handler: async (_args, ctx) => {
      const report = buildDoctorReport(ctx.cwd ?? process.cwd());
      if (ctx.hasUI) {
        pi.sendMessage({
          customType: "pico.doctor",
          content: report,
          display: true,
        });
        return;
      }
      // Non-interactive (--print / CI): the custom-message channel goes
      // nowhere — emit the report on stdout instead of silently doing
      // nothing with a success exit code.
      try {
        console.log(report);
      } catch {}
    },
  });
};

export default doctorExtension;
