/**
 * evolution 扩展的会话状态与配置读取。
 *
 * 状态是模块级单例（session-scoped，与 todo/plan 同模式）：
 *  - 消息指纹集合跨会话保留（同 memory 的 seenMessageTexts）——resume/fork
 *    会话的 agent_end 消息包含旧历史，只有模块级集合能识别"真正新鲜"的
 *    消息，否则 resume 会把旧历史当 fresh 重新审查。
 *  - session_start（非 reload）重置缓冲/回合计数/审查计数。
 */
import { readSettingsObject } from "../settings.ts";
import { envFlag } from "../policy.ts";

export interface ExtractableMessage {
  role: string;
  content: unknown;
}

export interface EvolutionConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
  reviewEveryTurns: number;
  maxReviewsPerSession: number;
  maxSkillBytes: number;
  denyPatterns: string[];
}

export interface EvolutionState {
  /** 本会话累积的、尚未被审查消费的消息。 */
  buffer: ExtractableMessage[];
  /** 本会话 agent_end 触发次数（= 已结束的回合数），审查阈值按回合计。 */
  turnCount: number;
  /** 上次触发审查时的回合计数（增量基准）。 */
  lastReviewedTurn: number;
  /** 本会话已触发的审查次数（触发即 +1，失败也推进——同 hermes）。 */
  reviewsDone: number;
  /** in-flight 审查 promise（session_shutdown 时限时等待）。 */
  inFlight: Promise<void> | null;
}

export const DEFAULT_REVIEW_EVERY_TURNS = 6;
export const DEFAULT_MAX_REVIEWS_PER_SESSION = 2;
export const DEFAULT_MAX_SKILL_BYTES = 64 * 1024;
export const MAX_BUFFER_MESSAGES = 200;
const MAX_SEEN_FINGERPRINTS = 20_000;

const state: EvolutionState = {
  buffer: [],
  turnCount: 0,
  lastReviewedTurn: 0,
  reviewsDone: 0,
  inFlight: null,
};

const seenFingerprints = new Set<string>();

/** session_shutdown 等待 in-flight 的上限（测试可注入更短值）。 */
let shutdownWaitMs = 20_000;

export function getState(): EvolutionState {
  return state;
}

/** Extract plain text from a message content field (string or content block array). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => (c as { text?: string }).text ?? "")
      .join(" ");
  }
  return "";
}

export function fingerprintMessage(m: ExtractableMessage): string {
  return `${m.role}\u0000${extractText(m.content)}`;
}

/**
 * 把新鲜消息加入缓冲。返回新增条数；重复指纹（本进程已见过）跳过。
 * 缓冲超上限时丢弃最旧。
 */
export function addFreshMessages(messages: ExtractableMessage[]): number {
  let added = 0;
  for (const m of messages) {
    const fp = fingerprintMessage(m);
    if (seenFingerprints.has(fp)) continue;
    seenFingerprints.add(fp);
    if (seenFingerprints.size > MAX_SEEN_FINGERPRINTS) {
      // 粗放淘汰最旧一半，防长驻进程无限增长。
      const overflow = [...seenFingerprints].slice(0, seenFingerprints.size - MAX_SEEN_FINGERPRINTS);
      for (const f of overflow) seenFingerprints.delete(f);
    }
    if (state.buffer.length >= MAX_BUFFER_MESSAGES) state.buffer.shift();
    state.buffer.push(m);
    added++;
  }
  return added;
}

export function resetSessionState(): void {
  state.buffer = [];
  state.turnCount = 0;
  state.lastReviewedTurn = 0;
  state.reviewsDone = 0;
  state.inFlight = null;
}

export function setShutdownWaitMsForTests(ms: number): void {
  shutdownWaitMs = ms;
}

export function getShutdownWaitMs(): number {
  return shutdownWaitMs;
}

export function __resetEvolutionStateForTests(): void {
  resetSessionState();
  seenFingerprints.clear();
}

/** env 优先（policy.ts envFlag 约定），settings 兜底；布尔校验同 policy。 */
export function readEvolutionConfig(): EvolutionConfig {
  const raw = readSettingsObject("evolution");
  const stringValue = (key: string): string | undefined => {
    const v = raw[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const numberValue = (key: string, dflt: number): number => {
    const v = raw[key];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const deny = process.env.PICO_EVOLUTION_DENY;
  const envTurns = Number(process.env.PICO_EVOLUTION_REVIEW_EVERY_TURNS);
  return {
    enabled: envFlag("PICO_EVOLUTION_ENABLED") ?? (typeof raw.enabled === "boolean" ? raw.enabled : false),
    provider: process.env.PICO_EVOLUTION_PROVIDER ?? stringValue("provider"),
    model: process.env.PICO_EVOLUTION_MODEL ?? stringValue("model"),
    reviewEveryTurns:
      (Number.isFinite(envTurns) && envTurns > 0 ? envTurns : undefined) ?? numberValue("reviewEveryTurns", DEFAULT_REVIEW_EVERY_TURNS),
    maxReviewsPerSession: numberValue("maxReviewsPerSession", DEFAULT_MAX_REVIEWS_PER_SESSION),
    maxSkillBytes: numberValue("maxSkillBytes", DEFAULT_MAX_SKILL_BYTES),
    denyPatterns: deny
      ? deny.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)
      : [],
  };
}
