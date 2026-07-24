/**
 * RTK integration.
 *
 * When enabled in settings, this replaces the built-in bash tool with the
 * standard pi bash tool plus a spawnHook that runs supported commands through
 * `rtk` for compact output.
 */
import { createBashTool, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readSettingsObject } from "../settings.ts";

export interface RtkConfig {
  enabled: boolean;
  mode: "spawnHook" | "instructionsOnly";
  command: string;
}

const SKIP_PREFIXES = [
  "rtk",
  "cd",
  "source",
  "export",
  "alias",
  "unalias",
  "history",
  "jobs",
  "fg",
  "bg",
  "watch",
  "tail -f",
  "bun run start",
  "npm run start",
  "pnpm dev",
  "npm run dev",
  "bun --hot",
];

const SUPPORTED_PREFIXES = [
  "ls",
  "tree",
  "cat",
  "head",
  "tail",
  "find",
  "grep",
  "rg",
  "git",
  "gh",
  "jest",
  "vitest",
  "playwright",
  "pytest",
  "go test",
  "cargo",
  "ruff",
  "eslint",
  "tsc",
  "docker",
  "kubectl",
  "aws",
  "pnpm list",
  "npm list",
  "bun test",
];

export function readRtkConfig(): RtkConfig {
  const integrations = readSettingsObject("integrations");
  const raw = integrations.rtk && typeof integrations.rtk === "object" && !Array.isArray(integrations.rtk)
    ? integrations.rtk as Record<string, unknown>
    : {};
  return {
    enabled: raw.enabled === true,
    mode: raw.mode === "instructionsOnly" ? "instructionsOnly" : "spawnHook",
    command: typeof raw.command === "string" && raw.command.trim().length > 0 ? raw.command.trim() : "rtk",
  };
}

export function shouldRewriteWithRtk(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return false;
  if (normalized.includes("\n")) return false;
  if (SKIP_PREFIXES.some((prefix) => commandStartsWith(normalized, prefix))) return false;
  return SUPPORTED_PREFIXES.some((prefix) => commandStartsWith(normalized, prefix));
}

export function rewriteRtkCommand(command: string, rtkCommand = "rtk"): string {
  if (!shouldRewriteWithRtk(command)) return command;
  return `${rtkCommand} ${command}`;
}

function commandStartsWith(command: string, prefix: string): boolean {
  return command === prefix || command.startsWith(`${prefix} `);
}

export const rtkExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const config = readRtkConfig();
  if (!config.enabled || config.mode !== "spawnHook" || process.env.SRCODE_RTK === "0") return;

  const bashTool = createBashTool(process.cwd(), {
    spawnHook: ({ command, cwd, env }) => ({
      command: rewriteRtkCommand(command, config.command),
      cwd,
      env,
    }),
  });

  pi.registerTool({
    ...bashTool,
    execute: async (id, params, signal, onUpdate, _ctx) => {
      return bashTool.execute(id, params, signal, onUpdate);
    },
  });
};

export default rtkExtension;
