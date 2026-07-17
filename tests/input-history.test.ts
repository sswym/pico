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

const originalHome = process.env.SRCODE_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.SRCODE_HOME;
  else process.env.SRCODE_HOME = originalHome;
});

function makeTempHistoryPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "srcode-input-history-"));
  return { dir, path: join(dir, "input-history.jsonl") };
}

function makeFakeTui() {
  return {
    requestRender: () => {},
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
