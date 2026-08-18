/**
 * Shared capability and safety-policy helpers for pico extensions.
 *
 * This is intentionally small: pi-coding-agent owns the main permission
 * system, while pico extensions use this module for local defaults that
 * would otherwise drift across tools.
 */
import { readSettingsObject } from "./settings.ts";
import { log } from "./logging.ts";

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

export interface SafetySettings {
  enableProjectHooks?: boolean;
  enableProjectMcp?: boolean;
  enableProjectLsp?: boolean;
  allowUnattendedPlanApproval?: boolean;
  allowLspFormatOnWrite?: boolean;
}

type SafetyKey = keyof SafetySettings;

export function envFlag(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

const warnedSafetyTypes = new Set<string>();

function readSafetyValue(raw: Record<string, unknown>, key: string): boolean | undefined {
  const value = raw[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && !warnedSafetyTypes.has(key)) {
    warnedSafetyTypes.add(key);
    log.warn("", `settings.json safety.${key} is a string ("${value}"); expected a boolean — treated as disabled`);
  }
  return undefined;
}

export function readSafetySettings(): SafetySettings {
  const raw = readSettingsObject("safety");
  const settings: SafetySettings = {};
  const enableProjectHooks = readSafetyValue(raw, "enableProjectHooks");
  if (enableProjectHooks !== undefined) settings.enableProjectHooks = enableProjectHooks;
  const enableProjectMcp = readSafetyValue(raw, "enableProjectMcp");
  if (enableProjectMcp !== undefined) settings.enableProjectMcp = enableProjectMcp;
  const enableProjectLsp = readSafetyValue(raw, "enableProjectLsp");
  if (enableProjectLsp !== undefined) settings.enableProjectLsp = enableProjectLsp;
  const allowUnattendedPlanApproval = readSafetyValue(raw, "allowUnattendedPlanApproval");
  if (allowUnattendedPlanApproval !== undefined) settings.allowUnattendedPlanApproval = allowUnattendedPlanApproval;
  const allowLspFormatOnWrite = readSafetyValue(raw, "allowLspFormatOnWrite");
  if (allowLspFormatOnWrite !== undefined) settings.allowLspFormatOnWrite = allowLspFormatOnWrite;
  return settings;
}

function safetyFlag(envName: string, settingsKey: SafetyKey): boolean {
  const env = envFlag(envName);
  if (env !== undefined) return env;
  return readSafetySettings()[settingsKey] ?? false;
}

export function safetyFlagSource(envName: string, settingsKey: SafetyKey): "env" | "settings" | "default" {
  if (envFlag(envName) !== undefined) return "env";
  if (readSafetySettings()[settingsKey] !== undefined) return "settings";
  return "default";
}

export interface SafetyFlagStatus {
  envName: string;
  settingsKey: SafetyKey;
  enabled: boolean;
  source: "env" | "settings" | "default";
}

export function safetyStatuses(): SafetyFlagStatus[] {
  return [
    {
      envName: "PICO_ALLOW_UNATTENDED_PLAN_APPROVAL",
      settingsKey: "allowUnattendedPlanApproval",
      enabled: allowUnattendedPlanApproval(),
      source: safetyFlagSource("PICO_ALLOW_UNATTENDED_PLAN_APPROVAL", "allowUnattendedPlanApproval"),
    },
    {
      envName: "PICO_ALLOW_LSP_FORMAT_ON_WRITE",
      settingsKey: "allowLspFormatOnWrite",
      enabled: allowLspFormatOnWrite(),
      source: safetyFlagSource("PICO_ALLOW_LSP_FORMAT_ON_WRITE", "allowLspFormatOnWrite"),
    },
    {
      envName: "PICO_ENABLE_PROJECT_HOOKS",
      settingsKey: "enableProjectHooks",
      enabled: allowProjectHooks(),
      source: safetyFlagSource("PICO_ENABLE_PROJECT_HOOKS", "enableProjectHooks"),
    },
    {
      envName: "PICO_ENABLE_PROJECT_MCP",
      settingsKey: "enableProjectMcp",
      enabled: allowProjectMcp(),
      source: safetyFlagSource("PICO_ENABLE_PROJECT_MCP", "enableProjectMcp"),
    },
    {
      envName: "PICO_ENABLE_PROJECT_LSP",
      settingsKey: "enableProjectLsp",
      enabled: allowProjectLsp(),
      source: safetyFlagSource("PICO_ENABLE_PROJECT_LSP", "enableProjectLsp"),
    },
  ];
}

export function allowUnattendedPlanApproval(): boolean {
  return safetyFlag("PICO_ALLOW_UNATTENDED_PLAN_APPROVAL", "allowUnattendedPlanApproval");
}

export function allowLspFormatOnWrite(): boolean {
  return safetyFlag("PICO_ALLOW_LSP_FORMAT_ON_WRITE", "allowLspFormatOnWrite");
}

export function allowProjectHooks(): boolean {
  return safetyFlag("PICO_ENABLE_PROJECT_HOOKS", "enableProjectHooks");
}

export function allowProjectMcp(): boolean {
  return safetyFlag("PICO_ENABLE_PROJECT_MCP", "enableProjectMcp");
}

export function allowProjectLsp(): boolean {
  return safetyFlag("PICO_ENABLE_PROJECT_LSP", "enableProjectLsp");
}

/**
 * Allow project-local subagents to run without interactive confirmation.
 * Interactive sessions still prompt unless the model sets confirmProjectAgents=false;
 * non-interactive runs refuse project agents unless this env flag is set.
 */
export function allowUnattendedProjectAgents(): boolean {
  return envFlag("PICO_ALLOW_UNATTENDED_PROJECT_AGENTS") ?? false;
}

export function capabilitySummary(): string {
  return CAPABILITIES
    .map((c) => `${c.label} (${c.risk}): ${c.description}`)
    .join("\n");
}
