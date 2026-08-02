# pico Context

pico is a thin wrapper over `@earendil-works/pi-coding-agent`. The upstream
agent owns the core loop, tool runtime, sessions, TUI, model providers, and
default tools. pico adds behaviour through ExtensionFactory modules.

## Domain Terms

- ExtensionFactory: a module-level factory that receives `ExtensionAPI` and
  registers tools, commands, or lifecycle event handlers.
- Extension: one pico capability package under `src/extensions/`, such as
  memory, subagent, web, lsp, hooks, mcp, plan, ask, or todo.
- Lifecycle event: pi event hooks used by extensions, including
  `before_agent_start`, `session_start`, `tool_call`, `tool_result`,
  `turn_end`, `agent_end`, and `session_shutdown`.
- Tool adapter: the thin layer that maps a pi tool call to an implementation
  module and formats the tool result.
- Session state: state scoped to one pico process/session, usually held in
  the extension closure unless a module needs explicit state objects for tests.
- Project scope: data or configuration tied to the current working directory,
  such as project memory facts, project MCP servers, and project LSP config.

## Architectural Preferences

- Keep pico as a wrapper. Prefer extending through ExtensionFactory modules
  instead of importing across extensions or patching upstream internals.
- Put behaviour behind testable modules. The pi registration file should be a
  shallow adapter; core routing, parsing, state machines, and formatting should
  live behind smaller interfaces.
- Use dependency injection for side-effect adapters. Hooks already follows this
  pattern with `createHooksExtension`; MCP now follows it with
  `createMcpExtension`.
- Treat project-scoped behaviour as session-cwd dependent. Use `ctx.cwd` from
  lifecycle events instead of `process.cwd()` when project config or memory
  scope matters.
- Keep read-only and write-capable tools separate when permissions depend on
  the distinction.
- Use `src/extensions/events.ts` for lightweight cross-extension notifications
  instead of importing one extension from another.

## Refactoring Notes

- `src/extensions/subagent/index.ts`: mode adapter for single, parallel, and
  chain subagent runs. It no longer uses `@ts-nocheck`. The pi tool adapter is
  intentionally shallow; execution orchestration now lives in
  `src/extensions/subagent/orchestrator.ts`. Pure seams for concurrency,
  session forking, and result/display helpers have been extracted under
  `src/extensions/subagent/`.
  TUI rendering has also been extracted to `src/extensions/subagent/renderer.ts`.
  JSON-mode runner event reduction has been extracted to
  `src/extensions/subagent/runner.ts`. Chain task construction now lives in
  `src/extensions/subagent/chain.ts`, and parallel placeholders/progress/summary
  formatting lives in `src/extensions/subagent/parallel.ts`. Provider-failure
  fallback classification lives in `src/extensions/subagent/fallback.ts`, and
  large file-only output spilling lives in `src/extensions/subagent/output.ts`.
  Git worktree setup, cleanup, and merge-note generation live in
  `src/extensions/subagent/worktree.ts`. Acceptance gate failure summaries,
  repair task construction, and gate-failed result annotation live in
  `src/extensions/subagent/gates.ts`. Fallback retry orchestration lives in
  `src/extensions/subagent/fallback.ts`. Process argument building, JSON stdout
  parsing, stderr capture, timeout/abort tracking, and exit annotation live in
  `src/extensions/subagent/process.ts`. Self-repair orchestration lives in
  `src/extensions/subagent/gates.ts`.
- `src/extensions/lsp/index.ts`: tool registration and lifecycle adapter for
  the LSP extension. Pure action helpers have been extracted to
  `src/extensions/lsp/actions.ts`; shared action constants, result helpers,
  risk classification, status/capabilities/request actions, workspace
  diagnostics formatting, and symbol result formatting live in
  `src/extensions/lsp/executor.ts`. File mutation actions intentionally remain
  blocked by ADR-0001 until a separate write permission tier exists. Relative
  document paths are resolved from session `ctx.cwd`, not `process.cwd()`.
- `src/extensions/memory/retrieval.ts`: hybrid retrieval shares the same
  project-scope semantics as `MemoryStore.search`: project queries see global
  plus current-project facts and exclude other project facts.
- `src/extensions/memory/index.ts`: pi registration adapter only. The `memory`
  tool routes through `src/extensions/memory/tool.ts`, and the `/memory` slash
  command routes through `src/extensions/memory/command.ts`. Command side
  effects (`notify`, `confirm`) are injected via `MemoryCommandDeps` so the
  whole subcommand surface is testable without a live ExtensionAPI.
