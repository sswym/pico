// @ts-nocheck — vendored from @earendil-works/pi-coding-agent's example;
// the upstream code relies on permissive index-access and is type-clean
// against its own bundle but not under srcode's stricter tsconfig
// (noUncheckedIndexedAccess, exact-optional). Behaviour is unchanged.
/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { checkAcceptanceGate } from "./gates.ts";
import { fireDelegationCallback } from "../memory/delegation-registry.ts";
import { createWorktree, getWorktreeDiff, mergeWorktree, type WorktreeHandle } from "./worktree.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	label?: string;
	phase?: string;
	outputFile?: string;
	contextFallback?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "timeout" || result.stopReason === "gate_failed";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "srcode-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "srcode", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Attempt to fork the current session into a new branched session file so a
 * subagent can inherit the parent's conversation history. Returns the forked
 * session file path, or undefined if forking isn't possible (no session
 * manager, no leaf id, no persisted session, or the API rejects the call).
 */
function tryForkSession(sessionManager: any): string | undefined {
	if (!sessionManager) return undefined;
	try {
		const leafId =
			typeof sessionManager.getLeafId === "function" ? sessionManager.getLeafId() : undefined;
		if (!leafId) return undefined;
		// createBranchedSession is only on the full SessionManager, not the
		// readonly view. Guard against undefined.
		if (typeof sessionManager.createBranchedSession !== "function") return undefined;
		const forkedPath = sessionManager.createBranchedSession(leafId);
		return typeof forkedPath === "string" && forkedPath.length > 0 ? forkedPath : undefined;
	} catch {
		return undefined;
	}
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	forkSessionPath?: string,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p"];
	if (forkSessionPath) {
		args.push("--session", forkSessionPath);
	} else {
		args.push("--no-session");
	}
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (agent.maxTokens) args.push("--max-tokens", String(agent.maxTokens));
	if (agent.thinking) args.push("--thinking", agent.thinking);

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;
		let timedOut = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const killProc = (reason: "abort" | "timeout") => {
				if (reason === "abort") wasAborted = true;
				else timedOut = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				resolve(1);
			});

			if (signal) {
				if (signal.aborted) killProc("abort");
				else signal.addEventListener("abort", () => killProc("abort"), { once: true });
			}

			if (agent.maxExecutionTimeMs && agent.maxExecutionTimeMs > 0) {
				timeoutHandle = setTimeout(() => killProc("timeout"), agent.maxExecutionTimeMs);
			}
		});

		currentResult.exitCode = exitCode;
		if (timedOut) {
			currentResult.stopReason = "timeout";
			currentResult.errorMessage = `Agent exceeded maxExecutionTimeMs (${agent.maxExecutionTimeMs}ms)`;
		}
		if (wasAborted) throw new Error("Subagent was aborted");

		// File-only output mode: when output exceeds the cap, persist it to a
		// temp file and shorten the assistant text to a reference. This keeps
		// large outputs out of the orchestrator's context window.
		if (
			agent.outputMode === "file-only" &&
			!isFailedResult(currentResult)
		) {
			const finalOutput = getFinalOutput(currentResult.messages);
			if (Buffer.byteLength(finalOutput, "utf8") > PER_TASK_OUTPUT_CAP) {
				try {
					const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "srcode-agent-output-"));
					const safeName = agent.name.replace(/[^\w.-]+/g, "_");
					const outFile = path.join(tmpDir, `output-${safeName}-${Date.now()}.md`);
					await fs.promises.writeFile(outFile, finalOutput, { encoding: "utf-8", mode: 0o600 });
					currentResult.outputFile = outFile;
					// Replace the final assistant text with a short reference so
					// the orchestrator sees only the file pointer and a preview.
					const preview = finalOutput.slice(0, 2048);
					const reference = `Output written to file (${Buffer.byteLength(finalOutput, "utf8")} bytes): ${outFile}\n\n--- Preview (first 2KB) ---\n${preview}`;
					for (let i = currentResult.messages.length - 1; i >= 0; i--) {
						const msg = currentResult.messages[i];
						if (msg.role === "assistant") {
							for (let j = msg.content.length - 1; j >= 0; j--) {
								const part = msg.content[j];
								if (part.type === "text") {
									msg.content[j] = { ...part, text: reference };
									break;
								}
							}
							break;
						}
					}
				} catch {
					/* ignore — fall back to inline output */
				}
			}
		}

		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

/**
 * After a successful run (or after fallback retries succeed), evaluate the
 * acceptance gate if the agent has one. On gate failure with selfRepair=true,
 * re-invoke the agent with failure details appended to the task.
 */
