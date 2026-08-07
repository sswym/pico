/**
 * Unified error module tests — ToolError fields, toolError factory,
 * classifyError passthrough/heuristics, non-Error throw values, cause.
 */
import { expect, test } from "bun:test";
import {
  classifyError,
  friendlyErrorMessage,
  toolError,
  ToolError,
  type ClassifiedError,
} from "../src/extensions/errors.ts";

test("ToolError carries code/modelHint/structured and is an Error", () => {
  const err = new ToolError("rate_limit", "slow down", {
    modelHint: "wait and retry",
    structured: { retryAfter: 60 },
  });
  expect(err).toBeInstanceOf(Error);
  expect(err).toBeInstanceOf(ToolError);
  expect(err.code).toBe("rate_limit");
  expect(err.message).toBe("slow down");
  expect(err.modelHint).toBe("wait and retry");
  expect(err.structured).toEqual({ code: "rate_limit", retryAfter: 60 });
  expect(err.name).toBe("ToolError");
});

test("ToolError defaults modelHint to empty string and structured to { code }", () => {
  const err = new ToolError("timeout", "took too long");
  expect(err.modelHint).toBe("");
  expect(err.structured).toEqual({ code: "timeout" });
});

test("ToolError constructor code wins over caller-supplied structured.code", () => {
  const err = new ToolError("network", "down", { structured: { code: "billing_error" } });
  expect(err.code).toBe("network");
  expect(err.structured.code).toBe("network");
});

test("toolError throws a ToolError with message and code (never returns)", () => {
  expect(() => toolError("invalid_request", "bad input")).toThrow(ToolError);
  try {
    toolError("invalid_request", "bad input", { modelHint: "fix the input" });
    expect.unreachable();
  } catch (e) {
    const classified = classifyError(e);
    expect(classified.code).toBe("invalid_request");
    expect(classified.userMessage).toBe("bad input");
    expect(classified.modelHint).toBe("fix the input");
  }
});

test("classifyError passes ToolError fields through untouched", () => {
  const err = new ToolError("config_error", "bad config", {
    modelHint: "fix ~/.pico config",
    structured: { file: "settings.json" },
    cause: new Error("parse error"),
  });
  const out = classifyError(err);
  expect(out.code).toBe("config_error");
  expect(out.userMessage).toBe("bad config");
  expect(out.modelHint).toBe("fix ~/.pico config");
  expect(out.structured).toEqual({ code: "config_error", file: "settings.json" });
  expect(out.cause).toBeInstanceOf(Error);
});

test("classifyError maps plain Error messages heuristically", () => {
  expect(classifyError(new Error("Rate limit exceeded, retry in 30s")).code).toBe("rate_limit");
  expect(classifyError(new Error("HTTP 429 Too Many Requests")).code).toBe("rate_limit");
  expect(classifyError(new Error("request timed out after 10s")).code).toBe("timeout");
  expect(classifyError(new Error("fetch failed: ENETUNREACH")).code).toBe("network");
  expect(classifyError(new Error("connect ECONNREFUSED 127.0.0.1:80")).code).toBe("network");
  expect(classifyError(new Error("ENOENT: no such file or directory")).code).toBe("invalid_request");
  expect(classifyError(new Error("'query' is required for search")).code).toBe("invalid_request");
  expect(classifyError(new Error("boom")).code).toBe("unknown");
});

test("classifyError keeps original message as userMessage and adds structured code", () => {
  const out = classifyError(new Error("fetch failed: network down"));
  expect(out.userMessage).toBe("fetch failed: network down");
  expect(out.modelHint).toBe("");
  expect(out.structured.code).toBe("network");
});

test("classifyError propagates plain Error cause", () => {
  const cause = new Error("inner");
  const out = classifyError(new Error("outer", { cause }));
  expect(out.cause).toBe(cause);
});

test("classifyError never throws on non-Error throw values", () => {
  const stringOut: ClassifiedError = classifyError("string boom");
  expect(stringOut.code).toBe("unknown");
  expect(stringOut.userMessage).toBe("string boom");

  expect(classifyError(null).code).toBe("unknown");
  expect(classifyError(undefined).code).toBe("unknown");
  expect(classifyError({ some: "object" }).code).toBe("unknown");
  expect(classifyError(42).code).toBe("unknown");
  // non-Error values are preserved as the cause
  expect(classifyError(null).cause).toBe(null);
  expect(classifyError("string boom").cause).toBe("string boom");
});

test("friendlyErrorMessage condenses schema validation dumps", () => {
  const raw = [
    'Validation failed for tool "askUserQuestion":',
    "  - /questions/0/options: must not have fewer than 2 items",
    "",
    "Received arguments:",
    '{"questions":[{"question":"x","options":[{"label":"only one"}]}]}',
  ].join("\n");
  const out = friendlyErrorMessage(raw);
  expect(out).toContain("工具 \"askUserQuestion\" 参数校验失败");
  expect(out).toContain("must not have fewer than 2 items");
  expect(out).not.toContain("Received arguments");
  expect(out).not.toContain('"questions"');
});

test("friendlyErrorMessage extracts provider envelope messages", () => {
  const envelope = 'Error: 400: {"message":"Error from provider (Console): Upstream failed","type":"invalid_request_error","code":"invalid_request_error"}';
  const out = friendlyErrorMessage(envelope);
  expect(out).toBe("Error from provider (Console): Upstream failed");

  const bareJson = '{"message":"The `reasoning_content` must be passed back","param":"","code":"x"}';
  expect(friendlyErrorMessage(bareJson)).toBe("The `reasoning_content` must be passed back");
});

test("friendlyErrorMessage passes through unrecognized text unchanged", () => {
  const plain = "Something went wrong here";
  expect(friendlyErrorMessage(plain)).toBe(plain);
  expect(friendlyErrorMessage("  ")).toBe("");
});
