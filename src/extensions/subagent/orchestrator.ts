import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentScope, applyDenyTools, discoverAgents } from "./agents.ts";
import { allowUnattendedProjectAgents } from "../policy.ts";
import { buildChainTask, findUnresolvedChainReferences } from "./chain.ts";
import { acquireChildSlot, mapWithConcurrencyLimit } from "./concurrency.ts";
import { loadSubagentConfig, positiveInt, resolveDenyAgents, resolveDenyTools, resolveSpawnWhitelist } from "./config.ts";
import { runWithFallbackModels } from "./fallback.ts";
import { runGateAfterSuccess } from "./gates.ts";
import { cancelRunningJobs, createJobId, failJob, getJob, registerJob, settleJob, waitForJobs } from "./jobs.ts";
import {
	SUBAGENT_CHANNEL_DIR_ENV,
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_RUN_ID_ENV,
	createChannelDir,
	createRunId,
} from "./supervisor-channel.ts";
import { spillLargeFileOnlyOutput } from "./output.ts";
import { validateOutputSchema } from "./schema.ts";
import { picoSubagentSessionDir } from "../paths.ts";
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
	subagentChildEnv,
	type SpawnedProcessLike,
} from "./process.ts";
import {
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	truncateOutput,
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
/** Default per-agent timeout (2.4.2): none of the built-in agents set
 *  maxExecutionTimeMs, so a hung model loop previously ran forever.
 *  Frontmatter/config can override. */
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

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
	list?: boolean;
	agent?: string;
	task?: string;
	tasks?: SubagentTaskItem[];
	chain?: SubagentChainItem[];
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
	context?: "fresh" | "fork";
	isolation?: "none" | "worktree";
	/** Shared background prepended to every parallel task (tasks mode). */
	sharedContext?: string;
	/** Launch as a background job (single mode only): returns a job id
	 *  immediately; collect the result later via the subagent_wait tool. */
	async?: boolean;
	/** Path to a saved subagent session file (from a previous failed run) to
	 *  continue instead of starting fresh. Single mode only. */
	resumeFrom?: string;
}

/** Child-process spawn signature, mirroring RunJsonProcessOptions.spawn. */
export type ChildSpawnFn = (
	command: string,
	args: string[],
	options: { cwd: string; shell: false; stdio: ["ignore", "pipe", "pipe"]; detached: true },
) => SpawnedProcessLike;

export interface SubagentRunContext {
	cwd: string;
	hasUI?: boolean;
	ui: {
		confirm(title: string, message: string): Promise<boolean>;
	};
	sessionManager?: unknown;
	/** Test seam: override the child process spawn (default: real spawn). */
	spawnProcess?: ChildSpawnFn;
}

/**
 * Wrap a parallel-run failure with the sibling results that finished before
 * the abort — one task failing must not make already-completed work vanish.
 * With no finished siblings the original error is returned untouched.
 */
export function describeSiblingResults(finished: SingleResult[], error: unknown): Error {
	const msg = error instanceof Error ? error.message : String(error);
	if (finished.length === 0) return error instanceof Error ? error : new Error(msg);
	const siblingSummary = finished
		.map((r) => `- [${r.agent}] ${truncateOutput(getResultOutput(r), 400)}`)
		.join("\n");
	return new Error(`${msg}\n\nSibling results from before the abort (${finished.length}):\n${siblingSummary}`);
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
	/** Parent dir for per-run session files; undefined disables session
	 *  persistence (--no-session). */
	persistSessionDir?: string;
	/** Session key for spawn accounting and async job registration. */
	sessionKey: string;
	/** Global cap on in-flight children (settings "subagent"). */
	globalConcurrencyLimit?: number;
	/** Per-session spawn cap (settings "subagent"); exceeded runs fail fast. */
	maxSpawnsPerSession?: number;
	/** Test seam: override the child spawn. */
	spawnProcess?: ChildSpawnFn;
	/** Pre-created supervisor channel (async jobs: parent needs the dir to
	 *  steer the run); when unset the run creates its own. */
	channelRunId?: string;
	channelDir?: string;
}

/** Per-session child spawn counter (settings "subagent".maxSubagentSpawnsPerSession). */
const sessionSpawnCounts = new Map<string, number>();

function bumpSessionSpawnCount(sessionKey: string): number {
	const count = (sessionSpawnCounts.get(sessionKey) ?? 0) + 1;
	sessionSpawnCounts.set(sessionKey, count);
	return count;
}