async function checkGateAfterSuccess(
	agent: AgentConfig | undefined,
	result: SingleResult,
	defaultCwd: string,
	cwd: string | undefined,
	agents: AgentConfig[],
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	forkSessionPath?: string,
): Promise<SingleResult> {
	if (!agent?.acceptance || isFailedResult(result)) return result;

	const acceptance = agent.acceptance;
	const runCwd = cwd ?? defaultCwd;
	const gateResult = await checkAcceptanceGate(acceptance, runCwd, signal);
	if (gateResult.passed) return result;

	const summarizeFailure = () => {
		const failed = gateResult.evidenceResults.filter((e) => !e.passed);
		const lines: string[] = [];
		if (gateResult.failedCriteria.length > 0) {
			lines.push(`Failed criteria: ${gateResult.failedCriteria.join("; ")}`);
		}
		if (failed.length > 0) {
			lines.push("Failed evidence:");
			for (const e of failed) {
				lines.push(`- $ ${e.command}\n  ${e.output.split("\n").slice(0, 5).join("\n  ")}`);
			}
		}
		return lines.join("\n");
	};

	if (!acceptance.selfRepair) {
		result.stopReason = "gate_failed";
		result.errorMessage = `Acceptance gate failed.\n${summarizeFailure()}`;
		return result;
	}

	const maxAttempts = acceptance.maxRepairAttempts ?? 1;
	let lastResult = result;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (signal?.aborted) break;
		const repairTask = [
			task,
			"",
			"## Acceptance gate failed (self-repair attempt " + attempt + " of " + maxAttempts + ")",
			summarizeFailure(),
			"",
			"Please fix the issues above and complete the task. The same checks will run again.",
		].join("\n");
		const repairResult = await runSingleAgent(
			defaultCwd,
			agents,
			agent.name,
			repairTask,
			cwd,
			step,
			signal,
			onUpdate,
			makeDetails,
		);
		lastResult = repairResult;
		if (!isFailedResult(repairResult)) {
			const recheck = await checkAcceptanceGate(acceptance, runCwd, signal);
			if (recheck.passed) return repairResult;
		}
	}

	lastResult.stopReason = "gate_failed";
	lastResult.errorMessage = `Acceptance gate failed after ${maxAttempts} self-repair attempt(s).\n${summarizeFailure()}`;
	return lastResult;
}

/**
 * Run a single agent with fallback model retry on provider failures.
 *
 * Only retries when the agent has `fallbackModels` and the failure looks like
 * a provider error (rate limit, overloaded, 503/429/529/capacity). Ordinary
 * tool errors, timeouts, and aborts are returned as-is.
 */
