import type { AgentConfig } from "./agents.ts";
import type { SingleResult } from "./results.ts";
import { applyJsonModeLine } from "./runner.ts";

export interface SpawnedProcessLike {
	stdout: { on(event: "data", handler: (data: unknown) => void): void };
	stderr: { on(event: "data", handler: (data: unknown) => void): void };
	on(event: "close" | "error" | "exit", handler: (code: number | null) => void): void;
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
	/** When this returns true (checked on every parsed event), the child is
	 *  killed and the run is flagged as budget-exceeded. Used for the soft
	 *  per-agent request budget (maxRequests). */
	budgetCheck?: () => boolean;
	spawn: (command: string, args: string[], options: { cwd: string; shell: false; stdio: ["ignore", "pipe", "pipe"]; detached: true }) => SpawnedProcessLike;
	onMessage?: () => void;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
}

export interface RunJsonProcessResult {
	exitCode: number;
	wasAborted: boolean;
	timedOut: boolean;
	budgetExceeded: boolean;
}

/** 2.6.3: stderr accumulates unboundedly and floods failed-result messages. */
const STDERR_CAP_BYTES = 256 * 1024;
const STDERR_OVERFLOW_MARKER = "[stderr truncated — head dropped]\n";
/** Cap on the partial-line stdout buffer: a runaway child emitting one giant
 *  unterminated line must not grow `buffer` without bound (complete lines are
 *  consumed immediately; only the trailing partial accumulates). */
const STDOUT_PARTIAL_CAP_BYTES = 1024 * 1024;

/**
 * Subagent nesting depth guard (mirrors PICO_HOOK_RECURSION_GUARD): every
 * subagent child is marked with PICO_SUBAGENT_DEPTH = parent depth + 1 and
 * bin/pico.ts refuses to start once the limit is reached, so an LLM cannot
 * recursively stack full pico processes (each ~100MB + own model context).
 */
export const SUBAGENT_DEPTH_ENV = "PICO_SUBAGENT_DEPTH";
export const MAX_SUBAGENT_DEPTH = 3;

/** Environment for a subagent child: inherit parent env + bumped depth and
 *  any caller-provided overrides (e.g. supervisor channel identity). */
export function subagentChildEnv(extra?: Record<string, string>): Record<string, string> {
	const raw = Number.parseInt(process.env[SUBAGENT_DEPTH_ENV] ?? "0", 10);
	const depth = Number.isFinite(raw) && raw >= 0 ? raw : 0;
	return { ...process.env, [SUBAGENT_DEPTH_ENV]: String(depth + 1), ...extra };
}

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
	return {
		agent: agentName,
		agentSource: "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: `Unknown agent: "${agentName}". Call subagent with list: true to enumerate available agents.`,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		step,
	};
}

export function buildAgentProcessArgs(
	agent: AgentConfig,
	task: string,
	forkSessionPath: string | undefined,
	systemPromptPath: string | undefined,
	sessionFile: string | undefined,
): string[] {
	const args: string[] = ["--mode", "json", "-p"];
	const sessionPath = forkSessionPath ?? sessionFile;
	if (sessionPath) {
		args.push("--session", sessionPath);
	} else {
		args.push("--no-session");
	}
	if (agent.model) args.push("--model", agent.model);
	// The supervisor channel tool must survive frontmatter tools allowlists —
	// a restricted agent would otherwise be unable to ask the parent for a
	// decision (intercom). Low-risk tool (writes only under the temp channel).
	if (agent.tools && agent.tools.length > 0 && !agent.tools.includes("contact_supervisor")) {
		args.push("--tools", [...agent.tools, "contact_supervisor"].join(","));
	} else if (agent.tools && agent.tools.length > 0) {
		args.push("--tools", agent.tools.join(","));
	}
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
	maxRequests: number | undefined,
): void {
	result.exitCode = exitCode;
	if (timedOut) {
		result.stopReason = "timeout";
		result.errorMessage = `Agent exceeded maxExecutionTimeMs (${maxExecutionTimeMs}ms)`;
		return;
	}
	if (result.stopReason === "budget") {
		result.errorMessage = `Agent exceeded request budget (${maxRequests} requests)`;
	}
}

