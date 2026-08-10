import { createHash } from "node:crypto";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
  complete,
  completeSimple,
} from "@earendil-works/pi-ai/compat";
import type {
  AssistantMessage,
  Model,
  ProviderHeaders,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CLASSIFIER_DETAILED_INSTRUCTION,
  CLASSIFIER_FAST_INSTRUCTION,
  CLASSIFIER_SYSTEM_PROMPT,
  DEFAULT_FAST_CLASSIFIER_MAX_TOKENS,
} from "./constants.ts";
import { formatModelSpec, parseModelSpec } from "./model.ts";
import { buildClassifierTranscript } from "./transcript.ts";
import type {
  ClassificationDecision,
  ClassifyAction,
  ClassifierIoAttempt,
  ClassifierReasoning,
  ClassifierReasoningLevel,
  ClassifierReasoningLog,
  ClassifyResult,
  EffectiveClassifierReasoningLevel,
  EffectiveConfig,
} from "./types.ts";

export function buildClassifierPrompt(config: EffectiveConfig): string {
  return CLASSIFIER_SYSTEM_PROMPT.replace(
    "<ENVIRONMENT>",
    config.environment.map((line) => `- ${line}`).join("\n"),
  )
    .replace(
      "<ALLOW_RULES>",
      config.allow.map((line) => `- ${line}`).join("\n"),
    )
    .replace(
      "<SOFT_DENY_RULES>",
      config.softDeny.map((line) => `- ${line}`).join("\n"),
    )
    .replace(
      "<HARD_DENY_RULES>",
      config.hardDeny.map((line) => `- ${line}`).join("\n"),
    );
}

type ClassifierResolution = {
  reasoning: ClassifierReasoningLog;
  classifier?: {
    model: Model<any>;
    apiKey?: string;
    headers?: ProviderHeaders;
  };
  completionPlan?: ClassifierCompletionPlan;
};

export function classifierReasoningForConfig(
  requestedLevel: ClassifierReasoningLevel | undefined,
): ClassifierReasoningLog {
  return requestedLevel === undefined
    ? { mode: "server-default" }
    : { mode: "explicit", requestedLevel };
}

async function resolveClassifier(
  ctx: ExtensionContext,
  config: EffectiveConfig,
): Promise<ClassifierResolution> {
  const configured = config.classifierModel;
  const model = configured
    ? (() => {
      const parsed = parseModelSpec(configured);
      return parsed
        ? ctx.modelRegistry.find(parsed.provider, parsed.id)
        : undefined;
    })()
    : ctx.model;
  if (!model) {
    return {
      reasoning: classifierReasoningForConfig(config.classifierReasoningLevel),
    };
  }

  const completionPlan = createClassifierCompletionPlan(
    model,
    config.classifierReasoningLevel,
  );
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return { reasoning: completionPlan.reasoning };
  return {
    reasoning: completionPlan.reasoning,
    classifier: {
      model,
      apiKey: auth.apiKey,
      headers: auth.headers,
    },
    completionPlan,
  };
}

export type ClassifierCompletionFn = (
  model: Model<any>,
  options: { systemPrompt: string; messages: UserMessage[] },
  callOptions: {
    apiKey?: string;
    headers?: ProviderHeaders;
    signal?: AbortSignal;
    maxTokens: number;
    temperature?: number;
    reasoning?: Exclude<EffectiveClassifierReasoningLevel, "off">;
    sessionId?: string;
    cacheRetention?: "none" | "short" | "long";
  },
) => Promise<AssistantMessage>;

export type RetryOptions = {
  maxAttempts?: number;
  maxTokens?: number;
  temperature?: number;
  reasoningLevel?: Exclude<EffectiveClassifierReasoningLevel, "off">;
  sessionId?: string;
  cacheRetention?: "none" | "short" | "long";
  stage?: "fast" | "detailed";
  /** Receives each attempt's raw response (or error) and parsed decision, for observability logging. */
  onAttempt?: (attempt: ClassifierIoAttempt) => void;
};

