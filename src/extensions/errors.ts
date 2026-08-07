/**
 * Unified error codes + top-level error classifier.
 *
 * Design intent (inspired by claude-code's error-code and
 * getAssistantMessageFromError): every thrown error in pico carries three
 * facets so any layer (TUI, model, telemetry) can react to it consistently —
 *
 *   1. `userMessage` — human/model-safe text describing what failed
 *      (the only part shown to the user or fed back to the model);
 *   2. `modelHint`   — recovery guidance for the model (empty string if none);
 *   3. `code`        — a stable, machine-readable ErrorCode for routing,
 *      retry policy and diagnostics, mirrored inside `structured`.
 *
 * `classifyError` is the single entry point that normalizes ANY thrown value
 * (ToolError, plain Error, string, null, object) into this shape — it never
 * throws itself. Plain Errors are mapped heuristically from their message;
 * anything unrecognized falls back to "unknown" so a classification failure
 * can never mask the original failure.
 */

export type ErrorCode =
  | "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request"
  | "server_error" | "max_output_tokens" | "config_error" | "spawn_failed"
  | "timeout" | "network" | "schema_violation" | "gate_failed" | "blocked" | "unknown";

export interface ClassifiedError {
  code: ErrorCode;
  userMessage: string;                 // 可安全展示给用户/模型
  modelHint: string;                   // 给模型的恢复提示（无则空串）
  structured: Record<string, unknown>; // 机器可读字段：{ code, ... } 至少含 code
  cause?: unknown;
}

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly modelHint: string;
  readonly structured: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    userMessage: string,
    opts?: { modelHint?: string; structured?: Record<string, unknown>; cause?: unknown },
  ) {
    super(userMessage, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ToolError";
    this.code = code;
    this.modelHint = opts?.modelHint ?? "";
    // code always wins so a caller-supplied structured.code can't drift
    // from the constructor's code.
    this.structured = { ...(opts?.structured ?? {}), code };
  }
}

/** 便捷工厂：throw toolError(code, message, opts?) — 返回 never */
export function toolError(
  code: ErrorCode,
  userMessage: string,
  opts?: { modelHint?: string; structured?: Record<string, unknown>; cause?: unknown },
): never {
  throw new ToolError(code, userMessage, opts);
}

/** 任意 throw 值 → 稳定分类，永不抛出 */
export function classifyError(e: unknown): ClassifiedError {
  if (e instanceof ToolError) {
    return {
      code: e.code,
      userMessage: e.message,
      modelHint: e.modelHint,
      structured: e.structured,
      cause: e.cause,
    };
  }
  if (e instanceof Error) {
    const code = classifyByMessage(e.message.toLowerCase());
    return {
      code,
      userMessage: e.message,
      modelHint: "",
      structured: { code },
      cause: e.cause,
    };
  }
  return {
    code: "unknown",
    userMessage: typeof e === "string" ? e : "unknown error",
    modelHint: "",
    structured: { code: "unknown" },
    cause: e,
  };
}

/** Message-substring heuristic for plain Errors (check order matters). */
function classifyByMessage(lower: string): ErrorCode {
  if (lower.includes("rate limit") || lower.includes("429")) return "rate_limit";
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) return "timeout";
  if (lower.includes("fetch failed") || lower.includes("enetunreach") || lower.includes("econnrefused") || lower.includes("network")) return "network";
  if (lower.includes("enoent") || lower.includes("required") || lower.includes("invalid")) return "invalid_request";
  if (lower.includes("schema")) return "schema_violation";
  return "unknown";
}

/**
 * Turn raw upstream error text into something a user can read. Upstream
 * surfaces two developer-oriented formats that used to land on screen
 * verbatim:
 *
 *  1. Tool schema violations:
 *     `Validation failed for tool "askUserQuestion":\n  - /questions/0/options: ...\n\nReceived arguments:\n{...JSON...}`
 *  2. Provider HTTP envelopes:
 *     `Error: 400: {"message":"...","type":"..."}` or `{"message":"..."}`
 *
 * Unrecognized text is returned unchanged so this never loses information.
 */
export function friendlyErrorMessage(raw: string): string {
  const trimmed = raw.trim();

  const validation = /^Validation failed for tool "([^"]+)"(?::\s*([\s\S]*))?$/.exec(trimmed);
  if (validation) {
    const tool = validation[1] ?? "unknown";
    const detail = (validation[2] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("-"));
    const reason = detail ? detail.slice(1).trim() : "参数不符合工具要求";
    return `工具 "${tool}" 参数校验失败：${reason}`;
  }

  const envelope = /^Error:\s*\d{3}:\s*(\{[\s\S]*\})$/.exec(trimmed);
  const jsonPart = envelope?.[1] ?? (/^(\{[\s\S]*\})$/.exec(trimmed)?.[1] ?? null);
  if (jsonPart) {
    try {
      const parsed = JSON.parse(jsonPart) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
    } catch {
      // not JSON — fall through to the raw text
    }
  }

  return trimmed;
}
