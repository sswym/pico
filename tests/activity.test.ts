import { afterEach, expect, test } from "bun:test";
import { ActivityTracker, type ActivityPhase } from "../src/extensions/retro-theme/activity.ts";

const trackers: ActivityTracker[] = [];

function makeTracker(now: () => number): ActivityTracker {
  const tracker = new ActivityTracker({ now });
  trackers.push(tracker);
  return tracker;
}

afterEach(() => {
  for (const tracker of trackers) tracker.__resetForTests();
  trackers.length = 0;
});

test("phase transitions follow the agent lifecycle", () => {
  const tracker = makeTracker(() => 0);
  const messages: Array<string | undefined> = [];
  tracker.attach((m) => messages.push(m));

  expect(tracker.getPhase()).toBe("idle" satisfies ActivityPhase);

  tracker.beginThinking();
  expect(tracker.getPhase()).toBe("thinking");

  tracker.beginStreaming();
  expect(tracker.getPhase()).toBe("streaming");

  tracker.beginTool("bash");
  expect(tracker.getPhase()).toBe("tool");
  expect(tracker.getToolName()).toBe("bash");

  tracker.endTool();
  expect(tracker.getPhase()).toBe("thinking");

  tracker.finish();
  expect(tracker.getPhase()).toBe("idle");
});

test("formatStatus reports phase and elapsed seconds from the injected clock", () => {
  let t = 100_000;
  const tracker = makeTracker(() => t);
  tracker.attach(() => {});

  expect(tracker.formatStatus()).toBeUndefined();

  tracker.beginThinking();
  expect(tracker.formatStatus()).toBe("thinking 0s");
  t += 3_500;
  expect(tracker.formatStatus()).toBe("thinking 4s");

  tracker.beginStreaming();
  t += 9_000;
  expect(tracker.formatStatus()).toBe("streaming 9s");

  tracker.beginTool("edit");
  t += 2_000;
  expect(tracker.formatStatus()).toBe("tool edit 2s");

  tracker.finish();
  expect(tracker.formatStatus()).toBeUndefined();
});

test("streaming does not reset the clock when it follows thinking", () => {
  let t = 0;
  const tracker = makeTracker(() => t);
  tracker.attach(() => {});

  tracker.beginThinking();
  t += 5_000;
  tracker.beginStreaming();
  t += 1_000;
  expect(tracker.formatStatus()).toBe("streaming 1s");
});

test("attach pushes the current status and idle restores the default message", () => {
  const tracker = makeTracker(() => 0);
  const messages: Array<string | undefined> = [];
  tracker.attach((m) => messages.push(m));

  tracker.beginThinking();
  // attach after start pushes the current status immediately
  tracker.attach((m) => messages.push(m));
  expect(messages).toContain("thinking 0s");

  tracker.finish();
  // idle clears with an undefined message
  expect(messages.at(-1)).toBeUndefined();
});
