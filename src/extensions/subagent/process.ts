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
	pid?: number;
}

export interface RunJsonProcessOptions {
	command: string;
	args: string[];
	cwd: string;
	result: SingleResult;
	signal?: AbortSignal;
	timeoutMs?: number;
	spawn: (command: string, args: string[], options: { cwd: string; shell: false; stdio: ["ignore", "pipe", "pipe"]; detached: true }) => SpawnedProcessLike;
	onMessage?: () => void;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
}

export interface RunJsonProcessResult {
	exitCode: number;
	wasAborted: boolean;
	timedOut: boolean;
}

/** 2.6.3: stderr accumulates unboundedly and floods failed-result messages. */
const STDERR_CAP_BYTES = 256 * 1024;
const STDERR_OVERFLOW_MARKER = "[stderr truncated — head dropped]\n";

function appendStderr(result: SingleResult, chunk: string): void {
	result.stderr += chunk;
	const bytes = Buffer.byteLength(result.stderr, "utf8");
	if (bytes <= STDERR_CAP_BYTES) return;
	if (result.stderr.startsWith(STDERR_OVERFLOW_MARKER)) {
		// Already capped — drop further chunks instead of re-trimming.
		if (bytes > STDERR_CAP_BYTES * 2) {
			result.stderr = result.stderr.slice(0, STDERR_CAP_BYTES * 2);
		}
		return;
	}
	let tail = result.stderr;
	while (Buffer.byteLength(tail, "utf8") > STDERR_CAP_BYTES) {
		tail = tail.slice(Math.max(1, Math.floor(tail.length / 2)));
	}
	result.stderr = `${STDERR_OVERFLOW_MARKER}${tail.trimStart()}`;
}

/**
 * Kill the child and its whole process group (2.4.1). `detached: true` puts
 * the child in its own process group; grandchildren (bun test, npm install)
 * would otherwise survive the abort and keep running in the background —
 * holding locks and possibly writing into a worktree that is already being
 * cleaned up. Falls back to the direct kill when the pid is unavailable
 * (fake spawns in tests).
 */
export function killProcessGroup(proc: SpawnedProcessLike, sig: "SIGTERM" | "SIGKILL"): void {
	if (proc.pid) {
		try {
			process.kill(-proc.pid, sig);
			return;
		} catch {
			// Group already gone — try the direct kill for safety.
		}
	}
	try {
		proc.kill(sig);
	} catch {
		// already dead
	}
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
	// Frontmatter switches: inheritProjectContext=false strips AGENTS.md/CLAUDE.md
	// from the child, inheritSkills=false strips the skills catalog.
	if (agent.inheritProjectContext === false) args.push("--no-context-files");
	if (agent.inheritSkills === false) args.push("--no-skills");
	if (systemPromptPath) {
		if (agent.systemPromptMode === "replace") {
			args.push("--system-prompt", systemPromptPath);
		} else {
			args.push("--append-system-prompt", systemPromptPath);
		}
	}
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
				detached: true,
			});
			let buffer = "";
			let killTimer: ReturnType<typeof setTimeout> | undefined;

			const killProc = (reason: "abort" | "timeout") => {
				if (reason === "abort") wasAborted = true;
				else timedOut = true;
				killProcessGroup(proc, "SIGTERM");
				// Escalate to SIGKILL if the child ignores SIGTERM. `proc.killed`
				// flips true on the first kill() call, so it cannot gate the
				// escalation; the timer is cleared on close, so firing it means the
				// process is still alive. Tracked so it can be cleared once the
				// process exits — otherwise this timer keeps the event loop alive
				// for up to 5s after an otherwise clean exit.
				killTimer = setTimer(() => {
					killProcessGroup(proc, "SIGKILL");
				}, 5000);
			};

		const processLine = (line: string) => {
			if (applyJsonModeLine(options.result, line)) options.onMessage?.();
		};

		// Chunks can split a multi-byte UTF-8 character; decoding each chunk
		// with String(data) would replace the split character with U+FFFD and
		// corrupt the parsed output. A streaming decoder keeps the state across
		// chunk boundaries (flushed on close).
		const stdoutDecoder = new TextDecoder("utf-8");
		const stderrDecoder = new TextDecoder("utf-8");

		proc.stdout.on("data", (data) => {
			const text = typeof data === "string" ? data : stdoutDecoder.decode(data as Uint8Array, { stream: true });
			buffer += text;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			appendStderr(options.result, typeof data === "string" ? data : stderrDecoder.decode(data as Uint8Array, { stream: true }));
		});

		proc.on("close", (code) => {
			if (timeoutHandle) clearTimer(timeoutHandle);
			if (killTimer) clearTimer(killTimer);
			// Flush any trailing bytes held by the streaming decoders.
			buffer += stdoutDecoder.decode();
			options.result.stderr += stderrDecoder.decode();
			if (buffer.trim()) processLine(buffer);
			// `code` is null when the child was killed by a signal (crash, OOM
			// killer, external kill). Mapping that to 0 would dress a half-finished
			// run as success; the abort/timeout paths carry their own flags.
			resolve(code ?? 1);
		});

		proc.on("error", (error) => {
			// 2.4.3: a spawn failure (ENOENT, EACCES, bad PATH) must not
			// degrade to a bare "Agent failed: (no output)" — the reason is
			// what lets the user actually diagnose it.
			if (timeoutHandle) clearTimer(timeoutHandle);
			if (killTimer) clearTimer(killTimer);
			const detail = error instanceof Error ? error.message : String(error);
			options.result.stopReason = "error";
			options.result.errorMessage = `Failed to spawn ${options.command}: ${detail} — check PATH and permissions.`;
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
