# srcode

> A vibe-coding agent built on the [@earendil-works](https://www.npmjs.com/org/earendil-works) Pi stack — `pi-coding-agent` for the CLI shell, `pi-agent-core` for the runtime, `pi-ai` for the unified provider layer, and `pi-tui` for the terminal UI. srcode adds three things on top: a **long-term memory** extension, a **subagent** extension, and a **vibe-coding system prompt**.

## Install / run

```bash
bun install
bun run bin/srcode.ts            # interactive TUI
bun run bin/srcode.ts -p "fix the failing test in foo.test.ts"
bun run bin/srcode.ts --help     # all upstream flags
```

After `bun link` (or once published), the `srcode` binary is on `$PATH`.

## What you get from upstream (free)

- Streaming chat TUI with a session selector, model picker (`Ctrl+P`), and context-usage footer.
- Built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` tools.
- `/compact` summarisation, session forking, project-trust prompts.
- Multi-provider (Anthropic, OpenAI, Google, Mistral, …) via `pi-ai`.

## What srcode adds

### 1. Long-term memory (`memory` tool + `/memory` command)

Backed by a single SQLite file at `~/.config/srcode/memory.db` (override with `$SRCODE_MEMORY_DB`). Schema is a slim port of hermes-agent's holographic store at `~/hermes-agent/plugins/memory/holographic/` — facts with `category`, `tags`, `trust_score`, FTS5 mirror — minus the HRR layer (planned for v2).

The model can call:

| action | required args | purpose |
| --- | --- | --- |
| `add` | `content`, `category` | store a durable fact |
| `search` | `query` | FTS lookup, ranked by trust × bm25 |
| `probe` | `entity` | phrase search around an entity name |
| `list` | — | enumerate facts |
| `update` | `fact_id` | edit content/category/tags |
| `remove` | `fact_id` | delete |
| `feedback` | `fact_id`, `helpful` | trust ±0.05 / ±0.10 |

You can also drive it directly:

```text
/memory list
/memory search bun
/memory add user_pref I prefer terse output
/memory remove 4
/memory clear
```

A short header is appended to the system prompt every turn, plus a `## Recalled memory` block when the user message hits stored facts. After each turn, simple regex patterns in `src/extensions/memory/extract.ts` skim user messages for "I prefer …" / "we decided …" lines and persist them automatically.

### 2. Subagents (`subagent` tool + workflow slash commands)

Vendored from `pi-coding-agent`'s example extension and bundled with four roles plus three workflow presets, all available without symlinking anything into `~/.pi/agent/`.

**Built-in roles** (`src/extensions/subagent/agents/*.md`):

| Role | Purpose | Tools |
|---|---|---|
| `scout` | Fast codebase recon, returns compressed context | read, grep, find, ls, bash, **memory** |
| `planner` | Turns context + requirement into a step-by-step plan | read, grep, find, ls, **memory** |
| `worker` | Implements a plan end-to-end | full set incl. **memory** |
| `reviewer` | Read-only quality / security review | read, grep, find, ls, bash, **memory** |

Each role's prompt instructs it to consult `memory(action="search", ...)` before acting and to add durable findings back, so subagent runs share project context with the main session instead of starting blind.

**Modes**:

```ts
// single
subagent(agent="scout", task="...")

// parallel — N agents at once, max 8 / concurrency 4
subagent(tasks=[{agent: "scout", task: "..."}, {agent: "scout", task: "..."}])

// chain — output of step N feeds into {previous} of step N+1
subagent(chain=[
  { agent: "scout",   task: "Find auth code for: $@" },
  { agent: "planner", task: "Plan changes given: {previous}" },
  { agent: "worker",  task: "Implement: {previous}" },
])
```

**Workflow slash commands** (auto-loaded from `src/extensions/subagent/prompts/`):

```text
/implement <goal>             scout → planner → worker
/scout-and-plan <goal>        scout → planner (no implementation)
/implement-and-review <goal>  worker → reviewer → worker
```

Each subagent runs in a separate `pi` process with its own context window, so the main conversation isn't polluted by recon noise. Ctrl+C propagates to kill children.

**Project-local agents.** If you have `.pi/agents/*.md` in the project root and pass `agentScope: "both"`, those override the bundled roles by name. The tool prompts for confirmation before invoking project agents (configurable via `confirmProjectAgents`).

### 3. Vibe-coding system prompt

`src/prompts/vibe-system.md` is appended to every system prompt. It encodes four rules: *think first, simplest thing that works, surgical edits, goal-driven execution* — distilled from `~/.claude/CLAUDE.md`. The aim is for srcode to ask before guessing, not refactor adjacent code, and trace every diff back to a stated requirement.

## Layout

```
srcode/
├── bin/srcode.ts                       # main(args, { extensionFactories: [...] }) + injects --prompt-template
├── src/
│   ├── extensions/
│   │   ├── memory/
│   │   │   ├── index.ts                # ExtensionFactory: tool + /memory + hooks
│   │   │   ├── store.ts                # MemoryStore (bun:sqlite + FTS5)
│   │   │   ├── schema.ts               # SQL DDL + constants
│   │   │   ├── prompt.ts               # system-prompt + recall renderers
│   │   │   └── extract.ts              # regex auto-extractor
│   │   ├── subagent/                   # vendored from pi-coding-agent examples
│   │   │   ├── index.ts                # subagent tool (single / parallel / chain)
│   │   │   ├── agents.ts               # discoverAgents — bundled + user + project
│   │   │   ├── agents/                 # scout / planner / worker / reviewer (.md)
│   │   │   └── prompts/                # implement / scout-and-plan / implement-and-review
│   │   └── vibe.ts                     # appends vibe-system.md to system prompt
│   ├── prompts/vibe-system.md          # behaviour contract
│   └── types/markdown.d.ts             # `import x from "*.md" with { type: "text" }`
└── tests/
    ├── memory.test.ts                  # 9 cases — add/search/feedback/update/remove/probe/clear/extract
    └── subagent.test.ts                # 3 cases — factory wiring, agent discovery, worker prompt
```

## Tests

```bash
bun test
```

12 cases. Memory tests are fully offline; subagent tests verify wiring + bundled-agent discovery without spawning real `pi` subprocesses.

## Roadmap

- v2 memory: HRR phase encoding (port `holographic.py` to TS) for entity reasoning + contradiction detection.
- A `/vibe` slash command to toggle the system-prompt block on the fly.
- Skill packaging: ship `vibe-system.md` as a Pi skill so it can be enabled without forking.
- Subagent: option to share a single SQLite WAL with the main session so children's `memory(add)` is visible immediately (today, FTS reads pick it up between turns since each subprocess opens the same file).
