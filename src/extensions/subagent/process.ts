import type { AgentConfig } from "./agents.ts";
import type { SingleResult } from "./results.ts";
import { applyJsonModeLine } from "./runner.ts";

export interface SpawnedProcessLike {
	stdout: { on(event: "data", handler: (data: unknown) => void): void };
	stderr: { on(event: "data", handler: (data: unknown) => void): void };
	on(event: "close", handler: (code: number | null) => void): void;
	on(event: "error", handler: (error: unknown) => void): void;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
	killed: boolean;
}

export interface RunJsonProcessOptions {
	command: string;
	args: string[];
	cwd: string;
	result: SingleResult;
	signal?: AbortSignal;
	timeoutMs?: number;
	spawn: (command: string, args: string[], options: { cwd: string; shell: false; stdio: ["ignore", "pipe", "pipe"] }) => SpawnedProcessLike;
	onMessage?: () => void;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
}

export interface RunJsonProcessResult {
	exitCode: number;
	wasAborted: boolean;
	timedOut: boolean;
}

export function createInitialResult(
	agent: AgentConfig,
	agentName: string,
	task: string,
	step: number | undefined,
): SingleResult {
	return {
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
}

export function createUnknownAgentResult(
	agentName: string,
	task: string,
	availableAgents: AgentConfig[],
	step: number | undefined,
): SingleResult {
	const available = availableAgents.map((a) => `"${a.name}"`).join(", ") || "none";
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

export function buildAgentProcessArgs(
	agent: AgentConfig,
	task: string,
	forkSessionPath: string | undefined,
	systemPromptPath: string | undefined,
): string[] {
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
	if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
	args.push(`Task: ${task}`);
	return args;
}

export function applyProcessExit(
	result: SingleResult,
	exitCode: number,
	timedOut: boolean,
	maxExecutionTimeMs: number | undefined,
): void {
	result.exitCode = exitCode;
	if (!timedOut) return;
	result.stopReason = "timeout";
	result.errorMessage = `Agent exceeded maxExecutionTimeMs (${maxExecutionTimeMs}ms)`;
}

export async function runJsonProcess(options: RunJsonProcessOptions): Promise<RunJsonProcessResult> {
	const setTimer = options.setTimeoutFn ?? setTimeout;
	const clearTimer = options.clearTimeoutFn ?? clearTimeout;
	let wasAborted = false;
	let timedOut = false;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	const exitCode = await new Promise<number>((resolve) => {
		const proc = options.spawn(options.command, options.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const killProc = (reason: "abort" | "timeout") => {
			if (reason === "abort") wasAborted = true;
			else timedOut = true;
			proc.kill("SIGTERM");
			// Escalate to SIGKILL if the child ignores SIGTERM. Tracked so it can
			// be cleared once the process exits — otherwise this timer keeps the
			// event loop alive for up to 5s after an otherwise clean exit.
			killTimer = setTimer(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
		};

		const processLine = (line: string) => {
			if (applyJsonModeLine(options.result, line)) options.onMessage?.();
		};

		proc.stdout.on("data", (data) => {
			buffer += String(data);
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			options.result.stderr += String(data);
		});

		proc.on("close", (code) => {
			if (timeoutHandle) clearTimer(timeoutHandle);
			if (killTimer) clearTimer(killTimer);
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 0);
		});

		proc.on("error", () => {
			if (timeoutHandle) clearTimer(timeoutHandle);
			if (killTimer) clearTimer(killTimer);
			resolve(1);
		});

		if (options.signal) {
			if (options.signal.aborted) killProc("abort");
			else options.signal.addEventListener("abort", () => killProc("abort"), { once: true });
		}

		if (options.timeoutMs && options.timeoutMs > 0) {
			timeoutHandle = setTimer(() => killProc("timeout"), options.timeoutMs);
		}
	});

	return { exitCode, wasAborted, timedOut };
}
