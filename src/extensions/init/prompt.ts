/**
 * /init prompt for srcode.
 *
 * Adapted from claude-code's NEW_INIT_PROMPT (~/claude_claw/claude-code/src/commands/init.ts).
 * The shape is the same — multi-phase guided AGENTS.md authoring — with these
 * srcode-specific changes:
 *
 *   • CLAUDE.md  → AGENTS.md
 *   • CLAUDE.local.md → AGENTS.local.md
 *   • Claude Code → srcode (in user-facing references)
 *   • .claude/rules/ → .srcode/rules/ (noted as v0.3 — not yet wired up)
 *   • AskUserQuestion tool name lower-cased to `askUserQuestion` (srcode's tool)
 *   • Closing line forbids writing CLAUDE.md so we don't get auto-overrides on
 *     repos where users have switched preference to AGENTS.md
 */
export const INIT_PROMPT = `Set up a minimal AGENTS.md (and optionally skills and hooks) for this repo. AGENTS.md is loaded into every srcode session, so it must be concise — only include what srcode would get wrong without it.

## Phase 1: Ask what to set up

Use the askUserQuestion tool to find out what the user wants:

- "Which AGENTS.md files should /init set up?"
  Options: "Project AGENTS.md" | "Personal AGENTS.local.md" | "Both project + personal"
  Description for project: "Team-shared instructions checked into source control — architecture, coding standards, common workflows."
  Description for personal: "Your private preferences for this project (gitignored, not shared) — your role, sandbox URLs, preferred test data, workflow quirks."

- "Also set up skills and hooks?"
  Options: "Skills + hooks" | "Skills only" | "Hooks only" | "Neither, just AGENTS.md"
  Description for skills: "On-demand capabilities you or srcode invoke with \`/skill-name\` — good for repeatable workflows and reference knowledge."
  Description for hooks: "Deterministic shell commands that run on tool events (e.g., format after every edit). srcode can't skip them. Note: srcode hooks live at ~/.srcode/hooks.json or .srcode/hooks.json."

## Phase 2: Explore the codebase

Launch a subagent (e.g. scout) to survey the codebase: manifest files (package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml, etc.), README, Makefile/build configs, CI config, existing AGENTS.md / CLAUDE.md, .cursor/rules or .cursorrules, .github/copilot-instructions.md, .windsurfrules, .clinerules.

Detect:
- Build, test, and lint commands (especially non-standard ones)
- Languages, frameworks, and package manager
- Project structure (monorepo with workspaces, multi-module, or single project)
- Code style rules that differ from language defaults
- Non-obvious gotchas, required env vars, or workflow quirks
- Existing .srcode/ directory contents
- Formatter configuration (prettier, biome, ruff, black, gofmt, rustfmt, or a unified format script like \`npm run format\` / \`make fmt\`)
- Git worktree usage: run \`git worktree list\` to check if this repo has multiple worktrees (only relevant if the user wants a personal AGENTS.local.md)

Note what you could NOT figure out from code alone — these become interview questions.

## Phase 3: Fill in the gaps

Use askUserQuestion to gather what you still need to write good AGENTS.md files and skills. Ask only things the code can't answer.

If the user chose project AGENTS.md or both: ask about codebase practices — non-obvious commands, gotchas, branch/PR conventions, required env setup, testing quirks. Skip things already in README or obvious from manifest files. Do not mark any options as "recommended" — this is about how their team works, not best practices.

If the user chose personal AGENTS.local.md or both: ask about them, not the codebase. Examples:
  - What's their role on the team?
  - How familiar are they with this codebase and its languages/frameworks?
  - Personal sandbox URLs, test accounts, API key paths, or local setup details srcode should know?
  - Communication preferences? (e.g. "be terse", "always explain tradeoffs")

**Synthesize a proposal from Phase 2 findings** — e.g., format-on-edit if a formatter exists, a \`/verify\` skill if tests exist, an AGENTS.md note for guidelines vs workflows. For each, pick the artifact type that fits, **constrained by the Phase 1 skills+hooks choice**:

  - **Hook** (stricter) — deterministic shell command on a tool event; srcode can't skip it. Fits mechanical, fast, per-edit steps: formatting, linting, running a quick test on the changed file.
  - **Skill** (on-demand) — you or srcode invoke \`/skill-name\` when you want it. Fits workflows that don't belong on every edit: deep verification, session reports, deploys.
  - **AGENTS.md note** (looser) — influences srcode's behaviour but not enforced. Fits communication/thinking preferences: "plan before coding", "be terse", "explain tradeoffs".

  Respect Phase 1's choice as a hard filter: "Skills only" downgrades hooks to skills/notes, "Neither" downgrades everything to AGENTS.md notes.

## Phase 4: Write AGENTS.md (if user chose project or both)

Write a minimal AGENTS.md at the project root. Every line must pass: "Would removing this cause srcode to make mistakes?" If no, cut it.

Include:
- Build/test/lint commands srcode can't guess (non-standard scripts, flags, sequences)
- Code style rules that DIFFER from language defaults
- Testing instructions and quirks
- Repo etiquette (branch naming, PR conventions, commit style)
- Required env vars or setup steps
- Non-obvious gotchas or architectural decisions
- Important parts from existing AI tool configs if they exist (.cursor/rules, .cursorrules, .github/copilot-instructions.md, .windsurfrules, .clinerules)

Exclude:
- File-by-file structure or component lists (srcode discovers these via read/grep)
- Standard language conventions
- Generic advice
- Long references — keep AGENTS.md concise; deeper material lives in skills

Be specific: "Use 2-space indentation in TypeScript" beats "Format code properly."

Do not repeat yourself or invent sections — only include information you actually found in files.

Prefix the file with:

\`\`\`
# AGENTS.md

This file provides guidance to srcode when working with code in this repository.
\`\`\`

If AGENTS.md already exists: read it, propose specific diffs, and explain why each change improves it. Do not silently overwrite.

For projects with distinct subdirectories (monorepos, multi-module): mention that subdirectory AGENTS.md files can be added for module-specific instructions.

## Phase 5: Write AGENTS.local.md (if user chose personal or both)

Write a minimal AGENTS.local.md at the project root. After creating it, add \`AGENTS.local.md\` to the project's .gitignore so it stays private.

Include:
- The user's role and familiarity with the codebase
- Personal sandbox URLs, test accounts, or local setup details
- Personal workflow or communication preferences

Keep it short — only include what would make srcode's responses noticeably better for this user.

If AGENTS.local.md already exists: read it, propose specific additions, and do not silently overwrite.

## Phase 6: Suggest and create skills (if user chose "Skills + hooks" or "Skills only")

Skills add capabilities srcode can use on demand without bloating every session. srcode already ships with \`verify\`, \`recap\`, and \`agents-init\` — review them first, then propose project-specific additions.

Create each new skill at \`.srcode/skills/<skill-name>/SKILL.md\` (this directory is loaded automatically when present):

\`\`\`yaml
---
name: <skill-name>
description: <what the skill does and when to use it>
---

<Instructions for srcode>
\`\`\`

For workflows with side effects (e.g., \`/deploy\`, \`/release\`), add \`disable-model-invocation: true\` so only the user can trigger it.

## Phase 7: Suggest hooks (if user chose "Skills + hooks" or "Hooks only")

srcode hooks are JSON entries at \`~/.srcode/hooks.json\` (user-level) or \`.srcode/hooks.json\` (project-level). Each entry:

\`\`\`json
{
  "event": "PreToolUse" | "PostToolUse" | "PreSessionEnd" | "PostUserMessage",
  "tool": "edit",
  "command": "biome format $FILE",
  "timeoutMs": 30000,
  "blocking": true
}
\`\`\`

Placeholders: \`$FILE\` (from the tool's file_path/path arg), \`$TOOL\` (tool name), \`$TURN\` (turn index).

If Phase 2 found a formatter, suggest a \`PostToolUse\` hook for \`edit\`/\`write\` invoking it. Walk the user through writing the JSON before saving.

## Phase 8: Summary and next steps

Recap what was set up — which files were written and the key points in each. Remind the user these files are a starting point and \`/init\` can be re-run any time to rescan.

If you found gaps that the user said no to (no GitHub CLI, no linter), list them with a one-line reason why each helps.

---

**Hard rule for srcode**: This project uses AGENTS.md, never CLAUDE.md. Do NOT write a CLAUDE.md file in this repo.
`;
