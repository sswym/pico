#!/usr/bin/env bun
/**
 * srcode — vibe coding agent
 *
 * Thin wrapper over @earendil-works/pi-coding-agent's main(). We add three
 * extensions on top of the upstream defaults:
 *   - vibe        : appends our coding-style guidelines to the system prompt
 *   - memory      : SQLite-backed long-term memory + /memory command
 *   - subagent    : delegate tasks to scout/planner/worker/reviewer roles
 *
 * The subagent extension ships with bundled agent definitions and workflow
 * prompts under `src/extensions/subagent/{agents,prompts}/`. We auto-inject
 * the prompts directory via `--prompt-template` so users get the
 * `/implement`, `/scout-and-plan`, `/implement-and-review` workflows for
 * free without symlinking anything into `~/.pi/agent/`.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "@earendil-works/pi-coding-agent";
import { memoryExtension } from "../src/extensions/memory/index.ts";
import subagentExtension from "../src/extensions/subagent/index.ts";
import { vibeExtension } from "../src/extensions/vibe.ts";

/**
 * Inject `--prompt-template <bundled-prompts-dir>` so srcode's workflow
 * presets are discoverable as slash commands. Skip if the user passed
 * `--no-prompt-templates` (or `-np`), or if they already pointed at our
 * directory explicitly.
 */
function withBundledPromptTemplates(rawArgs: string[]): string[] {
  if (rawArgs.includes("--no-prompt-templates") || rawArgs.includes("-np")) return rawArgs;

  const here = dirname(fileURLToPath(import.meta.url));
  const promptsDir = resolve(here, "..", "src", "extensions", "subagent", "prompts");
  if (!existsSync(promptsDir)) return rawArgs;

  // Avoid double-adding if the user already passed the same path.
  for (let i = 0; i < rawArgs.length - 1; i++) {
    if (rawArgs[i] === "--prompt-template" && resolve(rawArgs[i + 1]!) === promptsDir) {
      return rawArgs;
    }
  }
  return [...rawArgs, "--prompt-template", promptsDir];
}

const args = withBundledPromptTemplates(process.argv.slice(2));

await main(args, {
  extensionFactories: [vibeExtension, memoryExtension, subagentExtension],
});
