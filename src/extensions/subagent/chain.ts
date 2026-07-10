export interface ChainTaskStep {
	task: string;
	reads?: string[];
}

export type ReadFile = (filePath: string) => string;

export function buildChainTask(
	step: ChainTaskStep,
	previousOutput: string,
	outputs: Record<string, string>,
	readFile: ReadFile,
): string {
	let taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
	taskWithContext = taskWithContext.replace(
		/\{outputs\.(\w+)\}/g,
		(_, key: string) => outputs[key] ?? `(output "${key}" not found)`,
	);

	if (!step.reads || step.reads.length === 0) return taskWithContext;

	const readSections: string[] = [];
	for (const filePath of step.reads) {
		try {
			const content = readFile(filePath);
			readSections.push(`--- File: ${filePath} ---\n${content}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			readSections.push(`--- File: ${filePath} (could not read: ${message}) ---`);
		}
	}

	return `## Context (read into prompt)\n\n${readSections.join("\n\n")}\n\n## Task\n\n${taskWithContext}`;
}
