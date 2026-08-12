/**
 * Supervisor channel — subagent ↔ parent communication.
 *
 * 参考 nicobailon/pi-subagents 的文件信箱模式：子代理与父代理是独立进程
 * （stdin ignore、stdout 被 JSONL 协议占用），通信走文件系统——环境变量
 * 传递通道身份，requests/replies 目录承载消息，双方轮询。
 *
 * 子侧：spawn 时注入 PICO_SUBAGENT_CHANNEL_DIR 等环境变量；子代理进程内
 * 的 contact_supervisor 工具（仅子代理身份时注册）写请求文件并轮询回复。
 * 父侧：setInterval 轮询所有 channel 的 requests/，新请求通过
 * pi.sendMessage(..., {triggerTurn: true}) 唤醒父代理回合；父代理用
 * subagent_supervisor 工具回复（写回复文件），子代理轮询读到后继续。
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getJob } from "./jobs.ts";

export const SUBAGENT_CHANNEL_DIR_ENV = "PICO_SUBAGENT_CHANNEL_DIR";
export const SUBAGENT_RUN_ID_ENV = "PICO_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PICO_SUBAGENT_CHILD_AGENT";
export const SUBAGENT_CHILD_INDEX_ENV = "PICO_SUBAGENT_CHILD_INDEX";
export const SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV = "PICO_SUBAGENT_ORCHESTRATOR_SESSION_ID";

export const CONTACT_SUPERVISOR_TOOL = "contact_supervisor";
export const SUPERVISOR_TOOL = "subagent_supervisor";
export const STEER_TOOL = "subagent_steer";

const REQUESTS_DIR = "requests";
const REPLIES_DIR = "replies";
/** Parent-side steering instructions to a running child (subagent_steer). */
const STEER_DIR = "steer";
const MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
/** Parent poller cadence for new request files. */
export const PARENT_POLL_INTERVAL_MS = 500;
/** Child reply poll cadence. */
const CHILD_REPLY_POLL_MS = 250;

/** 通道根目录；PICO_SUPERVISOR_CHANNEL_ROOT 可覆盖（测试隔离/自托管 /tmp）。 */
export function channelRoot(): string {
	return process.env.PICO_SUPERVISOR_CHANNEL_ROOT?.trim() || path.join(os.tmpdir(), "pico-supervisor-channels");
}

type SupervisorReason = "need_decision" | "interview_request" | "progress_update";

interface SupervisorRequest {
	type: "pico.supervisor.request";
	id: string;
	createdAt: number;
	expiresAt?: number;
	reason: SupervisorReason;
	message: string;
	expectsReply: boolean;
	runId: string;
	agent: string;
	childIndex: number;
	orchestratorSessionId: string;
}

interface PendingRequest extends SupervisorRequest {
	channelDir: string;
	requestFile: string;
}

interface SupervisorReply {
	type: "pico.supervisor.reply";
	requestId: string;
	createdAt: number;
	message: string;
}

interface ChildMetadata {
	channelDir: string;
	runId: string;
	agent: string;
	childIndex: number;
	orchestratorSessionId: string;
}

