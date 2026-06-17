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
 * The subagent extension ships with bundled agent definitions and workflow
 * prompts under `src/extensions/subagent/{agents,prompts}/`. We auto-inject
 * the prompts directory via `--prompt-template` so users get the
 * `/implement`, `/scout-and-plan`, `/implement-and-review` workflows for
 * free without symlinking anything into `~/.srcode/agent/`.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// MUST be the first import — sets PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR
// before pi-coding-agent's config module evaluates them at top level.
import "./env-bootstrap.ts";

import { main } from "@earendil-works/pi-coding-agent";
import { askExtension } from "../src/extensions/ask/index.ts";
import { initExtension } from "../src/extensions/init/index.ts";
import { logoExtension } from "../src/extensions/logo/index.ts";
import { memoryExtension } from "../src/extensions/memory/index.ts";
import { permissionsExtension } from "../src/extensions/permissions/index.ts";
import { planExtension } from "../src/extensions/plan/index.ts";
import subagentExtension from "../src/extensions/subagent/index.ts";
import { todoExtension } from "../src/extensions/todo/index.ts";
import { vibeExtension } from "../src/extensions/vibe.ts";
import { webExtension } from "../src/extensions/web/index.ts";
import { hooksExtension } from "../src/extensions/hooks/index.ts";

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN".
 */
const IS_BUN_BINARY =
  import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/**
 * Inject `--prompt-template <bundled-prompts-dir>` so srcode's workflow
 * presets are discoverable as slash commands. Skip if the user passed
 * `--no-prompt-templates` (or `-np`), or if they already pointed at our
 * directory explicitly.
 *
 * In bun-binary mode, resolves prompts/ relative to the executable.
 */
const PACKAGE_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config"]);

function withBundledPromptTemplates(rawArgs: string[]): string[] {
  if (rawArgs.includes("--no-prompt-templates") || rawArgs.includes("-np")) return rawArgs;
  // Package-management commands don't accept global flags like --prompt-template.
  if (rawArgs.length > 0 && PACKAGE_COMMANDS.has(rawArgs[0]!)) return rawArgs;

  const here = IS_BUN_BINARY
    ? dirname(process.execPath)
    : dirname(fileURLToPath(import.meta.url));
  const promptsDir = IS_BUN_BINARY
    ? resolve(here, "prompts")
    : resolve(here, "..", "src", "extensions", "subagent", "prompts");
  if (!existsSync(promptsDir)) return rawArgs;

  // Avoid double-adding if the user already passed the same path.
  for (let i = 0; i < rawArgs.length - 1; i++) {
    if (rawArgs[i] === "--prompt-template" && resolve(rawArgs[i + 1]!) === promptsDir) {
      return rawArgs;
    }
  }
  return [...rawArgs, "--prompt-template", promptsDir];
}

/**
 * Inject `--skill <bundled-skills-dir>` so srcode's bundled skills
 * (verify, recap, agents-init) show up in the system prompt without
 * users having to symlink them into `~/.srcode/agent/skills/`. Skip if the
 * user passed `--no-skills` (or `-ns`), or if they already pointed at
 * our directory explicitly.
 *
 * In bun-binary mode, resolves skills/ relative to the executable.
 */
function withBundledSkills(rawArgs: string[]): string[] {
  if (rawArgs.includes("--no-skills") || rawArgs.includes("-ns")) return rawArgs;
  // Package-management commands don't accept global flags like --skill.
  if (rawArgs.length > 0 && PACKAGE_COMMANDS.has(rawArgs[0]!)) return rawArgs;

  const here = IS_BUN_BINARY
    ? dirname(process.execPath)
    : dirname(fileURLToPath(import.meta.url));
  const skillsDir = IS_BUN_BINARY
    ? resolve(here, "skills")
    : resolve(here, "..", "src", "skills");
  if (!existsSync(skillsDir)) return rawArgs;

  // Avoid double-adding if the user already passed the same path.
  for (let i = 0; i < rawArgs.length - 1; i++) {
    if (rawArgs[i] === "--skill" && resolve(rawArgs[i + 1]!) === skillsDir) {
      return rawArgs;
    }
  }
  return [...rawArgs, "--skill", skillsDir];
}

const args = withBundledSkills(withBundledPromptTemplates(process.argv.slice(2)));

// Override process.title so dev-mode runs show "srcode" instead of "pi".
// In compiled-binary mode, this is handled by piConfig.name in build/package.json.
process.title = "srcode";

await main(args, {
  extensionFactories: [
    vibeExtension,
    logoExtension,
    memoryExtension,
    subagentExtension,
    todoExtension,
    askExtension,
    initExtension,
    planExtension,
    webExtension,
    permissionsExtension,
    hooksExtension,
  ],
});
