/**
 * Acceptance gates — structured contract verification for subagent output.
 *
 * When an agent declares an `acceptance` block in its frontmatter, the runtime
 * checks the specified evidence commands after the agent completes. If the gate
 * fails and `selfRepair` is enabled, the agent is re-invoked with failure
 * details appended to its task.
 */
import { spawn } from "node:child_process";
import type { AcceptanceConfig } from "./agents.ts";
import { isFailedResult, type SingleResult } from "./results.ts";

const EVIDENCE_TIMEOUT_MS = 60_000;
const EVIDENCE_OUTPUT_CAP = 500;

export interface GateResult {
	passed: boolean;
	failedCriteria: string[];
	evidenceResults: Array<{ command: string; output: string; passed: boolean }>;
}

export function summarizeGateFailure(gateResult: GateResult): string {
	const failed = gateResult.evidenceResults.filter((e) => !e.passed);
	const lines: string[] = [];
	if (gateResult.failedCriteria.length > 0) {
		lines.push(`Failed criteria: ${gateResult.failedCriteria.join("; ")}`);
	}
	if (failed.length > 0) {
		lines.push("Failed evidence:");
		for (const evidence of failed) {
			lines.push(`- $ ${evidence.command}\n  ${evidence.output.split("\n").slice(0, 5).join("\n  ")}`);
		}
	}
	return lines.join("\n");
}

export function buildRepairTask(task: string, attempt: number, maxAttempts: number, failureSummary: string): string {
	return [
		task,
		"",
		`## Acceptance gate failed (self-repair attempt ${attempt} of ${maxAttempts})`,
		failureSummary,
		"",
		"Please fix the issues above and complete the task. The same checks will run again.",
	].join("\n");
}

export function markGateFailed(result: SingleResult, message: string): SingleResult {
	result.stopReason = "gate_failed";
	result.errorMessage = message;
	return result;
}

export interface GateAfterSuccessRequest<TContext> {
	agent: { name: string; acceptance?: AcceptanceConfig } | undefined;
	result: SingleResult;
	task: string;
	runCwd: string;
	context: TContext;
	signal?: AbortSignal;
	checkGate?: (acceptance: AcceptanceConfig, cwd: string, signal?: AbortSignal) => Promise<GateResult>;
	runRepair: (agentName: string, repairTask: string, context: TContext) => Promise<SingleResult>;
}

export async function runGateAfterSuccess<TContext>(
	request: GateAfterSuccessRequest<TContext>,
): Promise<SingleResult> {
	const { agent, result, task, runCwd, context, signal } = request;
	if (!agent?.acceptance || isFailedResult(result)) return result;

	const checkGate = request.checkGate ?? checkAcceptanceGate;
	const acceptance = agent.acceptance;
	const gateResult = await checkGate(acceptance, runCwd, signal);
	if (gateResult.passed) return result;
	const failureSummary = summarizeGateFailure(gateResult);

	if (!acceptance.selfRepair) {
		return markGateFailed(result, `Acceptance gate failed.\n${failureSummary}`);
	}

	const maxAttempts = acceptance.maxRepairAttempts ?? 1;
	let lastResult = result;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (signal?.aborted) break;
		const repairTask = buildRepairTask(task, attempt, maxAttempts, failureSummary);
		const repairResult = await request.runRepair(agent.name, repairTask, context);
		lastResult = repairResult;
		if (!isFailedResult(repairResult)) {
			const recheck = await checkGate(acceptance, runCwd, signal);
			if (recheck.passed) return repairResult;
		}
	}

	return markGateFailed(
		lastResult,
		`Acceptance gate failed after ${maxAttempts} self-repair attempt(s).\n${failureSummary}`,
	);
}

interface EvidenceRun {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
	aborted: boolean;
}

