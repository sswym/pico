/**
 * LspClient — minimal JSON-RPC 2.0 over stdio + LSP protocol client.
 *
 * Spawns a language server process, performs the initialize handshake, and
 * exposes typed request/notification helpers. Zero npm dependencies.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  Position,
  PublishDiagnosticsParams,
  ServerCapabilities,
  ServerConfig,
  SymbolInformation,
  TextDocumentItem,
  WorkspaceSymbol,
} from "./types.ts";

// ── Pending request tracking ──────────────────────────────────────────────

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: LspError) => void;
  timer: NodeJS.Timeout;
}

/** Structured error for LSP request failures. */
export class LspError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "LspError";
  }
}

// ── Content-Length framed reader ──────────────────────────────────────────

const HEADER_SEP = Buffer.from("\r\n\r\n");
const CONTENT_LENGTH_RE = /^Content-Length:\s*(\d+)/i;

/** Accumulates raw bytes and yields complete JSON-RPC message bodies. */
class FramedReader {
  private buf = Buffer.alloc(0);

  feed(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const bodies: Buffer[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const sepIdx = this.buf.indexOf(HEADER_SEP);
      if (sepIdx === -1) break;
      const header = this.buf.subarray(0, sepIdx).toString("utf8");
      const match = CONTENT_LENGTH_RE.exec(header);
      if (!match?.[1]) break;
      const len = parseInt(match[1], 10);
      const bodyStart = sepIdx + HEADER_SEP.length;
      if (this.buf.length < bodyStart + len) break; // incomplete body
      bodies.push(this.buf.subarray(bodyStart, bodyStart + len));
      this.buf = this.buf.subarray(bodyStart + len);
    }
    return bodies;
  }
}

// ── LspClient ─────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;

export interface DiagnosticsHandler {
  (uri: string, diagnostics: Diagnostic[]): void;
}

/**
 * One language-server process.  Call {@link initialize} after construction;
 * the client is unusable until that promise resolves.
 */
export class LspClient {
  readonly config: ServerConfig;
  capabilities: ServerCapabilities = {};

  private process: ChildProcess | null = null;
  private reader = new FramedReader();
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private diagnosticsHandlers: DiagnosticsHandler[] = [];
  private emitter = new EventEmitter();
  private _ready = false;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  get ready(): boolean {
    return this._ready;
  }

  /** Register a callback that fires whenever diagnostics change for a URI. */
  onDiagnostics(handler: DiagnosticsHandler): () => void {
    this.diagnosticsHandlers.push(handler);
    return () => {
      const idx = this.diagnosticsHandlers.indexOf(handler);
      if (idx >= 0) this.diagnosticsHandlers.splice(idx, 1);
    };
  }

  /** Get cached diagnostics for a file. */
  getDiagnostics(uri: string): Diagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Spawn the server, perform `initialize`, send `initialized`. */
  async initialize(workspaceRoot: string): Promise<InitializeResult> {
    const args = this.config.args ?? [];
    this.process = spawn(this.config.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workspaceRoot,
    });

    this.process.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.process.stderr?.on("data", (_chunk: Buffer) => {
      // Silence stderr — servers often log noisy debug info.
    });
    this.process.on("exit", (code) => {
      this._ready = false;
      this.rejectAll(new LspError(`Server exited with code ${code}`));
    });
    this.process.on("error", (err) => {
      this._ready = false;
      this.rejectAll(new LspError(`Server process error: ${err.message}`));
    });

