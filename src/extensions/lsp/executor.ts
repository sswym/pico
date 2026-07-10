import type { LspManagerState } from "./manager.ts";
import { flattenDocumentSymbols, formatDocumentSymbols, getActiveClients } from "./manager.ts";
import { loadConfig } from "./config.ts";
import { lspPositionToDisplay, uriToPath } from "./client.ts";
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

export function fail(text: string, details?: LspDetails) {
	return { content: [{ type: TEXT, text }], details: details ?? { success: false }, isError: true };
}

const LSP_READONLY_ACTIONS = new Set<Action>([
	"hover",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"diagnostics",
	"symbols",
	"capabilities",
	"status",
]);

const LSP_WRITE_OR_HIGH_RISK_ACTIONS = new Set<Action>([
	"rename",
	"rename_file",
	"reload",
	"request",
]);

export function asAction(raw: unknown): Action | null {
	if (typeof raw !== "string") return null;
	return (ACTIONS as readonly string[]).includes(raw) ? (raw as Action) : null;
}

export function isLspReadonlyInput(input: unknown): boolean {
	const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
	const action = asAction(record.action);
	if (!action) return false;
	if (action === "code_actions") return record.apply !== true;
	return LSP_READONLY_ACTIONS.has(action);
}

export function isLspWriteOrHighRiskInput(input: unknown): boolean {
	const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
	const action = asAction(record.action);
	if (!action) return false;
	if (action === "code_actions") return record.apply === true;
	return LSP_WRITE_OR_HIGH_RISK_ACTIONS.has(action);
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
			const filePath = uriToPath(uri);
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
