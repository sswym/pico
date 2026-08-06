/**
 * Subagent configuration — agent overrides loaded from ~/.pico/subagent.json.
 *
 * Patterned after hooks/config.ts: missing file is not an error,
 * malformed JSON is logged once and skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { picoHome } from "../paths.ts";
import type { AgentConfig } from "./agents.ts";

export interface AgentOverride {
	model?: string;
	thinking?: string;
	maxTokens?: number;
	maxExecutionTimeMs?: number;
	fallbackModels?: string[];
	tools?: string[];
	/** Soft assistant-request budget: the run is stopped once this many
	 *  turns have been consumed (partial output preserved, stopReason
	 *  "budget"). Mirrors oh-my-pi's softRequestBudget, minus the in-flight
	 *  wrap-up steering (json mode is stdout-only, no stdin injection). */
	maxRequests?: number;
}

export interface ParallelConfig {
	/** Max tasks accepted in one parallel `tasks[]` call. */
	maxTasks?: number;
	/** Max concurrently running subagents. */
	concurrency?: number;
}

export interface SessionsConfig {
	/** Persist each subagent's session file (default true). On success the
	 *  file is deleted; on failure/abort it is kept and the path is reported
	 *  so the run can be continued with `pico --session <path>`. */
	enabled?: boolean;
}

export interface SubagentConfig {
	agents?: Record<string, AgentOverride>;
	defaults?: Partial<AgentOverride>;
	/** Instance-level spawn allowlist. When set, the subagent tool refuses
	 *  agents not listed here (and so do nested subagent processes, which
	 *  inherit the same config). Missing/empty = all agents allowed. */
	spawns?: string[];
	parallel?: ParallelConfig;
	sessions?: SessionsConfig;
}

/** Coerce a config value to a positive integer; invalid values are dropped
 *  (callers fall back to defaults). Exported for orchestrator use. */
export function positiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.trunc(value);
	}
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		if (Number.isFinite(n) && n > 0) return Math.trunc(n);
	}
	return undefined;
}

/** Effective spawn allowlist; undefined = unrestricted. */
export function resolveSpawnWhitelist(config: SubagentConfig): string[] | undefined {
	const spawns = config.spawns;
	if (!Array.isArray(spawns)) return undefined;
	const names = spawns.map((s) => s.trim()).filter(Boolean);
	return names.length > 0 ? names : undefined;
}

const warnedPaths = new Set<string>();
/** Config errors accumulated since the last drain — surfaced to the TUI at
 *  session_start (2.2.2): a malformed subagent.json silently disabled the
 *  user's model/timeout overrides with no visible sign. */
const recentErrors: string[] = [];

function warnOnce(path: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const line = `[pico subagent] ignoring ${path}: ${msg}`;
  console.warn(line);
  recentErrors.push(line);
  if (warnedPaths.has(path)) return;
  warnedPaths.add(path);
}

/** Return and clear the accumulated config errors. */
export function drainSubagentConfigErrors(): string[] {
  return recentErrors.splice(0);
}

/** Reset the once-per-path warning cache. Test-only. */
export function __resetWarnedPaths(): void {
  warnedPaths.clear();
  recentErrors.length = 0;
}

export function loadSubagentConfig(): SubagentConfig {
	const configPath = join(picoHome(), "subagent.json");
	if (!existsSync(configPath)) return {};
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8"));
		if (!raw || typeof raw !== "object") return {};
		return raw as SubagentConfig;
	} catch (err) {
		warnOnce(configPath, err);
		return {};
	}
}

export function applyOverrides(agents: AgentConfig[], config: SubagentConfig): AgentConfig[] {
	if (!config.agents && !config.defaults) return agents;

	// subagent.json is hand-edited; the frontmatter path validates numbers
	// (toNumber, must be > 0) but overrides previously bypassed it — a typo'd
	// "abc"/-1/0 would be passed straight into the child argv. Re-validate.
	const positiveNumber = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

	// A string in these fields would be iterated character-by-character in
	// fallback.ts / joined into tool args — reject non-array values entirely.
	const stringArray = (value: unknown): string[] | undefined =>
		Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;

	return agents.map((agent) => {
		const specific = config.agents?.[agent.name];
		const defaults = config.defaults;
		if (!specific && !defaults) return agent;

		return {
			...agent,
			model: specific?.model ?? defaults?.model ?? agent.model,
			thinking: specific?.thinking ?? defaults?.thinking ?? agent.thinking,
			maxTokens: positiveNumber(specific?.maxTokens ?? defaults?.maxTokens) ?? agent.maxTokens,
			maxExecutionTimeMs:
				positiveNumber(specific?.maxExecutionTimeMs ?? defaults?.maxExecutionTimeMs) ?? agent.maxExecutionTimeMs,
			fallbackModels: stringArray(specific?.fallbackModels ?? defaults?.fallbackModels) ?? agent.fallbackModels,
			tools: stringArray(specific?.tools) ?? agent.tools,
			maxRequests: positiveNumber(specific?.maxRequests ?? defaults?.maxRequests) ?? agent.maxRequests,
		};
	});
}
