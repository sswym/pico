import * as path from "node:path";
import { rmSync } from "node:fs";
import { getFinalOutput, isFailedResult, type SingleResult } from "./results.ts";

export interface LargeOutputWriter {
	mkdtemp(prefix: string): Promise<string>;
	writeFile(filePath: string, content: string): Promise<void>;
	now(): number;
	tmpPrefix: string;
}

/**
 * Spilled temp dirs live until the session ends (2.4.7): a chain's later
 * steps (or the user's own follow-up read) receive the spill file path in
 * the message text, so deleting the file at once made the referenced output
 * vanish mid-run. cleanupSpillDirs() runs at session_shutdown.
 */
const spillDirs: string[] = [];

export function registerSpillDir(dir: string): void {
	spillDirs.push(dir);
}

/** Remove all spilled temp dirs. Called at session shutdown. */
export function cleanupSpillDirs(): void {
	for (const dir of spillDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}

/** Test-only: drop the registry without touching disk. */
export function __resetSpillDirsForTests(): void {
	spillDirs.length = 0;
}

/**
 * Spill a large file-only output to a temp dir. The dir is registered for
 * session-end cleanup instead of being removed immediately.
 */
export async function spillLargeFileOnlyOutput(
	result: SingleResult,
	agentName: string,
	outputMode: "inline" | "file-only" | undefined,
	byteCap: number,
	writer: LargeOutputWriter,
): Promise<void> {
	if (outputMode !== "file-only" || isFailedResult(result)) return;

	const finalOutput = getFinalOutput(result.messages);
	const byteLength = Buffer.byteLength(finalOutput, "utf8");
	if (byteLength <= byteCap) return;

	const tmpDir = await writer.mkdtemp(writer.tmpPrefix);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const outFile = path.join(tmpDir, `output-${safeName}-${writer.now()}.md`);
	await writer.writeFile(outFile, finalOutput);
	result.outputFile = outFile;
	registerSpillDir(tmpDir);

	const preview = finalOutput.slice(0, 2048);
	const reference = `Output written to file (${byteLength} bytes): ${outFile}\n\n--- Preview (first 2KB) ---\n${preview}`;
	replaceFinalAssistantText(result, reference);
}

export function replaceFinalAssistantText(result: SingleResult, text: string): boolean {
	for (let i = result.messages.length - 1; i >= 0; i--) {
		const msg = result.messages[i] as any;
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j];
			if (part?.type === "text") {
				msg.content[j] = { ...part, text };
				return true;
			}
		}
	}
	return false;
}
