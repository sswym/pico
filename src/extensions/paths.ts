/**
 * Shared path helpers for pico extensions.
 *
 * All user data lives under a single root directory:
 *   - Default: ~/.pico
 *   - Override: $PICO_HOME
 *
 * This replaces the old XDG-based layout (~/.config/pico) so that agent
 * state, memory, plans, hooks, and sessions are co-located under one roof.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the pico home directory.
 *
 * Priority:
 *   1. $PICO_HOME  (explicit override)
 *   2. ~/.pico      (default)
 */
export function picoHome(): string {
  const override = process.env.PICO_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), ".pico");
}

export function picoAgentHome(): string {
  return join(picoHome(), "agent");
}

export function picoSessionDir(): string {
  return join(picoAgentHome(), "sessions");
}

export function picoSettingsPath(): string {
  return join(picoAgentHome(), "settings.json");
}

export function picoModelsPath(): string {
  return join(picoAgentHome(), "models.json");
}

export function picoInputHistoryPath(): string {
  return join(picoAgentHome(), "input-history.jsonl");
}

export function picoMemoryDbPath(): string {
  return process.env.PICO_MEMORY_DB ?? join(picoHome(), "memory.db");
}

export function picoHolographicMemoryPath(): string {
  // Deliberately a separate env var from PICO_MEMORY_DB: the two backends
  // write incompatible formats (SQLite vs JSON), so sharing a path would let
  // one backend overwrite the other's data file.
  return process.env.PICO_HOLOGRAPHIC_MEMORY_PATH ?? join(picoHome(), "holographic-memory.json");
}

export function picoMcpConfigPath(): string {
  return join(picoHome(), "mcp-servers.json");
}

export function picoLspConfigPath(): string {
  return join(picoHome(), "lsp.json");
}
