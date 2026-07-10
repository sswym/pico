# ADR 0001: Block LSP Write Actions Until They Have a Separate Permission Tier

## Status

Accepted

## Context

The `lsp` tool includes both read-only actions and actions that can mutate files
or language-server state. Read-only actions include hover, definition,
references, diagnostics, symbols, capabilities, and status. Write or high-risk
actions include rename, rename_file, code_actions with `apply=true`, reload, and
raw request.

The permission model and README historically described `lsp` as low-risk
read-only. That made the interface misleading because a caller could use the
same tool name for file-changing actions.

## Decision

For now, `lsp` read-only actions are allowed to proceed, while write or
high-risk actions are blocked in the `tool_call` handler. The block message
directs callers to use explicit edit/write tools until LSP write capabilities
are split into a separate permission tier.

## Consequences

- The tool behaviour now matches the stated read-only permission posture.
- Cross-file LSP rename and code action application are temporarily unavailable
  through `lsp`.
- The next design step is to split write-capable actions into a separate tool
  or permission interface, then re-enable them with explicit approval semantics.

