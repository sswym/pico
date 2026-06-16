/**
 * Subagent configuration — agent overrides loaded from ~/.srcode/subagent.json.
 *
 * Patterned after hooks/config.ts: missing file is not an error,
 * malformed JSON is logged once and skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { srcodeHome } from "../paths.ts";
import type { AgentConfig } from "./agents.ts";

export interface AgentOverride {
	model?: string;
	thinking?: string;
	maxTokens?: number;
	maxExecutionTimeMs?: number;
	fallbackModels?: string[];
	tools?: string[];
}

export interface SubagentConfig {
	agents?: Record<string, AgentOverride>;
	defaults?: Partial<AgentOverride>;
}

const warnedPaths = new Set<string>();

function warnOnce(path: string, err: unknown): void {
	if (warnedPaths.has(path)) return;
	warnedPaths.add(path);
	const msg = err instanceof Error ? err.message : String(err);
	console.warn(`[srcode subagent] ignoring ${path}: ${msg}`);
}

/** Reset the once-per-path warning cache. Test-only. */
export function __resetWarnedPaths(): void {
	warnedPaths.clear();
}

export function loadSubagentConfig(): SubagentConfig {
	const configPath = join(srcodeHome(), "subagent.json");
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

	return agents.map((agent) => {
		const specific = config.agents?.[agent.name];
		const defaults = config.defaults;
		if (!specific && !defaults) return agent;

		return {
			...agent,
			model: specific?.model ?? defaults?.model ?? agent.model,
			thinking: specific?.thinking ?? defaults?.thinking ?? agent.thinking,
			maxTokens: specific?.maxTokens ?? defaults?.maxTokens ?? agent.maxTokens,
			maxExecutionTimeMs: specific?.maxExecutionTimeMs ?? defaults?.maxExecutionTimeMs ?? agent.maxExecutionTimeMs,
			fallbackModels: specific?.fallbackModels ?? defaults?.fallbackModels ?? agent.fallbackModels,
			tools: specific?.tools ?? agent.tools,
		};
	});
}
