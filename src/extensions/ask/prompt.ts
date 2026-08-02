/**
 * Description and guidelines for the askUserQuestion tool.
 *
 * Distilled from claude-code's AskUserQuestionTool prompt
 * (claude-code/packages/builtin-tools/src/tools/AskUserQuestionTool/prompt.ts).
 */
import ASK_TOOL_PROMPT from "../../prompts/ask-tool.md" with { type: "text" };

export { ASK_TOOL_PROMPT };

export const ASK_DESCRIPTION =
  "Asks the user multiple-choice questions to gather information, clarify ambiguity, understand preferences, or offer concrete choices.";

export const ASK_PROMPT_SNIPPET =
  "askUserQuestion — pose 1-4 multiple-choice questions to the user; returns their picks and any free-text 'Other'.";

export const ASK_GUIDELINES = [
  "Use askUserQuestion when you need a decision from the user before continuing; never to confirm work already done.",
  "Each question must have 2-4 options. The labels should be distinct and self-contained — no 'Other' option, pico adds one.",
  "If you recommend an option, put it first and append '(Recommended)' to its label.",
  "preview cannot be combined with multiSelect on the same question.",
];