function safeSegment(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function readTextEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

/** 子代理身份元数据；普通会话（父进程）没有这些环境变量。 */
export function readChildMetadata(): ChildMetadata | undefined {
	const channelDir = readTextEnv(SUBAGENT_CHANNEL_DIR_ENV);
	const runId = readTextEnv(SUBAGENT_RUN_ID_ENV);
	const agent = readTextEnv(SUBAGENT_CHILD_AGENT_ENV);
	const orchestratorSessionId = readTextEnv(SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV);
	const rawIndex = readTextEnv(SUBAGENT_CHILD_INDEX_ENV);
	if (!channelDir || !runId || !agent || !orchestratorSessionId || rawIndex === undefined || !/^\d+$/.test(rawIndex)) {
		return undefined;
	}
	return { channelDir, runId, agent, childIndex: Number(rawIndex), orchestratorSessionId };
}

let runIdCounter = 0;

/** 每次 run 的唯一身份（父侧生成，经环境变量传给子进程）。 */
export function createRunId(): string {
	runIdCounter++;
	return `run-${Date.now()}-${runIdCounter}`;
}

/** 生成一次 run 的通道身份（父侧）。 */
export function createChannelDir(runId: string, agent: string, childIndex: number): string {
	const channelDir = path.join(channelRoot(), `${safeSegment(runId)}-${safeSegment(agent)}-${childIndex}`);
	fs.mkdirSync(path.join(channelDir, REQUESTS_DIR), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(channelDir, REPLIES_DIR), { recursive: true, mode: 0o700 });
	return channelDir;
}

function requestPath(channelDir: string, requestId: string): string {
	return path.join(channelDir, REQUESTS_DIR, `${safeSegment(requestId)}.json`);
}

function replyPath(channelDir: string, requestId: string): string {
	return path.join(channelDir, REPLIES_DIR, `${safeSegment(requestId)}.json`);
}

function writeAtomicJson(filePath: string, value: unknown): void {
	const tmpPath = `${filePath}.tmp-${process.pid}`;
	fs.writeFileSync(tmpPath, JSON.stringify(value, null, "\t"));
	fs.renameSync(tmpPath, filePath);
}

export function removeRequestFile(file: string): void {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// best-effort cleanup
	}
}

/** 清空整个通道根目录（session_shutdown 时，同步模式下子代理均已结束）。 */
export function clearChannelRoot(): void {
	try {
		fs.rmSync(channelRoot(), { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
}

function askTimeoutMs(): number {
	const parsed = Number(process.env.PICO_SUPERVISOR_ASK_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ASK_TIMEOUT_MS;
}

function formatChildMessage(metadata: ChildMetadata, reason: SupervisorReason, message: string | undefined, interview: unknown): string {
	const heading =
		reason === "interview_request"
			? "Subagent requests a structured supervisor interview."
			: reason === "progress_update"
				? "Subagent progress update."
				: "Subagent needs a supervisor decision.";
	const lines = [heading, `Run: ${metadata.runId}`, `Agent: ${metadata.agent}`, `Child index: ${metadata.childIndex}`, ""];
	if (message?.trim()) lines.push(message.trim());
	if (reason === "interview_request" && interview !== undefined) {
		lines.push("", "Structured response requested. Reply with JSON, optionally fenced in ```json, matching the requested interview shape.", "");
		lines.push(JSON.stringify(interview, null, "\t"));
	}
	return lines.join("\n").trimEnd();
}

function parseStructuredReply(message: string): { value?: unknown; error?: string } {
	const trimmed = message.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
	try {
		return { value: JSON.parse(fenced ?? trimmed) };
	} catch (error) {
		return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
	}
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Supervisor request cancelled."));
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error("Supervisor request cancelled."));
		};
		timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForReply(channelDir: string, requestId: string, deadline: number, signal?: AbortSignal): Promise<string> {
	while (Date.now() <= deadline) {
		if (signal?.aborted) throw new Error("Supervisor request cancelled.");
		const file = replyPath(channelDir, requestId);
		if (fs.existsSync(file)) {
			const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SupervisorReply>;
			if (parsed.type === "pico.supervisor.reply" && parsed.requestId === requestId && typeof parsed.message === "string") {
				return parsed.message;
			}
		}
		await delay(CHILD_REPLY_POLL_MS, signal);
	}
	throw new Error("Timed out waiting for supervisor reply.");
}

// ── 子侧：contact_supervisor ────────────────────────────────────────────────

interface ContactSupervisorParams {
	reason: SupervisorReason;
	message?: string;
	interview?: unknown;
}

const ContactSupervisorParamsSchema = Type.Object({
	reason: StringEnum(["need_decision", "interview_request", "progress_update"] as const, {
		description: "need_decision: blocking question for the parent; interview_request: structured input; progress_update: fire-and-forget update.",
	}),
	message: Type.Optional(Type.String({ description: "The question or update text" })),
	interview: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true })),
});

