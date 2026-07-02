/**
 * srcode init extension.
 *
 * Registers a `/init` slash command. The handler injects a concise
 * AGENTS.md authoring brief as the next user message, then yields back to
 * the agent loop. The brief (in prompt.md) directs the LLM to parallel-scan
 * the codebase, ask the user what to set up, and synthesise AGENTS.md,
 * AGENTS.local.md, skills, and/or hooks as needed.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getEmbeddedContent } from "../embedded-assets.ts";
import PROMPT_MD from "./prompt.md" with { type: "text" };

/**
 * Resolve the init prompt content.
 *
 * In compiled-binary mode the prompt is embedded in the binary; in source
 * mode Bun imports it directly. The embedded-assets fallback handles both.
 */
function loadPrompt(): string {
  return getEmbeddedContent("init/prompt.md") ?? PROMPT_MD;
}

export const initExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerCommand("init", {
    description:
      "Initialize AGENTS.md (and optionally AGENTS.local.md, skills, hooks) for this project",
    handler: async (_args) => {
      pi.sendUserMessage(loadPrompt());
    },
  });
};
