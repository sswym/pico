/**
 * /doctor surfaces pico's local safety switches and capability boundaries.
 */
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import pkg from "../../../package.json" with { type: "json" };
import {
  capabilitySummary,
  safetyStatuses,
} from "../policy.ts";
import { readSettings } from "../settings.ts";
import { validateCurrentSettings } from "../settings-schema.ts";
import { picoSettingsPath } from "../paths.ts";
import {
  formatConfigYmlConflictLines,
  formatConfigYmlModelConflictLines,
  formatReasoningCompatLines,
  detectConfigYmlModelConflicts,
  detectReasoningCompatIssues,
} from "./config-scan.ts";

function enabled(value: boolean): string {
  return value ? "enabled" : "disabled";
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
  ].join("\n");
}

/**
 * Startup advisory for the "dual config" trap. config.yml vs settings.json
 * model conflicts and a default model missing the reasoning-content compat
 * flag only show up in /doctor — by then the user has already hit a silent
 * surprise (wrong provider, 400s on multi-turn calls). Warn once per session
 * instead.
 */
function startupConfigAdvisories(ctx: ExtensionContext): void {
  const modelConflicts = detectConfigYmlModelConflicts();
  if (modelConflicts.length > 0) {
    const keys = modelConflicts.map((c) => c.key).join("、");
    try {
      ctx.ui.notify(
        `配置冲突：config.yml 的 ${keys} 与 settings.json 不一致，实际生效 settings.json。运行 /doctor 查看详情。`,
        "warning",
      );
    } catch {}
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
  if (!missing) return;
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
