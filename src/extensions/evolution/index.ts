/**
 * evolution 扩展工厂：事件接线、触发判定、频率限制、in-flight 管理。
 *
 * 触发：agent_end 回合末检查——启用、新鲜回合 ≥ reviewEveryTurns、本会话
 * 审查 < maxReviewsPerSession、无 in-flight 时异步触发（fire-and-forget，
 * 主响应不阻塞）。审查失败也推进阈值水位（同 hermes 的 _iters_since_skill
 * 清零语义），模型持续不可用时不会每回合重试。
 *
 * 退出：session_shutdown 交互模式限时等待 in-flight（默认 20s，测试可注入
 * 更短值）；非交互（-p/--print）与 reload 不等待——fire-and-forget 让
 * promise 自然结束，避免拖慢无人值守脚本与重载流程。
 */
import type { AgentEndEvent, ExtensionAPI, ExtensionContext, ExtensionFactory, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { sep } from "node:path";
import { readManifest, userSkillsDir, applyReview, validateReviewOutput } from "./apply.ts";
import { runEvolutionReview, type ReviewOutput, type ReviewDeps } from "./review.ts";
import {
  addFreshMessages,
  getShutdownWaitMs,
  getState,
  resetSessionState,
  type EvolutionConfig,
  type ExtractableMessage,
  readEvolutionConfig,
} from "./state.ts";
// Deliberate cross-extension reuse（同 skill/index.ts 复用 subagent 的先例）：
// 现有技能清单需要完整扫描能力，重复实现 discoverSkills 的递归扫描不划算，
// skill/catalog.ts 是纯发现工具，无扩展状态。
import { discoverSkills } from "../skill/catalog.ts";
import { log } from "../logging.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 非交互判定：与 runtime/args.ts 的 isNonTuiArg 语义一致（-p/--print/--mode）。 */
function isNonInteractive(): boolean {
  return process.argv.some((arg) => arg === "-p" || arg === "--print" || arg.startsWith("--print=") || arg === "--mode" || arg.startsWith("--mode="));
}

/** 现有 pico 自产技能清单（清单内 + 用户级目录），供审查模型决定 create/update。 */
function listEvolvedSkills(ctx: ExtensionContext): Array<{ name: string; description: string }> {
  const manifest = readManifest();
  const root = userSkillsDir() + sep;
  return discoverSkills(ctx.cwd)
    .filter((s) => manifest.skills[s.name] !== undefined && s.filePath.startsWith(root))
    .map((s) => ({ name: s.name, description: s.description }));
}

async function consumeReview(
  ctx: ExtensionContext,
  messages: ExtractableMessage[],
  existing: Array<{ name: string; description: string }>,
  config: EvolutionConfig,
  reviewDeps?: ReviewDeps,
): Promise<void> {
  const output: ReviewOutput | null = await runEvolutionReview(ctx, messages, existing, reviewDeps);
  if (!output) return; // 模型不可用/截断/解析失败：静默降级
  const validated = validateReviewOutput(output, config);
  const result = applyReview(validated);
  const changed = [...result.created, ...result.updated];
  if (changed.length > 0) {
    console.log(`[pico evolution] skills: ${changed.join(", ")}${result.skipped.length > 0 ? ` (skipped: ${result.skipped.map((s) => `${s.name}:${s.reason}`).join(", ")})` : ""}`);
  }
}

function maybeTriggerReview(ctx: ExtensionContext, config: EvolutionConfig, reviewDeps?: ReviewDeps): void {
  const state = getState();
  if (state.inFlight) return;
  if (state.turnCount - state.lastReviewedTurn < config.reviewEveryTurns) return;
  if (state.reviewsDone >= config.maxReviewsPerSession) return;

  state.lastReviewedTurn = state.turnCount; // 立即推进，防同一批消息重复触发
  state.reviewsDone += 1;
  const messages = state.buffer.splice(0); // 消费整个缓冲（失败不重试，清空语义一致）
  const existing = listEvolvedSkills(ctx);
  state.inFlight = consumeReview(ctx, messages, existing, config, reviewDeps)
    .catch((err) => {
      log.warn("evolution", "review failed:", err);
    })
    .finally(() => {
      state.inFlight = null;
    });
}

export interface EvolutionExtensionDeps {
  /** 审查模型调用（测试注入 fake；缺省用真实 completeSimple）。 */
  reviewDeps?: ReviewDeps;
}

/**
 * DI 工厂（同 hooks/mcp/vision 模式）：测试传 fake reviewDeps 驱动完整链路，
 * 生产用默认。
 */
export function createEvolutionExtension(deps: EvolutionExtensionDeps = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("session_start", (event) => {
      try {
        // reload 时 factories 重跑但状态应保留（in-flight 自然结束）；其他原因重置。
        if (event.reason !== "reload") resetSessionState();
      } catch {
        // best-effort — 必须不破坏会话启动
      }
    });

    pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
      try {
        const config = readEvolutionConfig();
        if (!config.enabled) return;
        addFreshMessages((event.messages ?? []) as ExtractableMessage[]);
        getState().turnCount += 1;
        maybeTriggerReview(ctx, config, deps.reviewDeps);
      } catch {
        // best-effort — 审查失败不得影响回合
      }
    });

    pi.on("session_shutdown", async (event: SessionShutdownEvent, _ctx: ExtensionContext) => {
      try {
        const inFlight = getState().inFlight;
        if (!inFlight) return;
        // reload：不等待，promise 自然结束（进程不退出）；非交互：不等待，避免拖慢脚本。
        if (event.reason === "reload" || isNonInteractive()) return;
        await Promise.race([inFlight, sleep(getShutdownWaitMs())]);
      } catch {
        // best-effort
      }
    });
  };
}

export const evolutionExtension: ExtensionFactory = createEvolutionExtension();
