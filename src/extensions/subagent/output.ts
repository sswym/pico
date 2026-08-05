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
 * Spill a large file-only output to a temp dir. Returns a cleanup function
 * that removes the temp dir (the spilled file may contain sensitive agent
 * output — it must not accumulate in /tmp across a long session).
 */
export async function spillLargeFileOnlyOutput(
	result: SingleResult,
	agentName: string,
	outputMode: "inline" | "file-only" | undefined,
	byteCap: number,
	writer: LargeOutputWriter,
): Promise<(() => void) | undefined> {
	if (outputMode !== "file-only" || isFailedResult(result)) return undefined;

	const finalOutput = getFinalOutput(result.messages);
	const byteLength = Buffer.byteLength(finalOutput, "utf8");
	if (byteLength <= byteCap) return undefined;

	const tmpDir = await writer.mkdtemp(writer.tmpPrefix);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const outFile = path.join(tmpDir, `output-${safeName}-${writer.now()}.md`);
	await writer.writeFile(outFile, finalOutput);
	result.outputFile = outFile;

	const preview = finalOutput.slice(0, 2048);
	const reference = `Output written to file (${byteLength} bytes): ${outFile}\n\n--- Preview (first 2KB) ---\n${preview}`;
	replaceFinalAssistantText(result, reference);

	return () => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	};
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
