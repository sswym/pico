import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult } from "./results.ts";

export function applyJsonModeEvent(result: SingleResult, event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const raw = event as { type?: unknown; message?: unknown };
	if (raw.type === "message_end" && raw.message) {
		const msg = raw.message as Message;
		result.messages.push(msg);

		if (msg.role === "assistant") {
			result.usage.turns++;
			const usage = msg.usage;
			if (usage) {
				result.usage.input += usage.input || 0;
				result.usage.output += usage.output || 0;
				result.usage.cacheRead += usage.cacheRead || 0;
				result.usage.cacheWrite += usage.cacheWrite || 0;
				result.usage.cost += usage.cost?.total || 0;
				result.usage.contextTokens = usage.totalTokens || 0;
			}
			if (!result.model && msg.model) result.model = msg.model;
			if (msg.stopReason) result.stopReason = msg.stopReason;
			if (msg.errorMessage) result.errorMessage = msg.errorMessage;
		}
		return true;
	}

	if (raw.type === "tool_result_end" && raw.message) {
		result.messages.push(raw.message as Message);
		return true;
	}

	return false;
}

export function applyJsonModeLine(result: SingleResult, line: string): boolean {
	if (!line.trim()) return false;
	try {
		return applyJsonModeEvent(result, JSON.parse(line));
	} catch {
		return false;
	}
}

