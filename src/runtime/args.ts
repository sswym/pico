import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { picoAgentHome } from "../extensions/paths.ts";

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

/**
 * True when the user picked an explicit `--tui-mode`, in either the separated
 * (`--tui-mode fullscreen`) or equals (`--tui-mode=fullscreen`) form. An
 * explicit choice must never be overridden by the pico default.
 */
function hasExplicitTuiMode(rawArgs: string[]): boolean {
  return rawArgs.includes("--tui-mode") || rawArgs.some((arg) => arg.startsWith("--tui-mode="));
}

/**
 * Defaults the interactive TUI to upstream's fullscreen mode (0.84.0+).
 * Skipped for non-TUI output modes (`-p` / `--mode json|rpc`), package-
 * management commands, and whenever the user already passed `--tui-mode`.
 */
export function withDefaultTuiMode(options: RuntimeArgOptions): string[] {
  const { rawArgs } = options;

  if (rawArgs.some(isNonTuiArg)) return rawArgs;
  if (isPackageManagementCommand(rawArgs)) return rawArgs;
  if (hasExplicitTuiMode(rawArgs)) return rawArgs;
  return [...rawArgs, "--tui-mode", "fullscreen"];
}

/**
 * True when a `--theme` value is a file path rather than a theme name —
 * anything with a path separator, a leading dot (`./` `../`), or a tilde is
 * left for upstream's path loader untouched.
 */
function isPathLikeThemeArg(value: string): boolean {
  return value.startsWith(".") || value.startsWith("~") || value.includes("/") || value.includes("\\");
}

/**
 * Resolve a bare theme name to an existing theme file, mirroring upstream's
 * theme discovery order:
 *   1. custom themes dir — `agent/themes/<name>.json` (e.g. the bundled
 *      claude-code-dark synced at startup)
 *   2. builtin themes — `<PI_PACKAGE_DIR>/theme/<name>.json` (binary) or
 *      `<PI_PACKAGE_DIR>/<src|dist>/modes/interactive/theme/<name>.json`
 *      (source), matching upstream getThemesDir() for `dark` / `light`.
 * Returns null when neither exists — the arg then passes through unchanged
 * and upstream reports its own "theme path does not exist".
 */
function resolveThemeName(name: string, agentDir: string, isBunBinary: boolean): string | null {
  const stem = name.endsWith(".json") ? name.slice(0, -5) : name;

  const customPath = join(agentDir, "themes", `${stem}.json`);
  if (existsSync(customPath)) return customPath;

  const packageDir = process.env.PI_PACKAGE_DIR;
  if (packageDir) {
    const themesDir = isBunBinary
      ? join(packageDir, "theme")
      : join(packageDir, existsSync(join(packageDir, "src")) ? "src" : "dist", "modes", "interactive", "theme");
    const builtinPath = join(themesDir, `${stem}.json`);
    if (existsSync(builtinPath)) return builtinPath;
  }
  return null;
}

/**
 * Upstream treats every `--theme <value>` as a cwd-relative file path, so
 * `--theme claude-code-dark` fails with "theme path does not exist" (M2).
 * Rewrite bare names to the resolved theme file path (absolute paths and
 * other flags are untouched). Runs after ensureBundledThemeFile() in
 * bin/pico.ts, so the bundled claude-code-dark name always resolves.
 */
export function withResolvedThemeNames(options: RuntimeArgOptions): string[] {
  const { rawArgs, isBunBinary } = options;
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? picoAgentHome();
  const result = [...rawArgs];
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i] !== "--theme") continue;
    const value = result[i + 1]!;
    if (!value || isPathLikeThemeArg(value)) continue;
    const resolved = resolveThemeName(value, agentDir, isBunBinary);
    if (resolved !== null) result[i + 1] = resolved;
  }
  return result;
}

export function buildRuntimeArgs(options: RuntimeArgOptions): string[] {
  return withBundledSkills({
    ...options,
    rawArgs: withBundledPromptTemplates({
      ...options,
      rawArgs: withDefaultTuiMode({
        ...options,
        rawArgs: withResolvedThemeNames(options),
      }),
    }),
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

/**
 * Non-interactive `--export` (L33 缓解). Upstream parses `/export --path` /
 * `--export --path` as a positional argument and bakes a literal `--path`
 * file (or HTML) when no value follows. A bare option-like token after
 * `--export` can only be a mistake — intercept and explain before upstream
 * touches disk.
 */
export function validateExportArg(rawArgs: string[]): { ok: boolean; message?: string } {
  const idx = rawArgs.indexOf("--export");
  if (idx === -1) return { ok: true };
  const next = rawArgs[idx + 1];
  if (!next) {
    return { ok: false, message: "--export 缺少输出路径。用法：--export <session.jsonl> [<output.html>]" };
  }
  if (next.startsWith("-")) {
    return {
      ok: false,
      message: `--export 后的 "${next}" 看起来是另一个标志，不是导出路径。用法：--export <session.jsonl> [<output.html>]`,
    };
  }
  return { ok: true };
}
