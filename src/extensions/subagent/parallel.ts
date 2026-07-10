import { getResultOutput, isFailedResult, truncateOutput, type SingleResult, type UsageStats } from "./results.ts";

export const DEFAULT_USAGE_STATS: UsageStats = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

export interface ParallelTask {
	agent: string;
	task: string;
}

export function createParallelPlaceholders(tasks: ParallelTask[]): SingleResult[] {
	return tasks.map((task) => ({
		agent: task.agent,
		agentSource: "unknown",
		task: task.task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { ...DEFAULT_USAGE_STATS },
	}));
}

export function formatParallelProgress(results: SingleResult[]): string {
	const running = results.filter((r) => r.exitCode === -1).length;
	const done = results.length - running;
	return `Parallel: ${done}/${results.length} done, ${running} running...`;
}

export function summarizeParallelResults(
	results: SingleResult[],
	byteCap: number,
	mergeNotes: string[] = [],
): string {
	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const summaries = results.map((r) => {
		const output = truncateOutput(getResultOutput(r), byteCap);
		const status = isFailedResult(r)
			? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
			: "completed";
		const noteLine = r.contextFallback ? `\n_note: ${r.contextFallback}_\n` : "";
		return `### [${r.agent}] ${status}${noteLine}\n\n${output}`;
	});
	let text = `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`;
	if (mergeNotes.length > 0) {
		text += `\n\n---\n\n## Worktree merges\n\n${mergeNotes.join("\n\n")}`;
	}
	return text;
}
