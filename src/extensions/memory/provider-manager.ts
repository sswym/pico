/**
 * ProviderManager — orchestrates the active memory provider.
 *
 * It now behaves more like hermes-agent's MemoryManager:
 *   - resolves the configured provider
 *   - can register additional external providers
 *   - fans out lifecycle hooks
 *   - aggregates recall/search/tool schemas across providers
 *   - keeps background work off the main turn path
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ContradictionResult,
  Fact,
  MemoryInitializeContext,
  MemoryProvider,
  MemoryWriteMetadata,
  ScoredFact,
  SearchOptions,
} from "./provider.ts";
import type { Scope } from "./schema.ts";
import { BuiltinMemoryProvider } from "./builtin-provider.ts";
import { HolographicMemoryProvider } from "./holographic-provider.ts";
import { WriteQueue } from "./provider.ts";
import { srcodeMemoryDbPath, srcodeSettingsPath } from "../paths.ts";

export interface MemorySettings {
  /** Backend identifier: "builtin" | provider name. Default "builtin". */
  backend?: string;
}

export interface ProviderInfo {
  name: string;
  available: boolean;
  writable: boolean;
  searchable: boolean;
  factCount: number;
}

export interface MemoryProviderFactory {
  (): MemoryProvider;
}

const FACTORY_REGISTRY = new Map<string, MemoryProviderFactory>();

export function registerMemoryProviderFactory(name: string, factory: MemoryProviderFactory): void {
  FACTORY_REGISTRY.set(name, factory);
}

registerMemoryProviderFactory("builtin", () => new BuiltinMemoryProvider(resolveDbPath()));
registerMemoryProviderFactory("holographic", () => new HolographicMemoryProvider());

function readMemorySettings(): MemorySettings {
  try {
    const raw = JSON.parse(readFileSync(srcodeSettingsPath(), "utf-8"));
    if (raw && typeof raw === "object" && "memory" in raw) {
      const mem = (raw as Record<string, unknown>).memory;
      if (mem && typeof mem === "object") return mem as MemorySettings;
    }
  } catch {
    // missing or malformed settings -> defaults
  }
  return {};
}

