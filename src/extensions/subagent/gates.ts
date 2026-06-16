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

export interface GateResult {
	passed: boolean;
	failedCriteria: string[];
	evidenceResults: Array<{ command: string; output: string; passed: boolean }>;
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
		evidenceResults[i] && !evidenceResults[i].passed,
	);

	return {
		passed: failedCriteria.length === 0 && evidenceResults.every((e) => e.passed),
		failedCriteria,
		evidenceResults,
	};
}
