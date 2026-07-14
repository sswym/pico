/**
 * Shared capability and safety-policy helpers for srcode extensions.
 *
 * This is intentionally small: pi-coding-agent owns the main permission
 * system, while srcode extensions use this module for local defaults that
 * would otherwise drift across tools.
 */

export type Capability =
  | "read"
  | "write"
  | "shell"
  | "network"
  | "auto_write"
  | "project_code_exec"
  | "external_tool";

export interface CapabilityDescriptor {
  capability: Capability;
  label: string;
  risk: "low" | "medium" | "high";
  description: string;
}

export const CAPABILITIES: readonly CapabilityDescriptor[] = [
  {
    capability: "read",
    label: "Read",
    risk: "low",
    description: "Read local project context without mutating files.",
  },
  {
    capability: "write",
    label: "Write",
    risk: "high",
    description: "Create or modify files through explicit edit/write tools.",
  },
  {
    capability: "shell",
    label: "Shell",
    risk: "high",
    description: "Run local commands through shell-backed tools or hooks.",
  },
  {
    capability: "network",
    label: "Network",
    risk: "medium",
    description: "Fetch or search public network resources.",
  },
  {
    capability: "auto_write",
    label: "Auto Write",
    risk: "high",
    description: "Apply a second file mutation after an explicit write/edit.",
  },
  {
    capability: "project_code_exec",
    label: "Project Code Exec",
    risk: "high",
    description: "Execute commands configured by the current project.",
  },
  {
    capability: "external_tool",
    label: "External Tool",
    risk: "medium",
    description: "Delegate work to an external process or server.",
  },
];

export function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function allowUnattendedPlanApproval(): boolean {
  return envFlag("SRCODE_ALLOW_UNATTENDED_PLAN_APPROVAL");
}

export function allowLspFormatOnWrite(): boolean {
  return envFlag("SRCODE_ALLOW_LSP_FORMAT_ON_WRITE");
}

export function allowProjectHooks(): boolean {
  return envFlag("SRCODE_ENABLE_PROJECT_HOOKS");
}

export function allowProjectMcp(): boolean {
  return envFlag("SRCODE_ENABLE_PROJECT_MCP");
}

export function capabilitySummary(): string {
  return CAPABILITIES
    .map((c) => `${c.label} (${c.risk}): ${c.description}`)
    .join("\n");
}