export type StagedClassifierOptions = {
  sessionId: string;
  /** Override the fast-stage token budget; falls back to the default (512). */
  fastClassifierMaxTokens?: number;
  reasoningLevel?: Exclude<EffectiveClassifierReasoningLevel, "off">;
  onAttempt?: (attempt: ClassifierIoAttempt) => void;
};

export type ClassifierCompletionPlan = {
  completeFn: ClassifierCompletionFn;
  reasoning: ClassifierReasoning;
  reasoningLevel?: Exclude<EffectiveClassifierReasoningLevel, "off">;
};

/** Select the raw or normalized Pi AI completion path and record the effective level. */
export function createClassifierCompletionPlan(
  model: Model<any>,
  requestedLevel: ClassifierReasoningLevel | undefined,
  rawComplete: ClassifierCompletionFn = complete,
  simpleComplete: ClassifierCompletionFn = completeSimple,
): ClassifierCompletionPlan {
  if (requestedLevel === undefined) {
    return {
      completeFn: rawComplete,
      reasoning: { mode: "server-default" },
    };
  }

  const effectiveLevel = clampThinkingLevel(model, requestedLevel);
  const reasoning: ClassifierReasoning = {
    mode: "explicit",
    requestedLevel,
    effectiveLevel,
  };
  if (effectiveLevel === "off") {
    return { completeFn: simpleComplete, reasoning };
  }
  return {
    completeFn: simpleComplete,
    reasoning,
    reasoningLevel: effectiveLevel,
  };
}

/** Concatenate all text blocks of an assistant message into a single string. */
function extractAssistantText(message: AssistantMessage, trim = true): string {
  const text = message.content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
  return trim ? text.trim() : text;
}

