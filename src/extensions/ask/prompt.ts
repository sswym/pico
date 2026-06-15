/**
 * Description and guidelines for the askUserQuestion tool.
 *
 * Distilled from claude-code's AskUserQuestionTool prompt
 * (claude-code/packages/builtin-tools/src/tools/AskUserQuestionTool/prompt.ts).
 */

export const ASK_DESCRIPTION =
  "Asks the user multiple-choice questions to gather information, clarify ambiguity, understand preferences, or offer concrete choices.";

export const ASK_TOOL_PROMPT = `Use askUserQuestion when you need user input mid-task. It can:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices
4. Offer concrete choices about what direction to take

Usage notes:
- 1-4 questions per call. Each question has 2-4 options.
- An "Other" option is appended automatically; do NOT include your own.
- multiSelect: true allows multiple answers.
- If you recommend one option, list it first and append "(Recommended)" to its label.
- Plan mode: use this BEFORE finalising a plan to clarify requirements; do NOT use it to ask "is the plan good?". Use ExitPlanMode for plan approval.

Preview field:
- Optional per-option string rendered when the option is focused. Use for code snippets, ASCII mockups, or comparisons.
- Multi-line content is supported.
- preview is single-select only — combining it with multiSelect on the same question is rejected.`;

export const ASK_PROMPT_SNIPPET =
  "askUserQuestion — pose 1-4 multiple-choice questions to the user; returns their picks and any free-text 'Other'.";

export const ASK_GUIDELINES = [
  "Use askUserQuestion when you need a decision from the user before continuing; never to confirm work already done.",
  "Each question must have 2-4 options. The labels should be distinct and self-contained — no 'Other' option, srcode adds one.",
  "If you recommend an option, put it first and append '(Recommended)' to its label.",
  "preview cannot be combined with multiSelect on the same question.",
];