export async function runJsonProcess(options: RunJsonProcessOptions): Promise<RunJsonProcessResult> {
	const setTimer = options.setTimeoutFn ?? setTimeout;
	const clearTimer = options.clearTimeoutFn ?? clearTimeout;
	let wasAborted = false;
	let timedOut = false;
	let budgetExceeded = false;
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
			// `close` (all stdio EOF) can be delayed forever when a grandchild
			// escaped the process group (setsid/nohup daemon) and keeps the
			// pipes open. The process itself is gone once `exit` fires — a
			// bounded grace period then force-resolves instead of hanging the
			// tool call indefinitely.
			let hangTimer: ReturnType<typeof setTimeout> | undefined;

			const killProc = (reason: "abort" | "timeout" | "budget") => {
				if (reason === "abort") wasAborted = true;
				else if (reason === "budget") budgetExceeded = true;
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

			const clearTimers = () => {
				if (timeoutHandle) clearTimer(timeoutHandle);
				if (killTimer) clearTimer(killTimer);
				if (hangTimer) clearTimer(hangTimer);
			};

		const processLine = (line: string) => {
			if (applyJsonModeLine(options.result, line)) {
				options.onMessage?.();
				if (options.budgetCheck?.()) {
					killProc("budget");
					options.result.stopReason = "budget";
				}
			}
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
			if (Buffer.byteLength(buffer, "utf8") > STDOUT_PARTIAL_CAP_BYTES) {
				// One giant unterminated line: its head is already gone, so it
				// can never parse — drop it entirely instead of buffering it
				// without bound. Newline-terminated events keep parsing.
				buffer = "";
			}
			// Incremental line splitting: re-splitting the whole buffer on
			// every chunk is O(n²) once output grows; only scan the appended
			// text for complete lines and keep the trailing partial in buffer.
			const lastNewline = buffer.lastIndexOf("\n");
			if (lastNewline === -1) return;
			const complete = buffer.slice(0, lastNewline);
			buffer = buffer.slice(lastNewline + 1);
			for (const line of complete.split("\n")) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			appendStderr(options.result, typeof data === "string" ? data : stderrDecoder.decode(data as Uint8Array, { stream: true }));
		});

		proc.on("close", (code) => {
			clearTimers();
			// Flush any trailing bytes held by the streaming decoders.
			buffer += stdoutDecoder.decode();
			options.result.stderr += stderrDecoder.decode();
			if (buffer.trim()) processLine(buffer);
			// `code` is null when the child was killed by a signal (crash, OOM
			// killer, external kill). Mapping that to 0 would dress a half-finished
			// run as success; the abort/timeout paths carry their own flags.
			resolve(code ?? 1);
		});

		proc.on("exit", (code) => {
			// The child process itself is gone; `close` may still be pending
			// because an escaped grandchild holds the stdio pipes open. Bound
			// that wait so the tool call cannot hang forever. If `close` does
			// arrive (with the last buffered output), it wins and clears this.
			hangTimer = setTimer(() => {
				if (timeoutHandle) clearTimer(timeoutHandle);
				if (killTimer) clearTimer(killTimer);
				// `close` (which detaches the abort listener) may never fire
				// on this path — detach here or a later abort would kill the
				// stale (possibly recycled) pid's process group.
				detachAbort();
				resolve(code ?? 1);
			}, 10_000);
		});

		proc.on("error", (error) => {
			// 2.4.3: a spawn failure (ENOENT, EACCES, bad PATH) must not
			// degrade to a bare "Agent failed: (no output)" — the reason is
			// what lets the user actually diagnose it.
			clearTimers();
			const detail = error instanceof Error ? error.message : String(error);
			options.result.stopReason = "error";
			options.result.errorMessage = `Failed to spawn ${options.command}: ${detail} — check PATH and permissions.`;
			resolve(1);
		});

		let detachAbort: () => void = () => {};
		if (options.signal) {
			const onAbort = () => killProc("abort");
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
			// Detach the listener once the process is done so long sessions
			// with many subagent runs don't accumulate listeners on the
			// shared session signal (and don't SIGTERM a dead process on a
			// later interrupt).
			detachAbort = () => options.signal?.removeEventListener("abort", onAbort);
			proc.on("close", detachAbort);
			proc.on("error", detachAbort);
		}

		if (options.timeoutMs && options.timeoutMs > 0) {
			timeoutHandle = setTimer(() => killProc("timeout"), options.timeoutMs);
		}
	});

	return { exitCode, wasAborted, timedOut, budgetExceeded };
}