function readSettingsFile(): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(srcodeSettingsPath(), "utf-8"));
    return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeSettingsFile(settings: Record<string, unknown>): void {
  const path = srcodeSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

export function resolveDbPath(): string {
  return srcodeMemoryDbPath();
}

const FENCE_TAG_RE = /<\/?\s*memory-context\s*>/gi;

export function sanitizeContext(text: string): string {
  return text.replace(FENCE_TAG_RE, "").trim();
}

export function buildMemoryContextBlock(rawContext: string): string {
  if (!rawContext.trim()) return "";
  return [
    "<memory-context>",
    "The following is recalled from long-term memory. It may be stale or inaccurate — verify against current state:",
    "",
    rawContext.trim(),
    "</memory-context>",
  ].join("\n");
}

function normalizeToolSchema(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  const raw = schema as Record<string, unknown>;
  if (raw.type === "function" && raw.function && typeof raw.function === "object") {
    return normalizeToolSchema(raw.function);
  }
  const name = raw.name;
  if (typeof name !== "string" || !name.trim()) return null;
  return raw;
}

function dedupeFacts(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const fact of facts) {
    const key = `${fact.content}\u0000${fact.category}\u0000${fact.scope}\u0000${fact.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out;
}

export class ProviderManager {
  readonly provider: MemoryProvider;
  readonly providers: MemoryProvider[] = [];

  private readonly _toolToProvider = new Map<string, MemoryProvider>();
  private readonly _background = new WriteQueue();
  private _externalProvider: MemoryProvider | null = null;

  constructor(settings?: MemorySettings) {
    const resolved = settings ?? readMemorySettings();
    const backend = resolved.backend ?? "builtin";
    this.provider = this.resolveProvider(backend);
    this.providers.push(this.provider);
    this.indexProviderTools(this.provider);
  }

  private resolveProvider(backend: string): MemoryProvider {
    const factory = FACTORY_REGISTRY.get(backend);
    if (factory) return factory();
    const builtinFactory = FACTORY_REGISTRY.get("builtin");
    if (!builtinFactory) throw new Error("Builtin memory provider factory missing");
    console.warn(`[memory] Unknown provider "${backend}", falling back to builtin`);
    return builtinFactory();
  }

  private indexProviderTools(provider: MemoryProvider): void {
    for (const rawSchema of provider.getToolSchemas?.() ?? []) {
      const schema = normalizeToolSchema(rawSchema);
      if (!schema) continue;
      const name = schema.name;
      if (typeof name !== "string") continue;
      if (!this._toolToProvider.has(name)) {
        this._toolToProvider.set(name, provider);
      }
    }
  }

  initialize(sessionId: string, context: MemoryInitializeContext = {}): void {
    for (const provider of this.providers) {
      try {
        provider.initialize(sessionId, context);
      } catch {
        // provider init must never block the session
      }
    }
  }

  shutdown(): void {
    this._background.drain();
    for (const provider of this.providers) {
      try {
        provider.shutdown();
      } catch {
        // best effort
      }
    }
  }

  getInfo(): ProviderInfo {
    return {
      name: this.provider.name,
      available: this.provider.isAvailable(),
      writable: true,
      searchable: true,
      factCount: this.provider.count(),
    };
  }

  static availableProviders(): string[] {
    return Array.from(FACTORY_REGISTRY.keys()).sort();
  }

  static saveBackend(backend: string): { ok: boolean; reason?: string } {
    if (!FACTORY_REGISTRY.has(backend)) {
      return { ok: false, reason: `Unknown memory provider '${backend}'` };
    }
    const settings = readSettingsFile();
    const memory = settings.memory && typeof settings.memory === "object"
      ? settings.memory as Record<string, unknown>
      : {};
    memory.backend = backend;
    settings.memory = memory;
    writeSettingsFile(settings);
    return { ok: true };
  }

  registerExternalProvider(
    provider: MemoryProvider,
    toolName?: string,
  ): { accepted: boolean; reason?: string } {
    if (this._externalProvider && this._externalProvider !== provider) {
      return { accepted: false, reason: "A different external provider is already registered" };
    }
    if (toolName && toolName.trim()) {
      const reserved = new Set(["memory", "ask", "web", "todo", "subagent", "lsp", "plan", "mcp"]);
      if (reserved.has(toolName)) {
        return { accepted: false, reason: `Tool name "${toolName}" is reserved for core extensions` };
      }
    }

    if (this._externalProvider === provider) {
      return { accepted: true };
    }

    this._externalProvider = provider;
    this.providers.push(provider);
    this.indexProviderTools(provider);
    return { accepted: true };
  }

  getExternalProvider(): MemoryProvider | null {
    return this._externalProvider;
  }

  notifyMemoryToolWrite(metadata: MemoryWriteMetadata): void {
    for (const provider of this.providers) {
      if (provider === this.provider) continue;
      try {
        provider.onMemoryWrite?.(metadata);
      } catch (err) {
        console.warn("[memory] External provider onMemoryWrite failed:", err);
      }
    }
  }

  getAllToolSchemas(): Record<string, unknown>[] {
    const schemas: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const provider of this.providers) {
      for (const rawSchema of provider.getToolSchemas?.() ?? []) {
        const schema = normalizeToolSchema(rawSchema);
        if (!schema) continue;
        const name = schema.name;
        if (typeof name !== "string" || seen.has(name)) continue;
        seen.add(name);
        schemas.push(schema);
      }
    }
    return schemas;
  }

  getAllToolNames(): Set<string> {
    return new Set(this._toolToProvider.keys());
  }

  hasTool(toolName: string): boolean {
    return this._toolToProvider.has(toolName);
  }

  handleToolCall(toolName: string, args: Record<string, unknown>, context: Record<string, unknown> = {}): string {
    const provider = this._toolToProvider.get(toolName);
    if (!provider) {
      return JSON.stringify({ error: `No memory provider handles tool '${toolName}'` });
    }
    if (!provider.handleToolCall) {
      return JSON.stringify({ error: `Memory provider '${provider.name}' does not handle tool '${toolName}'` });
    }
    try {
      return provider.handleToolCall(toolName, args, context);
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  onTurnStart(turnNumber: number, message: string): void {
    for (const provider of this.providers) {
      try {
        provider.onTurnStart?.(turnNumber, message);
      } catch {
        // best effort
      }
    }
  }

  onSessionEnd(messages: unknown[]): void {
    for (const provider of this.providers) {
      try {
        provider.onSessionEnd?.(messages);
      } catch {
        // best effort
      }
    }
  }

  syncTurn(
    userContent: string,
    assistantContent: string,
    opts: { sessionId?: string; messages?: unknown[]; [key: string]: unknown } = {},
  ): void {
    this._background.push("sync-turn", () => {
      for (const provider of this.providers) {
        try {
          provider.syncTurn?.(userContent, assistantContent, opts);
        } catch {
          // best effort
        }
      }
    });
  }

  onSessionSwitch(
    newSessionId: string,
    opts: { parentSessionId?: string; reset?: boolean; rewound?: boolean; [key: string]: unknown } = {},
  ): void {
    if (!newSessionId) return;
    for (const provider of this.providers) {
      try {
        provider.onSessionSwitch?.(newSessionId, {
          parentSessionId: opts.parentSessionId ?? "",
          reset: opts.reset ?? false,
          rewound: opts.rewound ?? false,
          ...opts,
        });
      } catch {
        // best effort
      }
    }
  }

  onPreCompress(messages: unknown[]): string {
    const parts: string[] = [];
    for (const provider of this.providers) {
      try {
        const text = provider.onPreCompress?.(messages);
        if (text && text.trim()) parts.push(text.trim());
      } catch {
        // best effort
      }
    }
    return parts.join("\n\n");
  }

  onDelegation(task: string, result: string, childSessionId = ""): void {
    for (const provider of this.providers) {
      try {
        provider.onDelegation?.(task, result, childSessionId);
      } catch {
        // best effort
      }
    }
  }

  onMemoryWrite(metadata: MemoryWriteMetadata): void {
    this.notifyMemoryToolWrite(metadata);
  }

  add(content: string, opts: Parameters<MemoryProvider["add"]>[1] = {}): number {
    return this.provider.add(content, opts);
  }

  update(factId: number, opts: Parameters<MemoryProvider["update"]>[1]): boolean {
    return this.provider.update(factId, opts);
  }

  remove(factId: number): boolean {
    return this.provider.remove(factId);
  }

  feedback(factId: number, helpful: boolean): Fact | null {
    return this.provider.feedback(factId, helpful);
  }

  clear(): void {
    for (const provider of this.providers) {
      try {
        provider.clear();
      } catch {
        // best effort
      }
    }
  }

  count(): number {
    return this.provider.count();
  }

  get(factId: number): Fact | null {
    return this.provider.get(factId);
  }

  list(opts: SearchOptions = {}): Fact[] {
    return this.provider.list(opts);
  }

  search(query: string, opts: SearchOptions = {}): Fact[] {
    return this.provider.search(query, opts);
  }

  probe(entity: string, opts: SearchOptions = {}): Fact[] {
    return this.provider.probe(entity, opts);
  }

  related(entity: string, opts: SearchOptions = {}): ScoredFact[] {
    return this.provider.related(entity, opts);
  }

  reason(entities: string[], opts: SearchOptions = {}): ScoredFact[] {
    return this.provider.reason(entities, opts);
  }

  contradict(opts: { category?: string; limit?: number; scope?: Scope; cwd?: string } = {}): ContradictionResult[] {
    return this.provider.contradict(opts);
  }

  prefetch(query: string, opts: SearchOptions = {}): Fact[] {
    const facts: Fact[] = [];
    for (const provider of this.providers) {
      try {
        facts.push(...provider.prefetch(query, opts.cwd));
      } catch {
        // best effort
      }
    }
    return dedupeFacts(facts);
  }

  queuePrefetch(query: string, cwd?: string): void {
    this._background.push(`prefetch:${query.slice(0, 48)}`, () => {
      for (const provider of this.providers) {
        try {
          provider.queuePrefetch(query, cwd);
        } catch {
          // best effort
        }
      }
    });
  }

  async flushPending(timeoutMs = 2_000): Promise<boolean> {
    if (timeoutMs <= 0) {
      await this._background.flush();
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        this._background.flush().then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      return completed;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
