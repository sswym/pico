import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult } from "./results.ts";

/**
 * Per-result message cap (L6 部分落地). A subagent's session JSONL is stored
 * verbatim into the main session on every call — a long-running child and its
 * tool_result quirks can otherwise grow the main session by hundreds of KB per
 * call. The tail is what rendering and final-output extraction depend on
 * (getFinalOutput scans from the end), so we keep the FIRST user message for
 * task context, the LAST MAX_KEPT_MESSAGES for trajectory, and drop the
 * middle. 128 keeps a healthy tool-call slice on display while bounding the
 * stored bytes at roughly the same order as a 20-turn short session.
 */
export const MAX_KEPT_MESSAGES = 128;

function capMessages(result: SingleResult): void {
  if (result.messages.length <= MAX_KEPT_MESSAGES + 1) return;
  /** First user message (task context) always survives. */
  const firstIdx = result.messages.findIndex((m) => m.role === "user");
  const tail = result.messages.slice(-MAX_KEPT_MESSAGES);
  const first = firstIdx >= 0 ? result.messages[firstIdx] : undefined;
  const kept: Message[] = [];
  if (first && !tail.includes(first)) kept.push(first);
  kept.push(...tail);
  result.messages = kept;
}

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
		capMessages(result);
		return true;
	}

	if (raw.type === "tool_result_end" && raw.message) {
		result.messages.push(raw.message as Message);
		capMessages(result);
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

