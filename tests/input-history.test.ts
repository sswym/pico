import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendInputHistory,
  inputHistoryExtension,
  parseHistoryFile,
  PersistentHistoryEditor,
  readInputHistory,
  serializeHistoryFile,
} from "../src/extensions/input-history/index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const originalHome = process.env.PICO_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = originalHome;
});

function makeTempHistoryPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "pico-input-history-"));
  return { dir, path: join(dir, "input-history.jsonl") };
}

function makeFakeTui() {
  return {
    requestRender: () => {},
    terminal: { rows: 24 },
  } as any;
}

const stubTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selected: (text: string) => text,
    normal: (text: string) => text,
    dim: (text: string) => text,
    border: (text: string) => text,
    highlight: (text: string) => text,
  },
} as any;

const stubKeybindings = {
  matches: () => false,
} as any;

test("history parser ignores bad lines and keeps newest entries", () => {
  const raw = [
    JSON.stringify({ text: "one" }),
    "not json",
    JSON.stringify({ text: "two" }),
    JSON.stringify({ text: "two" }),
    JSON.stringify({ text: "three" }),
  ].join("\n");

  expect(parseHistoryFile(raw, 2)).toEqual(["two", "three"]);
});

test("appendInputHistory persists trimmed non-empty input with consecutive dedupe", () => {
  const { dir, path } = makeTempHistoryPath();
  try {
    appendInputHistory("  first  ", path);
    appendInputHistory("", path);
    appendInputHistory("first", path);
    appendInputHistory("second", path);

    expect(readInputHistory(path)).toEqual(["first", "second"]);
    expect(parseHistoryFile(serializeHistoryFile(["first", "second"]))).toEqual(["first", "second"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PersistentHistoryEditor preloads persisted history for arrow navigation", () => {
  const { dir, path } = makeTempHistoryPath();
  try {
    appendInputHistory("first prompt", path);
    appendInputHistory("second prompt", path);

    const editor = new PersistentHistoryEditor(makeFakeTui(), stubTheme, stubKeybindings, path);
    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("second prompt");

    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("first prompt");

    editor.handleInput("\x1b[B");
    expect(editor.getText()).toBe("second prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PersistentHistoryEditor wraps onSubmit to persist built-in commands before upstream handles them", async () => {
  const { dir, path } = makeTempHistoryPath();
  try {
    const submitted: string[] = [];
    const editor = new PersistentHistoryEditor(makeFakeTui(), stubTheme, stubKeybindings, path);
    editor.onSubmit = (text) => {
      submitted.push(text);
    };

    await editor.onSubmit?.("/new");

    expect(submitted).toEqual(["/new"]);
    expect(readInputHistory(path)).toEqual(["/new"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PersistentHistoryEditor renders Claude-style prompt frame when empty", () => {
  const editor = new PersistentHistoryEditor(makeFakeTui(), stubTheme, stubKeybindings);
  const lines = editor.render(120);

  expect(lines).toHaveLength(3);
  expect(visibleWidth(lines[0] ?? "")).toBe(120);
  expect(lines[1]).toContain("❯");
  expect(lines[1]?.startsWith("❯ ")).toBe(true);
  expect(visibleWidth(lines[1] ?? "")).toBe(120);
  expect(visibleWidth(lines[2] ?? "")).toBe(120);
});

test("PersistentHistoryEditor wraps long input instead of truncating it", () => {
  const editor = new PersistentHistoryEditor(makeFakeTui(), stubTheme, stubKeybindings);
  editor.setText("abcdefghijklmnopqrstuvwxyz");

  const lines = editor.render(12);
  const renderedText = lines.join("");

  expect(lines.length).toBeGreaterThan(3);
  expect(lines[1]?.startsWith("❯ ")).toBe(true);
  expect(lines[2]?.startsWith("  ")).toBe(true);
  expect(renderedText).toContain("abcdefghi");
  expect(renderedText).toContain("stuvwxyz");
  for (const line of lines) {
    expect(visibleWidth(line)).toBe(12);
  }
});

test("inputHistoryExtension installs a persistent editor factory on session start", () => {
  let handler: any;
  let factory: any;
  const fakePi: any = {
    on: (event: string, h: any) => {
      if (event === "session_start") handler = h;
    },
  };

  inputHistoryExtension(fakePi);
  handler({}, { ui: { setEditorComponent: (f: any) => { factory = f; } } });

  expect(typeof factory).toBe("function");
});
