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

/** Commands that tend to run indefinitely (followers, watchers, dev servers). */
const LONG_RUNNING_COMMANDS = ["tail", "jest", "vitest", "playwright", "bun", "npm", "pnpm", "watch"];

/** Flags/args that turn a supported command into a long-running process. */
const LONG_RUNNING_FLAGS = ["--watch", "--follow", "-f", "--hot", "watch"];

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
  if (isLongRunningCommand(normalized)) return false;
  return SUPPORTED_PREFIXES.some((prefix) => commandStartsWith(normalized, prefix));
}

/** True when the command spawns a follower/watcher/dev server that never exits. */
function isLongRunningCommand(command: string): boolean {
  const tokens = command.split(" ");
  const head = tokens[0];
  if (!head || !LONG_RUNNING_COMMANDS.includes(head)) return false;
  const args = tokens.slice(1);
  if (args.some((arg) => LONG_RUNNING_FLAGS.includes(arg))) return true;
  // npm/pnpm/bun run dev-* or run start spawn dev servers / watch mode.
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "run" && (args[i + 1]!.startsWith("dev") || args[i + 1] === "start")) return true;
  }
  return false;
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
  if (!config.enabled || config.mode !== "spawnHook" || process.env.PICO_RTK === "0") return;

  let noticeShown = false;
  pi.on("session_start", (_event, ctx) => {
    if (noticeShown || !ctx.hasUI) return;
    noticeShown = true;
    try {
      ctx.ui.notify(
        "rtk 输出压缩已启用：受支持的 bash 命令将通过 rtk 执行以节省 token，" +
          "输出可能与原命令不同。可在 settings.json 的 integrations.rtk.enabled 关闭。",
        "info",
      );
    } catch {}
  });

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
