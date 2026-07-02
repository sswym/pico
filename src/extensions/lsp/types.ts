/**
 * Minimal LSP protocol types — zero dependencies, directly models the spec.
 * Only the subset needed by srcode's LSP extension is included.
 */

// ── JSON-RPC base ─────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ── LSP basic structures ──────────────────────────────────────────────────

export interface Position {
  /** 0-based line. */
  line: number;
  /** 0-based UTF-16 character offset. */
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface TextDocumentIdentifier {
  uri: string;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
  version: number;
}

export interface TextDocumentItem {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

// ── Diagnostic ────────────────────────────────────────────────────────────

export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface Diagnostic {
  range: Range;
  severity?: DiagnosticSeverity;
  code?: string | number;
  source?: string;
  message: string;
}

export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Diagnostic[];
}

// ── Hover ─────────────────────────────────────────────────────────────────

export interface MarkedStringLanguage {
  language: string;
  value: string;
}

export type MarkedString = string | MarkedStringLanguage;

export interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export interface Hover {
  contents: MarkedString | MarkedString[] | MarkupContent;
  range?: Range;
}

// ── Symbol ────────────────────────────────────────────────────────────────

export enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: SymbolKind;
  location: Location;
  containerName?: string;
}

export interface WorkspaceSymbol {
  name: string;
  kind: SymbolKind;
  location: Location | { uri: string };
  containerName?: string;
}

// ── Initialize ────────────────────────────────────────────────────────────

export interface ServerCapabilities {
  textDocumentSync?: number | { openClose?: boolean; change?: number };
  hoverProvider?: boolean;
  definitionProvider?: boolean;
  referencesProvider?: boolean;
  documentSymbolProvider?: boolean;
  workspaceSymbolProvider?: boolean;
  [key: string]: unknown;
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo?: { name?: string; version?: string };
}

export interface InitializeParams {
  processId: number | null;
  rootUri: string | null;
  capabilities: Record<string, unknown>;
  workspaceFolders?: Array<{ uri: string; name: string }> | null;
  initializationOptions?: unknown;
}

// ── Server config ─────────────────────────────────────────────────────────

export interface ServerConfig {
  /** Language identifier (e.g. "typescript", "python", "rust"). */
  language: string;
  /** File extensions this server handles (without dot). */
  extensions: string[];
  /** Command to spawn the server process. */
  command: string;
  /** Arguments for the server process. */
  args?: string[];
  /** Optional initializationOptions sent during `initialize`. */
  initializationOptions?: unknown;
}