async function sendSupervisorRequest(params: ContactSupervisorParams, signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
	const metadata = readChildMetadata();
	if (!metadata) throw new Error("Supervisor channel is not available for this subagent.");
	if (params.reason !== "progress_update" && !params.message?.trim() && params.reason !== "interview_request") {
		throw new Error("message is required for supervisor decisions.");
	}
	const requestId = randomUUID();
	const createdAt = Date.now();
	const expectsReply = params.reason !== "progress_update";
	const replyDeadline = createdAt + askTimeoutMs();
	const request: SupervisorRequest = {
		type: "pico.supervisor.request",
		id: requestId,
		createdAt,
		...(expectsReply ? { expiresAt: replyDeadline } : {}),
		reason: params.reason,
		message: formatChildMessage(metadata, params.reason, params.message, params.interview),
		expectsReply,
		runId: metadata.runId,
		agent: metadata.agent,
		childIndex: metadata.childIndex,
		orchestratorSessionId: metadata.orchestratorSessionId,
	};
	const serialized = JSON.stringify(request);
	if (Buffer.byteLength(serialized, "utf-8") > MAX_MESSAGE_BYTES) throw new Error("Supervisor request is too large.");
	writeAtomicJson(requestPath(metadata.channelDir, requestId), request);

	if (!expectsReply) {
		return { content: [{ type: "text", text: "Supervisor progress update queued." }], details: { delivered: true, requestId } };
	}

	try {
		const reply = await waitForReply(metadata.channelDir, requestId, replyDeadline, signal);
		const details: Record<string, unknown> = { requestId, reason: params.reason };
		if (params.reason === "interview_request") {
			const structured = parseStructuredReply(reply);
			if (structured.error) details.structuredReplyParseError = structured.error;
			else details.structuredReply = structured.value;
		}
		return { content: [{ type: "text", text: `**Reply from supervisor:**\n${reply}` }], details };
	} catch (error) {
		removeRequestFile(requestPath(metadata.channelDir, requestId));
		throw error;
	}
}

/**
 * 子代理身份时注册 contact_supervisor（普通会话不注册）。返回是否注册。
 */
export function registerChildSupervisorTool(pi: ExtensionAPI): boolean {
	if (!readChildMetadata()) return false;
	pi.registerTool({
		name: CONTACT_SUPERVISOR_TOOL,
		label: "Contact Supervisor",
		description: [
			"Contact the parent/supervisor session for a blocking decision, structured interview, or progress update.",
			"Available only inside subagents.",
			"- Need a decision, approval, or scope clarification: contact_supervisor({ reason: \"need_decision\", message: \"<question>\" }) — blocks until the parent replies.",
			"- Need structured supervisor input: contact_supervisor({ reason: \"interview_request\", message: \"<what is needed>\", interview: { title: \"...\", questions: [] } }) — reply JSON arrives as details.structuredReply.",
			"- Meaningful progress or plan changes: contact_supervisor({ reason: \"progress_update\", message: \"UPDATE: <summary>\" }) — fire-and-forget.",
			"Do not use for routine completion handoffs; if no coordination is needed, return a focused task result.",
		].join(" "),
		parameters: ContactSupervisorParamsSchema,
		async execute(_id, params, signal) {
			return await sendSupervisorRequest(params as ContactSupervisorParams, signal);
		},
	});
	return true;
}

// ── 父侧：subagent_supervisor + 轮询器 ──────────────────────────────────────

interface SupervisorToolParams {
	action: "reply" | "pending" | "status";
	replyTo?: string;
	message?: string;
}

const SupervisorToolParamsSchema = Type.Object({
	action: StringEnum(["reply", "pending", "status"] as const, {
		description: "reply: answer a pending child request; pending: list requests awaiting a reply; status: channel health.",
	}),
	replyTo: Type.Optional(Type.String({ description: "Request id to reply to (from pending)" })),
	message: Type.Optional(Type.String({ description: "Reply text (required for reply)" })),
});

