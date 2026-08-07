/**
 * pico observability extension — 结构化 JSONL 事件日志（第 20 个扩展）。
 *
 * 设计意图：为"本次调用链经历了什么 / 每个环节耗时多少"提供最小可观测层。
 * 学习 claude-code 的 trace-id 贯穿思想——每个事件携带 sessionId/turnId 血缘，
 * 可重组成完整的调用链——但刻意保持极简：无 OTel/Langfuse/Sentry 依赖，
 * 只把元数据事件追加落盘为 $PICO_HOME/agent/events.jsonl（一行一个 JSON 事件，
 * 与 input-history.jsonl 同目录），供日后离线分析。
 *
 * 隐私红线（绝不越界）：
 *  - 绝不记录用户内容、工具输入参数、工具输出、prompt/system 内容。
 *  - payload 只允许元数据：工具名、provider/model id、错误布尔标记、子会话 id 等。
 *  - 事件数据里拿不到所需字段时安全降级：省略该字段，绝不猜测内容。
 *
 * 容错：所有 fs 操作失败一律静默吞掉（catch 带注释）——日志绝不能拖垮会话。
 * 文件模式 0o600：事件可能间接暴露敏感元数据（如子会话 id），与 input-history
 * 对 API key 类数据的防护一致。
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { subscribeSessionExtensionEvent, type SubagentCompletedEvent } from "./events.ts";
import { picoAgentHome } from "./paths.ts";

export interface PicoLogEvent {
  ts: number; // Date.now()
  sessionId?: string;
  turnId?: string; // 当前 turn 标识（无活动 turn 则省略）
  event: string; // 事件名
  durationMs?: number; // 可选耗时
  payload?: Record<string, unknown>; // 仅元数据，绝不包含用户内容
}

/** 日志文件大小上限：5MB。超限时截断保留最后 1000 行（读回→重写，见 appendEvent）。 */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_KEPT_LINES = 1000;

/**
 * 非交互（-p / CI / --mode json|rpc）模式下把工具调用进度写到 stderr：
 * stdout 被重定向/管道消费，TUI 不存在，用户只能看到完成时一次性输出的
 * 最终答案——工具序列与耗时对卡死/慢任务零可见性。TTY 模式由 TUI 接管，
 * 不输出。只写元数据（工具名/耗时/错误标记），不写工具参数与输出。
 */
function maybeEmitProgress(line: string): void {
  if (process.stdout.isTTY) return;
  // Subagent children run non-interactively and their stderr is captured into
  // the subagent result — streaming progress there only adds noise to
  // failed-result messages.
  if (process.env.PICO_SUBAGENT_DEPTH) return;
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // 进度输出失败（stderr 被关闭等）绝不影响主流程。
  }
}

// 可变上限：__setObservabilityLimitsForTests 可临时调小以验证截断逻辑，
// __resetObservabilityForTests 恢复默认值。
let maxLogBytes = MAX_LOG_BYTES;
let maxKeptLines = MAX_KEPT_LINES;

/** 会话/回合血缘状态（module-level，与 todo/memory 等扩展同风格，session 为 key）。 */
let currentSessionId: string | undefined;
let currentTurnId: string | undefined;
let sessionStartTime = 0;
let turnStartTime = 0;
let turnCounter = 0;
/** toolCallId → 开始时间，用于 tool_result 的耗时计算（用后即删，不积累）。 */
const toolStartTimes = new Map<string, number>();

/** 日志文件路径：$PICO_HOME/agent/events.jsonl（与 input-history.jsonl 同目录）。 */
export function getObservabilityFilePath(): string {
  return join(picoAgentHome(), "events.jsonl");
}

/** 捕获当前 sessionId（参照 todo/index.ts 的 sessionKey 模式）。拿不到就省略。 */
function captureSessionId(ctx: { sessionManager?: { getSessionId?: () => string | undefined } }): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? undefined;
  } catch {
    // Host 无可用 session manager：降级为无 sessionId，事件省略该字段。
    return undefined;
  }
}

