/**
 * Agent discovery and configuration
 *
 * Vendored from @earendil-works/pi-coding-agent's example subagent extension,
 * with one pico-specific change: agents bundled at
 * `src/extensions/subagent/agents/` are loaded by default (under the "user"
 * scope) so the four built-in roles work out of the box. User-defined agents
 * in ~/.pico/agent/agents/ still override by name.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { applyOverrides, loadSubagentConfig } from "./config.ts";
import { getEmbeddedContent, getEmbeddedKeys } from "../embedded-assets.ts";

export type AgentScope = "user" | "project" | "both";

export interface AcceptanceConfig {
	criteria?: string[];
	evidence?: Array<{ command: string; expect?: string }>;
	selfRepair?: boolean;
	maxRepairAttempts?: number;
}

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
	thinking?: string; // "low" | "medium" | "high"
	maxExecutionTimeMs?: number; // wall-clock timeout per invocation
	maxTokens?: number; // --max-tokens override
	fallbackModels?: string[]; // ordered list of models to retry on provider failure
	systemPromptMode?: "append" | "replace"; // default "append"
	inheritProjectContext?: boolean; // whether to pass project instructions
	inheritSkills?: boolean; // whether to pass skills catalog
	outputMode?: "inline" | "file-only"; // large output handling
	acceptance?: AcceptanceConfig; // structured acceptance contract
	/** JSON Schema subset (type/required/properties/items) validated against
	 *  the final assistant output; failure marks the run schema_violation. */
	outputSchema?: unknown;
	/** Soft assistant-request budget; the run stops at this many turns. */
	maxRequests?: number;
}

/**
 * Tools a subagent child can use when its frontmatter declares no allowlist
 * (the child runs `pico --mode json` with the default tool set). Only used to
 * compute the denyTools complement — the set is deliberately maintained by
 * hand: omitting a tool here excludes it from the child (safe direction), and
 * the names below are confirmed against pi-coding-agent's core tools plus the
 * tools registered by pico extensions.
 */
export const KNOWN_CHILD_TOOLS = [
	"bash", "read", "write", "edit", "grep", "find", "ls",
	"memory", "webSearch", "webFetch", "web_search_exa", "skill",
	"askUserQuestion", "todoWrite", "subagent", "undo_redo", "lsp", "visionAnalyze",
];

/**
 * Apply the config-level tool deny-list to an agent. Explicit allowlists are
 * filtered; unrestricted agents become restricted to KNOWN_CHILD_TOOLS minus
 * the denied names (a child with no tools frontmatter otherwise inherits the
 * full default tool set, which the deny-list could not constrain).
 */