interface SteerParams {
	jobs: string[];
	message: string;
}

const SteerParamsSchema = Type.Object({
	jobs: Type.Array(Type.String(), { description: "Async job ids (subagent-job-N) to steer" }),
	message: Type.String({ description: "Instruction to the running subagents" }),
});

/** 从工具执行 ctx 解析当前会话 id（jobs 按会话隔离）。 */
function sessionIdFromContext(ctx: unknown): string {
	const manager = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager;
	const id = manager?.getSessionId?.();
	return typeof id === "string" && id.length > 0 ? id : "default";
}

function listRequestFiles(): Array<{ channelDir: string; file: string }> {
	let channelEntries: fs.Dirent[];
	try {
		channelEntries = fs.readdirSync(channelRoot(), { withFileTypes: true });
	} catch {
		return [];
	}
	const files: Array<{ channelDir: string; file: string }> = [];
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		const channelDir = path.join(channelRoot(), entry.name);
		let requestEntries: fs.Dirent[];
		try {
			requestEntries = fs.readdirSync(path.join(channelDir, REQUESTS_DIR), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const requestEntry of requestEntries) {
			if (requestEntry.isFile() && requestEntry.name.endsWith(".json")) files.push({ channelDir, file: path.join(channelDir, REQUESTS_DIR, requestEntry.name) });
		}
	}
	return files;
}

function parseRequestFile(file: string, channelDir: string): PendingRequest | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SupervisorRequest>;
		if (parsed.type !== "pico.supervisor.request") return undefined;
		if (typeof parsed.id !== "string" || !parsed.id) return undefined;
		if (parsed.reason !== "need_decision" && parsed.reason !== "interview_request" && parsed.reason !== "progress_update") return undefined;
		if (typeof parsed.message !== "string" || !parsed.message) return undefined;
		if (typeof parsed.runId !== "string" || typeof parsed.agent !== "string" || typeof parsed.childIndex !== "number") return undefined;
		if (typeof parsed.orchestratorSessionId !== "string") return undefined;
		return { ...(parsed as SupervisorRequest), channelDir, requestFile: file };
	} catch {
		return undefined;
	}
}

function writeReply(channelDir: string, requestId: string, message: string): void {
	if (!message.trim()) throw new Error("message is required for supervisor replies.");
	const reply: SupervisorReply = {
		type: "pico.supervisor.reply",
		requestId,
		createdAt: Date.now(),
		message: message.trim(),
	};
	writeAtomicJson(replyPath(channelDir, requestId), reply);
}

/** 父侧：向运行中的子代理投递一条 steer 指令。返回指令 id。 */
export function writeSteer(channelDir: string, message: string): string {
	if (!message.trim()) throw new Error("message is required for steering.");
	const id = randomUUID();
	const payload = JSON.stringify({ type: "pico.supervisor.steer", id, createdAt: Date.now(), message: message.trim() });
	if (Buffer.byteLength(payload, "utf-8") > MAX_MESSAGE_BYTES) throw new Error("Steer message is too large.");
	const steerDir = path.join(channelDir, STEER_DIR);
	fs.mkdirSync(steerDir, { recursive: true, mode: 0o700 });
	writeAtomicJson(path.join(steerDir, `${safeSegment(id)}.json`), JSON.parse(payload) as unknown);
	return id;
}

/**
 * 子侧：事件驱动的 steer 消费。子代理进程内注册后，在每次工具结果/回合
 * 开始时检查 channel 的 steer/ 目录，新指令经 sendMessage 注入子会话
 * （子代理下一回合看到并执行），文件随即删除防重复投递。
 */
