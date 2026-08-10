/**
 * context-pruner extension — trims stale tool output before every LLM call.
 *
 * Uses the upstream `context` event (fired via `transformContext` before
 * each provider request): superseded full-file `read` results are replaced
 * with a short marker so later turns stop re-paying tokens for a file the
 * model has already re-read.
 *
 * Derived from oh-my-pi `session-maintenance.ts #pruneStaleToolResults` —
 * the same "newer read supersedes older read" rule, implemented at the
 * extension layer via the `context` event instead of inside the agent loop.
 */

import type { ContextEvent, ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { pruneSupersededReads } from "./prune.ts";

const DISABLE_ENV = "PICO_CONTEXT_PRUNER_DISABLE";

function isEnabledEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no" && normalized !== "off";
}

type Message = ContextEvent["messages"][number];

export const contextPrunerExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.on("context", (event, ctx) => {
    if (isEnabledEnv(process.env[DISABLE_ENV])) return {};
    if (!Array.isArray(event.messages) || event.messages.length === 0) return {};
    const messages = pruneSupersededReads(event.messages as Message[], ctx.cwd);
    return { messages };
  });
};
