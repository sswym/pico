export interface ChainTaskStep {
	task: string;
	reads?: string[];
}

export type ReadFile = (filePath: string) => string;

/** Cap for {previous} inlining (2.4.7): a MB-scale prior step would explode
 *  the next step's context window. */
export const PREVIOUS_OUTPUT_CAP = 32 * 1024;

/** Cap for read-file context injection. */
const READ_FILE_CAP = 16 * 1024;

function truncate(text: string, cap: number): string {
	if (text.length <= cap) return text;
	return `${text.slice(0, cap)}\n\n[... truncated: ${text.length - cap} chars omitted for context]`;
}

export function buildChainTask(
	step: ChainTaskStep,
	previousOutput: string,
	outputs: Record<string, string>,
	readFile: ReadFile,
): string {
	const cappedPrevious = previousOutput ? truncate(previousOutput, PREVIOUS_OUTPUT_CAP) : previousOutput;
	// Replacement FUNCTION (not string): a string replacement would interpret
	// `$$`, `$&`, `` $` ``, `$'` in the agent's previous output as special
	// patterns and silently corrupt the task prompt.
	let taskWithContext = step.task.replace(/\{previous\}/g, () => cappedPrevious);
	taskWithContext = taskWithContext.replace(
		/\{outputs\.(\w+)\}/g,
		(_, key: string) =>
			outputs[key] ??
			`[CHAIN ERROR: output "${key}" not found — the step that defines it must run first, or the name is misspelled]`,
	);

	if (!step.reads || step.reads.length === 0) return taskWithContext;

	const readSections: string[] = [];
	for (const filePath of step.reads) {
		try {
			const content = truncate(readFile(filePath), READ_FILE_CAP);
			readSections.push(`--- File: ${filePath} ---\n${content}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			readSections.push(`--- File: ${filePath} (could not read: ${message}) ---`);
		}
	}

	return `## Context (read into prompt)\n\n${readSections.join("\n\n")}\n\n## Task\n\n${taskWithContext}`;
}
