import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { allowUnattendedProjectAgents } from "../policy.ts";
import { buildChainTask } from "./chain.ts";
import { mapWithConcurrencyLimit } from "./concurrency.ts";
import { runWithFallbackModels } from "./fallback.ts";
import { runGateAfterSuccess } from "./gates.ts";
import { spillLargeFileOnlyOutput } from "./output.ts";
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
import { tryForkSession } from "./session.ts";
import {
	cleanupWorktrees,
	mergeParallelWorktrees,
	prepareParallelWorktrees,
	type WorktreeHandle,
} from "./worktree.ts";
import { publishExtensionEvent } from "../events.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
type SubagentToolResult = AgentToolResult<SubagentDetails> & { isError?: boolean };

export interface SubagentTaskItem {
	agent: string;
	task: string;
	cwd?: string;
	context?: "fresh" | "fork";
}

export interface SubagentChainItem extends SubagentTaskItem {
	label?: string;
	model?: string;
	output?: string;
	reads?: string[];
	phase?: string;
}

export interface SubagentRequest {
	agent?: string;
	task?: string;
	tasks?: SubagentTaskItem[];
	chain?: SubagentChainItem[];
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
	context?: "fresh" | "fork";
	isolation?: "none" | "worktree";
}

export interface SubagentRunContext {
	cwd: string;
	hasUI?: boolean;
	ui: {
		confirm(title: string, message: string): Promise<boolean>;
	};
	sessionManager?: unknown;
}

interface AgentRunRequest {
	agentName: string;
	task: string;
	cwd?: string;
	step?: number;
}

interface AgentRunSupport {
	defaultCwd: string;
	agents: AgentConfig[];
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	forkSessionPath?: string;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pico-subagent-"));
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

	return { command: "pico", args };
}

