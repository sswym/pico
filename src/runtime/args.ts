import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config"]);

export interface RuntimeArgOptions {
  rawArgs: string[];
  entryMetaUrl: string;
  isBunBinary: boolean;
  embeddedPromptsDir?: string;
  embeddedSkillsDir?: string;
}

export function withBundledPromptTemplates(options: RuntimeArgOptions): string[] {
  const { rawArgs, entryMetaUrl, isBunBinary, embeddedPromptsDir } = options;

  if (rawArgs.includes("--no-prompt-templates") || rawArgs.includes("-np")) return rawArgs;
  if (isPackageManagementCommand(rawArgs)) return rawArgs;

  const promptsDir = embeddedPromptsDir ?? (
    isBunBinary
      ? resolve(dirname(process.execPath), "prompts")
      : resolve(dirname(fileURLToPath(entryMetaUrl)), "..", "src", "prompts")
  );
  if (!existsSync(promptsDir)) return rawArgs;

  for (let i = 0; i < rawArgs.length - 1; i++) {
    if (rawArgs[i] === "--prompt-template" && resolve(rawArgs[i + 1]!) === promptsDir) {
      return rawArgs;
    }
  }
  return [...rawArgs, "--prompt-template", promptsDir];
}

export function withBundledSkills(options: RuntimeArgOptions): string[] {
  const { rawArgs, entryMetaUrl, isBunBinary, embeddedSkillsDir } = options;

  if (rawArgs.includes("--no-skills") || rawArgs.includes("-ns")) return rawArgs;
  if (isPackageManagementCommand(rawArgs)) return rawArgs;

  const skillsDir = embeddedSkillsDir ?? (
    isBunBinary
      ? resolve(dirname(process.execPath), "skills")
      : resolve(dirname(fileURLToPath(entryMetaUrl)), "..", "src", "skills")
  );
  if (!existsSync(skillsDir)) return rawArgs;

  for (let i = 0; i < rawArgs.length - 1; i++) {
    if (rawArgs[i] === "--skill" && resolve(rawArgs[i + 1]!) === skillsDir) {
      return rawArgs;
    }
  }
  return [...rawArgs, "--skill", skillsDir];
}

export function buildRuntimeArgs(options: RuntimeArgOptions): string[] {
  return withBundledSkills({
    ...options,
    rawArgs: withBundledPromptTemplates(options),
  });
}

/**
 * True when the arg selects a programmatic (non-TUI) output mode. Matches
 * both the separated (`--mode json`, `--print <msg>`) and the equals
 * (`--mode=json`, `--print=<msg>`) forms — a missed equals form lets
 * console.clear() corrupt stdout for RPC/JSON consumers in a TTY.
 */
export function isNonTuiArg(arg: string): boolean {
  return (
    arg === "--mode" ||
    arg.startsWith("--mode=") ||
    arg === "--print" ||
    arg.startsWith("--print=") ||
    arg === "-p"
  );
}

function isPackageManagementCommand(rawArgs: string[]): boolean {
  return rawArgs.length > 0 && PACKAGE_COMMANDS.has(rawArgs[0]!);
}
