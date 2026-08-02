/**
 * MCP stdio client — spawns a subprocess, speaks JSON-RPC 2.0 line-delimited.
 *
 * Lifecycle per server:
 *   spawn() → initialize() → [listTools() / callTool()] → close()
 *
 * Each server gets its own subprocess. stdout is read line-by-line; complete
 * JSON-RPC responses are dispatched to the pending request map. Notifications
 * (responses with no id) are silently dropped.
 */
import type {
  McpServerConfig,
  McpServerHandle,
  McpInitializeResult,
  McpTool,
  McpToolCallResult,
} from "./types.ts";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const CLIENT_NAME = "pico";
const CLIENT_VERSION = "0.1.0";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTIC_LINES = 20;

function appendDiagnostic(handle: McpServerHandle, line: string): void {
  const text = line.trim();
  if (!text) return;
  const diagnostics = handle.diagnostics ?? [];
  diagnostics.push(text);
  if (diagnostics.length > MAX_DIAGNOSTIC_LINES) {
    diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTIC_LINES);
  }
  handle.diagnostics = diagnostics;
}

/**
 * Spawn an MCP server subprocess.
 * The subprocess is ready to accept JSON-RPC messages (caller must `initialize`
 * before listing or calling tools).
 */
export function spawnMcpServer(id: string, config: McpServerConfig): McpServerHandle {
  const proc = Bun.spawn([config.command, ...(config.args ?? [])], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...config.env },
  });

  // stdin is FileSink when piped
  const stdin = proc.stdin as unknown as McpServerHandle["proc"]["stdin"];

  const handle: McpServerHandle = {
    id,
    proc: {
      stdin,
      kill: (signal?: number) => proc.kill(signal),
      exited: proc.exited,
    },
    nextId: 1,
    pending: new Map(),
    buffer: "",
    diagnostics: [],
  };

  // Wire up stdout reader — accumulate lines, dispatch complete JSON-RPC responses
  const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  (async () => {
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        handle.buffer += decoder.decode(value, { stream: true });
        processBuffer(handle);
      }
      // Flush remaining buffer on stream end
      if (handle.buffer.length > 0) {
        processBuffer(handle);
      }
    } catch {
      // Stream error — pending requests rejected below
    }
    // Stream ended — reject all pending
    for (const [, pending] of handle.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP server "${id}" disconnected`));
    }
    handle.pending.clear();
  })();

  // Capture stderr for /mcp diagnostics. Do not print during TUI startup:
  // direct terminal writes can corrupt the input editor.
  const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const stderrDecoder = new TextDecoder();
  (async () => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        const text = stderrDecoder.decode(value, { stream: true });
        for (const line of text.split("\n").filter(Boolean)) {
          appendDiagnostic(handle, line);
        }
      }
    } catch {
      // stderr stream error — ignore
    }
  })();

  return handle;
}

/** Process buffered stdout data, extracting complete lines. */
function processBuffer(handle: McpServerHandle): void {
  let idx: number;
  while ((idx = handle.buffer.indexOf("\n")) !== -1) {
    const line = handle.buffer.slice(0, idx);
    handle.buffer = handle.buffer.slice(idx + 1);
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      // Notifications (no id) — skip
      if (parsed.id === undefined || parsed.id === null) continue;
      const id = parsed.id as number;
      const pending = handle.pending.get(id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      handle.pending.delete(id);
      if (parsed.error && typeof parsed.error === "object") {
        const err = parsed.error as { code?: number; message?: string };
        pending.reject(new Error(`MCP error (${err.code ?? "?"}): ${err.message ?? "unknown"}`));
      } else {
        pending.resolve(parsed.result);
      }
    } catch {
      appendDiagnostic(handle, `Failed to parse JSON-RPC response: ${trimmed}`);
    }
  }
}

/**
 * Send a JSON-RPC request and wait for the response.
 * Returns the `result` field of the response.
 */
async function sendRequest(
  handle: McpServerHandle,
  method: string,
  params: unknown,
): Promise<unknown> {
  const id = handle.nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();

  const timer = setTimeout(() => {
    handle.pending.delete(id);
    reject(new Error(`MCP request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
  }, REQUEST_TIMEOUT_MS);

  handle.pending.set(id, { resolve, reject, timer });

  const body = JSON.stringify({ jsonrpc: "2.0", method, params, id });
  handle.proc.stdin.write(new TextEncoder().encode(body + "\n"));
  // Bun buffers piped stdin writes (FileSink) — without an explicit flush the
  // request stays buffered until the buffer fills or the process exits, so
  // every request would time out against a long-lived MCP server.
  handle.proc.stdin.flush?.();

  // Wait for response
  return promise;
}

/**
 * Initialize the MCP session.
 * Must be called before any other requests.
 */
export async function mcpInitialize(
  handle: McpServerHandle,
): Promise<McpInitializeResult> {
  const result = await sendRequest(handle, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
  }) as McpInitializeResult;

  // Send initialized notification (fire-and-forget)
  const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  handle.proc.stdin.write(new TextEncoder().encode(notif + "\n"));
  handle.proc.stdin.flush?.();

  handle.serverInfo = result.serverInfo;
  return result;
}

/**
 * List available tools from the MCP server.
 */
export async function mcpListTools(handle: McpServerHandle): Promise<McpTool[]> {
  const result = await sendRequest(handle, "tools/list", {}) as { tools: McpTool[] };
  return result.tools ?? [];
}

/**
 * Call a tool on the MCP server.
 */
export async function mcpCallTool(
  handle: McpServerHandle,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const result = await sendRequest(handle, "tools/call", {
    name,
    arguments: args,
  }) as McpToolCallResult;
  return result;
}

/**
 * Close the MCP server subprocess gracefully.
 */
export function closeMcpServer(handle: McpServerHandle): void {
  for (const [, pending] of handle.pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`MCP server "${handle.id}" shutting down`));
  }
  handle.pending.clear();
  handle.proc.kill();
}
