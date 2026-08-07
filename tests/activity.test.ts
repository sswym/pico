import { afterEach, expect, test } from "bun:test";
import { ActivityTracker, formatDuration, type ActivityPhase } from "../src/extensions/retro-theme/activity.ts";

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

test("formatDuration renders compound units like 1s / 1m1s / 1h1m1s", () => {
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(1)).toBe("1s");
  expect(formatDuration(59)).toBe("59s");
  expect(formatDuration(60)).toBe("1m");
  expect(formatDuration(61)).toBe("1m1s");
  expect(formatDuration(112)).toBe("1m52s");
  expect(formatDuration(3599)).toBe("59m59s");
  expect(formatDuration(3600)).toBe("1h");
  expect(formatDuration(3660)).toBe("1h1m");
  expect(formatDuration(3661)).toBe("1h1m1s");
  expect(formatDuration(3605)).toBe("1h5s");
  expect(formatDuration(7325)).toBe("2h2m5s");
});

test("formatStatus uses compound durations for each phase", () => {
  let t = 100_000;
  const tracker = makeTracker(() => t);
  tracker.attach(() => {});

  tracker.beginTool("subagent");
  t += 112_000;
  expect(tracker.formatStatus()).toBe("tool subagent 1m52s");

  tracker.beginThinking();
  t += 3_661_000;
  expect(tracker.formatStatus()).toBe("thinking 1h1m1s");
});