    const params: InitializeParams = {
      processId: process.pid,
      rootUri: `file://${workspaceRoot}`,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: {},
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
        },
        workspace: { symbol: {} },
      },
      workspaceFolders: [{ uri: `file://${workspaceRoot}`, name: workspaceRoot }],
      initializationOptions: this.config.initializationOptions,
    };

    const result = await this.request<InitializeResult>("initialize", params);
    this.capabilities = result.capabilities;

    this.notify("initialized", {});
    this._ready = true;
    return result;
  }

  /** Gracefully shut down the server. */
  async shutdown(): Promise<void> {
    if (!this.process) return;
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
    } catch {
      // Best-effort — server may already be dead.
    }
    this.process.kill();
    this.process = null;
    this._ready = false;
    this.rejectAll(new LspError("Client shut down"));
  }

  // ── Text document operations ──────────────────────────────────────────

  /** Tell the server we opened a document. */
  didOpen(doc: TextDocumentItem): void {
    this.notify("textDocument/didOpen", { textDocument: doc });
  }

  /** Tell the server the full content of a document changed. */
  didChange(uri: string, version: number, text: string): void {
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /** Tell the server we closed a document. */
  didClose(uri: string): void {
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  /** Ensure the server has the latest content of a file. */
  ensureOpen(filePath: string, text: string, languageId: string): string {
    const uri = pathToUri(filePath);
    this.didOpen({ uri, languageId, version: 1, text });
    return uri;
  }

  // ── LSP requests ──────────────────────────────────────────────────────

  async textDocumentHover(
    uri: string,
    position: Position,
  ): Promise<Hover | null> {
    const result = await this.request<Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position,
    });
    return result;
  }

  async textDocumentDefinition(
    uri: string,
    position: Position,
  ): Promise<Location | Location[] | null> {
    const result = await this.request<Location | Location[] | null>(
      "textDocument/definition",
      { textDocument: { uri }, position },
    );
    return result;
  }

  async textDocumentReferences(
    uri: string,
    position: Position,
  ): Promise<Location[] | null> {
    const result = await this.request<Location[] | null>(
      "textDocument/references",
      {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      },
    );
    return result;
  }

  async textDocumentDocumentSymbol(
    uri: string,
  ): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    const result = await this.request<
      DocumentSymbol[] | SymbolInformation[] | null
    >("textDocument/documentSymbol", { textDocument: { uri } });
    return result;
  }

  async workspaceSymbol(
    query: string,
  ): Promise<WorkspaceSymbol[] | null> {
    const result = await this.request<WorkspaceSymbol[] | null>(
      "workspace/symbol",
      { query },
    );
    return result;
  }

  // ── JSON-RPC transport ────────────────────────────────────────────────

  private request<T>(method: string, params: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.process?.stdin) {
        return reject(new LspError("Server not running"));
      }
      const id = this.nextId++;
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id);
          reject(new LspError(`Request ${method} timed out`, -1));
        }, REQUEST_TIMEOUT_MS),
      });
      this.process.stdin.write(frame);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.process?.stdin) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    this.process.stdin.write(frame);
  }

  private onStdout(chunk: Buffer): void {
    const bodies = this.reader.feed(chunk);
    for (const body of bodies) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      } catch {
        continue; // malformed — skip
      }
      if ("id" in msg && "method" in msg) {
        // server-to-client request — we don't expect these; ignore
        continue;
      }
      if ("id" in msg) {
        // response
        this.handleResponse(
          msg as { id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } },
        );
      } else if ("method" in msg) {
        // notification
        this.handleNotification(msg as { method: string; params?: unknown });
      }
    }
  }

  private handleResponse(resp: {
    id: number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  }): void {
    const p = this.pending.get(resp.id);
    if (!p) return;
    this.pending.delete(resp.id);
    clearTimeout(p.timer);
    if (resp.error) {
      p.reject(new LspError(resp.error.message, resp.error.code, resp.error.data));
    } else {
      p.resolve(resp.result);
    }
  }

  private handleNotification(notif: { method: string; params?: unknown }): void {
    if (notif.method === "textDocument/publishDiagnostics") {
      const params = notif.params as PublishDiagnosticsParams;
      this.diagnostics.set(params.uri, params.diagnostics);
      for (const handler of this.diagnosticsHandlers) {
        handler(params.uri, params.diagnostics);
      }
    }
    this.emitter.emit(notif.method, notif.params);
  }

  private rejectAll(err: LspError): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function pathToUri(filePath: string): string {
  const abs = filePath.startsWith("/") ? filePath : `/${filePath}`;
  return `file://${abs}`;
}

export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) return uri.slice(7);
  return uri;
}

export function positionToLsp(line: number, character: number): Position {
  // User-facing: 1-based lines. LSP: 0-based.
  return { line: Math.max(0, line - 1), character: Math.max(0, character) };
}

export function lspPositionToDisplay(pos: Position): { line: number; character: number } {
  return { line: pos.line + 1, character: pos.character };
}

export function locationToDisplay(loc: Location): {
  filePath: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
} {
  return {
    filePath: uriToPath(loc.uri),
    line: loc.range.start.line + 1,
    character: loc.range.start.character,
    endLine: loc.range.end.line + 1,
    endCharacter: loc.range.end.character,
  };
}
