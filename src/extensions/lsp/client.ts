/**
 * LspClient — minimal JSON-RPC 2.0 over stdio + LSP protocol client.
 *
 * Spawns a language server process, performs the initialize handshake, and
 * exposes typed request/notification helpers. Zero npm dependencies.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  CodeAction,
  CodeActionContext,
  Diagnostic,
  DocumentSymbol,
  FileRenameEvent,
  FormattingOptions,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  LocationLink,
  Position,
  PublishDiagnosticsParams,
  ServerCapabilities,
  ServerConfig,
  SymbolInformation,
  TextDocumentItem,
  WorkspaceEdit,
  WorkspaceSymbol,
} from "./types.ts";

// ── Pending request tracking ──────────────────────────────────────────────

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: LspError) => void;
  timer: NodeJS.Timeout;
}

/** Error codes for programmatic error handling. */
export const COMMAND_NOT_FOUND = "command-not-found";

export class LspError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
    public readonly errorCode?: string,
  ) {
    super(message);
    this.name = "LspError";
  }
}

// ── Content-Length framed reader ──────────────────────────────────────────

const HEADER_SEP = Buffer.from("\r\n\r\n");
const CONTENT_LENGTH_RE = /^Content-Length:\s*(\d+)/i;

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
      if (this.buf.length < bodyStart + len) break;
      bodies.push(this.buf.subarray(bodyStart, bodyStart + len));
      this.buf = this.buf.subarray(bodyStart + len);
    }
    return bodies;
  }
}

// ── LspClient ─────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;

export type DiagnosticsHandler = (uri: string, diagnostics: Diagnostic[]) => void;

/** The lifecycle state of a language server. */
export type LspServerStatus = "starting" | "ready" | "stopped" | "error";

export class LspClient {
  readonly config: ServerConfig;
  readonly serverName: string;
  capabilities: ServerCapabilities = {};
  serverInfo: { name?: string; version?: string } = {};
  /** Extracted short version for status display. */
  get displayVersion(): string {
    const raw = this.serverInfo.version;
    if (!raw) return "";
    try {
      const obj = JSON.parse(raw);
      // gopls puts the real version in Main.Version
      if (obj.Main?.Version && obj.Main.Version !== "(devel)") return obj.Main.Version;
      if (obj.version) return obj.version;
    } catch {}
    // Not JSON or no known field — return as-is, but truncate long strings
    return raw.length > 32 ? raw.slice(0, 29) + "…" : raw;
  }
  status: LspServerStatus = "stopped";

  private process: ChildProcess | null = null;
  private reader = new FramedReader();
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private diagnosticsHandlers: DiagnosticsHandler[] = [];
  private emitter = new EventEmitter();
  private _ready = false;

  constructor(config: ServerConfig, serverName?: string) {
    this.config = config;
    this.serverName = serverName ?? config.language;
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

  /** Get all cached diagnostics as a map. */
  getAllDiagnostics(): Map<string, Diagnostic[]> {
    return this.diagnostics;
  }

  /**
   * Wait for fresh diagnostics for a URI.
   * Returns diagnostics when they arrive, or null on timeout/abort.
   */
  async waitForDiagnostics(
    uri: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Diagnostic[] | null> {
    // Check cache first
    const existing = this.diagnostics.get(uri);
    if (existing && existing.length > 0) {
      return existing;
    }

    return new Promise<Diagnostic[] | null>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (handler) {
          const idx = this.diagnosticsHandlers.indexOf(handler);
          if (idx >= 0) this.diagnosticsHandlers.splice(idx, 1);
        }
      };

      const onAbort = () => {
        cleanup();
        resolve(null);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      let handler: DiagnosticsHandler | null = null;
      handler = (handlerUri: string, diagnostics: Diagnostic[]) => {
        if (handlerUri === uri) {
          cleanup();
          resolve(diagnostics);
        }
      };
      this.diagnosticsHandlers.push(handler);
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async initialize(workspaceRoot: string): Promise<InitializeResult> {
    this.status = "starting";
    const args = this.config.args ?? [];
    const child = spawn(this.config.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workspaceRoot,
    });
    this.process = child;

    // Detect ENOENT (binary not found) quickly via a race against the
    // initialize request. Node fires "error" asynchronously; we race it
    // against a short timeout so the user isn't stuck for 30s.
    const spawnReady = new Promise<Error | null>((resolve) => {
      let settled = false;
      child.on("error", (err: Error) => {
        this._ready = false;
        this.status = "error";
        this.rejectAll(new LspError(`Server process error: ${err.message}`));
        if (!settled) { settled = true; resolve(err); }
      });
      // If no error within 50ms, the binary exists and process started.
      setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 50);
    });

    child.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (_chunk: Buffer) => {});
    child.on("exit", (code) => {
      this._ready = false;
      this.status = "stopped";
      this.rejectAll(new LspError(`Server exited with code ${code}`));
    });

    const err = await spawnReady;
    if (err) {
      const errno = err as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        throw new LspError(
          `Command "${this.config.command}" not found (ENOENT)`,
          undefined,
          undefined,
          COMMAND_NOT_FOUND,
        );
      }
      throw new LspError(`Failed to start server: ${err.message}`);
    }

