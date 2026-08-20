/**
 * MCP (Model Context Protocol) type definitions.
 *
 * JSON-RPC 2.0 over stdio transport, compatible with the MCP specification
 * used by Claude Code.
 *
 * Protocol version: 2024-11-05
 */

// ─── Config types ──────────────────────────────────────────────────────────

export interface McpStdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig;

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

// ─── MCP Initialize ────────────────────────────────────────────────────────

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version: string };
}

// ─── MCP Tools ─────────────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

// ─── MCP Tool Call ─────────────────────────────────────────────────────────

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface McpResourceContent {
  type: "resource";
  resource: { text?: string; blob?: string; uri: string; mimeType?: string };
}

export type McpContent = McpTextContent | McpImageContent | McpResourceContent;

export interface McpToolCallResult {
  content: McpContent[];
  isError?: boolean;
}

// ─── Runtime handle ────────────────────────────────────────────────────────

export interface McpServerHandle {
  /** Unique server identifier (from config key). */
  id: string;
  /** The spawned subprocess. */
  proc: {
    pid?: number;
    stdin: {
      write(data: string | Uint8Array): number;
      /** Flush buffered writes to the child process (Bun FileSink). */
      flush?(): void;
      end(data?: string | Uint8Array): number | Promise<number>;
    };
    kill(signal?: number): void;
    exited: Promise<number>;
  };
  /** Server metadata returned from initialize. */
  serverInfo?: { name: string; version: string };
  /** Next JSON-RPC request id. */
  nextId: number;
  /** Pending request resolvers, keyed by request id. */
  pending: Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  /** Accumulated stdout buffer for line processing. */
  buffer: string;
  /** Recent stderr / protocol diagnostics, shown by /mcp instead of printed into the TUI. */
  diagnostics?: string[];
}
