/**
 * Acceptance gates — structured contract verification for subagent output.
 *
 * When an agent declares an `acceptance` block in its frontmatter, the runtime
 * checks the specified evidence commands after the agent completes. If the gate
 * fails and `selfRepair` is enabled, the agent is re-invoked with failure
 * details appended to its task.
 */
import { execSync } from "node:child_process";
import type { AcceptanceConfig } from "./agents.ts";
import { isFailedResult, type SingleResult } from "./results.ts";

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
	_signal?: AbortSignal,
): Promise<GateResult> {
	const evidenceResults: GateResult["evidenceResults"] = [];

	for (const ev of acceptance.evidence ?? []) {
		if (_signal?.aborted) break;
		try {
			const output = execSync(ev.command, {
				cwd,
				timeout: 60_000,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const expectExit0 = ev.expect !== "exit 1";
			evidenceResults.push({ command: ev.command, output: output.slice(0, 500), passed: expectExit0 });
		} catch (err: any) {
			const output = (err.stdout || "") + (err.stderr || "");
			const expectExit1 = err.status !== 0 && ev.expect === "exit 1";
			evidenceResults.push({
				command: ev.command,
				output: output.slice(0, 500),
				passed: expectExit1,
			});
		}
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