/**
 * 追加一条事件到日志（同步写）。任何 fs 失败静默吞掉——日志绝不能拖垮会话。
 */
export function logEvent(event: string, payload?: Record<string, unknown>, opts?: { durationMs?: number }): void {
  const entry: PicoLogEvent = { ts: Date.now(), event };
  if (currentSessionId !== undefined) entry.sessionId = currentSessionId;
  if (currentTurnId !== undefined) entry.turnId = currentTurnId;
  if (opts?.durationMs !== undefined) entry.durationMs = opts.durationMs;
  // 空 payload（如 provider/model 均不可得）直接省略字段，不写空对象。
  if (payload && Object.keys(payload).length > 0) entry.payload = payload;
  appendEvent(entry);
}

/** 追加+超限截断。模式仿照 input-history：JSONL 追加 + 0o600 模式修复 + 锁保护的读改写 trim。 */
function appendEvent(entry: PicoLogEvent): void {
  const path = getObservabilityFilePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      // { mode: 0o600 } 只在首次创建时生效；修复遗留宽权限（并发写入或旧版本留下的 0644）。
      const mode = statSync(path).mode & 0o777;
      if ((mode & 0o077) !== 0) chmodSync(path, 0o600);
    } catch {
      // 文件尚不存在——下方 appendFileSync 会以 0o600 创建。
    }
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", mode: 0o600 });
    try {
      // 超过 5MB 上限时截断：读回 → 保留最后 1000 行 → 临时文件重写。
      // 相比滚动到 events.jsonl.old，这是最简方案：不产生第二个文件，读回解析
      // 天然容忍半行写入（损坏行被跳过）。读改写需与其他 pico 实例的截断串行化
      // （并发 rename 会互相覆盖），复用 input-history 的 mkdir 原子锁；锁被占时
      // 跳过本次截断，追加已成功，下次追加再试。
      if (statSync(path).size > maxLogBytes) {
        const release = tryAcquireTrimLock(path);
        if (!release) return;
        try {
          const raw = readFileSync(path, "utf-8");
          const lines = raw.split("\n").filter((line) => line.trim().length > 0);
          if (lines.length > maxKeptLines) {
            const kept = lines.slice(-maxKeptLines);
            const tmpPath = `${path}.${process.pid}.tmp`;
            writeFileSync(tmpPath, `${kept.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
            renameSync(tmpPath, path);
          }
        } finally {
          release();
        }
      }
    } catch {
      // 读回截断是 best-effort：追加本身已成功，失败只影响后续超限清理。
    }
  } catch {
    // 只读目录、磁盘满等一律静默——日志失败绝不影响主流程。
  }
}

const TRIM_LOCK_STALE_MS = 30_000;

/**
 * 跨 pico 实例串行化截断的读-改-写（mkdir 是原子的）。返回释放函数；锁被其他
 * 实例持有时返回 null——追加已经成功，本次截断跳过，下一次追加会再试。
 * 模式借自 input-history/index.ts 的 tryAcquireTrimLock。
 */
function tryAcquireTrimLock(path: string): (() => void) | null {
  const lockDir = `${path}.trim-lock`;
  const acquire = (): (() => void) | null => {
    try {
      mkdirSync(lockDir);
      return () => {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
      };
    } catch {
      return null;
    }
  };
  const release = acquire();
  if (release) return release;
  // 锁被崩溃实例残留——超过 30s 视为过期，打破后重试。
  try {
    const st = statSync(lockDir);
    if (Date.now() - st.mtimeMs > TRIM_LOCK_STALE_MS) {
      rmSync(lockDir, { recursive: true, force: true });
      return acquire();
    }
  } catch {
    // 锁目录在 mkdir 失败与 stat 之间消失——视为空闲。
  }
  return null;
}

/** 读回全部事件（测试/调试用）。文件不存在或解析失败返回 []，损坏行跳过。 */
export function readObservabilityEvents(): PicoLogEvent[] {
  try {
    const raw = readFileSync(getObservabilityFilePath(), "utf-8");
    const events: PicoLogEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as PicoLogEvent);
      } catch {
        // 忽略损坏行：部分写入绝不破坏读取。
      }
    }
    return events;
  } catch {
    return [];
  }
}

/** 测试钩子：清空内存状态（sessionId/turnId/计数器）并恢复截断默认值。 */
export function __resetObservabilityForTests(): void {
  currentSessionId = undefined;
  currentTurnId = undefined;
  sessionStartTime = 0;
  turnStartTime = 0;
  turnCounter = 0;
  toolStartTimes.clear();
  maxLogBytes = MAX_LOG_BYTES;
  maxKeptLines = MAX_KEPT_LINES;
}

/** 仅测试用：临时改小截断阈值以验证超限逻辑（__resetObservabilityForTests 恢复默认）。 */
export function __setObservabilityLimitsForTests(maxBytes: number, maxLines: number): void {
  maxLogBytes = maxBytes;
  maxKeptLines = maxLines;
}

export const observabilityExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    currentSessionId = captureSessionId(ctx);
    sessionStartTime = Date.now();
    turnCounter = 0;
    logEvent("session_start");
  });

  pi.on("turn_start", (_event) => {
    turnCounter += 1;
    // turnId 贯穿本回合内所有事件（trace-id 思想）：<sessionId>:<n>。
    currentTurnId = `${currentSessionId ?? "unknown"}:${turnCounter}`;
    turnStartTime = Date.now();
    logEvent("turn_start");
  });

  pi.on("turn_end", () => {
    const durationMs = turnStartTime > 0 ? Date.now() - turnStartTime : undefined;
    logEvent("turn_end", undefined, { durationMs });
    currentTurnId = undefined;
    turnStartTime = 0;
  });

  pi.on("tool_call", (event: ToolCallEvent) => {
    toolStartTimes.set(event.toolCallId, Date.now());
    // payload 只放工具名——绝不放 input 参数/文件内容。
    logEvent("tool_call", { tool: event.toolName });
    maybeEmitProgress(`[pico] tool: ${event.toolName}`);
  });

  pi.on("tool_result", (event: ToolResultEvent) => {
    const startedAt = toolStartTimes.get(event.toolCallId);
    toolStartTimes.delete(event.toolCallId);
    const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
    const payload: Record<string, unknown> = { tool: event.toolName };
    // 只记错误布尔标记，绝不记录输出内容（ToolResultEvent.isError 即错误标记）。
    if (event.isError) payload.error = true;
    logEvent("tool_result", payload, { durationMs });
    const elapsed = durationMs !== undefined ? ` (${durationMs}ms)` : "";
    maybeEmitProgress(`[pico] tool done: ${event.toolName}${elapsed}${event.isError ? " — error" : ""}`);
  });

  pi.on("before_provider_request", (_event, ctx: ExtensionContext) => {
    // 该事件本身只有 payload（prompt 请求体，绝不落盘）；provider/model 从
    // ctx.model 取元数据。attempt 等字段事件里不存在——按降级规则省略。
    const payload: Record<string, unknown> = {};
    if (ctx.model?.provider) payload.provider = ctx.model.provider;
    if (ctx.model?.id) payload.model = ctx.model.id;
    logEvent("provider_request", payload);
  });

  pi.on("session_shutdown", () => {
    const durationMs = sessionStartTime > 0 ? Date.now() - sessionStartTime : undefined;
    logEvent("session_shutdown", undefined, { durationMs });
    currentSessionId = undefined;
    currentTurnId = undefined;
    sessionStartTime = 0;
    turnStartTime = 0;
    toolStartTimes.clear();
  });

  // session 级订阅：/reload 会清（见 events.ts 的 clearSessionExtensionSubscriptions）。
  // 实际发布的 subagent_completed 载荷只有 { task, result, childSessionId? }——
  // task/result 是内容（用户指令/代理输出），一律不记；只记元数据 childSessionId。
  subscribeSessionExtensionEvent("subagent_completed", (event: SubagentCompletedEvent) => {
    logEvent("subagent_completed", event.childSessionId ? { childSessionId: event.childSessionId } : undefined);
  });
};
