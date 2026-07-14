/**
 * /doctor surfaces srcode's local safety switches and capability boundaries.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  allowLspFormatOnWrite,
  allowProjectHooks,
  allowProjectMcp,
  allowUnattendedPlanApproval,
  capabilitySummary,
} from "../policy.ts";

function enabled(value: boolean): string {
  return value ? "enabled" : "disabled";
}

export function buildDoctorReport(cwd: string): string {
  return [
    "srcode doctor",
    "",
    `cwd: ${cwd}`,
    "",
    "Safety switches:",
    `  SRCODE_ALLOW_UNATTENDED_PLAN_APPROVAL: ${enabled(allowUnattendedPlanApproval())}`,
    `  SRCODE_ALLOW_LSP_FORMAT_ON_WRITE: ${enabled(allowLspFormatOnWrite())}`,
    `  SRCODE_ENABLE_PROJECT_HOOKS: ${enabled(allowProjectHooks())}`,
    `  SRCODE_ENABLE_PROJECT_MCP: ${enabled(allowProjectMcp())}`,
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