/**
 * Run one evidence command asynchronously. The agent loop must never block
 * on an evidence command: `execSync` would freeze the whole pico (UI, other
 * tools, MCP in-flight requests) for up to 60s per command, and an AbortSignal
 * could not interrupt an in-flight sync command. Async spawn keeps the event
 * loop responsive and lets cancellation land immediately.
 */
function runEvidenceCommand(command: string, cwd: string, signal?: AbortSignal): Promise<EvidenceRun> {
	return new Promise((resolve) => {
		const child = spawn("sh", ["-c", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// Own process group so a timeout/abort kills grandchildren too
			// (npm/node subprocesses would otherwise outlive the shell and
			// hold the pipes open).
			detached: true,
		});
		let stdout = "";
		let stderr = "";
		let done = false;
		let killed = false;

		const killGroup = (sig: NodeJS.Signals) => {
			if (killed) return;
			killed = true;
			try {
				process.kill(-child.pid!, sig);
			} catch {
				try { child.kill(sig); } catch { /* already gone */ }
			}
		};

		const finish = (partial: Partial<EvidenceRun>) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({
				exitCode: child.exitCode ?? null,
				output: (stdout + stderr).slice(0, EVIDENCE_OUTPUT_CAP),
				timedOut: false,
				aborted: false,
				...partial,
			});
		};

		const escalate = () => {
			// SIGKILL upgrade if the group ignores SIGTERM. `killed` (proc.killed
			// semantics) flips on the first kill call, so the timer must not be
			// gated on it; it is cleared on close, so firing means still alive.
			const k2 = setTimeout(() => killGroup("SIGKILL"), 2000);
			k2.unref?.();
			child.once("close", () => clearTimeout(k2));
		};

		const onAbort = () => {
			killGroup("SIGTERM");
			escalate();
			finish({ aborted: true });
		};

		const timer = setTimeout(() => {
			killGroup("SIGTERM");
			escalate();
			finish({ timedOut: true });
		}, EVIDENCE_TIMEOUT_MS);
		timer.unref?.();

		child.stdout.on("data", (d) => { stdout += String(d); });
		child.stderr.on("data", (d) => { stderr += String(d); });
		child.on("close", () => finish({}));
		child.on("error", () => finish({ exitCode: 127 }));

		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Execute evidence commands and evaluate the acceptance gate.
 *
 * Each evidence entry runs `command` in the given cwd. If `expect` is "exit 0"
 * (the default), a successful exit code means the check passed. The output is
 * captured (first 500 chars) for diagnostic reporting.
 */
export async function checkAcceptanceGate(
	acceptance: AcceptanceConfig,
	cwd: string,
	signal?: AbortSignal,
): Promise<GateResult> {
	const evidenceResults: GateResult["evidenceResults"] = [];

	for (const ev of acceptance.evidence ?? []) {
		if (signal?.aborted) break;
		const run = await runEvidenceCommand(ev.command, cwd, signal);

		let passed: boolean;
		if (run.timedOut || run.aborted || run.exitCode === null) {
			// A timed-out / killed command is never a passing check — exit 127,
			// missing binaries and signal deaths are failures, not "exit 1".
			passed = false;
		} else if (ev.expect === "exit 1") {
			passed = run.exitCode === 1;
		} else if (ev.expect === undefined || ev.expect === "exit 0") {
			passed = run.exitCode === 0;
		} else {
			// Unknown expect value is a configuration error — fail loudly with
			// the reason instead of silently treating it as exit-0.
			passed = false;
			run.output = `${run.output}\n[acceptance] unknown expect value: ${ev.expect}`.trim();
		}
		evidenceResults.push({ command: ev.command, output: run.output, passed });
	}

	// Criteria without a matching evidence entry are considered failed.
	const failedCriteria = (acceptance.criteria ?? []).filter((_, i) =>
		!evidenceResults[i] || !evidenceResults[i].passed,
	);

	return {
		passed: failedCriteria.length === 0 && evidenceResults.every((e) => e.passed),
		failedCriteria,
		evidenceResults,
	};
}
