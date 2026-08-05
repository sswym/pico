/**
 * Description and guidelines for the askUserQuestion tool.
 *
 * The long-form usage guidance lives in src/prompts/ask-tool.md and is
 * injected via `promptGuidelines: [ASK_TOOL_PROMPT]` — the md is the single
 * source of truth. Only the one-line inventory metadata stays here.
 */
import ASK_TOOL_PROMPT from "../../prompts/ask-tool.md" with { type: "text" };

export { ASK_TOOL_PROMPT };

export const ASK_DESCRIPTION =
  "Asks the user multiple-choice questions to gather information, clarify ambiguity, understand preferences, or offer concrete choices.";

export const ASK_PROMPT_SNIPPET =
  "askUserQuestion — pose 1-4 multiple-choice questions to the user; returns their picks and any free-text 'Other'.";