export function registerChildSteerWatcher(pi: ExtensionAPI): boolean {
	const metadata = readChildMetadata();
	if (!metadata) return false;
	const steerDir = path.join(metadata.channelDir, STEER_DIR);
	const consumed = new Set<string>();

	const deliver = (): void => {
		let files: string[];
		try {
			files = fs.readdirSync(steerDir).filter((name) => name.endsWith(".json"));
		} catch {
			return; // 目录尚不存在 = 无指令
		}
		for (const file of files) {
			if (consumed.has(file)) continue;
			consumed.add(file);
			let message: string | undefined;
			try {
				const parsed = JSON.parse(fs.readFileSync(path.join(steerDir, file), "utf-8")) as { type?: unknown; message?: unknown };
				if (parsed.type === "pico.supervisor.steer" && typeof parsed.message === "string" && parsed.message) {
					message = parsed.message;
				}
			} catch {
				// 写了一半的文件（原子写前的 .tmp）——跳过，下次再读。
			}
			if (!message) continue;
			try {
				fs.rmSync(path.join(steerDir, file), { force: true });
			} catch {
				// best-effort
			}
			pi.sendMessage(
				{
					customType: "subagent_steer",
					content: `**Steer from supervisor:**\n${message}`,
					display: true,
					details: { from: "supervisor" },
				},
				{ deliverAs: "nextTurn" },
			);
		}
	};

	pi.on("tool_result", deliver);
	pi.on("agent_start", deliver);
	return true;
}

function resolvePendingRequest(pending: Map<string, PendingRequest>, params: SupervisorToolParams): PendingRequest {
	if (params.replyTo) {
		const request = pending.get(params.replyTo);
		if (!request) throw new Error(`No pending supervisor request found for replyTo '${params.replyTo}'.`);
		return request;
	}
	const requests = [...pending.values()];
	if (requests.length === 1) return requests[0]!;
	if (requests.length === 0) throw new Error("No pending supervisor requests need a reply.");
	throw new Error("Multiple pending supervisor requests need replies. Use replyTo.");
}

function poll(pi: ExtensionAPI, sessionId: string, pending: Map<string, PendingRequest>, seen: Set<string>): void {
	const now = Date.now();

	// 已入列的请求：过期或已被回复 → 清掉请求文件。
	for (const request of [...pending.values()]) {
		const replied = fs.existsSync(replyPath(request.channelDir, request.id));
		const expired = request.expiresAt !== undefined && now > request.expiresAt;
		if (replied || expired) {
			removeRequestFile(request.requestFile);
			pending.delete(request.id);
		}
	}

	for (const { channelDir, file } of listRequestFiles()) {
		if (seen.has(file)) continue;
		seen.add(file);
		const request = parseRequestFile(file, channelDir);
		if (!request || request.orchestratorSessionId !== sessionId) continue;
		const replied = fs.existsSync(replyPath(channelDir, request.id));
		const expired = request.expiresAt !== undefined && now > request.expiresAt;
		if (replied || expired) {
			removeRequestFile(file);
			continue;
		}
		if (request.expectsReply) pending.set(request.id, request);
		else removeRequestFile(file); // progress_update 一次性展示
		pi.sendMessage(
			{
				customType: "subagent_supervisor_request",
				content: request.message,
				display: true,
				details: {
					id: request.id,
					reason: request.reason,
					expectsReply: request.expectsReply,
					runId: request.runId,
					agent: request.agent,
					childIndex: request.childIndex,
				},
			},
			{ triggerTurn: true },
		);
	}
}

export interface SupervisorChannel {
	start: (sessionId: string) => void;
	dispose: () => void;
	pendingCount: () => number;
}

/**
 * 父侧通道：注册 subagent_supervisor 工具（reply/pending/status）+ 轮询器。
 * 子代理进程也运行本扩展，因此嵌套子代理同样由上一级进程的通道处理。
 */
