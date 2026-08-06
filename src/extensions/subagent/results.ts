import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope } from "./agents.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	label?: string;
	phase?: string;
	outputFile?: string;
	contextFallback?: string;
	/** Path of the subagent's session JSONL, kept after a failed/aborted run
	 *  so it can be continued with `pico --session <path>`. */
	sessionFile?: string;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as any;
		if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part?.type === "text" && typeof part.text === "string") return part.text;
			}
		}
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.stopReason === "timeout" ||
		result.stopReason === "gate_failed" ||
		result.stopReason === "budget" ||
		result.stopReason === "schema_violation"
	);
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export function truncateOutput(output: string, byteCap: number): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= byteCap) return output;

	let truncated = output.slice(0, byteCap);
	while (Buffer.byteLength(truncated, "utf8") > byteCap) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const raw of messages as any[]) {
		if (raw?.role !== "assistant" || !Array.isArray(raw.content)) continue;
		for (const part of raw.content) {
			if (part?.type === "text" && typeof part.text === "string") {
				items.push({ type: "text", text: part.text });
			} else if (part?.type === "toolCall" && typeof part.name === "string") {
				items.push({ type: "toolCall", name: part.name, args: part.arguments ?? {} });
			}
		}
	}
	return items;
}

