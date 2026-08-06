import type { LspManagerState } from "./manager.ts";
import { flattenDocumentSymbols, formatDocumentSymbols, getActiveClients } from "./manager.ts";
import { loadConfig } from "./config.ts";
import { lspPositionToDisplay, uriToPath } from "./client.ts";
import { existsSync } from "node:fs";
import { toolError, type ErrorCode } from "../errors.ts";
import {
	extractLocationFields,
	isFlatSymbolInfoArray,
	isHierarchicalSymbolArray,
	isWorkspaceSymbolArray,
} from "./actions.ts";

export const ACTIONS = [
	"hover", "definition", "type_definition", "implementation", "references",
	"diagnostics", "symbols", "code_actions", "rename", "rename_file",
	"capabilities", "status", "reload", "request",
] as const;

export type Action = (typeof ACTIONS)[number];

export interface LspDetails {
	serverName?: string;
	action?: string;
	success: boolean;
}

const TEXT: "text" = "text";

export function ok(text: string, details?: LspDetails) {
	return { content: [{ type: TEXT, text }], details: details ?? { success: true } };
}

export function fail(text: string, _details?: LspDetails, cause?: unknown, code: ErrorCode = "invalid_request"): never {
	// Throwing is the only way the agent loop learns a tool call failed — a
	// returned isError flag is dropped upstream and the failure would render
	// as a success. Throws a coded ToolError (errors.ts) for stable routing.
	throw toolError(code, text, cause === undefined ? undefined : { cause });
}

export interface LspActionMeta {
	readonly: boolean;      // 纯只读操作
	writeCapable: boolean;  // 可能写盘/高风险的写操作
}

/**
 * 单一事实来源：14 个 action 的权限元数据（code_actions 的 apply 动态特判，
 * 见 isLspReadonlyInput / isLspWriteOrHighRiskInput）。
 */
export const LSP_ACTION_METADATA: Record<Action, LspActionMeta> = {
	hover: { readonly: true, writeCapable: false },
	definition: { readonly: true, writeCapable: false },
	type_definition: { readonly: true, writeCapable: false },
	implementation: { readonly: true, writeCapable: false },
	references: { readonly: true, writeCapable: false },
	diagnostics: { readonly: true, writeCapable: false },
	symbols: { readonly: true, writeCapable: false },
	capabilities: { readonly: true, writeCapable: false },
	status: { readonly: true, writeCapable: false },
	// code_actions 动态特判：无 apply → 只读；apply=true → 写。表中同时标记
	// 两种能力，实际取值由 isLspReadonlyInput / isLspWriteOrHighRiskInput 的
	// apply 分支决定。
	code_actions: { readonly: true, writeCapable: true },
	rename: { readonly: false, writeCapable: true },
	rename_file: { readonly: false, writeCapable: true },
	// request 可调用任意 LSP 方法（含 workspace/applyEdit 等写方法），按高风险处理。
	request: { readonly: false, writeCapable: true },
	// reload 只重启服务器、不读写文件系统：既非只读也非写。
	reload: { readonly: false, writeCapable: false },
};

function isReadonlyAction(action: Action): boolean {
	return LSP_ACTION_METADATA[action].readonly;
}

function isWriteOrHighRiskAction(action: Action): boolean {
	return LSP_ACTION_METADATA[action].writeCapable;
}

export const READONLY_ACTIONS = ACTIONS.filter((action) => isReadonlyAction(action));

// code_actions 的 writeCapable 由 apply=true 输入触发，本身不是独立 action 名，
// 保留既有展示串 "code_actions apply=true"，故从写集合中剔除该 action 名。
export const BLOCKED_WRITE_OR_HIGH_RISK_ACTIONS = [
	...ACTIONS.filter((action) => isWriteOrHighRiskAction(action) && action !== "code_actions"),
	"code_actions apply=true",
] as const;

export function asAction(raw: unknown): Action | null {
	if (typeof raw !== "string") return null;
	return (ACTIONS as readonly string[]).includes(raw) ? (raw as Action) : null;
}

export function isLspReadonlyInput(input: unknown): boolean {
	const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
	const action = asAction(record.action);
	if (!action) return false;
	if (action === "code_actions") return record.apply !== true;
	return isReadonlyAction(action);
}

export function isLspWriteOrHighRiskInput(input: unknown): boolean {
	const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
	const action = asAction(record.action);
	if (!action) return false;
	if (action === "code_actions") return record.apply === true;
	return isWriteOrHighRiskAction(action);
}

