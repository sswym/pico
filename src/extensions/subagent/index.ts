/**
 * Subagent Tool - Delegate tasks to specialized agents.
 *
 * The tool adapter owns schema, description, and rendering. Execution lives in
 * orchestrator.ts so mode routing, fallback, gates, worktrees, and event
 * publication can be tested and evolved behind one deeper module.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runSubagentRequest, waitForSubagentJobs, type SubagentRequest, type SubagentRunContext } from "./orchestrator.ts";
import { renderSubagentCall, renderSubagentResult, renderSubagentWaitCall } from "./renderer.ts";
import { cleanupSpillDirs } from "./output.ts";
import { cancelRunningJobs } from "./jobs.ts";
import { createSupervisorChannel, registerChildSupervisorTool } from "./supervisor-channel.ts";
import { loadSubagentConfig, drainSubagentConfigErrors } from "./config.ts";

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
	list: Type.Optional(
		Type.Boolean({ description: "If true, return the list of available agents (name, source, description) and run nothing." }),
	),
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
	sharedContext: Type.Optional(
		Type.String({ description: "Shared background prepended to every task in parallel (tasks) mode" }),
	),
	async: Type.Optional(
		Type.Boolean({
			description:
				'Launch as a background job (single mode only): returns a job id immediately. Collect the result later with the subagent_wait tool (jobs: [id]). The job outlives the current turn and is canceled at session shutdown.',
		}),
	),
	resumeFrom: Type.Optional(
		Type.String({
			description:
				'Path to a saved subagent session file (reported by a previous failed/aborted run) to continue it instead of starting fresh. Single mode only.',
		}),
	),
});

export default function (pi: ExtensionAPI) {
	// Supervisor channel（intercom）：子代理进程同样运行本扩展，由环境变量
	// 身份门控注册 contact_supervisor；父侧轮询器随会话启停。
	const supervisorChannel = createSupervisorChannel(pi);
	registerChildSupervisorTool(pi);

	// Spilled subagent output files must not accumulate across a long
	// session — but they must survive until the session ends (2.4.7).
	pi.on("session_shutdown", (_event, ctx) => {
		cleanupSpillDirs();
		// Async jobs launched by this session are canceled (child process
		// groups killed) so no orphan pico processes outlive the session.
		const manager = (ctx as { sessionManager?: { getSessionId?: () => unknown } })?.sessionManager;
		const id = manager?.getSessionId?.();
		cancelRunningJobs(typeof id === "string" && id.length > 0 ? id : undefined);
		supervisorChannel.dispose();
	});
	// 2.2.2: surface subagent.json parse errors in the TUI (console.warn
	// only reached stderr, so overrides silently didn't apply).
	pi.on("session_start", (_event, ctx) => {
		loadSubagentConfig();
		for (const message of drainSubagentConfigErrors()) {
			try {
				ctx.ui.notify(message, "warning");
			} catch {
				// non-TUI mode may drop notify
			}
		}
		const manager = (ctx as { sessionManager?: { getSessionId?: () => unknown } })?.sessionManager;
		const sessionId = manager?.getSessionId?.();
		supervisorChannel.start(typeof sessionId === "string" && sessionId.length > 0 ? sessionId : "default");
	});
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"",
			"## When to use",
			"- Multi-phase tasks (research -> plan -> implement -> verify) -> chain mode",
			"- 3+ independent sub-tasks that don't share files -> parallel mode (one worker/reviewer per task)",
			"- Exploration that would dominate main context (>10 file reads or >50 grep calls) -> single mode (scout/worker) for context isolation",
			"- Tasks needing an independent perspective (review, audit, second opinion) -> single mode (reviewer/oracle)",
			"- Tasks with explicit acceptance criteria (tests must pass, lint must be clean) -> single mode (worker with acceptance gate)",
			"",
			"## When NOT to use",
			"- Tasks under 3 file reads - direct execution is faster and cheaper",
			"- Tasks where cross-file context is essential and can't be summarized for handoff",
			"- Trivial edits, single-line fixes, or simple Q&A",
			"",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} and {outputs.name} placeholders).",
			"Single mode also supports async: true — the subagent runs in the background and this tool returns a job id immediately; collect the result later with the subagent_wait tool. Use async for work that should proceed while you keep working.",
			"To continue a previous failed/aborted run, pass resumeFrom: \"<session file path>\" (the path is reported by the failed run) in single mode.",
			"To enumerate available agents (built-in + user/project overrides), call this tool with list: true — it returns names, sources and descriptions without running anything.",
			"Agent frontmatter supports: model, tools, thinking, maxExecutionTimeMs (default 30 min if unset), maxTokens, fallbackModels, systemPromptMode, inheritProjectContext, inheritSkills, acceptance.",
			"User-level overrides may live in ~/.pico/agent/agents/<name>.md (same name = replaces built-in) or ~/.pico/subagent.json (partial field overrides).",
			'Project-local agents in .pico/agents are opt-in: set agentScope: "both" (or "project").',
			"Project agents are repo-controlled; interactive sessions confirm before running them, and non-interactive runs refuse them unless PICO_ALLOW_UNATTENDED_PROJECT_AGENTS=1 is set.",
			"Do NOT shell out to `ls` to discover agents - use the list: true mode of this tool instead.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return await runSubagentRequest(
				params as SubagentRequest,
				signal,
				onUpdate,
				ctx as SubagentRunContext,
			);
		},

		renderCall(args, theme, _context) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, { expanded }, theme, context) {
			return renderSubagentResult(result, expanded, theme, context);
		},
	});
	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description: [
			"Collect results of async subagent jobs launched with subagent(async: true).",
			"Pass the job ids returned at launch (jobs array); each job's final output is returned once it settles.",
			"Jobs run in the background of the same process, so call this tool after doing other work — the wait blocks until the jobs finish, up to timeoutMs (default 5 min).",
			"Failed/aborted jobs are reported with their stop reason; unknown ids are flagged.",
		].join(" "),
		parameters: Type.Object({
			jobs: Type.Array(Type.String(), { description: "Job ids returned by subagent(async: true) launches" }),
			timeoutMs: Type.Optional(
				Type.Number({ description: "Max milliseconds to wait. Default 300000 (5 min). Jobs still running when it fires stay running — call again to keep waiting." }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return await waitForSubagentJobs(
				params as { jobs: string[]; timeoutMs?: number },
				signal,
				ctx as SubagentRunContext,
			);
		},

		renderCall(args, theme, _context) {
			return renderSubagentWaitCall(args, theme);
		},

		renderResult(result, { expanded }, theme, context) {
			return renderSubagentResult(result, expanded, theme, context);
		},
	});
}
