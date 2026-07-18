/**
 * Todo extension unit tests.
 *
 * The interesting bits are: assignment of stable ids, the auto-collapse
 * when every task is completed, the multipleInProgress invariant, and the
 * /todo command's clear/list paths. UI rendering goes via formatTodoList,
 * which we cover via shape, not pixel-by-pixel.
 */
import { expect, test } from "bun:test";
import { formatPendingReminder, formatTodoList } from "../src/extensions/todo/prompt.ts";
import { TodoStore } from "../src/extensions/todo/store.ts";

const KEY = "session-1";

function makeStore(): TodoStore {
  return new TodoStore();
}

test("commit auto-assigns ids when items have none", () => {
  const store = makeStore();
  const r = store.commit(KEY, [
    { content: "Read the docs", activeForm: "Reading the docs", status: "in_progress" },
    { content: "Apply the patch", activeForm: "Applying the patch", status: "pending" },
  ]);
  expect(r.newTodos.map((t) => t.id)).toEqual(["1", "2"]);
  expect(r.collapsed).toBe(false);
});

test("commit preserves caller-supplied ids and increments around them", () => {
  const store = makeStore();
  const r = store.commit(KEY, [
    { id: "10", content: "A", activeForm: "Aing", status: "completed" },
    { content: "B", activeForm: "Bing", status: "in_progress" },
  ]);
  expect(r.newTodos[0]!.id).toBe("10");
  expect(r.newTodos[1]!.id).toBe("11");
});

test("collapse to empty when every task is completed", () => {
  const store = makeStore();
  store.commit(KEY, [
    { content: "A", activeForm: "Aing", status: "in_progress" },
    { content: "B", activeForm: "Bing", status: "pending" },
  ]);
  const r = store.commit(KEY, [
    { id: "1", content: "A", activeForm: "Aing", status: "completed" },
    { id: "2", content: "B", activeForm: "Bing", status: "completed" },
  ]);
  expect(r.collapsed).toBe(true);
  expect(store.get(KEY)).toEqual([]);
});

test("multipleInProgress flag fires when more than one in_progress", () => {
  const store = makeStore();
  const r = store.commit(KEY, [
    { content: "A", activeForm: "Aing", status: "in_progress" },
    { content: "B", activeForm: "Bing", status: "in_progress" },
  ]);
  expect(r.multipleInProgress).toBe(true);
});

test("reset and resetAll clear state", () => {
  const store = makeStore();
  store.commit("a", [{ content: "x", activeForm: "xing", status: "pending" }]);
  store.commit("b", [{ content: "y", activeForm: "ying", status: "pending" }]);
  store.reset("a");
  expect(store.get("a")).toEqual([]);
  expect(store.get("b")).toHaveLength(1);
  store.resetAll();
  expect(store.get("b")).toEqual([]);
});

test("formatTodoList icons reflect status and activeForm in_progress", () => {
  const out = formatTodoList([
    { id: "1", content: "Run tests", activeForm: "Running tests", status: "in_progress" },
    { id: "2", content: "Write docs", activeForm: "Writing docs", status: "pending" },
    { id: "3", content: "Ship", activeForm: "Shipping", status: "completed" },
  ]);
  expect(out).toContain("● #1 Running tests");
  expect(out).toContain("○ #2 Write docs");
  expect(out).toContain("✓ #3 Ship");
});

test("formatPendingReminder hides when all completed", () => {
  const all = [
    { id: "1", content: "Done thing", activeForm: "Doing thing", status: "completed" as const },
  ];
  expect(formatPendingReminder(all)).toBe("");
});

test("formatPendingReminder includes only open items", () => {
  const out = formatPendingReminder([
    { id: "1", content: "Open A", activeForm: "Doing A", status: "in_progress" },
    { id: "2", content: "Done B", activeForm: "Doing B", status: "completed" },
    { id: "3", content: "Pending C", activeForm: "Doing C", status: "pending" },
  ]);
  expect(out).toContain("Open A");
  expect(out).not.toContain("Done B");
  expect(out).toContain("Pending C");
});

test("allLists returns one entry per non-empty session", () => {
  const store = makeStore();
  store.commit("a", [{ content: "x", activeForm: "xing", status: "pending" }]);
  store.commit("b", [{ content: "y", activeForm: "ying", status: "pending" }]);
  expect(store.allLists()).toHaveLength(2);
});
