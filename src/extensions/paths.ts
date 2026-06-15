/**
 * Shared path helpers for srcode extensions.
 *
 * All user data lives under a single root directory:
 *   - Default: ~/.srcode
 *   - Override: $SRCODE_HOME
 *
 * This replaces the old XDG-based layout (~/.config/srcode) so that agent
 * state, memory, plans, hooks, and sessions are co-located under one roof.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the srcode home directory.
 *
 * Priority:
 *   1. $SRCODE_HOME  (explicit override)
 *   2. ~/.srcode      (default)
 */
export function srcodeHome(): string {
  const override = process.env.SRCODE_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), ".srcode");
}