/** Parse the exact detailed-stage JSON contract; any wrapper or shape drift fails closed. */
export function parseClassifierDecision(
  message: AssistantMessage,
): ClassificationDecision | undefined {
  const text = extractAssistantText(message);
  const validTiers = new Set<ClassificationDecision["tier"]>([
    "hard_deny",
    "soft_deny",
    "allow",
    "explicit_intent",
    "none",
  ]);
  try {
    for (const key of ["decision", "tier", "reason"]) {
      const occurrences = text.match(new RegExp(`"${key}"\\s*:`, "g"))?.length ?? 0;
      if (occurrences !== 1) return undefined;
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const keys = Object.keys(parsed).sort();
    if (keys.join(",") !== "decision,reason,tier") return undefined;
    if (parsed.decision !== "allow" && parsed.decision !== "block") {
      return undefined;
    }
    if (!validTiers.has(parsed.tier as ClassificationDecision["tier"])) {
      return undefined;
    }
    const tier = parsed.tier as ClassificationDecision["tier"];
    if (
      (parsed.decision === "allow" &&
        !["allow", "explicit_intent", "none"].includes(tier)) ||
      (parsed.decision === "block" &&
        !["hard_deny", "soft_deny", "none"].includes(tier))
    ) {
      return undefined;
    }
    if (typeof parsed.reason !== "string" || parsed.reason.trim() === "") {
      return undefined;
    }
    return {
      decision: parsed.decision,
      tier,
      reason: parsed.reason,
    };
  } catch {
    return undefined;
  }
}

function stageMessage(text: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function responseAttempt(
  stage: "fast" | "detailed",
  attempt: number,
  response: AssistantMessage,
  durationMs: number,
  parsed?: ClassificationDecision,
  trimText = true,
): ClassifierIoAttempt {
  return {
    stage,
    attempt,
    response: {
      stopReason: response.stopReason,
      text: extractAssistantText(response, trimText),
      model: response.model,
      timestamp: response.timestamp,
      usage: response.usage,
      ...(response.errorMessage === undefined
        ? {}
        : { errorMessage: response.errorMessage }),
    },
    parsed,
    durationMs,
  };
}

function classifierFailure(
  response: AssistantMessage,
  label: "Classifier" | "Fast classifier",
  retryLength = false,
): ClassificationDecision | undefined {
  if (
    response.stopReason === "stop" ||
    (retryLength && response.stopReason === "length")
  ) {
    return undefined;
  }
  const fallback = response.stopReason === "aborted"
    ? "Classifier model request was aborted."
    : response.stopReason === "error"
    ? "Classifier model returned an error response."
    : `${label} response did not stop cleanly (${response.stopReason}).`;
  return {
    decision: "block",
    tier: "none",
    reason: `${label} failed; auto mode fails closed: ${
      response.errorMessage || fallback
    }`,
  };
}

/**
 * Call the detailed classifier and parse its decision, retrying malformed or
 * truncated output. Provider errors and exhausted retries fail closed.
 */
export async function classifyWithRetry(
  completeFn: ClassifierCompletionFn,
  classifier: {
    model: Model<any>;
    apiKey?: string;
    headers?: ProviderHeaders;
  },
  prompt: { systemPrompt: string; messages: UserMessage[] },
  signal: AbortSignal | undefined,
  options: RetryOptions = {},
): Promise<ClassificationDecision> {
  const maxAttempts = options.maxAttempts ?? 2;
  const maxTokens = options.maxTokens ?? 1200;
  const temperature = options.temperature;
  const stage = options.stage ?? "detailed";
  const onAttempt = options.onAttempt;
  let lastReason =
    "Classifier response was not valid decision JSON; auto mode fails closed.";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const started = Date.now();
    let response: AssistantMessage;
    try {
      response = await completeFn(
        classifier.model,
        prompt,
        {
          apiKey: classifier.apiKey,
          headers: classifier.headers,
          signal,
          maxTokens,
          ...(temperature === undefined ? {} : { temperature }),
          ...(options.reasoningLevel === undefined
            ? {}
            : { reasoning: options.reasoningLevel }),
          sessionId: options.sessionId,
          cacheRetention: options.cacheRetention,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onAttempt?.({
        stage,
        attempt: attempt + 1,
        error: message,
        durationMs: Date.now() - started,
      });
      return {
        decision: "block",
        tier: "none",
        reason: `Classifier failed; auto mode fails closed: ${message}`,
      };
    }
    const durationMs = Date.now() - started;
    const failure = classifierFailure(response, "Classifier", true);
    const decision = response.stopReason === "stop"
      ? parseClassifierDecision(response)
      : undefined;
    onAttempt?.(
      responseAttempt(stage, attempt + 1, response, durationMs, decision, false),
    );
    if (failure) return failure;
    if (decision) return decision;
    lastReason =
      response.stopReason === "length"
        ? "Classifier response was truncated before producing valid decision JSON; auto mode fails closed."
        : "Classifier response was not valid decision JSON; auto mode fails closed.";
  }
  return { decision: "block", tier: "none", reason: lastReason };
}

/** Run the one-token conservative gate, then detailed review only when requested. */
export async function classifyInStages(
  completeFn: ClassifierCompletionFn,
  classifier: {
    model: Model<any>;
    apiKey?: string;
    headers?: ProviderHeaders;
  },
  prompt: { systemPrompt: string; contextMessage: UserMessage },
  signal: AbortSignal | undefined,
  options: StagedClassifierOptions,
): Promise<ClassificationDecision> {
  const fastStarted = Date.now();
  let fastResponse: AssistantMessage;
  try {
    fastResponse = await completeFn(
      classifier.model,
      {
        systemPrompt: prompt.systemPrompt,
        messages: [
          prompt.contextMessage,
          stageMessage(CLASSIFIER_FAST_INSTRUCTION),
        ],
      },
      {
        apiKey: classifier.apiKey,
        headers: classifier.headers,
        signal,
        // Reasoning and OpenAI-compatible models may consume hidden reasoning,
        // control, and EOS tokens before emitting the required visible digit.
        maxTokens: options.fastClassifierMaxTokens ??
          DEFAULT_FAST_CLASSIFIER_MAX_TOKENS,
        ...(options.reasoningLevel === undefined
          ? {}
          : { reasoning: options.reasoningLevel }),
        sessionId: options.sessionId,
        cacheRetention: "short",
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onAttempt?.({
      stage: "fast",
      attempt: 1,
      error: message,
      durationMs: Date.now() - fastStarted,
    });
    return {
      decision: "block",
      tier: "none",
      reason: `Fast classifier failed; auto mode fails closed: ${message}`,
    };
  }

  const fastText = extractAssistantText(fastResponse, false).trim();
  const failure = classifierFailure(fastResponse, "Fast classifier");
  options.onAttempt?.(
    responseAttempt(
      "fast",
      1,
      fastResponse,
      Date.now() - fastStarted,
      undefined,
      false,
    ),
  );
  if (failure) return failure;
  if (fastText === "0") {
    return {
      decision: "allow",
      tier: "none",
      reason: "Fast classifier found no policy-relevant risk.",
    };
  }
  if (fastText !== "1") {
    return {
      decision: "block",
      tier: "none",
      reason:
        "Fast classifier response was not 0 or 1 after trimming whitespace; auto mode fails closed.",
    };
  }

  return classifyWithRetry(
    completeFn,
    classifier,
    {
      systemPrompt: prompt.systemPrompt,
      messages: [
        prompt.contextMessage,
        stageMessage(CLASSIFIER_DETAILED_INSTRUCTION),
      ],
    },
    signal,
    {
      stage: "detailed",
      sessionId: options.sessionId,
      cacheRetention: "short",
      reasoningLevel: options.reasoningLevel,
      onAttempt: options.onAttempt,
    },
  );
}

export function classifierCacheSessionId(ctx: ExtensionContext): string {
  const source = ctx.sessionManager.getSessionId?.() ??
    ctx.sessionManager.getSessionFile?.() ?? ctx.cwd;
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 32);
  return `pi-automode-${digest}`;
}

export const defaultClassifyAction: ClassifyAction = async (
  ctx,
  config,
  action,
  loadedContext,
): Promise<ClassifyResult> => {
  const resolution = await resolveClassifier(ctx, config);
  if (!resolution.classifier || !resolution.completionPlan) {
    return {
      decision: "block",
      tier: "none",
      reason: "No classifier model/API key available; auto mode fails closed.",
      reasoning: resolution.reasoning,
    };
  }
  const classifier = resolution.classifier;
  const completionPlan = resolution.completionPlan;

  const systemPrompt = buildClassifierPrompt(config);
  const transcript = buildClassifierTranscript(ctx, {
    maxUserTokens: config.maxUserTranscriptTokens,
    maxToolTokens: config.maxToolTranscriptTokens,
  });
  const contextText = `<loaded-project-instructions>\n${
    loadedContext || "(none)"
  }\n</loaded-project-instructions>\n\n<classifier-transcript>\n${
    transcript || "(none)"
  }\n</classifier-transcript>\n\nLatest action to classify:\n${action}`;
  const contextMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: contextText }],
    timestamp: Date.now(),
  };

  const attempts: ClassifierIoAttempt[] = [];
  const started = Date.now();
  const decision = await classifyInStages(
    completionPlan.completeFn,
    classifier,
    { systemPrompt, contextMessage },
    ctx.signal,
    {
      sessionId: classifierCacheSessionId(ctx),
      fastClassifierMaxTokens: config.fastClassifierMaxTokens,
      reasoningLevel: completionPlan.reasoningLevel,
      onAttempt: (attempt) => attempts.push(attempt),
    },
  );

  return {
    ...decision,
    reasoning: completionPlan.reasoning,
    io: {
      model: formatModelSpec(classifier.model),
      reasoning: completionPlan.reasoning,
      prompt: {
        system: systemPrompt,
        context: contextText,
        fastInstruction: CLASSIFIER_FAST_INSTRUCTION,
        detailedInstruction: CLASSIFIER_DETAILED_INSTRUCTION,
      },
      attempts,
      durationMs: Date.now() - started,
    },
  };
};
