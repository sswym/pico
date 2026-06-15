/**
 * srcode init extension.
 *
 * Registers a `/init` slash command. The handler injects a multi-phase
 * AGENTS.md authoring brief as the next user message, then yields back to
 * the agent loop — same strategy as claude-code's /init (it's a "prompt"
 * command, not a tool call). Phases ask the user what to set up, scout the
 * repo (via the bundled subagent extension), then write AGENTS.md and
 * optionally AGENTS.local.md / skills / hooks.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { INIT_PROMPT } from "./prompt.ts";

export const initExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerCommand("init", {
    description:
      "Initialize AGENTS.md (and optionally AGENTS.local.md, skills, hooks) for this project",
    handler: async (_args) => {
      // sendUserMessage triggers a turn automatically; the agent loop then
      // executes the multi-phase brief, calling askUserQuestion / scout etc.
      // as it goes.
      pi.sendUserMessage(INIT_PROMPT);
    },
  });
};
