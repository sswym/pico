#!/usr/bin/env bun
/**
 * pico — vibe coding agent
 *
 * Thin wrapper over @earendil-works/pi-coding-agent's main(). We add a
 * stack of extensions on top of the upstream defaults:
 *   - vibe        : appends our coding-style guidelines to the system prompt
 *   - logo        : replaces the built-in TUI header with pico's ASCII logo
 *   - memory      : SQLite-backed long-term memory + /memory command
 *   - subagent    : delegate tasks to scout/planner/worker/reviewer roles
 *   - todo        : session task checklist (todoWrite tool + /todo command)
 *   - hooks       : file-driven Pre/PostToolUse hooks (registered last so it
 *                   observes the final tool surface other extensions assemble)
 *
 * pico ships bundled agent definitions and workflow prompts under
 * `src/prompts/`. We auto-inject the prompts directory via
 * `--prompt-template` so users get the
 * `/implement`, `/scout-and-plan`, `/implement-and-review` workflows for
 * free without symlinking anything into `~/.pico/agent/`.
 */
// MUST be the first import — sets PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR
// before pi-coding-agent's config module evaluates them at top level.
import "./env-bootstrap.ts";

import { main, VERSION as UPSTREAM_VERSION } from "@earendil-works/pi-coding-agent";
import picoPkg from "../package.json" with { type: "json" };
import { buildRuntimeArgs, isNonTuiArg } from "../src/runtime/args.ts";
import { isBunBinaryRuntime, prepareEmbeddedRuntime } from "../src/runtime/embedded-runtime.ts";
import { ensureBundledThemeFile } from "../src/extensions/retro-theme/index.ts";
import { createDefaultExtensionRegistry } from "../src/runtime/extensions.ts";
import { runSetupCommandIfRequested } from "../src/runtime/setup.ts";

// --- Extract embedded assets (compiled-binary mode only) ---
const isBunBinary = isBunBinaryRuntime(import.meta.url);
const embeddedDirs = prepareEmbeddedRuntime(isBunBinary);
const rawArgs = process.argv.slice(2);

// ── Hook recursion guard (2.5.8) ─────────────────────────────────────────
// A hooks.json PreToolUse/PostToolUse command that calls `pico` itself would
// nest agent-in-hook-in-agent forever. runner.ts marks every hook subprocess
// with PICO_HOOK_RECURSION_GUARD; refuse to start under it.
if (process.env.PICO_HOOK_RECURSION_GUARD === "1") {
  console.error(
    "[pico] refusing to start: pico was invoked from inside a pico hook (PICO_HOOK_RECURSION_GUARD is set). " +
      "Hooks must not call the pico CLI — use direct commands instead.",
  );
  process.exit(1);
}

// ── Subagent nesting depth guard ─────────────────────────────────────────
// Every subagent child is spawned with PICO_SUBAGENT_DEPTH = parent depth + 1
// (subagent/process.ts). An LLM that keeps calling the subagent tool inside a
// subagent would otherwise stack full pico processes (each ~100MB binary +
// independent model context) until the machine is exhausted. Mirrors the hook
// recursion guard: refuse to start past the configured depth.
if (Number.parseInt(process.env.PICO_SUBAGENT_DEPTH ?? "0", 10) >= 3) {
  console.error(
    "[pico] refusing to start: subagent nesting depth limit reached (PICO_SUBAGENT_DEPTH >= 3). " +
      "Subagents cannot spawn sub-subagents past 3 levels.",
  );
  process.exit(1);
}

// ── Brand layer for --version / --help ──────────────────────────────────
// Upstream prints its own "pi" brand and version; pico prefixes its own
// identity so users and scripts see a consistent product name/version.
function printBrandedVersion(): void {
  // 2.7.2: the upstream version is noise for normal users — plain "pico X";
  // `--verbose` adds the upstream detail for diagnostics.
  const picoVersion = (picoPkg as { version?: string }).version ?? "0.0.0";
  if (rawArgs.includes("--verbose")) {
    console.log(`pico ${picoVersion} (upstream pi ${UPSTREAM_VERSION})`);
  } else {
    console.log(`pico ${picoVersion}`);
  }
}

function printBrandedHelpHeader(): void {
  console.log(
    [
      `pico v${(picoPkg as { version?: string }).version ?? "?"} — vibe coding agent`,
      "",
      "pico 特有命令（交互内 /help 可看全部）：",
      "  pico setup       交互式初始化向导（模型/工具/安全/界面等）",
      "  /init            生成或审计 AGENTS.md（绝不写 CLAUDE.md）",
      "  /doctor          查看安全开关、能力边界与配置冲突",
      "  /help            离线命令与快捷键速查",
      "",
      "以下为上游 pi 的完整参数：",
      "",
    ].join("\n"),
  );
}

if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
  printBrandedVersion();
  process.exit(0);
}
// 2.2.4: `pico setup --help` shows the setup wizard's own help — the pico
// brand header would duplicate the pico-specific command list. Skip it.
if ((rawArgs.includes("--help") || rawArgs.includes("-h")) && !rawArgs.includes("setup")) {
  printBrandedHelpHeader();
}

// ── Missing prompt for -p/--print ───────────────────────────────────────
// `pico -p` / `pico --print` without a prompt used to exit 0 silently —
// scripts passing an empty argument got a no-op run with no diagnostic.
// Refuse loudly with a non-zero exit code instead.
import { missingPrintPrompt } from "../src/runtime/print-guard.ts";

const isHelpOrVersion =
  rawArgs.includes("--help") || rawArgs.includes("-h") || rawArgs.includes("--version") || rawArgs.includes("-v");
if (!isHelpOrVersion && missingPrintPrompt(rawArgs)) {
  console.error('pico: -p/--print 缺少提示词（例如 pico -p "你的需求"）。');
  process.exit(2);
}

// ── L25: materialize the bundled theme before pi's TUI init ─────────────
// pi's theme controller resolves the configured theme during TUI startup —
// before extension session_start events fire. A pristine home would
// otherwise fail its first launch with "Failed to load theme ... Theme not
// found: claude-code-dark" and fall back to dark. Pre-writing the bundled
// theme file (only when missing) makes the first launch resolve it; the
// retro-theme extension's own session_start sync keeps it fresh afterwards.
// Also lets --theme <name> resolve below (M2).
ensureBundledThemeFile();

const args = buildRuntimeArgs({
  rawArgs,
  entryMetaUrl: import.meta.url,
  isBunBinary,
  embeddedPromptsDir: embeddedDirs?.promptsDir,
  embeddedSkillsDir: embeddedDirs?.skillsDir,
});

const setupExitCode = await runSetupCommandIfRequested(rawArgs);
if (setupExitCode !== null) {
  const code = setupExitCode;
  process.exit(code);
}

// Override process.title so dev-mode runs show "pico" instead of "pi".
// In compiled-binary mode, this is handled by piConfig.name in build/package.json.
process.title = "pico";

// Clear the screen only for interactive TTY sessions. `--print`/`--mode
// rpc|json` consumers read stdout programmatically, and the brand layer just
// printed help above — a stray clear would destroy both.
const isNonTuiMode = rawArgs.some(isNonTuiArg);
if (process.stdout.isTTY && !isHelpOrVersion && !isNonTuiMode) {
  console.clear();
}

await main(args, {
  extensionFactories: createDefaultExtensionRegistry().factories(),
});
