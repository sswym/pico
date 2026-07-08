/**
 * ProviderManager — orchestrates the active memory provider.
 *
 * Ported from hermes-agent's agent/memory_manager.py MemoryManager.
 *
 * Responsibilities:
 *   - Resolve the active provider based on settings/env
 *   - Context sanitization (strip <memory-context> fence tags)
 *   - Context fencing (wrap prefetched content in <memory-context>)
 *   - Provider lifecycle (init / shutdown)
 *   - Tool schema injection for external providers
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryProvider } from "./provider.ts";
import { BuiltinMemoryProvider } from "./builtin-provider.ts";

// ---- Settings ------------------------------------------------------------

export interface MemorySettings {
  /** Backend identifier: "builtin" | provider name. Default "builtin". */
  backend?: string;
}

function getSettingsPath(): string {
  return join(homedir(), ".srcode", "agent", "settings.json");
}

function readMemorySettings(): MemorySettings {
  try {
    const raw = JSON.parse(readFileSync(getSettingsPath(), "utf-8"));
    if (raw && typeof raw === "object" && "memory" in raw) {
      const mem = (raw as Record<string, unknown>).memory;
      if (mem && typeof mem === "object") {
        return mem as MemorySettings;
      }
    }
  } catch {
    // file missing or malformed — use defaults
  }
  return {};
}

export function resolveDbPath(): string {
  const override = process.env.SRCODE_MEMORY_DB;
  if (override) return override;
  return join(homedir(), ".srcode", "memory.db");
}

// ---- Context fencing helpers --------------------------------------------

/** Regex matching <memory-context> or </memory-context> tags (case-insensitive). */
const FENCE_TAG_RE = /<\/?\s*memory-context\s*>/gi;

/** Strip memory-context fence tags from text. */
export function sanitizeContext(text: string): string {
  return text.replace(FENCE_TAG_RE, "").trim();
}

/** Wrap prefetched content in a fenced block with system note. */
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

// ---- ProviderManager -----------------------------------------------------

export interface ProviderInfo {
  name: string;
  available: boolean;
  writable: boolean;
  searchable: boolean;
  factCount: number;
}

export class ProviderManager {
  readonly provider: MemoryProvider;

  constructor(settings?: MemorySettings) {
    const resolved = settings ?? readMemorySettings();
    this.provider = this._resolveProvider(resolved);
  }

  private _resolveProvider(settings: MemorySettings): MemoryProvider {
    const backend = settings.backend ?? "builtin";

    if (backend === "builtin") {
      const p = new BuiltinMemoryProvider(resolveDbPath());
      if (!p.isAvailable()) {
        throw new Error(`Memory provider "${backend}" is not available`);
      }
      return p;
    }

    // External providers are resolved lazily via the plugin system.
    // If no external provider matches, fall back to builtin.
    const external = this._tryLoadExternal(backend);
    if (external) return external;

    console.warn(`[memory] Unknown provider "${backend}", falling back to builtin`);
    return new BuiltinMemoryProvider(resolveDbPath());
  }

  private _tryLoadExternal(_name: string): MemoryProvider | null {
    // Future: load from plugins/memory/<name>/ via dynamic import.
    // For now, only builtin is available.
    return null;
  }

  /** Return structured info about the active provider. */
  getInfo(): ProviderInfo {
    return {
      name: this.provider.name,
      available: this.provider.isAvailable(),
      writable: true,
      searchable: true,
      factCount: this.provider.count(),
    };
  }
}