async function runWithFallback(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	forkSessionPath?: string,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	const result = await runSingleAgent(
		defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, forkSessionPath,
	);

	// If the agent succeeded or has no fallbacks, return as-is.
	if (!isFailedResult(result) || !agent?.fallbackModels?.length) {
		// Check acceptance gate on success
		return await checkGateAfterSuccess(agent, result, defaultCwd, cwd, agents, task, step, signal, onUpdate, makeDetails, forkSessionPath);
	}

	// Only retry on provider failures (not timeout, abort, or tool errors).
	const isProviderError = result.stopReason === "error" &&
		/rate[\s._-]?limit|overloaded|503|429|529|capacity|quota/i.test(result.errorMessage || "");
	if (!isProviderError) return result;

	// Try each fallback model in order.
	for (const fallbackModel of agent.fallbackModels) {
		if (signal?.aborted) break;
		const fallbackAgent = { ...agent, model: fallbackModel, fallbackModels: undefined };
		const fallbackAgents = agents.map((a) => a.name === agentName ? fallbackAgent : a);
		const fallbackResult = await runSingleAgent(
			defaultCwd, fallbackAgents, agentName, task, cwd, step, signal, onUpdate, makeDetails, forkSessionPath,
		);
		if (!isFailedResult(fallbackResult)) return fallbackResult;
	}

	// All fallbacks failed; return the original failure.
	return result;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: '"fork" to inherit parent session context, "fresh" for clean context' })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} or {outputs.name} placeholders" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	label: Type.Optional(Type.String({ description: "Human-readable step label" })),
	model: Type.Optional(Type.String({ description: "Override agent model for this step" })),
	output: Type.Optional(Type.String({ description: "Named output key, referenceable as {outputs.key} in later steps" })),
	reads: Type.Optional(Type.Array(Type.String(), { description: "File paths to inject as context for this step" })),
	phase: Type.Optional(Type.String({ description: "Logical phase (e.g., 'research', 'implement', 'verify')" })),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: '"fork" to inherit parent session context' })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: '"fork" to inherit parent session context. Default: fresh.' })),
	isolation: Type.Optional(StringEnum(["none", "worktree"] as const, { description: '"worktree" to isolate parallel tasks in git worktrees. Default: none.', default: "none" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"",
			"## When to use",
			"- Multi-phase tasks (research → plan → implement → verify) → chain mode",
			"- 3+ independent sub-tasks that don't share files → parallel mode (one worker/reviewer per task)",
			"- Exploration that would dominate main context (>10 file reads or >50 grep calls) → single mode (scout/worker) for context isolation",
			"- Tasks needing an independent perspective (review, audit, second opinion) → single mode (reviewer/oracle)",
			"- Tasks with explicit acceptance criteria (tests must pass, lint must be clean) → single mode (worker with acceptance gate)",
			"",
			"## When NOT to use",
			"- Tasks under 3 file reads — direct execution is faster and cheaper",
			"- Tasks where cross-file context is essential and can't be summarized for handoff",
			"- Trivial edits, single-line fixes, or simple Q&A",
			"",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} and {outputs.name} placeholders).",
			"Built-in agents: scout, planner, worker, reviewer, oracle, researcher.",
			"Agent frontmatter supports: model, tools, thinking, maxExecutionTimeMs, maxTokens, fallbackModels, systemPromptMode, inheritProjectContext, inheritSkills, acceptance.",
			"User-level overrides may live in ~/.srcode/agent/agents/<name>.md (same name = replaces built-in) or ~/.srcode/subagent.json (partial field overrides).",
			'Project-local agents in .srcode/agents are opt-in: set agentScope: "both" (or "project").',
			"Do NOT shell out to `ls` to discover agents — call this tool with an obviously wrong agent name to get the authoritative list, or just trust the six built-ins above.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				const outputs: Record<string, string> = {};

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];

					// Variable substitution: {previous} and {outputs.key}
					let taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
					taskWithContext = taskWithContext.replace(
						/\{outputs\.(\w+)\}/g,
						(_, key) => outputs[key] ?? `(output "${key}" not found)`,
					);

					// Inject reads context (file contents prepended to the task)
					if (step.reads && step.reads.length > 0) {
						const readSections: string[] = [];
						for (const filePath of step.reads) {
							try {
								const content = fs.readFileSync(filePath, "utf-8");
								readSections.push(`--- File: ${filePath} ---\n${content}`);
							} catch (err: any) {
								readSections.push(`--- File: ${filePath} (could not read: ${err.message}) ---`);
							}
						}
						taskWithContext = `## Context (read into prompt)\n\n${readSections.join("\n\n")}\n\n## Task\n\n${taskWithContext}`;
					}

					// Step-level model override
					const stepAgents = step.model
						? agents.map((a) => (a.name === step.agent ? { ...a, model: step.model } : a))
						: agents;

					// Per-step session forking, falling back to fresh context.
					let stepForkPath: string | undefined;
					let stepForkFallback: string | undefined;
					if (step.context === "fork") {
						stepForkPath = tryForkSession((ctx as any).sessionManager);
						if (!stepForkPath) stepForkFallback = "context=fork requested but session forking unavailable; using fresh context";
					}

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runWithFallback(
						ctx.cwd,
						stepAgents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						stepForkPath,
					);

					// Annotate the result with chain step metadata for rendering
					if (step.label) result.label = step.label;
					if (step.phase) result.phase = step.phase;
					if (stepForkFallback) result.contextFallback = stepForkFallback;

					results.push(result);
					fireDelegationCallback(step.task, getResultOutput(result));

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);

					// Store named output for later substitution
					if (step.output) {
						outputs[step.output] = previousOutput;
					}
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				const useWorktree = params.isolation === "worktree";
				const worktreeHandles: Array<WorktreeHandle | null> = new Array(params.tasks.length).fill(null);
				const worktreeErrors: string[] = [];

				if (useWorktree) {
					for (let i = 0; i < params.tasks.length; i++) {
						try {
							const t = params.tasks[i];
							worktreeHandles[i] = createWorktree(ctx.cwd, t.agent, i);
						} catch (err: any) {
							worktreeErrors.push(`task ${i} (${params.tasks[i].agent}): ${err.message || err}`);
						}
					}
					if (worktreeErrors.length > 0) {
						// Roll back any worktrees we did create before bailing.
						for (const h of worktreeHandles) {
							if (h) try { h.cleanup(); } catch {}
						}
						return {
							content: [
								{
									type: "text",
									text: `Failed to set up git worktrees:\n${worktreeErrors.join("\n")}`,
								},
							],
							details: makeDetails("parallel")([]),
							isError: true,
						};
					}
				}

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				try {
					const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
						// Per-task working directory: worktree dir wins over explicit cwd.
						const handle = worktreeHandles[index];
						const taskCwd = handle ? handle.worktreeDir : t.cwd;

						// Per-task fork session if requested.
						let forkPath: string | undefined;
						let forkFallbackNote: string | undefined;
						if (t.context === "fork") {
							forkPath = tryForkSession((ctx as any).sessionManager);
							if (!forkPath) forkFallbackNote = "context=fork requested but session forking unavailable; using fresh context";
						}

						const result = await runWithFallback(
							ctx.cwd,
							agents,
							t.agent,
							t.task,
							taskCwd,
							undefined,
							signal,
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
							forkPath,
						);
						if (forkFallbackNote) result.contextFallback = forkFallbackNote;
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					});

					// Worktree merge phase (best-effort, post-completion).
					const mergeNotes: string[] = [];
					if (useWorktree) {
						for (let i = 0; i < results.length; i++) {
							const handle = worktreeHandles[i];
							if (!handle) continue;
							const r = results[i];
							if (isFailedResult(r)) {
								mergeNotes.push(`task ${i} (${r.agent}): skipped merge (task failed)`);
								continue;
							}
							const diff = getWorktreeDiff(ctx.cwd, handle.branchName);
							if (!diff.trim()) {
								mergeNotes.push(`task ${i} (${r.agent}): no changes to merge`);
								continue;
							}
							const merge = mergeWorktree(ctx.cwd, handle.branchName);
							if (merge.success) {
								mergeNotes.push(`task ${i} (${r.agent}): merged\n${diff.trimEnd()}`);
							} else {
								mergeNotes.push(`task ${i} (${r.agent}): ${merge.conflict}`);
							}
						}
					}

					// Fire delegation callback for each subagent result.
					for (let i = 0; i < results.length; i++) {
						const t = params.tasks[i];
						const r = results[i];
						if (t && r) fireDelegationCallback(t.task, getResultOutput(r));
					}

					const successCount = results.filter((r) => !isFailedResult(r)).length;
					const summaries = results.map((r) => {
						const output = truncateParallelOutput(getResultOutput(r));
						const status = isFailedResult(r)
							? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
							: "completed";
						const noteLine = r.contextFallback ? `\n_note: ${r.contextFallback}_\n` : "";
						return `### [${r.agent}] ${status}${noteLine}\n\n${output}`;
					});
					let text = `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`;
					if (useWorktree && mergeNotes.length > 0) {
						text += `\n\n---\n\n## Worktree merges\n\n${mergeNotes.join("\n\n")}`;
					}
					return {
						content: [{ type: "text", text }],
						details: makeDetails("parallel")(results),
					};
				} finally {
					if (useWorktree) {
						for (const h of worktreeHandles) {
							if (h) try { h.cleanup(); } catch {}
						}
					}
				}
			}

			if (params.agent && params.task) {
				let forkPath: string | undefined;
				let forkFallbackNote: string | undefined;
				if (params.context === "fork") {
					forkPath = tryForkSession((ctx as any).sessionManager);
					if (!forkPath) forkFallbackNote = "context=fork requested but session forking unavailable; using fresh context";
				}
				const result = await runWithFallback(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					forkPath,
				);
				// Fire delegation callback for single subagent result.
				fireDelegationCallback(params.task, getResultOutput(result));
				if (forkFallbackNote) result.contextFallback = forkFallbackNote;
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				const fallbackPrefix = forkFallbackNote ? `_note: ${forkFallbackNote}_\n\n` : "";
				return {
					content: [{ type: "text", text: fallbackPrefix + (getFinalOutput(result.messages) || "(no output)") }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						const stepLabel = r.label ? r.label : `Step ${r.step}`;
						const phaseTag = r.phase ? theme.fg("warning", `[${r.phase}] `) : "";
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── ${stepLabel}: `) + phaseTag + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const stepLabel = r.label ? r.label : `Step ${r.step}`;
					const phaseTag = r.phase ? theme.fg("warning", `[${r.phase}] `) : "";
					text += `\n\n${theme.fg("muted", `─── ${stepLabel}: `)}${phaseTag}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
