/**
 * RTK integration.
 *
 * When enabled in settings, supported bash commands run through `rtk` for
 * compact output. The "bash" tool itself is registered by undo-redo (upstream
 * rejects duplicate extension tool names as a fatal startup error), so this
 * extension contributes a bash spawn hook that undo-redo composes into its
 * tool — see src/extensions/bash-hooks.ts.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { registerBashSpawnHook } from "../bash-hooks.ts";
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

/**
 * Flags that make a supported head long-running. Keyed by head so `-f` is
 * only treated as "follow" where it actually means that (kubectl logs,
 * docker logs) and never misclassifies e.g. `docker compose -f file up`.
 */
const LONG_RUNNING_FLAGS: Record<string, string[]> = {
  tail: ["-f", "--follow"],
  tsc: ["--watch"],
  cargo: ["watch"],
  eslint: ["--watch"],
  jest: ["--watch"],
  vitest: ["--watch", "watch"],
  playwright: ["--watch"],
  bun: ["--hot", "--watch"],
};

/** Head-specific subcommand sequences that run forever. */
const LONG_RUNNING_PATTERNS: Array<{ head: string; matches: (args: string[]) => boolean }> = [
  {
    head: "kubectl",
    matches: (args) => args.includes("logs") && (args.includes("-f") || args.includes("--follow")),
  },
  {
    head: "docker",
    matches: (args) =>
      (args.includes("logs") && (args.includes("-f") || args.includes("--follow"))) ||
      args.includes("up") ||
      args.includes("watch"),
  },
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
  // 2.5.10: pipelines/redirections/command chains must run raw — wrapping
  // only the first segment breaks their semantics.
  if (SHELL_COMPOSITION_RE.test(normalized)) return false;
  if (SKIP_PREFIXES.some((prefix) => commandStartsWith(normalized, prefix))) return false;
  if (isLongRunningCommand(normalized)) return false;
  return SUPPORTED_PREFIXES.some((prefix) => commandStartsWith(normalized, prefix));
}

/** Shell metacharacters that break rtk wrapping (2.5.10): piping through
 *  rtk compresses the intermediate output before the consumer sees it
 *  (`git log | head`), redirection would write the compressed text to the
 *  file, and && / || / ; only wrap the first segment. */
const SHELL_COMPOSITION_RE = /[|><;&`$()]/;

/**
 * True when the command spawns a follower/watcher/dev server that never exits.
 */
function isLongRunningCommand(command: string): boolean {
  const tokens = command.split(" ");
  const head = tokens[0];
  if (!head) return false;
  const args = tokens.slice(1);
  const flags = LONG_RUNNING_FLAGS[head];
  if (flags && flags.some((flag) => args.includes(flag))) return true;
  for (const pattern of LONG_RUNNING_PATTERNS) {
    if (pattern.head === head && pattern.matches(args)) return true;
  }
  // npm/pnpm/bun run dev-* or run start spawn dev servers / watch mode.
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "run" && (args[i + 1]!.startsWith("dev") || args[i + 1] === "start")) return true;
  }
  // `cargo run` / `go run` launch long-lived dev servers — compressing their
  // output corrupts a live session view (2.5.10).
  if ((head === "cargo" || head === "go") && args[0] === "run") return true;
  return false;
}

/**
 * Whether the configured rtk binary is actually reachable, probed per command
 * name and cached briefly. Enabling the integration in settings while rtk is
 * not installed would otherwise turn every supported bash command into an
 * `rtk: command not found` hard failure with no hint. The TTL keeps a
 * freshly-installed rtk from staying "unavailable" for the whole session.
 */
const RTK_PROBE_TTL_MS = 60_000;
const rtkAvailabilityCache = new Map<string, { available: boolean; at: number }>();

export function __resetRtkAvailabilityForTests(): void {
  rtkAvailabilityCache.clear();
}

export function isRtkAvailable(command: string): boolean {
  const cached = rtkAvailabilityCache.get(command);
  if (cached && Date.now() - cached.at < RTK_PROBE_TTL_MS) return cached.available;
  const safeCommand = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  let available = false;
  try {
    const probe = Bun.spawnSync(["sh", "-c", `command -v "${safeCommand}" >/dev/null 2>&1`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    available = probe.exitCode === 0;
  } catch {
    available = false;
  }
  rtkAvailabilityCache.set(command, { available, at: Date.now() });
  return available;
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

  registerBashSpawnHook((context) => ({
    ...context,
    command: isRtkAvailable(config.command)
      ? rewriteRtkCommand(context.command, config.command)
      : context.command,
  }));

  let noticeShown = false;
  pi.on("session_start", (_event, ctx) => {
    if (noticeShown || !ctx.hasUI) return;
    noticeShown = true;
    try {
      if (isRtkAvailable(config.command)) {
        ctx.ui.notify(
          "rtk 输出压缩已启用：受支持的 bash 命令将通过 rtk 执行以节省 token，" +
            "输出可能与原命令不同。可在 settings.json 的 integrations.rtk.enabled 关闭。",
          "info",
        );
      } else {
        ctx.ui.notify(
          `rtk 已启用但找不到可执行文件 "${config.command}" — 命令将原样执行，未做压缩。` +
            "请安装 rtk 或修正 settings.json 的 integrations.rtk.command。",
          "warning",
        );
      }
    } catch {}
  });
};

export default rtkExtension;