async function runSingleAgent(
	request: AgentRunRequest,
	support: AgentRunSupport,
): Promise<SingleResult> {
	const { agentName, task, cwd, step } = request;
	const { defaultCwd, agents, signal, onUpdate, makeDetails, forkSessionPath } = support;
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		return createUnknownAgentResult(agentName, task, agents, step);
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	/** Removes the spilled large-output temp dir (if any) in the finally. */
	let spillCleanup: (() => void) | undefined;

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
			spillCleanup = await spillLargeFileOnlyOutput(currentResult, agent.name, agent.outputMode, PER_TASK_OUTPUT_CAP, {
				tmpPrefix: path.join(os.tmpdir(), "pico-agent-output-"),
				mkdtemp: (prefix) => fs.promises.mkdtemp(prefix),
				writeFile: (filePath, content) => fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 }),
				now: () => Date.now(),
			});
		} catch {
			/* ignore - fall back to inline output */
		}

		return currentResult;
	} finally {
		if (spillCleanup)
			try {
				spillCleanup();
			} catch {
				/* ignore */
			}
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

async function checkGateAfterSuccess(
	agent: AgentConfig | undefined,
	result: SingleResult,
	request: AgentRunRequest,
	support: AgentRunSupport,
): Promise<SingleResult> {
	return await runGateAfterSuccess({
		agent,
		result,
		task: request.task,
		runCwd: request.cwd ?? support.defaultCwd,
		context: undefined,
		signal: support.signal,
		runRepair: (agentName, repairTask) => runSingleAgent({
			agentName,
			task: repairTask,
			cwd: request.cwd,
			step: request.step,
		}, support),
	});
}

async function runWithFallback(
	request: AgentRunRequest,
	support: AgentRunSupport,
): Promise<SingleResult> {
	return await runWithFallbackModels({
		agents: support.agents,
		agentName: request.agentName,
		context: undefined,
		signal: support.signal,
		run: (runAgents) => runSingleAgent(request, { ...support, agents: runAgents }),
		onSuccessOrNoFallback: (agent, result) => checkGateAfterSuccess(agent, result, request, support),
	});
}

export async function runSubagentRequest(
	params: SubagentRequest,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	ctx: SubagentRunContext,
): Promise<SubagentToolResult> {
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

	if ((agentScope === "project" || agentScope === "both") && (confirmProjectAgents || !ctx.hasUI)) {
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

			if (!ctx.hasUI) {
				// Non-interactive runs (CI, --print) cannot confirm — refuse
				// unless explicitly opted in, mirroring plan-mode's
				// PICO_ALLOW_UNATTENDED_PLAN_APPROVAL gate.
				if (!allowUnattendedProjectAgents()) {
					return {
						content: [
							{
								type: "text",
								text:
									"Canceled: project-local agents need approval in this non-interactive run. " +
									"Set PICO_ALLOW_UNATTENDED_PROJECT_AGENTS=1 to allow them.",
							},
						],
						details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
					};
				}
			} else {
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

			const stepAgents = step.model
				? agents.map((a) => (a.name === step.agent ? { ...a, model: step.model } : a))
				: agents;

			let stepForkPath: string | undefined;
			let stepForkFallback: string | undefined;
			if (step.context === "fork") {
				stepForkPath = tryForkSession(ctx.sessionManager);
				if (!stepForkPath) stepForkFallback = "context=fork requested but session forking unavailable; using fresh context";
			}

			const chainUpdate: OnUpdateCallback | undefined = onUpdate
				? (partial) => {
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
				{ agentName: step.agent, task: taskWithContext, cwd: step.cwd, step: i + 1 },
				{
					defaultCwd: ctx.cwd,
					agents: stepAgents,
					signal,
					onUpdate: chainUpdate,
					makeDetails: makeDetails("chain"),
					forkSessionPath: stepForkPath,
				},
			);

			if (step.label) result.label = step.label;
			if (step.phase) result.phase = step.phase;
			if (stepForkFallback) result.contextFallback = stepForkFallback;

			results.push(result);
			publishExtensionEvent("subagent_completed", { task: step.task, result: getResultOutput(result) });

			const isError = isFailedResult(result);
			if (isError) {
				const errorMsg = getResultOutput(result);
				// Throw instead of returning an isError flag: the agent loop only
				// derives isError from thrown exceptions, so a returned flag is
				// silently dropped and the failure renders as a success.
				throw new Error(`Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`);
			}
			previousOutput = getFinalOutput(result.messages);

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
				throw new Error(prepared.errorText);
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
				const handle = worktreeHandles[index];
				const taskCwd = handle ? handle.worktreeDir : t.cwd;

				let forkPath: string | undefined;
				let forkFallbackNote: string | undefined;
				if (t.context === "fork") {
					forkPath = tryForkSession(ctx.sessionManager);
					if (!forkPath) forkFallbackNote = "context=fork requested but session forking unavailable; using fresh context";
				}

				const result = await runWithFallback(
					{ agentName: t.agent, task: t.task, cwd: taskCwd },
					{
						defaultCwd: ctx.cwd,
						agents,
						signal,
						onUpdate: (partial) => {
						if (partial.details?.results[0]) {
							allResults[index] = partial.details.results[0];
							emitParallelUpdate();
						}
						},
						makeDetails: makeDetails("parallel"),
						forkSessionPath: forkPath,
					},
				);
				if (forkFallbackNote) result.contextFallback = forkFallbackNote;
				allResults[index] = result;
				emitParallelUpdate();
				return result;
			});

			const mergeNotes = useWorktree ? mergeParallelWorktrees(ctx.cwd, results, worktreeHandles) : [];

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
			forkPath = tryForkSession(ctx.sessionManager);
			if (!forkPath) forkFallbackNote = "context=fork requested but session forking unavailable; using fresh context";
		}
		const result = await runWithFallback(
			{ agentName: params.agent, task: params.task, cwd: params.cwd },
			{
				defaultCwd: ctx.cwd,
				agents,
				signal,
				onUpdate,
				makeDetails: makeDetails("single"),
				forkSessionPath: forkPath,
			},
		);
		publishExtensionEvent("subagent_completed", { task: params.task, result: getResultOutput(result) });
		if (forkFallbackNote) result.contextFallback = forkFallbackNote;
		const isError = isFailedResult(result);
		if (isError) {
			const errorMsg = getResultOutput(result);
			throw new Error(`Agent ${result.stopReason || "failed"}: ${errorMsg}`);
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
}
