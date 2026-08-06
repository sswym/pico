/**
 * LspClient — minimal JSON-RPC 2.0 over stdio + LSP protocol client.
 *
 * Spawns a language server process, performs the initialize handshake, and
 * exposes typed request/notification helpers. Zero npm dependencies.
 */
import { type ChildProcess, spawn } from "node:child_process";
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
// The `m` flag lets Content-Length appear on any header line, not just the
// first — some servers emit Content-Type before Content-Length.
const CONTENT_LENGTH_RE = /^Content-Length:\s*(\d+)/im;
// A malicious/buggy server declaring a huge Content-Length (or emitting
// unbounded unframed output) must not make the client buffer forever.
const MAX_MESSAGE_SIZE = 64 * 1024 * 1024; // 64MB declared body
const MAX_BUFFER_SIZE = MAX_MESSAGE_SIZE + 1024 * 1024; // + header slack

class FramedReader {
  private buf = Buffer.alloc(0);

  /** Throws on protocol violations that would otherwise buffer without bound. */
  feed(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const bodies: Buffer[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const sepIdx = this.buf.indexOf(HEADER_SEP);
      if (sepIdx === -1) break;
      const header = this.buf.subarray(0, sepIdx).toString("utf8");
      const match = CONTENT_LENGTH_RE.exec(header);
      if (!match?.[1]) {
        // A complete header block with no parseable Content-Length is
        // malformed. Discard it (and its separator) instead of breaking —
        // otherwise the same bytes are re-examined on every feed and the
        // reader deadlocks, dropping all subsequent messages.
        this.buf = this.buf.subarray(sepIdx + HEADER_SEP.length);
        continue;
      }
      const len = parseInt(match[1], 10);
      if (len > MAX_MESSAGE_SIZE) {
        throw new Error(`Content-Length ${len} exceeds the 64MB limit`);
      }
      const bodyStart = sepIdx + HEADER_SEP.length;
      if (this.buf.length < bodyStart + len) break;
      bodies.push(this.buf.subarray(bodyStart, bodyStart + len));
      this.buf = this.buf.subarray(bodyStart + len);
    }
    // No complete frame and no header separator — the bytes are unframed
    // garbage. Drop the connection once they exceed the cap.
    if (this.buf.length > MAX_BUFFER_SIZE) {
      throw new Error(`Unframed server output exceeds the 64MB buffer limit`);
    }
    return bodies;
  }
}

// ── LspClient ─────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
/** initialize() gets a much longer budget (2.5.1): cold starts (first
 *  project index for rust-analyzer etc.) regularly exceed 30s, and a
 *  too-short window condemns the server to a failure backoff. */
const INITIALIZE_TIMEOUT_MS = 90_000;
/** A server that stops draining stdin (wedged) must not hang the notify
 *  queue forever — drop the frame and continue after this budget. */
const NOTIFY_DRAIN_TIMEOUT_MS = 10_000;