export function applyDenyTools(agent: AgentConfig, denied: string[]): AgentConfig {
	if (denied.length === 0) return agent;
	if (agent.tools) {
		const filtered = agent.tools.filter((t) => !denied.includes(t));
		return { ...agent, tools: filtered };
	}
	const allowed = KNOWN_CHILD_TOOLS.filter((t) => !denied.includes(t));
	return { ...agent, tools: allowed };
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

const BUILTIN_AGENTS_DIR = resolveBuiltinAgentsDir();

/**
 * Locate the bundled agents/ directory.
 *
 * In source mode (`bun run bin/pico.ts`), `import.meta.url` points to this
 * file, so agents/ is its sibling. In Bun-compiled binaries, `import.meta.url`
 * resolves into `/$bunfs/...`, which is a virtual filesystem that does NOT
 * include .md assets — `fs.readdirSync` on that path returns nothing. The
 * compiled binary ships the agent definitions on disk next to the executable
 * (see scripts/build.ts), so we fall back to `<execDir>/agents` there.
 */
function resolveBuiltinAgentsDir(): string {
	// In embedded (compiled-binary) mode there is no on-disk agents/ dir —
	// agents are loaded from the embedded asset map instead.
	if (getEmbeddedKeys("agents/").length > 0) {
		return ""; // sentinel: will use loadEmbeddedAgents()
	}
	const url = import.meta.url;
	const isBunBinary = url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
	if (isBunBinary) {
		return path.join(path.dirname(process.execPath), "agents");
	}
	return path.join(path.dirname(fileURLToPath(url)), "..", "..", "prompts", "agents");
}

/**
 * Load agents from the embedded asset map (compiled-binary mode).
 * Uses the same frontmatter parsing logic as loadAgentsFromDir.
 */
function loadEmbeddedAgents(): AgentConfig[] {
	const agents: AgentConfig[] = [];
	const keys = getEmbeddedKeys("agents/");
	for (const key of keys) {
		if (!key.endsWith(".md")) continue;
		const content = getEmbeddedContent(key);
		if (!content) continue;

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		const tools =
			typeof frontmatter.tools === "string"
				? frontmatter.tools
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean)
				: undefined;

		const fallbackModels =
			typeof frontmatter.fallbackModels === "string"
				? frontmatter.fallbackModels
						.split(",")
						.map((m) => m.trim())
						.filter(Boolean)
				: Array.isArray(frontmatter.fallbackModels)
					? (frontmatter.fallbackModels as unknown[]).map((m) => String(m).trim()).filter(Boolean)
					: undefined;

		const toNumber = (v: unknown): number | undefined => {
			if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
			if (typeof v === "string") {
				const n = Number(v);
				if (Number.isFinite(n) && n > 0) return n;
			}
			return undefined;
		};
		const toBool = (v: unknown): boolean | undefined => {
			if (typeof v === "boolean") return v;
			if (v === "true") return true;
			if (v === "false") return false;
			return undefined;
		};

		let acceptance: AcceptanceConfig | undefined;
		if (frontmatter.acceptance && typeof frontmatter.acceptance === "object") {
			const a = frontmatter.acceptance as Record<string, unknown>;
			const criteria = Array.isArray(a.criteria)
				? (a.criteria as unknown[]).map((c) => String(c)).filter(Boolean)
				: undefined;
			const evidence = Array.isArray(a.evidence)
				? (a.evidence as unknown[])
						.filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
						.map((e) => ({
							command: String(e.command ?? "").trim(),
							expect: typeof e.expect === "string" ? e.expect : undefined,
						}))
						.filter((e) => e.command.length > 0)
				: undefined;
			if ((criteria?.length ?? 0) > 0 || (evidence?.length ?? 0) > 0) {
				acceptance = {
					criteria,
					evidence,
					selfRepair: toBool(a.selfRepair),
					maxRepairAttempts: toNumber(a.maxRepairAttempts),
				};
			}
		}

		const outputMode = frontmatter.outputMode === "file-only" ? "file-only" : undefined;
		const outputSchema =
			frontmatter.output && typeof frontmatter.output === "object" ? frontmatter.output : undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source: "user",
			filePath: `<embedded>/${key}`,
			thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
			maxExecutionTimeMs: toNumber(frontmatter.maxExecutionTimeMs),
			maxTokens: toNumber(frontmatter.maxTokens),
			fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
			systemPromptMode: frontmatter.systemPromptMode === "replace" ? "replace" : undefined,
			inheritProjectContext: toBool(frontmatter.inheritProjectContext),
			inheritSkills: toBool(frontmatter.inheritSkills),
			outputMode,
			acceptance,
			outputSchema,
			maxRequests: toNumber(frontmatter.maxRequests),
		});
	}
	return agents;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		// One malformed file (tab indentation, duplicate keys) must not break
		// the whole agent registry — skip it with a hint instead of throwing
		// a bare YAML parse error on every subagent tool call.
		let frontmatter: Record<string, unknown>;
		let body: string;
		try {
			const parsed = parseFrontmatter<Record<string, unknown>>(content);
			frontmatter = parsed.frontmatter;
			body = parsed.body;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[pico subagent] skipping agent file ${filePath}: invalid frontmatter (${message})`);
			continue;
		}

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		const tools =
			typeof frontmatter.tools === "string"
				? frontmatter.tools
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean)
				: undefined;

		const fallbackModels =
			typeof frontmatter.fallbackModels === "string"
				? frontmatter.fallbackModels
						.split(",")
						.map((m) => m.trim())
						.filter(Boolean)
				: Array.isArray(frontmatter.fallbackModels)
					? (frontmatter.fallbackModels as unknown[]).map((m) => String(m).trim()).filter(Boolean)
					: undefined;

		const toNumber = (v: unknown): number | undefined => {
			if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
			if (typeof v === "string") {
				const n = Number(v);
				if (Number.isFinite(n) && n > 0) return n;
			}
			return undefined;
		};
		const toBool = (v: unknown): boolean | undefined => {
			if (typeof v === "boolean") return v;
			if (v === "true") return true;
			if (v === "false") return false;
			return undefined;
		};

		// Acceptance gate (structured contract for output verification)
		let acceptance: AcceptanceConfig | undefined;
		if (frontmatter.acceptance && typeof frontmatter.acceptance === "object") {
			const a = frontmatter.acceptance as Record<string, unknown>;
			const criteria = Array.isArray(a.criteria)
				? (a.criteria as unknown[]).map((c) => String(c)).filter(Boolean)
				: undefined;
			const evidence = Array.isArray(a.evidence)
				? (a.evidence as unknown[])
						.filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
						.map((e) => ({
							command: String(e.command ?? "").trim(),
							expect: typeof e.expect === "string" ? e.expect : undefined,
						}))
						.filter((e) => e.command.length > 0)
				: undefined;
			if ((criteria?.length ?? 0) > 0 || (evidence?.length ?? 0) > 0) {
				acceptance = {
					criteria,
					evidence,
					selfRepair: toBool(a.selfRepair),
					maxRepairAttempts: toNumber(a.maxRepairAttempts),
				};
			}
		}

		// "outputMode" field: only "file-only" is meaningful; everything else stays inline.
		const outputMode = frontmatter.outputMode === "file-only" ? "file-only" : undefined;
		const outputSchema =
			frontmatter.output && typeof frontmatter.output === "object" ? frontmatter.output : undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
			thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
			maxExecutionTimeMs: toNumber(frontmatter.maxExecutionTimeMs),
			maxTokens: toNumber(frontmatter.maxTokens),
			fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
			systemPromptMode: frontmatter.systemPromptMode === "replace" ? "replace" : undefined,
			inheritProjectContext: toBool(frontmatter.inheritProjectContext),
			inheritSkills: toBool(frontmatter.inheritSkills),
			outputMode,
			acceptance,
			outputSchema,
			maxRequests: toNumber(frontmatter.maxRequests),
		});
	}
	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pico", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// Builtins are loaded first under the "user" scope; same-named entries from
	// ~/.pico/agent/agents/ replace them via Map.set().
	// In embedded mode (BUILTIN_AGENTS_DIR === ""), load from the asset map.
	const builtinAgents = scope === "project" ? [] : BUILTIN_AGENTS_DIR === "" ? loadEmbeddedAgents() : loadAgentsFromDir(BUILTIN_AGENTS_DIR, "user");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of builtinAgents) agentMap.set(agent.name, agent);
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of builtinAgents) agentMap.set(agent.name, agent);
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	const rawAgents = Array.from(agentMap.values());

	// Apply overrides from ~/.pico/subagent.json
	const config = loadSubagentConfig();
	const finalAgents = applyOverrides(rawAgents, config);

	return { agents: finalAgents, projectAgentsDir };
}
