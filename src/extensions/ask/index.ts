/**
 * pico askUserQuestion extension.
 *
 * Lets the LLM pose 1-4 structured multiple-choice questions to the user
 * and receive their selections plus optional free-text "Other" notes —
 * mirrors claude-code's AskUserQuestionTool. We layer it on pi's existing
 * dialog primitives (`ctx.ui.select` / `ctx.ui.input`) so we don't need to
 * draw a custom overlay; multiSelect is implemented as a sequence of
 * single-selects with a sentinel "(done — submit)" entry, and preview
 * content is appended to the option label as a `· preview` tag (the LLM
 * gets the actual preview text back via the answers payload).
 */
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  AskUserQuestionParams,
  findInvalidPreviewMultiSelect,
  OTHER_LABEL,
  type AskOptionInput,
  type AskQuestionInput,
  type AskUserQuestionInput,
} from "./schema.ts";
import {
  ASK_DESCRIPTION,
  ASK_GUIDELINES,
  ASK_PROMPT_SNIPPET,
  ASK_TOOL_PROMPT,
} from "./prompt.ts";
import { renderToolCallText, renderToolResultText } from "../tool-render.ts";

// keep typebox import alive in case verbatimModuleSyntax elides it
void Type;

const DONE_SENTINEL = "(done — submit)";
const PREVIEW_SUFFIX = " · preview";
const RESERVED_LABELS = new Set([OTHER_LABEL, DONE_SENTINEL]);

interface QuestionAnswer {
  picks: string[];
  notes?: string;
  preview?: string;
}

interface AskAnswers {
  [question: string]: { picks: string[]; notes?: string; preview?: string };
}

function errorResult(message: string): never {
  // Throwing is the only way the agent loop learns a tool call failed — a
  // returned isError flag is dropped upstream and the failure would render
  // as a success.
  throw new Error(message);
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function questionTitle(question: AskQuestionInput): string {
  return question.header ? `[${question.header}] ${question.question}` : question.question;
}

function decorateLabel(opt: AskOptionInput): string {
  const parts = [opt.label];
  const description = opt.description.trim();
  if (description) parts.push(description);
  let label = parts.join(" · ");
  if (opt.preview) label = `${label}${PREVIEW_SUFFIX}\n${opt.preview}`;
  return label;
}

function findOptionByDecoratedLabel(
  options: AskOptionInput[],
  decorated: string,
): AskOptionInput | undefined {
  return options.find((o) => decorateLabel(o) === decorated);
}

function validateQuestionLabels(question: AskQuestionInput): string | null {
  const displayLabels = new Set<string>();
  for (const opt of question.options) {
    if (RESERVED_LABELS.has(opt.label)) {
      return `Question "${question.question}" uses reserved option label "${opt.label}".`;
    }
    const display = decorateLabel(opt);
    if (RESERVED_LABELS.has(display)) {
      return `Question "${question.question}" has an option that conflicts with an internal control label.`;
    }
    if (displayLabels.has(display)) {
      return `Question "${question.question}" has duplicate displayed option "${display}".`;
    }
    displayLabels.add(display);
  }
  return null;
}

async function askSingle(
  ctx: ExtensionContext,
  question: AskQuestionInput,
): Promise<QuestionAnswer | null> {
  const labels = [...question.options.map(decorateLabel), OTHER_LABEL];
  const choice = await ctx.ui.select(questionTitle(question), labels);
  if (choice === undefined) return null;

  if (choice === OTHER_LABEL) {
    const notes = await ctx.ui.input(questionTitle(question), "Type your answer…");
    if (notes === undefined) return null;
    return { picks: [OTHER_LABEL], notes };
  }

  const opt = findOptionByDecoratedLabel(question.options, choice);
  return {
    picks: [opt?.label ?? choice],
    ...(opt?.preview !== undefined ? { preview: opt.preview } : {}),
  };
}

async function askMulti(
  ctx: ExtensionContext,
  question: AskQuestionInput,
): Promise<QuestionAnswer | null> {
  const remaining = new Set(question.options.map((o) => o.label));
  const picked: string[] = [];
  let otherNotes: string | undefined;

  while (remaining.size > 0) {
    const remainingOptions = question.options.filter((o) => remaining.has(o.label));
    const labels = [...remainingOptions.map(decorateLabel), OTHER_LABEL, DONE_SENTINEL];
    const title =
      picked.length === 0
        ? questionTitle(question)
        : `${questionTitle(question)} (already picked: ${picked.join(", ")})`;
    const choice = await ctx.ui.select(title, labels);
    if (choice === undefined) return null;
    if (choice === DONE_SENTINEL) break;

    if (choice === OTHER_LABEL) {
      const notes = await ctx.ui.input(questionTitle(question), "Type additional answer…");
      if (notes === undefined) return null;
      if (!picked.includes(OTHER_LABEL)) picked.push(OTHER_LABEL);
      otherNotes = otherNotes ? `${otherNotes}\n${notes}` : notes;
      continue;
    }

    const opt = findOptionByDecoratedLabel(remainingOptions, choice);
    if (opt && remaining.has(opt.label)) {
      picked.push(opt.label);
      remaining.delete(opt.label);
    }
  }

  if (picked.length === 0) return null;
  return { picks: picked, ...(otherNotes !== undefined ? { notes: otherNotes } : {}) };
}

export const askExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerTool(
    defineTool({
      name: "askUserQuestion",
      label: "Ask",
      description: ASK_DESCRIPTION,
      promptSnippet: ASK_PROMPT_SNIPPET,
      promptGuidelines: ASK_GUIDELINES,
      parameters: AskUserQuestionParams,
      renderCall(args, theme, context) {
        return renderToolCallText("askUserQuestion", args, theme, context);
      },
      renderResult(result, options, theme, context) {
        return renderToolResultText(result, options, theme, context);
      },
      async execute(_id, params: AskUserQuestionInput, _signal, _onUpdate, ctx) {
        if (!ctx.hasUI) {
          return errorResult(
            "askUserQuestion requires interactive UI; the current run mode does not provide one. Restate your question in plain text instead.",
          );
        }

        const offending = findInvalidPreviewMultiSelect(params.questions);
        if (offending) {
          return errorResult(
            `Question "${offending}" combines preview options with multiSelect. preview is single-select only.`,
          );
        }
        const seenQuestions = new Set<string>();
        for (const question of params.questions) {
          const labelError = validateQuestionLabels(question);
          if (labelError) return errorResult(labelError);
          // Answers are keyed by the question text — duplicates would
          // silently overwrite each other in the result payload.
          const key = question.question.trim();
          if (seenQuestions.has(key)) {
            return errorResult(`Duplicate question text: "${question.question}". Use unique question text.`);
          }
          seenQuestions.add(key);
        }

        const answers: AskAnswers = {};
        for (const q of params.questions) {
          const result = q.multiSelect ? await askMulti(ctx, q) : await askSingle(ctx, q);
          if (result === null) {
            return errorResult(`User cancelled question "${q.question}".`);
          }
          answers[q.question] = {
            picks: result.picks,
            ...(result.notes !== undefined ? { notes: result.notes } : {}),
            ...(result.preview !== undefined ? { preview: result.preview } : {}),
          };
        }

        return jsonResult({ answers });
      },
    }),
  );
};

export default askExtension;
export { ASK_TOOL_PROMPT };
export { AskUserQuestionParams } from "./schema.ts";
