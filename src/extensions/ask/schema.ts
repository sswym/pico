/**
 * AskUserQuestion params schema.
 *
 * Matches the shape claude-code's AskUserQuestionTool exposes (1-4 questions,
 * each with 2-4 options, optional preview, optional multiSelect), expressed as
 * typebox so it composes with pi-coding-agent's tool runtime.
 *
 * The (preview + multiSelect) combination on the same question is invalid;
 * we enforce it at execute() time rather than via a typebox refinement so the
 * error path stays in TypeScript.
 */
import { Type, type Static } from "@earendil-works/pi-ai";

export const ASK_TOOL_CHIP_WIDTH = 12;

export const AskOption = Type.Object({
  label: Type.String({
    minLength: 1,
    description:
      "Short display text (1-5 words). Concise label for the user to pick. Don't include any 'Other' choice — pico adds one automatically.",
  }),
  description: Type.String({
    description:
      "One-line explanation of what choosing this option means or implies. Helps the user weigh trade-offs.",
  }),
  preview: Type.Optional(
    Type.String({
      description:
        "Optional preview content rendered when this option is focused. Use for ASCII mockups, code snippets, or short comparisons. Multi-line text is fine. Cannot be combined with multiSelect on the same question.",
    }),
  ),
});

export const AskQuestion = Type.Object({
  question: Type.String({
    minLength: 1,
    description:
      "The full question to ask the user. Should be specific and end with a question mark. If multiSelect=true, phrase it accordingly (e.g. \"Which features do you want to enable?\").",
  }),
  header: Type.String({
    minLength: 1,
    maxLength: ASK_TOOL_CHIP_WIDTH,
    description: `Very short label (max ${ASK_TOOL_CHIP_WIDTH} chars) shown as a chip/tag. Examples: "Auth method", "Library", "Approach".`,
  }),
  options: Type.Array(AskOption, {
    minItems: 2,
    maxItems: 4,
    description:
      "2-4 distinct, mutually-exclusive choices (unless multiSelect=true). Don't include 'Other' — pico appends one.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      description:
        "Set to true to allow multiple options to be selected. Cannot be combined with preview on options.",
    }),
  ),
});

export const AskUserQuestionParams = Type.Object({
  questions: Type.Array(AskQuestion, {
    minItems: 1,
    maxItems: 4,
    description: "1-4 questions to ask the user in a single round.",
  }),
});

export type AskOptionInput = Static<typeof AskOption>;
export type AskQuestionInput = Static<typeof AskQuestion>;
export type AskUserQuestionInput = Static<typeof AskUserQuestionParams>;

/** "Other" sentinel — appended client-side to every question's option list. */
export const OTHER_LABEL = "Other";

/**
 * Validate the (multiSelect + preview) constraint.
 *
 * Returns the question text that violates the rule, or null if every question
 * is valid. We surface this as a tool execution error rather than a schema
 * refinement so the LLM gets a readable, retryable failure.
 */
export function findInvalidPreviewMultiSelect(
  questions: AskQuestionInput[],
): string | null {
  for (const q of questions) {
    if (!q.multiSelect) continue;
    const offending = q.options.find((opt) => opt.preview !== undefined);
    if (offending) return q.question;
  }
  return null;
}
