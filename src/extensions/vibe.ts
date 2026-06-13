/**
 * vibe extension — injects srcode's "vibe coding" behavioural guidelines into
 * the system prompt for every turn.
 *
 * We don't replace the upstream system prompt — we append. Concretely we
 * listen on `before_agent_start` and return a `systemPrompt` that is
 * `${event.systemPrompt}\n\n${VIBE_GUIDE}`. Multiple extensions returning
 * `systemPrompt` are chained by pi-coding-agent (each receives the prior
 * extension's result via the next event), so the order in `extensionFactories`
 * is just for execution order — final content is the union.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import vibeGuide from "../prompts/vibe-system.md" with { type: "text" };

export const vibeExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", (event) => {
    const base = event.systemPrompt ?? "";
    return { systemPrompt: `${base}\n\n${vibeGuide}` };
  });
};