export function executeStatusAction(state: LspManagerState, cwd: string) {
	if (!state.config) state.config = loadConfig(cwd);
	const serverNames = Object.keys(state.config.servers);
	if (serverNames.length === 0) return ok("No language servers configured for this project.");
	const active = getActiveClients(state);
	if (active.length === 0) {
		return ok(`Configured servers: ${serverNames.join(", ")}\nNo servers started yet.`);
	}
	const lines: string[] = [];
	for (const [name, client] of active) {
		const ver = client.displayVersion || "unknown";
		const openCount = client.getAllDiagnostics().size;
		lines.push(`  ${name} v${ver} — ${client.status} (${openCount} files with diagnostics)`);
	}
	return ok(`Active language servers:\n${lines.join("\n")}`, { action: "status", success: true });
}

export function executeCapabilitiesAction(client: { serverName: string; capabilities: Record<string, unknown> }) {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(client.capabilities)) {
		if (value === true) lines.push(`  ${key}: supported`);
		else if (typeof value === "object" && value !== null) lines.push(`  ${key}: ${JSON.stringify(value)}`);
	}
	return ok(`Capabilities of ${client.serverName}:\n${lines.join("\n")}`, {
		serverName: client.serverName,
		action: "capabilities",
		success: true,
	});
}

export async function executeRequestAction(
	client: { rawRequest(method: string, payload: unknown): Promise<unknown> },
	query: string | undefined,
	payload: unknown,
) {
	if (!query) return fail("request action requires 'query' (LSP method name).");
	try {
		const result = await client.rawRequest(query, payload ?? null);
		return ok(JSON.stringify(result, null, 2));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return fail(`LSP request failed: ${msg}`);
	}
}

export function executeWorkspaceDiagnosticsAction(state: LspManagerState) {
	const activeClients = getActiveClients(state);
	if (activeClients.length === 0) return ok("No active language servers.");
	const allMessages: string[] = [];
	for (const [_serverName, managed] of activeClients) {
		const allDiags = managed.getAllDiagnostics();
		for (const [uri, diags] of allDiags) {
			if (diags.length === 0) continue;
			// Files deleted mid-session keep their cached diagnostics forever
			// — drop them from the workspace report so the model isn't told
			// that a deleted file still has errors.
			const filePath = uriToPath(uri);
			if (filePath && !existsSync(filePath)) continue;
			for (const diagnostic of diags) {
				const pos = lspPositionToDisplay(diagnostic.range.start);
				const severity = diagnostic.severity === 1
					? "ERROR"
					: diagnostic.severity === 2
						? "WARNING"
						: diagnostic.severity === 3
							? "INFO"
							: "HINT";
				const code = diagnostic.code ? ` [${diagnostic.code}]` : "";
				const source = diagnostic.source ? ` (${diagnostic.source})` : "";
				allMessages.push(`${filePath}:${pos.line}:${pos.character} ${severity}${code}${source}: ${diagnostic.message}`);
			}
		}
	}
	if (allMessages.length === 0) return ok("No diagnostics found.", { action: "diagnostics", success: true });
	return ok(`Workspace diagnostics (${allMessages.length}):\n${allMessages.join("\n")}`, {
		action: "diagnostics",
		success: true,
	});
}

export function formatWorkspaceSymbolsResult(query: string, result: unknown) {
	if (!Array.isArray(result) || result.length === 0) return ok(`No symbols found matching "${query}".`);
	if (!isWorkspaceSymbolArray(result)) return ok(`No symbols found matching "${query}".`);
	const lines: string[] = [];
	for (const symbol of result) {
		const loc = extractLocationFields(symbol.location);
		if (loc) {
			lines.push(`  ${symbol.name} [${symbol.kind}] ${loc.uri.replace("file://", "")}:${loc.line + 1}`);
		} else {
			lines.push(`  ${symbol.name} [${symbol.kind}] (no location)`);
		}
	}
	return ok(`Workspace symbols matching "${query}" (${result.length}):\n${lines.join("\n")}`);
}

export function formatDocumentSymbolsResult(file: string, result: unknown) {
	if (!Array.isArray(result) || result.length === 0) return ok(`No symbols found in ${file}.`);
	if (isHierarchicalSymbolArray(result)) {
		const flat = flattenDocumentSymbols(result);
		return ok(formatDocumentSymbols(flat));
	}
	if (isFlatSymbolInfoArray(result)) {
		const lines: string[] = [];
		for (const symbol of result) {
			const symbolFile = symbol.location.uri.replace("file://", "");
			const container = symbol.containerName ? ` (${symbol.containerName})` : "";
			lines.push(`  ${symbol.name} [${symbol.kind}] ${symbolFile}:${symbol.location.range.start.line + 1}${container}`);
		}
		return ok(`Symbols in ${file} (${result.length}):\n${lines.join("\n")}`);
	}
	return ok(`No symbols found in ${file}.`);
}
