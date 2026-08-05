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

test("session-scoped subscriptions are dropped on reload teardown", () => {
  const seen: string[] = [];
  const subscribeSessionExtensionEvent = (
    require("../src/extensions/events.ts") as typeof import("../src/extensions/events.ts")
  ).subscribeSessionExtensionEvent;
  const clear = (
    require("../src/extensions/events.ts") as typeof import("../src/extensions/events.ts")
  ).clearSessionExtensionSubscriptions;

  // First factory run (session 1).
  subscribeSessionExtensionEvent("subagent_completed", (event) => {
    seen.push(`s1:${event.task}`);
  });
  publishExtensionEvent("subagent_completed", { task: "a", result: "r" });
  expect(seen).toEqual(["s1:a"]);

  // /reload: factories re-run, old session-scoped subscriptions are dropped,
  // the new factory's subscription is the only one left.
  clear();
  subscribeSessionExtensionEvent("subagent_completed", (event) => {
    seen.push(`s2:${event.task}`);
  });
  publishExtensionEvent("subagent_completed", { task: "b", result: "r" });
  expect(seen).toEqual(["s1:a", "s2:b"]);

  // A second reload must not accumulate: only one handler per generation.
  clear();
  subscribeSessionExtensionEvent("subagent_completed", (event) => {
    seen.push(`s3:${event.task}`);
  });
  publishExtensionEvent("subagent_completed", { task: "c", result: "r" });
  expect(seen).toEqual(["s1:a", "s2:b", "s3:c"]);
});