    const params: InitializeParams = {
      processId: process.pid,
      rootUri: `file://${workspaceRoot}`,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } },
          rename: {},
          formatting: {},
          publishDiagnostics: {},
        },
        workspace: { symbol: {}, workspaceEdit: { documentChanges: true } },
      },
      workspaceFolders: [{ uri: `file://${workspaceRoot}`, name: workspaceRoot }],
      initializationOptions: this.config.initializationOptions,
    };

    const result = await this.request<InitializeResult>("initialize", params);
    this.capabilities = result.capabilities;
    this.serverInfo = result.serverInfo ?? {};

    this.notify("initialized", {});
    this._ready = true;
    this.status = "ready";
    return result;
  }

  async shutdown(): Promise<void> {
    if (!this.process) return;
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
    } catch {}
    this.process.kill();
    this.process = null;
    this._ready = false;
    this.status = "stopped";
    this.rejectAll(new LspError("Client shut down"));
  }

  // ── Text document operations ──────────────────────────────────────────

  didOpen(doc: TextDocumentItem): void {
    this.notify("textDocument/didOpen", { textDocument: doc });
  }

  didChange(uri: string, version: number, text: string): void {
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  didClose(uri: string): void {
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  didSave(uri: string): void {
    this.notify("textDocument/didSave", { textDocument: { uri } });
  }

  ensureOpen(filePath: string, text: string, languageId: string): string {
    const uri = pathToUri(filePath);
    this.didOpen({ uri, languageId, version: 1, text });
    return uri;
  }

  // ── LSP requests ──────────────────────────────────────────────────────

  async textDocumentHover(uri: string, position: Position, signal?: AbortSignal): Promise<Hover | null> {
    return this.request<Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position,
    }, signal);
  }

  async textDocumentDefinition(uri: string, position: Position, signal?: AbortSignal): Promise<Location | Location[] | LocationLink[] | null> {
    return this.request("textDocument/definition", {
      textDocument: { uri },
      position,
    }, signal);
  }


  async textDocumentTypeDefinition(uri: string, position: Position, signal?: AbortSignal): Promise<Location | Location[] | LocationLink[] | null> {
    return this.request("textDocument/typeDefinition", {
      textDocument: { uri },
      position,
    }, signal);
  }


  async textDocumentImplementation(uri: string, position: Position, signal?: AbortSignal): Promise<Location | Location[] | LocationLink[] | null> {
    return this.request("textDocument/implementation", {
      textDocument: { uri },
      position,
    }, signal);
  }


  async textDocumentReferences(uri: string, position: Position, signal?: AbortSignal): Promise<Location[] | null> {
    return this.request<Location[] | null>("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    }, signal);
  }


  async textDocumentDocumentSymbol(uri: string, signal?: AbortSignal): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    return this.request("textDocument/documentSymbol", { textDocument: { uri } }, signal);
  }


  async workspaceSymbol(query: string, signal?: AbortSignal): Promise<WorkspaceSymbol[] | null> {
    return this.request<WorkspaceSymbol[] | null>("workspace/symbol", { query }, signal);
  }


  async textDocumentCodeAction(
    uri: string,
    range: { start: Position; end: Position },
    context: CodeActionContext,
    signal?: AbortSignal,
  ): Promise<CodeAction[] | null> {
    return this.request<CodeAction[] | null>("textDocument/codeAction", {
      textDocument: { uri },
      range,
      context,
    }, signal);
  }


  async codeActionResolve(action: CodeAction, signal?: AbortSignal): Promise<CodeAction> {
    return this.request<CodeAction>("codeAction/resolve", action, signal);
  }


  async textDocumentRename(uri: string, position: Position, newName: string, signal?: AbortSignal): Promise<WorkspaceEdit | null> {
    return this.request<WorkspaceEdit | null>("textDocument/rename", {
      textDocument: { uri },
      position,
      newName,
    }, signal);
  }


  async workspaceWillRenameFiles(files: FileRenameEvent[], signal?: AbortSignal): Promise<WorkspaceEdit | null> {
    return this.request<WorkspaceEdit | null>("workspace/willRenameFiles", { files }, signal);
  }


  async workspaceDidRenameFiles(files: FileRenameEvent[]): Promise<void> {
    this.notify("workspace/didRenameFiles", { files });
  }

  async textDocumentFormatting(uri: string, options: FormattingOptions, signal?: AbortSignal): Promise<Array<{ range: { start: Position; end: Position }; newText: string }> | null> {
    return this.request("textDocument/formatting", {
      textDocument: { uri },
      options,
    }, signal);
  }


  /** Invoke an arbitrary LSP method. */
  async rawRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request(method, params, signal);
  }

  /** Send an arbitrary LSP notification. */
  rawNotify(method: string, params: unknown): void {
    this.notify(method, params);
  }

  // ── JSON-RPC transport ────────────────────────────────────────────────

  private request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.process?.stdin) {
        return reject(new LspError("Server not running"));
      }
      const id = this.nextId++;
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspError(`Request ${method} timed out`, -1));
      }, REQUEST_TIMEOUT_MS);

      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new LspError(`Request ${method} aborted`, -1));
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new LspError(`Request ${method} aborted`, -1));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(result as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
        timer,
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
        continue;
      }
      if ("id" in msg && "method" in msg) continue;
      if ("id" in msg) {
        this.handleResponse(
          msg as { id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } },
        );
      } else if ("method" in msg) {
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
