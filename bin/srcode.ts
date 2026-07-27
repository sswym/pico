#!/usr/bin/env bun
/**
 * srcode — vibe coding agent
 *
 * Thin wrapper over @earendil-works/pi-coding-agent's main(). We add a
 * stack of extensions on top of the upstream defaults:
 *   - vibe        : appends our coding-style guidelines to the system prompt
 *   - logo        : replaces the built-in TUI header with srcode's ASCII logo
 *   - memory      : SQLite-backed long-term memory + /memory command
 *   - subagent    : delegate tasks to scout/planner/worker/reviewer roles
 *   - todo        : session task checklist (todoWrite tool + /todo command)
 *   - hooks       : file-driven Pre/PostToolUse hooks (registered last so it
 *                   observes the final tool surface other extensions assemble)
 *
 * srcode ships bundled agent definitions and workflow prompts under
 * `src/prompts/`. We auto-inject the prompts directory via
 * `--prompt-template` so users get the
 * `/implement`, `/scout-and-plan`, `/implement-and-review` workflows for
 * free without symlinking anything into `~/.srcode/agent/`.
 */
// MUST be the first import — sets PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR
// before pi-coding-agent's config module evaluates them at top level.
import "./env-bootstrap.ts";

import { main } from "@earendil-works/pi-coding-agent";
import { buildRuntimeArgs } from "../src/runtime/args.ts";
import { isBunBinaryRuntime, prepareEmbeddedRuntime } from "../src/runtime/embedded-runtime.ts";
import { createDefaultExtensionRegistry } from "../src/runtime/extensions.ts";
import { runSetupCommandIfRequested } from "../src/runtime/setup.ts";

// --- Extract embedded assets (compiled-binary mode only) ---
const isBunBinary = isBunBinaryRuntime(import.meta.url);
const embeddedDirs = prepareEmbeddedRuntime(isBunBinary);
const rawArgs = process.argv.slice(2);

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

// Override process.title so dev-mode runs show "srcode" instead of "pi".
// In compiled-binary mode, this is handled by piConfig.name in build/package.json.
process.title = "srcode";

console.clear();

await main(args, {
  extensionFactories: createDefaultExtensionRegistry().factories(),
});
