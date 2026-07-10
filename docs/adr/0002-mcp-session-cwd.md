# ADR 0002: Load MCP Configuration From Session CWD

## Status

Accepted

## Context

MCP server configuration has both user-level and project-level layers. The
project layer lives at `<cwd>/.srcode/mcp-servers.json`, so the active working
directory determines which servers should be connected.

The original MCP extension connected during extension initialization and used
`process.cwd()`. That made project configuration depend on the wrapper process
startup directory rather than the session context.

## Decision

MCP connection now happens on `session_start`, using `ctx.cwd`. The extension is
constructed through `createMcpExtension`, which accepts loader/client adapters
for tests and uses the real MCP stdio client in production.

## Consequences

- Project MCP servers are resolved from the actual session working directory.
- MCP connection behaviour is testable without spawning real servers.
- Tools are registered after session startup rather than during extension
  factory initialization.

