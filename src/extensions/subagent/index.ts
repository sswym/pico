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
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { buildChainTask } from "./chain.ts";
import { runWithFallbackModels } from "./fallback.ts";
import { runGateAfterSuccess } from "./gates.ts";
import { spillLargeFileOnlyOutput } from "./output.ts";
import { publishExtensionEvent } from "../events.ts";
import {
	cleanupWorktrees,
	mergeParallelWorktrees,
	prepareParallelWorktrees,
	type WorktreeHandle,
} from "./worktree.ts";
import { mapWithConcurrencyLimit } from "./concurrency.ts";
import {
	createParallelPlaceholders,
	formatParallelProgress,
	summarizeParallelResults,
} from "./parallel.ts";
import {
	applyProcessExit,
	buildAgentProcessArgs,
	createInitialResult,
	createUnknownAgentResult,
	runJsonProcess,
} from "./process.ts";
import {
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	type SingleResult,
	type SubagentDetails,
} from "./results.ts";
import { renderSubagentCall, renderSubagentResult } from "./renderer.ts";
import { tryForkSession } from "./session.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

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
		return createUnknownAgentResult(agentName, task, agents, step);
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult = createInitialResult(agent, agentName, task, step);

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
		}

		const args = buildAgentProcessArgs(agent, task, forkSessionPath, tmpPromptPath ?? undefined);
		const invocation = getPiInvocation(args);
		const processResult = await runJsonProcess({
			command: invocation.command,
			args: invocation.args,
			cwd: cwd ?? defaultCwd,
			result: currentResult,
			signal,
			timeoutMs: agent.maxExecutionTimeMs,
			spawn: (command, args, options) => spawn(command, args, options),
			onMessage: emitUpdate,
		});

		applyProcessExit(currentResult, processResult.exitCode, processResult.timedOut, agent.maxExecutionTimeMs);
		if (processResult.wasAborted) throw new Error("Subagent was aborted");

		try {
			await spillLargeFileOnlyOutput(currentResult, agent.name, agent.outputMode, PER_TASK_OUTPUT_CAP, {
				tmpPrefix: path.join(os.tmpdir(), "srcode-agent-output-"),
				mkdtemp: (prefix) => fs.promises.mkdtemp(prefix),
				writeFile: (filePath, content) => fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 }),
				now: () => Date.now(),
			});
		} catch {
			/* ignore — fall back to inline output */
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
	return await runGateAfterSuccess({
		agent,
		result,
		task,
		runCwd: cwd ?? defaultCwd,
		context: undefined,
		signal,
		runRepair: (agentName, repairTask) => runSingleAgent(
			defaultCwd,
			agents,
			agentName,
			repairTask,
			cwd,
			step,
			signal,
			onUpdate,
			makeDetails,
			forkSessionPath,
		),
	});
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
	return await runWithFallbackModels({
		agents,
		agentName,
		context: undefined,
		signal,
		run: (runAgents) => runSingleAgent(
			defaultCwd,
			runAgents,
			agentName,
			task,
			cwd,
			step,
			signal,
			onUpdate,
			makeDetails,
			forkSessionPath,
		),
		onSuccessOrNoFallback: (agent, result) => checkGateAfterSuccess(
			agent,
			result,
			defaultCwd,
			cwd,
			agents,
			task,
			step,
			signal,
			onUpdate,
			makeDetails,
			forkSessionPath,
		),
	});
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

			const chain = params.chain;
			if (chain && chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				const outputs: Record<string, string> = {};

				for (const [i, step] of chain.entries()) {
					const taskWithContext = buildChainTask(
						step,
						previousOutput,
						outputs,
						(filePath) => fs.readFileSync(filePath, "utf-8"),
					);

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
					publishExtensionEvent("subagent_completed", { task: step.task, result: getResultOutput(result) });

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
				const lastResult = results.at(-1);
				return {
					content: [{ type: "text", text: lastResult ? getFinalOutput(lastResult.messages) || "(no output)" : "(no output)" }],
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

				if (useWorktree) {
					const prepared = prepareParallelWorktrees(ctx.cwd, params.tasks);
					worktreeHandles.splice(0, worktreeHandles.length, ...prepared.handles);
					if (prepared.errorText) {
						return {
							content: [
								{
									type: "text",
									text: prepared.errorText,
								},
							],
							details: makeDetails("parallel")([]),
							isError: true,
						};
					}
				}

				const allResults = createParallelPlaceholders(params.tasks);

				const emitParallelUpdate = () => {
					if (onUpdate) {
						onUpdate({
							content: [
								{ type: "text", text: formatParallelProgress(allResults) },
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

					const mergeNotes = useWorktree ? mergeParallelWorktrees(ctx.cwd, results, worktreeHandles) : [];

					// Fire delegation callback for each subagent result.
					for (let i = 0; i < results.length; i++) {
						const t = params.tasks[i];
						const r = results[i];
						if (t && r) publishExtensionEvent("subagent_completed", { task: t.task, result: getResultOutput(r) });
					}

					const text = summarizeParallelResults(
						results,
						PER_TASK_OUTPUT_CAP,
						useWorktree ? mergeNotes : [],
					);
					return {
						content: [{ type: "text", text }],
						details: makeDetails("parallel")(results),
					};
				} finally {
					if (useWorktree) {
						cleanupWorktrees(worktreeHandles);
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
				publishExtensionEvent("subagent_completed", { task: params.task, result: getResultOutput(result) });
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
			return renderSubagentCall(args, theme);
		},

		renderResult(result, { expanded }, theme, _context) {
			return renderSubagentResult(result, expanded, theme);
		},
	});
}
