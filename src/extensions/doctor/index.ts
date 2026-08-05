/**
 * /doctor surfaces pico's local safety switches and capability boundaries.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import pkg from "../../../package.json" with { type: "json" };
import {
  capabilitySummary,
  safetyStatuses,
} from "../policy.ts";
import { readSettings } from "../settings.ts";
import { picoSettingsPath } from "../paths.ts";
import {
  formatConfigYmlConflictLines,
  formatReasoningCompatLines,
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
    ...formatConfigYmlConflictLines(),
    ...formatReasoningCompatLines(),
  ].join("\n");
}

export const doctorExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerCommand("doctor", {
    description: "Show pico safety switches and capability boundaries",
    handler: async (_args, ctx) => {
      const report = buildDoctorReport(ctx.cwd ?? process.cwd());
      pi.sendMessage({
        customType: "pico.doctor",
        content: report,
        display: true,
      });
    },
  });
};

export default doctorExtension;
