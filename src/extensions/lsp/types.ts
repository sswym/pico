/**
 * Minimal LSP protocol types — zero dependencies, directly models the spec.
 * Only the subset needed by pico's LSP extension is included.
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

// ── LSP basic structures ──────────────────────────────────────────────────

export interface Position {
  line: number;
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

export interface LocationLink {
  originSelectionRange?: Range;
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
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

// ── Code Action ───────────────────────────────────────────────────────────

export interface CodeActionContext {
  diagnostics: Diagnostic[];
  only?: string[];
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  edit?: WorkspaceEdit;
  command?: Command;
  isPreferred?: boolean;
}

export interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

// ── Workspace Edit ────────────────────────────────────────────────────────

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<TextDocumentEdit | CreateFile | RenameFile | DeleteFile>;
}

export interface TextDocumentEdit {
  textDocument: VersionedTextDocumentIdentifier;
  edits: TextEdit[];
}

export interface CreateFile {
  kind: "create";
  uri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

export interface RenameFile {
  kind: "rename";
  oldUri: string;
  newUri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

export interface DeleteFile {
  kind: "delete";
  uri: string;
  options?: { recursive?: boolean; ignoreIfNotExists?: boolean };
}

// ── Formatting ────────────────────────────────────────────────────────────

export interface FormattingOptions {
  tabSize: number;
  insertSpaces: boolean;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  trimFinalNewlines?: boolean;
}

// ── File Event ────────────────────────────────────────────────────────────

export interface FileRename {
  oldUri: string;
  newUri: string;
}

export interface FileRenameEvent {
  oldUri: string;
  newUri: string;
}

export interface ApplyResult {
  ok: boolean;
  fileCount: number;
  messages: string[];
  error?: string;
}

export type DocumentChange = TextDocumentEdit | CreateFile | DeleteFile | RenameFile;

// ── Initialize ────────────────────────────────────────────────────────────

export interface ServerCapabilities {
  textDocumentSync?: number | { openClose?: boolean; change?: number };
  hoverProvider?: boolean;
  definitionProvider?: boolean;
  typeDefinitionProvider?: boolean;
  implementationProvider?: boolean;
  referencesProvider?: boolean;
  documentSymbolProvider?: boolean;
  workspaceSymbolProvider?: boolean;
  codeActionProvider?: boolean | { codeActionKinds?: string[] };
  renameProvider?: boolean;
  documentFormattingProvider?: boolean;
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
  language: string;
  extensions: string[];
  command: string;
  args?: string[];
  initializationOptions?: unknown;
}
