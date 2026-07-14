/**
 * /doctor surfaces srcode's local safety switches and capability boundaries.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  capabilitySummary,
  safetyStatuses,
} from "../policy.ts";
import { srcodeSettingsPath } from "../paths.ts";

function enabled(value: boolean): string {
  return value ? "enabled" : "disabled";
}

export function buildDoctorReport(cwd: string): string {
  const safetyLines = safetyStatuses().map((status) => (
    `  ${status.settingsKey}: ${enabled(status.enabled)} (${status.source}; env ${status.envName})`
  ));
  return [
    "srcode doctor",
    "",
    `cwd: ${cwd}`,
    `settings: ${srcodeSettingsPath()}`,
    "",
    "Safety switches:",
    ...safetyLines,
    "",
    "Capabilities:",
    capabilitySummary().split("\n").map((line) => `  ${line}`).join("\n"),
  ].join("\n");
}

export const doctorExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerCommand("doctor", {
    description: "Show srcode safety switches and capability boundaries",
    handler: async (_args, ctx) => {
      const report = buildDoctorReport(ctx.cwd ?? process.cwd());
      pi.sendMessage({
        customType: "srcode.doctor",
        content: report,
        display: true,
      });
    },
  });
};

export default doctorExtension;