/** Test-only: reset per-session spawn accounting. */
export function __resetSessionSpawnCountsForTests(): void {
	sessionSpawnCounts.clear();
}

function getSessionKey(ctx: SubagentRunContext): string {
	const manager = ctx.sessionManager as { getSessionId?: () => unknown } | undefined;
	const id = manager?.getSessionId?.();
	return typeof id === "string" && id.length > 0 ? id : "default";
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pico-subagent-"));
	try {
		const safeName = agentName.replace(/[^\w.-]+/g, "_");
		const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
		});
		return { dir: tmpDir, filePath };
	} catch (err) {
		// A failed write must not leak the temp directory in /tmp.
		await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		throw err;
	}
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

/** Validate the final assistant output against the agent's declared
 *  `output` schema (JSON Schema subset). Failures mark the run
 *  schema_violation so isFailedResult / chain / parallel treat it as a
 *  failure instead of passing unverified data upward. */
export function applyOutputSchemaCheck(schema: unknown, result: SingleResult): void {
	const finalOutput = getFinalOutput(result.messages);
	let parsed: unknown;
	try {
		parsed = JSON.parse(finalOutput);
	} catch {
		result.stopReason = "schema_violation";
		result.errorMessage = "Output schema violation: output is not valid JSON";
		return;
	}
	const check = validateOutputSchema(schema, parsed);
	if (!check.success) {
		result.stopReason = "schema_violation";
		result.errorMessage = `Output schema violation: ${check.errors.join("; ")}`;
	}
}

