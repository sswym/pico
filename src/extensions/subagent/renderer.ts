import * as os from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
	ELLIPSIS,
	renderExpandHint,
	renderStatusIcon,
	sanitizeTerminalText,
	truncateWithEllipsis,
	UI_ICONS,
} from "../ui/rendering.ts";
import type { AgentScope } from "./agents.ts";
import {
	getDisplayItems,
	getFinalOutput,
	isFailedResult,
	type DisplayItem,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
} from "./results.ts";

const COLLAPSED_ITEM_COUNT = 10;
/** Per-line width budget for collapsed item text — a single unwrapped line
 *  of 10k chars would wrap to hundreds of terminal rows. */
const COLLAPSED_LINE_WIDTH = 120;
/** Hard cap on total collapsed item lines (10 items × 3 lines + overhead). */
const MAX_COLLAPSED_LINES = 40;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: Partial<UsageStats>, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = sanitizeTerminalText((args.command as string) || ELLIPSIS);
			const preview = truncateWithEllipsis(command, 60);
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = sanitizeTerminalText((args.file_path || args.path || ELLIPSIS) as string);
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = sanitizeTerminalText((args.file_path || args.path || ELLIPSIS) as string);
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = sanitizeTerminalText((args.file_path || args.path || ELLIPSIS) as string);
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = sanitizeTerminalText((args.path || ".") as string);
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = sanitizeTerminalText((args.pattern || "*") as string);
			const rawPath = sanitizeTerminalText((args.path || ".") as string);
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = sanitizeTerminalText((args.pattern || "") as string);
			const rawPath = sanitizeTerminalText((args.path || ".") as string);
			return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		default: {
			const argsStr = sanitizeTerminalText(JSON.stringify(args));
			const preview = truncateWithEllipsis(argsStr, 50);
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export function renderSubagentCall(args: any, theme: any) {
	const scope: AgentScope = args.agentScope ?? "user";
	if (args.chain && args.chain.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `chain (${args.chain.length} steps)`) +
			theme.fg("muted", ` [${scope}]`);
		for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
			const step = args.chain[i];
			const cleanTask = sanitizeTerminalText(step.task).replace(/\{previous\}/g, "").trim();
			const preview = truncateWithEllipsis(cleanTask, 40);
			text += "\n  " + theme.fg("muted", `${i + 1}.`) + " " + theme.fg("accent", sanitizeTerminalText(step.agent)) + theme.fg("dim", ` ${preview}`);
		}
		if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `${ELLIPSIS} +${args.chain.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	if (args.tasks && args.tasks.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
			theme.fg("muted", ` [${scope}]`);
		for (const t of args.tasks.slice(0, 3)) {
			const preview = truncateWithEllipsis(sanitizeTerminalText(t.task), 40);
			text += `\n  ${theme.fg("accent", sanitizeTerminalText(t.agent))}${theme.fg("dim", ` ${preview}`)}`;
		}
		if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `${ELLIPSIS} +${args.tasks.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	const agentName = sanitizeTerminalText(args.agent || ELLIPSIS);
	const preview = args.task ? truncateWithEllipsis(sanitizeTerminalText(args.task), 60) : ELLIPSIS;
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		theme.fg("muted", ` [${scope}]`);
	text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

function aggregateUsage(results: SingleResult[]) {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

export function renderSubagentResult(result: any, expanded: boolean, theme: any) {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? sanitizeTerminalText(text.text) : "(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();
	const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
		const collapsed = limit !== undefined;
		const toShow = limit ? items.slice(-limit) : items;
		const skipped = limit && items.length > limit ? items.length - limit : 0;
		let text = "";
		let lineCount = 0;
		const append = (str: string) => {
			text += str;
			lineCount += str.split("\n").length;
		};
		if (skipped > 0) append(theme.fg("muted", `${ELLIPSIS} ${skipped} earlier items\n`));
		for (const item of toShow) {
			if (collapsed && lineCount >= MAX_COLLAPSED_LINES) break;
			if (item.type === "text") {
				const safeText = sanitizeTerminalText(item.text);
				let preview = expanded ? safeText : safeText.split("\n").slice(0, 3).join("\n");
				if (collapsed) {
					preview = preview.split("\n").map((l) => truncateWithEllipsis(l, COLLAPSED_LINE_WIDTH)).join("\n");
				}
				append(`${theme.fg("toolOutput", preview)}\n`);
			} else {
				append(`${theme.fg("muted", `${UI_ICONS.toolCall} `) + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`);
			}
		}
		return text.trimEnd();
	};

	if (details.mode === "single" && details.results.length === 1) {
		const r = details.results[0]!;
		const isError = isFailedResult(r);
		const icon = renderStatusIcon(theme, isError ? "error" : "success");
		const displayItems = getDisplayItems(r.messages);
		const finalOutput = getFinalOutput(r.messages);

		if (expanded) {
			const container = new Container();
			let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
			if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
			container.addChild(new Text(header, 0, 0));
			if (isError && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${sanitizeTerminalText(r.errorMessage)}`), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", sanitizeTerminalText(r.task)), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			if (displayItems.length === 0 && !finalOutput) {
				container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
			} else {
				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(new Text(theme.fg("muted", `${UI_ICONS.toolCall} `) + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
					}
				}
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(sanitizeTerminalText(finalOutput).trim(), 0, 0, mdTheme));
				}
			}
			const usageStr = formatUsageStats(r.usage, r.model);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			return container;
		}

		let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
		if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${sanitizeTerminalText(r.errorMessage)}`)}`;
		else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
		else {
			text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
			if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${renderExpandHint(theme)}`;
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
		return new Text(text, 0, 0);
	}

	if (details.mode === "chain") {
		const successCount = details.results.filter((r) => !isFailedResult(r)).length;
		const icon = renderStatusIcon(theme, successCount === details.results.length ? "success" : "error");
		let text = icon + " " + theme.fg("toolTitle", theme.bold("chain ")) + theme.fg("accent", `${successCount}/${details.results.length} steps`);
		for (const r of details.results) {
			const rIcon = renderStatusIcon(theme, isFailedResult(r) ? "error" : "success");
			const displayItems = getDisplayItems(r.messages);
			const stepLabel = r.label ? r.label : `Step ${r.step}`;
			const phaseTag = r.phase ? theme.fg("warning", `[${r.phase}] `) : "";
			text += `\n\n${theme.fg("muted", `─── ${stepLabel}: `)}${phaseTag}${theme.fg("accent", r.agent)} ${rIcon}`;
			if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
			else text += `\n${renderDisplayItems(displayItems, expanded ? undefined : 5)}`;
			if (expanded) {
				const finalOutput = getFinalOutput(r.messages);
				if (finalOutput) text += `\n\n${sanitizeTerminalText(finalOutput).trim()}`;
			}
		}
		const usageStr = formatUsageStats(aggregateUsage(details.results));
		if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
		if (!expanded) text += `\n${renderExpandHint(theme)}`;
		return new Text(text, 0, 0);
	}

	if (details.mode === "parallel") {
		const running = details.results.filter((r) => r.exitCode === -1).length;
		const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
		const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
		const isRunning = running > 0;
		const icon = renderStatusIcon(theme, isRunning ? "running" : failCount > 0 ? "partial" : "success");
		const status = isRunning ? `${successCount + failCount}/${details.results.length} done, ${running} running` : `${successCount}/${details.results.length} tasks`;
		let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
		for (const r of details.results) {
			const rIcon = renderStatusIcon(theme, r.exitCode === -1 ? "running" : isFailedResult(r) ? "error" : "success");
			const displayItems = getDisplayItems(r.messages);
			text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
			if (displayItems.length === 0) text += `\n${theme.fg("muted", r.exitCode === -1 ? `(running${ELLIPSIS})` : "(no output)")}`;
			else text += `\n${renderDisplayItems(displayItems, expanded ? undefined : 5)}`;
		}
		if (!isRunning) {
			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
		}
		if (!expanded) text += `\n${renderExpandHint(theme)}`;
		return new Text(text, 0, 0);
	}

	const text = result.content[0];
	return new Text(text?.type === "text" ? sanitizeTerminalText(text.text) : "(no output)", 0, 0);
}
