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
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// MUST be the first import — sets PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR
// before pi-coding-agent's config module evaluates them at top level.
import "./env-bootstrap.ts";

import { main } from "@earendil-works/pi-coding-agent";
import { askExtension } from "../src/extensions/ask/index.ts";
import { initExtension } from "../src/extensions/init/index.ts";
import { logoExtension } from "../src/extensions/logo/index.ts";
import { memoryExtension } from "../src/extensions/memory/index.ts";
import { planExtension } from "../src/extensions/plan/index.ts";
import subagentExtension from "../src/extensions/subagent/index.ts";
import { todoExtension } from "../src/extensions/todo/index.ts";
import { languageExtension } from "../src/extensions/language.ts";
import { vibeExtension } from "../src/extensions/vibe.ts";
import { omaExtension } from "../src/extensions/oma.ts";
import { webExtension } from "../src/extensions/web/index.ts";
import lspExtension from "../src/extensions/lsp/index.ts";
import { hooksExtension } from "../src/extensions/hooks/index.ts";
import { mcpExtension } from "../src/extensions/mcp/index.ts";
import { getEmbeddedContent, getEmbeddedKeys } from "../src/extensions/embedded-assets.ts";

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN".
 */
const IS_BUN_BINARY =
  import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/**
 * If embedded assets are available (compiled-binary mode), extract them to a
 * temp directory so pi-coding-agent can find them via its normal file-system
 * resolution. Sets PI_PACKAGE_DIR so theme/export-html/assets resolve there.
 *
 * Returns { promptsDir, skillsDir } paths for slash-command and skill
 * injection, or null if not in embedded mode.
 */
function prepareEmbeddedRuntime(): { promptsDir: string; skillsDir: string } | null {
  // Only extract embedded assets when running as a compiled binary.
  // In source mode, node_modules provides everything — stale generated
  // files from a previous build must not trigger temp-dir extraction.
  if (!IS_BUN_BINARY) return null;
  const allKeys = getEmbeddedKeys("");
  if (allKeys.length === 0) return null;

  // Create a temp directory to host all extracted assets
  const tmpDir = resolve(tmpdir(), `srcode-${randomBytes(6).toString("hex")}`);
  mkdirSync(tmpDir, { recursive: true });

  // Register cleanup on exit
  const cleanup = () => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  // Extract each embedded asset to the temp directory
  for (const key of allKeys) {
    const content = getEmbeddedContent(key);
    if (content === null) continue;

    const filePath = resolve(tmpDir, key);
    mkdirSync(dirname(filePath), { recursive: true });

    // Binary assets (e.g. PNG) are base64-encoded
    if (key.startsWith("assets/") && !key.endsWith(".json")) {
      writeFileSync(filePath, Buffer.from(content, "base64"));
    } else {
      writeFileSync(filePath, content, "utf-8");
    }
  }

  // Tell pi-coding-agent where to find theme/export-html/assets
  process.env.PI_PACKAGE_DIR = tmpDir;

  return {
    promptsDir: resolve(tmpDir, "prompts"),
    skillsDir: resolve(tmpDir, "skills"),
  };
}

/**
 * Inject `--prompt-template <bundled-prompts-dir>` so srcode's workflow
 * presets are discoverable as slash commands. Skip if the user passed
 * `--no-prompt-templates` (or `-np`), or if they already pointed at our
 * directory explicitly.
 *
 * In bun-binary mode, resolves prompts/ relative to the executable.
 */
const PACKAGE_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config"]);

function withBundledPromptTemplates(rawArgs: string[], embeddedPromptsDir?: string): string[] {
  if (rawArgs.includes("--no-prompt-templates") || rawArgs.includes("-np")) return rawArgs;
  // Package-management commands don't accept global flags like --prompt-template.
  if (rawArgs.length > 0 && PACKAGE_COMMANDS.has(rawArgs[0]!)) return rawArgs;

  // In embedded mode, prompts were extracted to a temp directory
  const promptsDir = embeddedPromptsDir ?? (
    IS_BUN_BINARY
      ? resolve(dirname(process.execPath), "prompts")
      : resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "extensions", "subagent", "prompts")
  );
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
function withBundledSkills(rawArgs: string[], embeddedSkillsDir?: string): string[] {
  if (rawArgs.includes("--no-skills") || rawArgs.includes("-ns")) return rawArgs;
  // Package-management commands don't accept global flags like --skill.
  if (rawArgs.length > 0 && PACKAGE_COMMANDS.has(rawArgs[0]!)) return rawArgs;

  // In embedded mode, skills were extracted to a temp directory
  const skillsDir = embeddedSkillsDir ?? (
    IS_BUN_BINARY
      ? resolve(dirname(process.execPath), "skills")
      : resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "skills")
  );
  if (!existsSync(skillsDir)) return rawArgs;

  // Avoid double-adding if the user already passed the same path.
  for (let i = 0; i < rawArgs.length - 1; i++) {
    if (rawArgs[i] === "--skill" && resolve(rawArgs[i + 1]!) === skillsDir) {
      return rawArgs;
    }
  }
  return [...rawArgs, "--skill", skillsDir];
}

// --- Extract embedded assets (compiled-binary mode only) ---
const embeddedDirs = prepareEmbeddedRuntime();

const args = withBundledSkills(
  withBundledPromptTemplates(process.argv.slice(2), embeddedDirs?.promptsDir),
  embeddedDirs?.skillsDir,
);

// Override process.title so dev-mode runs show "srcode" instead of "pi".
// In compiled-binary mode, this is handled by piConfig.name in build/package.json.
process.title = "srcode";

console.clear();

await main(args, {
  extensionFactories: [
    vibeExtension,
    omaExtension,
    languageExtension,
    logoExtension,
    memoryExtension,
    subagentExtension,
    todoExtension,
    askExtension,
    initExtension,
    planExtension,
    webExtension,
    lspExtension,
    hooksExtension,
    mcpExtension,
  ],
});
