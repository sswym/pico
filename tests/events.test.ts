import { afterEach, expect, test } from "bun:test";
import {
  __resetExtensionEventsForTests,
  publishExtensionEvent,
  subscribeExtensionEvent,
} from "../src/extensions/events.ts";
import { fireDelegationCallback, registerDelegationCallback } from "../src/extensions/memory/delegation-registry.ts";

afterEach(() => {
  __resetExtensionEventsForTests();
});

test("extension events publish to subscribers and support unsubscribe", () => {
  const seen: string[] = [];
  const unsubscribe = subscribeExtensionEvent("subagent_completed", (event) => {
    seen.push(`${event.task}:${event.result}`);
  });

  publishExtensionEvent("subagent_completed", { task: "a", result: "done" });
  unsubscribe();
  publishExtensionEvent("subagent_completed", { task: "b", result: "ignored" });

  expect(seen).toEqual(["a:done"]);
});

test("delegation registry remains a compatibility wrapper over extension events", () => {
  const seen: Array<{ task: string; result: string; childSessionId?: string }> = [];
  registerDelegationCallback((task, result, childSessionId) => {
    seen.push({ task, result, childSessionId });
  });

  fireDelegationCallback("task", "result", "child");

  expect(seen).toEqual([{ task: "task", result: "result", childSessionId: "child" }]);
});