export function createSupervisorChannel(pi: ExtensionAPI): SupervisorChannel {
	const pending = new Map<string, PendingRequest>();
	const seen = new Set<string>();
	let poller: ReturnType<typeof setInterval> | undefined;
	let currentSessionId = "";

	const supervisorTool: ToolDefinition<typeof SupervisorToolParamsSchema, Record<string, unknown>> = {
		name: SUPERVISOR_TOOL,
		label: "Subagent Supervisor",
		description: [
			"Answer pending requests from child subagents (contact_supervisor asks).",
			"- subagent_supervisor({ action: \"pending\" }) — list requests awaiting a reply.",
			"- subagent_supervisor({ action: \"reply\", replyTo: \"<id>\", message: \"...\" }) — answer one; the child unblocks and continues.",
			"- subagent_supervisor({ action: \"status\" }) — channel health.",
		].join(" "),
		parameters: SupervisorToolParamsSchema,
		async execute(_id, params) {
			poll(pi, currentSessionId, pending, seen);
			const input = params as SupervisorToolParams;
			if (input.action === "status") {
				return { content: [{ type: "text", text: `Supervisor channel active. Pending replies: ${pending.size}.` }], details: { active: true, pending: pending.size } };
			}
			if (input.action === "pending") {
				const lines = [...pending.values()].map((request) => {
					const replyHint = ` Reply: subagent_supervisor({ action: "reply", replyTo: "${request.id}", message: "..." })`;
					return `- ${request.id}: ${request.agent} [${request.runId}#${request.childIndex}] ${request.reason}.${replyHint}`;
				});
				return { content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No pending supervisor requests." }], details: { pending: [...pending.values()].map((r) => ({ id: r.id, runId: r.runId, agent: r.agent, childIndex: r.childIndex, reason: r.reason })) } };
			}
			if (input.action === "reply") {
				const request = resolvePendingRequest(pending, input);
				writeReply(request.channelDir, request.id, input.message ?? "");
				removeRequestFile(request.requestFile);
				pending.delete(request.id);
				return { content: [{ type: "text", text: `Replied to supervisor request ${request.id}.` }], details: { replyTo: request.id, runId: request.runId, agent: request.agent } };
			}
			throw new Error(`Unsupported subagent_supervisor action: ${input.action}`);
		},
	};
	pi.registerTool(supervisorTool);

	const steerTool: ToolDefinition<typeof SteerParamsSchema, Record<string, unknown>> = {
		name: STEER_TOOL,
		label: "Subagent Steer",
		description: [
			"Send an instruction to running async subagent jobs (launched with subagent(async: true)).",
			"The job's child picks the instruction up at its next tool boundary and acts on it — use it to correct direction mid-run instead of waiting for the job to finish and restarting.",
			"Only jobs of the current session can be steered; settled/unknown jobs are reported as skipped.",
		].join(" "),
		parameters: SteerParamsSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const input = params as SteerParams;
			const sessionKey = sessionIdFromContext(ctx);
			const results: Array<{ jobId: string; status: string }> = [];
			for (const jobId of input.jobs) {
				const job = getJob(sessionKey, jobId);
				if (!job) {
					results.push({ jobId, status: "unknown" });
					continue;
				}
				if (job.status !== "running" || !job.channelDir) {
					results.push({ jobId, status: "not-runnable" });
					continue;
				}
				writeSteer(job.channelDir, input.message);
				results.push({ jobId, status: "delivered" });
			}
			const text = results
				.map((r) => `- ${r.jobId}: ${r.status}`)
				.join("\n");
			return { content: [{ type: "text", text: `Steer delivered:\n${text}` }], details: { results } };
		},
	};
	pi.registerTool(steerTool);

	return {
		start(sessionId) {
			if (poller) return;
			currentSessionId = sessionId;
			poll(pi, currentSessionId, pending, seen);
			poller = setInterval(() => poll(pi, currentSessionId, pending, seen), PARENT_POLL_INTERVAL_MS);
			poller.unref?.();
		},
		dispose() {
			if (poller) clearInterval(poller);
			poller = undefined;
			pending.clear();
			seen.clear();
			clearChannelRoot();
		},
		pendingCount: () => pending.size,
	};
}