export type DiagnosticsHandler = (uri: string, diagnostics: Diagnostic[], version?: number) => void;

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
  /** Highest document version this client has synced per URI (didOpen/didChange). */
  private documentVersions = new Map<string, number>();
  /** Dynamically registered capabilities (client/registerCapability), e.g.
   *  "textDocument/diagnostic" pull providers. */
  private dynamicProviders = new Set<string>();
  private _ready = false;
  /** Bounded tail of server stderr, surfaced when the server crashes. */
  private stderrTail = "";

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
   *
   * Never short-circuits on cached diagnostics: callers use this after a
   * didSave, so only publishes that follow the save count. Reading the
   * pre-save cache would silently drop newly introduced diagnostics on
   * the second and later writes to the same file.
   *
   * Version tracking: publishes that carry a `version` older than the
   * version synced at registration time are stale (a server replying to an
   * older didChange after our didSave) and are dropped. Servers that omit
   * the version field fall back to the accept-any behavior.
   */
  async waitForDiagnostics(
    uri: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Diagnostic[] | null> {
    const expectedVersion = this.documentVersions.get(uri) ?? 0;
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
      handler = (handlerUri: string, diagnostics: Diagnostic[], version?: number) => {
        if (handlerUri !== uri) return;
        if (version !== undefined && version < expectedVersion) return;
        cleanup();
        resolve(diagnostics);
      };
      this.diagnosticsHandlers.push(handler);
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async initialize(workspaceRoot: string): Promise<InitializeResult> {
    this.status = "starting";
    // `$PID` tokens let servers (e.g. omnisharp) bind to this client process.
    const args = resolveServerArgs(this.config.args ?? [], process.pid);
    const child = spawn(this.config.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workspaceRoot,
    });
    this.process = child;
    // A server that dies between the ready check and the next write raises
    // EPIPE on stdin; without a listener that's an uncaught exception.
    child.stdin?.on("error", () => {});

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
    child.stderr?.on("data", (chunk: Buffer) => {
      // Keep a bounded tail so a crashing server's diagnostics aren't lost.
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    child.on("exit", (code) => {
      this._ready = false;
      this.status = "stopped";
      if (this.process === child) this.process = null;
      const detail = this.stderrTail.trim();
      this.rejectAll(
        new LspError(`Server exited with code ${code}${detail ? `: ${detail.slice(-500)}` : ""}`),
      );
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

    const result = await this.request<InitializeResult>("initialize", params, undefined, INITIALIZE_TIMEOUT_MS);
    this.capabilities = result.capabilities;
    this.serverInfo = result.serverInfo ?? {};

    this.notify("initialized", {});
    // Servers that read runtime settings via workspace/didChangeConfiguration
    // or workspace/configuration must see the configured settings; without
    // this push they stay on defaults (settings were parsed but never sent).
    this.notify("workspace/didChangeConfiguration", { settings: this.config.settings ?? {} });
    this._ready = true;
    this.status = "ready";
    return result;
  }

  async shutdown(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    try {
      // Bound the shutdown request: a wedged server must not stall session
      // teardown for the full request timeout (30s).
      await this.request("shutdown", null, AbortSignal.timeout(2_000));
      this.notify("exit", null);
    } catch {}
    proc.kill();
    // Escalate to SIGKILL if the server ignores the graceful shutdown, so a
    // wedged process doesn't linger. `proc.killed` flips true on the first
    // kill() call, so it can't gate the escalation; the timer is cleared on
    // exit, so firing it means the process is still alive. Unref'd so it
    // never keeps the event loop alive.
    const forceKill = setTimeout(() => {
      proc.kill("SIGKILL");
    }, 2000);
    forceKill.unref?.();
    proc.once("exit", () => clearTimeout(forceKill));
    this.process = null;
    this._ready = false;
    this.status = "stopped";
    this.rejectAll(new LspError("Client shut down"));
  }

  // ── Text document operations ──────────────────────────────────────────

  didOpen(doc: TextDocumentItem): void {
    this.documentVersions.set(doc.uri, doc.version);
    this.notify("textDocument/didOpen", { textDocument: doc });
  }

  didChange(uri: string, version: number, text: string): void {
    this.documentVersions.set(uri, version);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  didClose(uri: string): void {
    // Drop cached diagnostics for closed documents so workspace-level
    // diagnostics never surface stale entries for deleted/closed files.
    this.diagnostics.delete(uri);
    this.documentVersions.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  didSave(uri: string): void {
    // Keep cached diagnostics intact: they are the fallback when a server
    // does not re-publish after didSave (waitForDiagnostics itself never
    // reads the cache — only fresh publishes count — so callers deciding
    // "no diagnostics" from a silent server would otherwise report false
    // negatives for files that do have errors).
    this.notify("textDocument/didSave", { textDocument: { uri } });
  }

  ensureOpen(filePath: string, text: string, languageId: string): string {
    const uri = pathToUri(filePath);
    this.didOpen({ uri, languageId, version: 1, text });
    return uri;
  }

  // ── LSP requests ──────────────────────────────────────────────────────

  async textDocumentHover(uri: string, position: Position, signal?: AbortSignal, timeoutMs?: number): Promise<Hover | null> {
    return this.request<Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position,
    }, signal, timeoutMs);
  }

  async textDocumentDefinition(uri: string, position: Position, signal?: AbortSignal, timeoutMs?: number): Promise<Location | Location[] | LocationLink[] | null> {
    return this.request("textDocument/definition", {
      textDocument: { uri },
      position,
    }, signal, timeoutMs);
  }


  async textDocumentTypeDefinition(uri: string, position: Position, signal?: AbortSignal, timeoutMs?: number): Promise<Location | Location[] | LocationLink[] | null> {
    return this.request("textDocument/typeDefinition", {
      textDocument: { uri },
      position,
    }, signal, timeoutMs);
  }


  async textDocumentImplementation(uri: string, position: Position, signal?: AbortSignal, timeoutMs?: number): Promise<Location | Location[] | LocationLink[] | null> {
    return this.request("textDocument/implementation", {
      textDocument: { uri },
      position,
    }, signal, timeoutMs);
  }


  async textDocumentReferences(uri: string, position: Position, signal?: AbortSignal, timeoutMs?: number): Promise<Location[] | null> {
    return this.request<Location[] | null>("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    }, signal, timeoutMs);
  }


  async textDocumentDocumentSymbol(uri: string, signal?: AbortSignal, timeoutMs?: number): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    return this.request("textDocument/documentSymbol", { textDocument: { uri } }, signal, timeoutMs);
  }


  async workspaceSymbol(query: string, signal?: AbortSignal, timeoutMs?: number): Promise<WorkspaceSymbol[] | null> {
    return this.request<WorkspaceSymbol[] | null>("workspace/symbol", { query }, signal, timeoutMs);
  }


  async textDocumentCodeAction(
    uri: string,
    range: { start: Position; end: Position },
    context: CodeActionContext,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<CodeAction[] | null> {
    return this.request<CodeAction[] | null>("textDocument/codeAction", {
      textDocument: { uri },
      range,
      context,
    }, signal, timeoutMs);
  }


  async codeActionResolve(action: CodeAction, signal?: AbortSignal, timeoutMs?: number): Promise<CodeAction> {
    return this.request<CodeAction>("codeAction/resolve", action, signal, timeoutMs);
  }


  async textDocumentRename(uri: string, position: Position, newName: string, signal?: AbortSignal, timeoutMs?: number): Promise<WorkspaceEdit | null> {
    return this.request<WorkspaceEdit | null>("textDocument/rename", {
      textDocument: { uri },
      position,
      newName,
    }, signal, timeoutMs);
  }


  async workspaceWillRenameFiles(files: FileRenameEvent[], signal?: AbortSignal, timeoutMs?: number): Promise<WorkspaceEdit | null> {
    return this.request<WorkspaceEdit | null>("workspace/willRenameFiles", { files }, signal, timeoutMs);
  }


  async workspaceDidRenameFiles(files: FileRenameEvent[]): Promise<void> {
    this.notify("workspace/didRenameFiles", { files });
  }

  async textDocumentFormatting(uri: string, options: FormattingOptions, signal?: AbortSignal, timeoutMs?: number): Promise<Array<{ range: { start: Position; end: Position }; newText: string }> | null> {
    return this.request("textDocument/formatting", {
      textDocument: { uri },
      options,
    }, signal, timeoutMs);
  }

  /** Pull-based diagnostics (LSP 3.17): ask the server for the current full
   *  diagnostic set for a URI. Returns null when the server returns nothing
   *  usable; throws LspError when the server doesn't support the method. */
  async requestDiagnostic(uri: string, signal?: AbortSignal, timeoutMs = 10_000): Promise<Diagnostic[] | null> {
    const result = await this.request<
      { items?: Diagnostic[]; relatedDocuments?: unknown } | Diagnostic[] | null
    >("textDocument/diagnostic", { textDocument: { uri } }, signal, timeoutMs);
    if (Array.isArray(result)) return result;
    if (result && typeof result === "object" && Array.isArray(result.items)) return result.items;
    return null;
  }

  /** True when the server supports pull-based diagnostics (static capability
   *  or dynamically registered via client/registerCapability). */
  get supportsDocumentDiagnostics(): boolean {
    if (this.capabilities.diagnosticProvider != null) return true;
    return this.dynamicProviders.has("textDocument/diagnostic");
  }

  /** Notify the server of a workspace file change (1=Created, 2=Changed, 3=Deleted). */
  didChangeWatchedFiles(uri: string, changeType: 1 | 2 | 3): void {
    this.notify("workspace/didChangeWatchedFiles", { changes: [{ uri, type: changeType }] });
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

  private request<T>(method: string, params: unknown, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
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
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        // Tell the server to stop working on the request instead of letting
        // it burn CPU on work nobody will read.
        this.sendCancelRequest(id);
        reject(new LspError(`Request ${method} aborted`, -1));
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          this.sendCancelRequest(id);
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

  /**
   * FIFO chain honouring stdin backpressure for notifications: `write()`
   * returning false means the kernel buffer is full (slow server, e.g. a
   * busy rust-analyzer) — keep queuing would grow memory without bound, so
   * wait for `drain` before the next frame.
   */
  private notifyQueue: Promise<void> = Promise.resolve();

  private notify(method: string, params: unknown): void {
    if (!this.process?.stdin) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    this.notifyQueue = this.notifyQueue
      .then(async () => {
        const stdin = this.process?.stdin;
        if (!stdin) return;
        if (stdin.write(frame) === false) {
          // A wedged server that never drains must not hang the queue
          // forever: drop the frame after a bounded wait.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              stdin.off("drain", onDrain);
              resolve();
            }, NOTIFY_DRAIN_TIMEOUT_MS);
            timer.unref?.();
            const onDrain = () => {
              clearTimeout(timer);
              resolve();
            };
            stdin.once("drain", onDrain);
          });
        }
      })
      .catch(() => {
        // A closed stdin must not take notifications down; the frame is
        // dropped (the server is gone anyway).
      });
  }

  /** Fire-and-forget $/cancelRequest: bypasses the notify queue so the
   *  cancellation reaches a busy server even while other frames are queued. */
  private sendCancelRequest(id: number): void {
    const stdin = this.process?.stdin;
    if (!stdin) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    try {
      stdin.write(frame);
    } catch {
      // Server already gone.
    }
  }

  private onStdout(chunk: Buffer): void {
    let bodies: Buffer[];
    try {
      bodies = this.reader.feed(chunk);
    } catch (err) {
      // A runaway Content-Length or unbounded unframed output must not be
      // buffered forever — tear the connection down instead.
      const msg = err instanceof Error ? err.message : String(err);
      this.destroy(new LspError(`LSP protocol violation: ${msg}`));
      return;
    }
    for (const body of bodies) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if ("id" in msg && "method" in msg) {
        // Server-to-client request (e.g. client/registerCapability)
        this.handleRequest(msg as { id: unknown; method: string; params?: unknown });
      } else if ("id" in msg) {
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

  /**
   * Handle a server-to-client request (a JSON-RPC message with both `id` and `method`).
   * Responds with null result for known methods, or MethodNotFound for unknown ones.
   */
  private handleRequest(req: { id: unknown; method: string; params?: unknown }): void {
    // Known server requests we can safely no-op
    const KNOWN_METHODS = new Set([
      "client/registerCapability",
      "client/unregisterCapability",
      "window/workDoneProgress/create",
    ]);

    let response: Record<string, unknown>;
    if (req.method === "workspace/applyEdit") {
      // We never apply server-initiated edits — but answering null (instead
      // of the spec-mandated { applied: boolean }) would make the server
      // believe the edit landed and silently diverge from disk state.
      response = { jsonrpc: "2.0", id: req.id, result: { applied: false } };
    } else if (req.method === "workspace/configuration") {
      // Serve configured settings per requested section. Servers that
      // pull runtime configuration (pyright, lua-language-server, …) fall
      // back to defaults when this is answered with MethodNotFound.
      const items = (req.params as { items?: Array<{ section?: string }> } | undefined)?.items ?? [];
      const settings = this.config.settings;
      const result = items.map((item) => {
        if (settings && typeof settings === "object" && item.section) {
          const record = settings as Record<string, unknown>;
          if (item.section in record) return record[item.section];
        }
        return null;
      });
      response = { jsonrpc: "2.0", id: req.id, result };
    } else if (req.method === "client/registerCapability") {
      const registrations = (req.params as { registrations?: Array<{ method?: string }> } | undefined)?.registrations ?? [];
      for (const reg of registrations) {
        if (reg.method) this.dynamicProviders.add(reg.method);
      }
      response = { jsonrpc: "2.0", id: req.id, result: null };
    } else if (req.method === "client/unregisterCapability") {
      const unregistrations = (req.params as { unregistrations?: Array<{ method?: string }> } | undefined)?.unregistrations ?? [];
      for (const unreg of unregistrations) {
        if (unreg.method) this.dynamicProviders.delete(unreg.method);
      }
      response = { jsonrpc: "2.0", id: req.id, result: null };
    } else if (KNOWN_METHODS.has(req.method)) {
      response = { jsonrpc: "2.0", id: req.id, result: null };
    } else {
      response = {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
    }

    const frame = `Content-Length: ${Buffer.byteLength(JSON.stringify(response))}\r\n\r\n${JSON.stringify(response)}`;
    try {
      this.process?.stdin?.write(frame);
    } catch {
      // Ignore write errors
    }
  }

  private handleNotification(notif: { method: string; params?: unknown }): void {
    if (notif.method === "textDocument/publishDiagnostics") {
      // Malformed servers (protocol-tolerance bugs / version skew) can send
      // the notification without params. Dereferencing `params.uri` would
      // throw inside the stdout data handler — outside any try/catch — and
      // crash the whole process. Drop the notification instead.
      const params = notif.params;
      if (typeof params !== "object" || params === null) return;
      const uri = (params as { uri?: unknown }).uri;
      const diagnostics = (params as { diagnostics?: unknown }).diagnostics;
      const version = (params as { version?: unknown }).version;
      if (typeof uri !== "string" || !Array.isArray(diagnostics)) return;
      this.diagnostics.set(uri, diagnostics as Diagnostic[]);
      const parsedVersion = typeof version === "number" ? version : undefined;
      for (const handler of this.diagnosticsHandlers) {
        handler(uri, diagnostics as Diagnostic[], parsedVersion);
      }
    }
  }

  /** Hard-tear-down after a fatal protocol error: kill the process and fail
   *  every in-flight request. Unlike shutdown(), no graceful handshake. */
  private destroy(err: LspError): void {
    const proc = this.process;
    this._ready = false;
    this.status = "error";
    this.process = null;
    if (proc) {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }
    this.rejectAll(err);
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

/** Substitute `$PID` tokens in server args with the given pid (omnisharp
 *  and similar servers bind to the client process via its pid). */
export function resolveServerArgs(args: string[], pid: number): string[] {
  if (!args.some((a) => a.includes("$PID"))) return args;
  return args.map((a) => a.replaceAll("$PID", String(pid)));
}

export function pathToUri(filePath: string): string {
  const abs = filePath.startsWith("/") ? filePath : `/${filePath}`;
  // Encode spaces/#/non-ASCII — a raw file:// URL is invalid for strict
  // servers (rust-analyzer/gopls) and round-trips through uriToPath broken.
  // encodeURI leaves `#` and `?` untouched, but both are URI delimiters: a
  // file named "foo#1.ts" must not arrive as file:///foo (fragment "1.ts").
  const encoded = encodeURI(abs).replace(/#/g, "%23").replace(/\?/g, "%3F");
  return `file://${encoded}`;
}

export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    const path = uri.slice(7);
    try {
      // decodeURIComponent (not decodeURI): decodeURI leaves reserved
      // characters like %23/# and %3F/? encoded, breaking the round-trip
      // for the very filenames pathToUri now escapes.
      return decodeURIComponent(path);
    } catch {
      // Malformed percent-encoding — return as-is rather than corrupting it.
      return path;
    }
  }
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
