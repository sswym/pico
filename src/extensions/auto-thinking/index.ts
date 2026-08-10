/**
 * auto-thinking extension — forces deeper reasoning on demand.
 *
 * Three capabilities (all extension-layer, no extra model calls):
 *
 * 1. **ultrathink keyword** (oh-my-pi `modes/ultrathink.ts` + `thinking.ts`):
 *    when the user prompt contains the standalone prose word `ultrathink`,
 *    raise the session thinking level to `max` (upstream clamps to model
 *    capabilities) and inject a hidden `<system-notice>` multi-step
 *    reasoning reminder into the system prompt for that turn. The previous
 *    thinking level is restored when the turn ends.
 *
 * 2. The `/thinking` command (off|minimal|low|medium|high|xhigh|max):
 *    explicit session-level thinking control (oh-my-pi `thinking.ts`
 *    level→effort mapping); no argument prints the current level.
 *
 * 3. **auto-difficulty classification** is intentionally NOT included in
 *    v1: the extension API has no direct model-call surface, so a
 *    per-turn classifier would need a subprocess round-trip per turn.
 *    That cost/benefit is wrong for v1 — see docs/analysis report §3 H1.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { buildUltrathinkNotice, containsUltrathink } from "./ultrathink.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const NOTICE_ONLY_ENV = "PICO_ULTRATHINK_NOTICE_ONLY";
const DISABLE_ENV = "PICO_AUTO_THINKING_DISABLE";

function isEnabledEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no" && normalized !== "off";
}

function disabled(): boolean {
  return isEnabledEnv(process.env[DISABLE_ENV]);
}

function noticeOnly(): boolean {
  return isEnabledEnv(process.env[NOTICE_ONLY_ENV]);
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export const autoThinkingExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  // Session-scoped: the level we raised for an ultrathink turn, restored on agent_end.
  let raisedFrom: ThinkingLevel | undefined;

  pi.on("before_agent_start", (event) => {
    if (disabled()) return {};
    const hasKeyword = containsUltrathink(event.prompt ?? "");
    if (!hasKeyword) return {};

    const extras: string[] = [];
    const current = pi.getThinkingLevel();

    if (!noticeOnly()) {
      if (current !== "max") {
        raisedFrom = current;
        pi.setThinkingLevel("max");
      } else {
        raisedFrom = undefined;
      }
    }
    extras.push(buildUltrathinkNotice());

    return { systemPrompt: `${event.systemPrompt}\n\n${extras.join("\n\n")}` };
  });

  pi.on("agent_end", () => {
    if (raisedFrom !== undefined) {
      pi.setThinkingLevel(raisedFrom);
      raisedFrom = undefined;
    }
  });

  pi.registerCommand("thinking", {
    description: "Show or set the thinking level: off|minimal|low|medium|high|xhigh|max",
    handler: async (args, ctx) => {
      const level = args.trim().toLowerCase();
      if (!level) {
        const current = pi.getThinkingLevel();
        ctx.ui.notify(`Thinking level: ${current ?? "unknown"}`, "info");
        return;
      }
      if (!isThinkingLevel(level)) {
        ctx.ui.notify(`Unknown thinking level "${level}". Valid: ${THINKING_LEVELS.join(" | ")}`, "error");
        return;
      }
      pi.setThinkingLevel(level);
      raisedFrom = undefined; // user-set levels are not auto-restored
      ctx.ui.notify(`Thinking level set to ${level}`, "info");
    },
  });
};