async function runSingleAgent(
	request: AgentRunRequest,
	support: AgentRunSupport,
): Promise<SingleResult> {
	const { agentName, task, cwd, step } = request;
	const {
		defaultCwd,
		agents,
		signal,
		onUpdate,
		makeDetails,
		forkSessionPath,
		persistSessionDir,
		sessionKey,
		globalConcurrencyLimit,
		maxSpawnsPerSession,
		spawnProcess,
	} = support;
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		return createUnknownAgentResult(agentName, task, agents, step);
	}

	if (maxSpawnsPerSession && bumpSessionSpawnCount(sessionKey) > maxSpawnsPerSession) {
		return {
			agent: agentName,
			agentSource: "user",
			task,
			exitCode: 1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			stopReason: "error",
			errorMessage: `Max subagent spawns per session (${maxSpawnsPerSession}) exceeded`,
			step,
		};
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

		// 2.4.4: emit an initial "(running...)" update before the child even
		// produces its first event — slow first-token models previously left
		// the result panel blank for 10-60s with no indication of life.
		emitUpdate();

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
		}

		// Session persistence: a fresh per-run session file (unless the run
		// forks the parent session, which already owns its file). Kept on
		// failure/abort so the run can be continued with `pico --session`.
		let sessionDir: string | null = null;
		let sessionFile: string | undefined;
		if (!forkSessionPath && persistSessionDir) {
			sessionDir = fs.mkdtempSync(path.join(persistSessionDir, "run-"));
			sessionFile = path.join(sessionDir, "session.jsonl");
		}

		const args = buildAgentProcessArgs(agent, task, forkSessionPath, tmpPromptPath ?? undefined, sessionFile);
		const invocation = getPiInvocation(args);

		// Supervisor channel（intercom/steering）：每个 run 一个通道目录，身份
		// 经环境变量传给子进程；子进程内 contact_supervisor 据此写请求/轮询
		// 回复，父侧轮询器（supervisor-channel.ts）扫描同一根目录。异步作业
		// 的通道由 launchAsyncSingleJob 预创建（父侧需据此 steer）。
		const runId = support.channelRunId ?? createRunId();
		const channelDir = support.channelDir ?? createChannelDir(runId, agent.name, step ?? 0);

		// 2.6.3: stderr accumulates unboundedly and floods failed-result messages.
		// The global slot (settings "subagent".globalConcurrencyLimit) bounds in-flight
		// children across the whole session; held only for the child run.
		const releaseSlot = await acquireChildSlot(globalConcurrencyLimit);
		let processResult: Awaited<ReturnType<typeof runJsonProcess>>;
		try {
			processResult = await runJsonProcess({
				command: invocation.command,
				args: invocation.args,
				cwd: cwd ?? defaultCwd,
				result: currentResult,
				signal,
				timeoutMs: agent.maxExecutionTimeMs ?? DEFAULT_AGENT_TIMEOUT_MS,
				budgetCheck: (() => {
					const maxRequests = agent.maxRequests;
					return maxRequests ? () => currentResult.usage.turns >= maxRequests : undefined;
				})(),
				// Tag the child with PICO_SUBAGENT_DEPTH so nesting is bounded
				// (bin/pico.ts refuses to start past MAX_SUBAGENT_DEPTH).
				spawn: spawnProcess ?? ((command, args, options) => spawn(command, args, {
					...options,
					env: subagentChildEnv({
						[SUBAGENT_CHANNEL_DIR_ENV]: channelDir,
						[SUBAGENT_RUN_ID_ENV]: runId,
						[SUBAGENT_CHILD_AGENT_ENV]: agent.name,
						[SUBAGENT_CHILD_INDEX_ENV]: String(step ?? 0),
						[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV]: sessionKey,
					}),
				})),
				onMessage: emitUpdate,
			});
		} finally {
			releaseSlot();
		}

		applyProcessExit(currentResult, processResult.exitCode, processResult.timedOut, agent.maxExecutionTimeMs, agent.maxRequests);
		if (processResult.wasAborted) {
			// 2.4.5: an aborted run is a result, not a thrown exception — the
			// partial messages it produced must stay visible to the caller so
			// parallel/chain modes can preserve already-finished work.
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = "Subagent aborted (user interrupt)";
		}

		if (agent.outputSchema && !isFailedResult(currentResult)) {
			applyOutputSchemaCheck(agent.outputSchema, currentResult);
		}

		try {
			// Spilled output files are registered for session-end cleanup
			// (2.4.7) — chained steps may still need to read the path.
			await spillLargeFileOnlyOutput(currentResult, agent.name, agent.outputMode, PER_TASK_OUTPUT_CAP, {
				tmpPrefix: path.join(os.tmpdir(), "pico-agent-output-"),
				mkdtemp: (prefix) => fs.promises.mkdtemp(prefix),
				writeFile: (filePath, content) => fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 }),
				now: () => Date.now(),
			});
		} catch {
			/* ignore - fall back to inline output */
		}

		if (sessionDir) {
			if (isFailedResult(currentResult)) {
				currentResult.sessionFile = sessionFile;
			} else {
				fs.rmSync(sessionDir, { recursive: true, force: true });
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

interface AsyncLaunchExtras {
	persistSessionDir?: string;
	globalConcurrencyLimit?: number;
	maxSpawnsPerSession?: number;
	sessionKey: string;
}

async function launchAsyncSingleJob(
	params: { agent: string; task: string; cwd?: string; resumeFrom?: string },
	ctx: SubagentRunContext,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	agents: AgentConfig[],
	extras: AsyncLaunchExtras,
): Promise<SubagentToolResult> {
	const jobId = createJobId();
	const controller = new AbortController();
	// 异步作业的通道目录预创建并记入 job：父代理可用 subagent_steer 向
	// 运行中的作业发指令（写入 channel 的 steer/ 目录，子侧轮询注入）。
	const runId = createRunId();
	const channelDir = createChannelDir(runId, params.agent, 0);
	// The job outlives the parent turn: only the session-shutdown cancel
	// (cancelRunningJobs) aborts it, never the parent's per-turn signal.
	registerJob(extras.sessionKey, jobId, params.agent, params.task, () => controller.abort(), { channelDir, runId });

	const resultPromise = runWithFallback(
		{ agentName: params.agent, task: params.task, cwd: params.cwd },
		{
			defaultCwd: ctx.cwd,
			agents,
			signal: controller.signal,
			onUpdate: undefined,
			makeDetails,
			forkSessionPath: params.resumeFrom,
			persistSessionDir: extras.persistSessionDir,
			sessionKey: extras.sessionKey,
			globalConcurrencyLimit: extras.globalConcurrencyLimit,
			maxSpawnsPerSession: extras.maxSpawnsPerSession,
			spawnProcess: ctx.spawnProcess,
			channelRunId: runId,
			channelDir,
		},
	);
	resultPromise.then(
		(result) => {
			settleJob(extras.sessionKey, jobId, result);
			publishExtensionEvent("subagent_completed", { task: params.task, result: getResultOutput(result) });
		},
		(err) => {
			failJob(extras.sessionKey, jobId, err instanceof Error ? err.message : String(err));
		},
	);

	return {
		content: [
			{
				type: "text",
				text:
					`Launched async subagent job ${jobId} (agent ${params.agent}).\n` +
					`The subagent runs in the background. Use the subagent_wait tool with jobs: ["${jobId}"] to collect its result.`,
			},
		],
		details: makeDetails([]),
	};
}

/**
 * Collect results of async subagent jobs (the subagent_wait tool). Waits
 * until every listed job settles, up to timeoutMs, honoring the turn signal.
 */
export async function waitForSubagentJobs(
	params: { jobs: string[]; timeoutMs?: number },
	signal: AbortSignal | undefined,
	ctx: SubagentRunContext,
): Promise<SubagentToolResult> {
	const sessionKey = getSessionKey(ctx);
	const outcome = await waitForJobs(sessionKey, params.jobs, { timeoutMs: params.timeoutMs, signal });

	const results: SingleResult[] = [];
	const lines: string[] = [];
	for (const id of params.jobs) {
		const job = getJob(sessionKey, id);
		if (!job) {
			lines.push(`### Job ${id} — unknown (not launched in this session)`);
			continue;
		}
		if (job.errorMessage) {
			lines.push(`### Job ${id} [${job.agent}] — failed: ${job.errorMessage}`);
			continue;
		}
		if (!job.result) {
			lines.push(`### Job ${id} [${job.agent}] — still running`);
			continue;
		}
		results.push(job.result);
		const r = job.result;
		const status = isFailedResult(r)
			? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
			: "completed";
		lines.push(`### Job ${id} [${r.agent}] ${status}\n\n${truncateOutput(getResultOutput(r), PER_TASK_OUTPUT_CAP)}`);
	}

	let statusLine = "";
	if (outcome.timedOut) {
		statusLine = `\n\n_Wait timed out after ${params.timeoutMs ?? "—"}ms: ${outcome.pending.length} job(s) still running. Call subagent_wait again to keep waiting._`;
	} else if (outcome.aborted) {
		statusLine = `\n\n_Wait aborted: ${outcome.pending.length} job(s) still running in the background._`;
	}

	const text = lines.length > 0 ? lines.join("\n\n---\n\n") + statusLine : "(no jobs)";
	return {
		content: [{ type: "text", text }],
		details: {
			mode: results.length === 1 ? "single" : "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results,
		},
	};
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

	// Discovery mode: return the authoritative agent list without running
	// anything. Models previously had to trigger an "Unknown agent" error to
	// enumerate agents — the error path was the only list endpoint.
	if (params.list === true) {
		const lines = agents.length > 0
			? agents.map((a) => `- ${a.name} (${a.source}): ${(a.description ?? "").split("\n")[0] || "no description"}`)
			: ["(no agents available)"];
		return {
			content: [{ type: "text", text: `Available subagents (scope: ${agentScope}):\n${lines.join("\n")}` }],
			details: { mode: "single", agentScope, projectAgentsDir: discovery.projectAgentsDir, results: [] },
		};
	}

	// Instance-level tuning from settings.json "subagent" key (2.7.x): parallel caps,
	// spawn allowlist, session persistence, global concurrency, per-session
	// spawn cap, and tool/agent deny rules can all be configured there.
	const subagentConfig = loadSubagentConfig();
	const maxParallelTasks = positiveInt(subagentConfig.parallel?.maxTasks) ?? MAX_PARALLEL_TASKS;
	const maxConcurrency = positiveInt(subagentConfig.parallel?.concurrency) ?? MAX_CONCURRENCY;
	const spawnWhitelist = resolveSpawnWhitelist(subagentConfig);
	const denyTools = resolveDenyTools(subagentConfig);
	const denyAgents = resolveDenyAgents(subagentConfig);
	const globalConcurrencyLimit = positiveInt(subagentConfig.globalConcurrencyLimit);
	const maxSpawnsPerSession = positiveInt(subagentConfig.maxSubagentSpawnsPerSession);
	const sessionKey = getSessionKey(ctx);
	const persistSessionDir =
		subagentConfig.sessions?.enabled === false ? undefined : picoSubagentSessionDir();
	if (persistSessionDir) {
		try {
			fs.mkdirSync(persistSessionDir, { recursive: true });
		} catch {
			/* non-fatal: fall back to --no-session semantics */
		}
	}

	// P2 permissions.denyTools: enforced here so it applies to every mode and
	// to nested subagent processes (they inherit the same config).
	const effectiveAgents = denyTools ? agents.map((a) => applyDenyTools(a, denyTools)) : agents;

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

	// async and resumeFrom are single-mode-only knobs; silently ignoring them
	// in parallel/chain calls would surprise the caller.
	if ((params.async === true || params.resumeFrom) && (hasChain || hasTasks)) {
		return {
			content: [
				{
					type: "text",
					text: "Invalid parameters: async and resumeFrom are only supported in single mode (agent + task).",
				},
			],
			details: makeDetails(hasChain ? "chain" : "parallel")([]),
		};
	}

	// 2.7.1: spawn allowlist — refuse agents not listed in settings "subagent".spawns
	// `spawns` before any confirmation or execution. Nested subagent
	// processes inherit the same config, so the allowlist holds recursively.
	if (spawnWhitelist) {
		const requestedAgentNames = new Set<string>();
		if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
		if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
		if (params.agent) requestedAgentNames.add(params.agent);
		const blocked = Array.from(requestedAgentNames).filter((name) => !spawnWhitelist.includes(name));
		if (blocked.length > 0) {
			return {
				content: [
					{
						type: "text",
						text: `Canceled: agent(s) not in the spawn allowlist (settings "subagent".spawns): ${blocked.join(", ")}. Allowed: ${spawnWhitelist.join(", ")}.`,
					},
				],
				details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
			};
		}
	}

	// P2 permissions.denyAgents: inverted allowlist, always enforced. Applies
	// to every mode; nested subagent processes inherit the same config.
	if (denyAgents && denyAgents.size > 0) {
		const requestedAgentNames = new Set<string>();
		if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
		if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
		if (params.agent) requestedAgentNames.add(params.agent);
		const denied = Array.from(requestedAgentNames).filter((name) => denyAgents.has(name));
		if (denied.length > 0) {
			return {
				content: [
					{
						type: "text",
						text: `Canceled: agent(s) denied by settings "subagent".permissions.denyAgents: ${denied.join(", ")}.`,
					},
				],
				details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
			};
		}
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
			const unresolved = findUnresolvedChainReferences(taskWithContext);
			if (unresolved.length > 0) {
				const available = Object.keys(outputs);
				const stepSummaries =
					results.length > 0
						? `\n\nSteps completed before the error:\n${results
								.map((r, j) => `- step ${j + 1} [${r.agent}]: ${truncateOutput(getResultOutput(r), 300)}`)
								.join("\n")}`
						: "";
				throw new Error(
					`Chain reference error at step ${i + 1} (${step.agent}): the task references {outputs.${unresolved.join("}, {outputs.")}} ` +
						`which no completed step defines` +
						(available.length > 0
							? ` (available outputs: ${available.join(", ")})`
							: " (no earlier step declared an \"output\" label)") +
						`. Fix the step task to use {outputs.<label>} matching an earlier step's "output" field, or inline the needed text directly, then retry.` +
						stepSummaries,
				);
			}

			const stepAgents = step.model
				? effectiveAgents.map((a) => (a.name === step.agent ? { ...a, model: step.model } : a))
				: effectiveAgents;

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
					persistSessionDir,
					sessionKey,
					globalConcurrencyLimit,
					maxSpawnsPerSession,
					spawnProcess: ctx.spawnProcess,
				},
			);

			if (step.label) result.label = step.label;
			if (step.phase) result.phase = step.phase;
			if (stepForkFallback) result.contextFallback = stepForkFallback;

			results.push(result);
			publishExtensionEvent("subagent_completed", { task: step.task, result: getResultOutput(result) });

			if (result.stopReason === "aborted" || signal?.aborted) {
				// 2.4.5: user interrupt — keep the completed steps visible
				// instead of letting Promise.all-style rejection swallow them.
				break;
			}

			const isError = isFailedResult(result);
			if (isError) {
				const errorMsg = getResultOutput(result);
				const resumeHint = result.sessionFile
					? `\n\nSession saved for continuation: ${result.sessionFile} (continue with subagent(resumeFrom: "${result.sessionFile}") or "pico --session <path>")`
					: "";
				// Throw instead of returning an isError flag: the agent loop only
				// derives isError from thrown exceptions, so a returned flag is
				// silently dropped and the failure renders as a success.
				throw new Error(`Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}${resumeHint}`);
			}
			previousOutput = getFinalOutput(result.messages);

			if (step.output) {
				outputs[step.output] = previousOutput;
			}
		}
		const lastResult = results.at(-1);
		const aborted = lastResult?.stopReason === "aborted" || signal?.aborted;
		// Chain 只把最后一步输出回传父进程，中间步骤（scout/worker）对父 agent
		// 是黑盒——把每步输出摘要附在结果尾部，父 agent 才能汇总/审计每一步。
		const summarizedSteps = aborted ? results : results.slice(0, -1);
		const stepSummaries = summarizedSteps
			.map((r, i) => {
				const label = r.label ? ` (${r.label})` : "";
				const status = r.stopReason === "aborted" ? "aborted" : "completed";
				return `### Step ${i + 1}: ${r.agent}${label} — ${status}\n\n${truncateOutput(getResultOutput(r), 1500)}`;
			})
			.join("\n\n---\n\n");
		const contentText = aborted
			? `Chain aborted after ${results.length} of ${chain.length} steps.\n\n${stepSummaries}`
			: lastResult
				? `${getFinalOutput(lastResult.messages) || "(no output)"}${
						stepSummaries.length > 0 ? `\n\n---\n\n## Step summaries\n\n${stepSummaries}` : ""
					}`
				: "(no output)";
		return {
			content: [{ type: "text", text: contentText }],
			details: makeDetails("chain")(results),
		};
	}

	if (params.tasks && params.tasks.length > 0) {
		if (params.tasks.length > maxParallelTasks)
			return {
				content: [
					{
						type: "text",
						text: `Too many parallel tasks (${params.tasks.length}). Max is ${maxParallelTasks}.`,
					},
				],
				details: makeDetails("parallel")([]),
			};

		// Shared context (2.7.2): when the caller provides `sharedContext`, it
		// is prepended to every task so parallel agents share the same
		// background without the caller duplicating it per task.
		const sharedContext = params.sharedContext?.trim();
		const buildTaskPrompt = (task: string): string =>
			sharedContext ? `## Context\n\n${sharedContext}\n\n## Task\n\n${task}` : task;

		const useWorktree = params.isolation === "worktree";
		const worktreeHandles: Array<WorktreeHandle | null> = new Array(params.tasks.length).fill(null);

		if (useWorktree) {
			const prepared = await prepareParallelWorktrees(ctx.cwd, params.tasks);
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

		// 2.4.4: show "0/N running..." immediately instead of a blank panel
		// until the first task produces output.
		emitParallelUpdate();

		// One task failing (e.g. prompt-temp-file write) must not leave the
		// siblings running into a worktree that is about to be cleaned up:
		// abort them via a private controller, and wait for all workers to
		// settle (mapWithConcurrencyLimit) before the finally below removes
		// the worktrees.
		const parallelAbort = new AbortController();
		const parallelSignal = signal ? AbortSignal.any([signal, parallelAbort.signal]) : parallelAbort.signal;

		try {
			let results: SingleResult[];
			try {
				results = await mapWithConcurrencyLimit(params.tasks, maxConcurrency, async (t, index) => {
					const handle = worktreeHandles[index];
					const taskCwd = handle ? handle.worktreeDir : t.cwd;

					let forkPath: string | undefined;
					let forkFallbackNote: string | undefined;
					if (t.context === "fork") {
						forkPath = tryForkSession(ctx.sessionManager);
						if (!forkPath) forkFallbackNote = "context=fork requested but session forking unavailable; using fresh context";
					}

					const result = await runWithFallback(
						{ agentName: t.agent, task: buildTaskPrompt(t.task), cwd: taskCwd },
						{
							defaultCwd: ctx.cwd,
							agents: effectiveAgents,
							signal: parallelSignal,
							onUpdate: (partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
							},
							makeDetails: makeDetails("parallel"),
							forkSessionPath: forkPath,
							persistSessionDir,
							sessionKey,
							globalConcurrencyLimit,
							maxSpawnsPerSession,
							spawnProcess: ctx.spawnProcess,
						},
					);
					if (forkFallbackNote) result.contextFallback = forkFallbackNote;
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				}, () => {
					parallelAbort.abort();
				});
			} catch (err) {
				// One task failing (e.g. a prompt-temp write) aborts its
				// siblings, but their already-finished work must not vanish
				// with the exception — surface it next to the error so the
				// caller can still act on completed results.
				throw describeSiblingResults(allResults.filter((r) => r && r.exitCode !== -1), err);
			}

			// 2.4.5: on interrupt, running tasks come back as aborted results
			// (runSingleAgent no longer throws); never-launched tasks keep
			// their placeholder status — report them, don't drop the lot.
			const mergeNotes = useWorktree ? await mergeParallelWorktrees(ctx.cwd, results, worktreeHandles) : [];

			for (let i = 0; i < results.length; i++) {
				const t = params.tasks[i];
				const r = results[i];
				if (t && r && r.stopReason !== "aborted" && r.exitCode !== -1) {
					publishExtensionEvent("subagent_completed", { task: t.task, result: getResultOutput(r) });
				}
			}

			const abortedCount = results.filter((r) => r.stopReason === "aborted").length;
			const pendingCount = results.filter((r) => r.exitCode === -1).length;

			const text = summarizeParallelResults(
				results,
				PER_TASK_OUTPUT_CAP,
				useWorktree ? mergeNotes : [],
			) + (abortedCount > 0 || pendingCount > 0
				? `\n\n_Interrupted: ${abortedCount} task(s) aborted, ${pendingCount} not started. Completed results above are preserved._`
				: "");
			return {
				content: [{ type: "text", text }],
				details: makeDetails("parallel")(results),
			};
		} finally {
			if (useWorktree) {
				await cleanupWorktrees(worktreeHandles);
			}
		}
	}

	if (params.agent && params.task) {
		if (params.resumeFrom && !fs.existsSync(params.resumeFrom)) {
			return {
				content: [
					{
						type: "text",
						text: `Invalid resumeFrom path: ${params.resumeFrom} — file does not exist. Pass the session file path reported by a failed run.`,
					},
				],
				details: makeDetails("single")([]),
			};
		}

		// Async launch (P0): spawn immediately and return a job id; the child
		// finishes in the background and the result is collected later via the
		// subagent_wait tool.
		if (params.async === true) {
			return await launchAsyncSingleJob(
				{ agent: params.agent, task: params.task, cwd: params.cwd, resumeFrom: params.resumeFrom },
				ctx,
				makeDetails("single"),
				effectiveAgents,
				{ persistSessionDir, globalConcurrencyLimit, maxSpawnsPerSession, sessionKey },
			);
		}

		let forkPath: string | undefined;
		let forkFallbackNote: string | undefined;
		if (params.resumeFrom) {
			// Resume: reuse the saved session file instead of creating a fresh
			// per-run one, so the child continues where the failed run stopped.
			forkPath = params.resumeFrom;
		} else if (params.context === "fork") {
			forkPath = tryForkSession(ctx.sessionManager);
			if (!forkPath) forkFallbackNote = "context=fork requested but session forking unavailable; using fresh context";
		}
		const result = await runWithFallback(
			{ agentName: params.agent, task: params.task, cwd: params.cwd },
			{
				defaultCwd: ctx.cwd,
				agents: effectiveAgents,
				signal,
				onUpdate,
				makeDetails: makeDetails("single"),
				forkSessionPath: forkPath,
				persistSessionDir,
				sessionKey,
				globalConcurrencyLimit,
				maxSpawnsPerSession,
				spawnProcess: ctx.spawnProcess,
			},
		);
		publishExtensionEvent("subagent_completed", { task: params.task, result: getResultOutput(result) });
		if (forkFallbackNote) result.contextFallback = forkFallbackNote;
		const resumeHint = result.sessionFile
			? `\n\nSession saved for continuation: ${result.sessionFile} (continue with subagent(resumeFrom: "${result.sessionFile}") or "pico --session <path>")`
			: "";
		if (result.stopReason === "aborted") {
			return {
				content: [{ type: "text", text: `Agent aborted. Partial output:\n\n${truncateOutput(getResultOutput(result), 8192)}${resumeHint}` }],
				details: makeDetails("single")([result]),
			};
		}
		const isError = isFailedResult(result);
		if (isError) {
			const errorMsg = getResultOutput(result);
			throw new Error(`Agent ${result.stopReason || "failed"}: ${errorMsg}${resumeHint}`);
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
