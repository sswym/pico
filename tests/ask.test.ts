/**
 * Tests for src/extensions/ask.
 *
 * UI flows can't run in unit tests (no terminal), but we can drive
 * `execute()` against a faked ExtensionContext that records ui.select /
 * ui.input calls. We cover:
 *   - the (preview + multiSelect) refusal
 *   - the hasUI=false fallback
 *   - schema validity helpers
 *   - the single-question happy path with and without "Other"
 *   - the multi-question + multiSelect happy path
 */
import { describe, expect, test } from "bun:test";
import {
  askExtension,
} from "../src/extensions/ask/index.ts";
import {
  findInvalidPreviewMultiSelect,
  type AskQuestionInput,
} from "../src/extensions/ask/schema.ts";

interface UiCall {
  kind: "select" | "input";
  title: string;
  options?: string[];
}

interface FakeUi {
  hasUI: boolean;
  selectQueue: Array<string | undefined>;
  inputQueue: Array<string | undefined>;
  calls: UiCall[];
  ctx: any;
}

function makeUi(opts: {
  hasUI?: boolean;
  selectQueue?: Array<string | undefined>;
  inputQueue?: Array<string | undefined>;
}): FakeUi {
  const calls: UiCall[] = [];
  const selectQueue = [...(opts.selectQueue ?? [])];
  const inputQueue = [...(opts.inputQueue ?? [])];
  const ctx: any = {
    hasUI: opts.hasUI ?? true,
    cwd: process.cwd(),
    mode: "tui",
    ui: {
      async select(title: string, options: string[]) {
        calls.push({ kind: "select", title, options });
        return selectQueue.shift();
      },
      async input(title: string) {
        calls.push({ kind: "input", title });
        return inputQueue.shift();
      },
      async confirm() {
        return false;
      },
      notify() {},
    },
  };
  return { hasUI: ctx.hasUI, selectQueue, inputQueue, calls, ctx };
}

async function loadAskTool(): Promise<any> {
  let registered: any;
  const fakePi: any = {
    on: () => {},
    registerCommand: () => {},
    registerTool: (t: any) => {
      registered = t;
    },
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  await askExtension(fakePi);
  if (!registered) throw new Error("askExtension did not register a tool");
  return registered;
}

function parseDetails(result: any) {
  return result.details;
}

describe("findInvalidPreviewMultiSelect", () => {
  test("returns null when every question is valid", () => {
    const qs: AskQuestionInput[] = [
      {
        question: "A?",
        header: "A",
        multiSelect: true,
        options: [
          { label: "x", description: "" },
          { label: "y", description: "" },
        ],
      },
      {
        question: "B?",
        header: "B",
        options: [
          { label: "x", description: "", preview: "code" },
          { label: "y", description: "" },
        ],
      },
    ];
    expect(findInvalidPreviewMultiSelect(qs)).toBeNull();
  });

  test("flags question that mixes preview + multiSelect", () => {
    const qs: AskQuestionInput[] = [
      {
        question: "A?",
        header: "A",
        multiSelect: true,
        options: [
          { label: "x", description: "", preview: "code" },
          { label: "y", description: "" },
        ],
      },
    ];
    expect(findInvalidPreviewMultiSelect(qs)).toBe("A?");
  });
});

describe("askExtension execute()", () => {
  test("hasUI=false → returns isError without prompting", async () => {
    const tool = await loadAskTool();
    const { ctx, calls } = makeUi({ hasUI: false });
    const res = await tool.execute(
      "id",
      {
        questions: [
          {
            question: "A?",
            header: "A",
            options: [
              { label: "x", description: "" },
              { label: "y", description: "" },
            ],
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(parseDetails(res).error).toContain("requires interactive UI");
  });

  test("preview + multiSelect → execute returns isError", async () => {
    const tool = await loadAskTool();
    const { ctx } = makeUi({});
    const res = await tool.execute(
      "id",
      {
        questions: [
          {
            question: "A?",
            header: "A",
            multiSelect: true,
            options: [
              { label: "x", description: "", preview: "code" },
              { label: "y", description: "" },
            ],
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(parseDetails(res).error).toContain("preview is single-select only");
  });

  test("single question, plain pick → returns answers", async () => {
    const tool = await loadAskTool();
    const { ctx } = makeUi({ selectQueue: ["bun"] });
    const res = await tool.execute(
      "id",
      {
        questions: [
          {
            question: "Runtime?",
            header: "Runtime",
            options: [
              { label: "bun", description: "" },
              { label: "node", description: "" },
            ],
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(parseDetails(res).answers).toEqual({
      "Runtime?": { picks: ["bun"] },
    });
  });

  test("user picks Other → input collected as notes", async () => {
    const tool = await loadAskTool();
    const { ctx, calls } = makeUi({ selectQueue: ["Other"], inputQueue: ["deno"] });
    const res = await tool.execute(
      "id",
      {
        questions: [
          {
            question: "Runtime?",
            header: "Runtime",
            options: [
              { label: "bun", description: "" },
              { label: "node", description: "" },
            ],
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(parseDetails(res).answers["Runtime?"]).toEqual({
      picks: ["Other"],
      notes: "deno",
    });
    expect(calls.map((c) => c.kind)).toEqual(["select", "input"]);
  });

  test("multiSelect collects multiple picks via DONE sentinel", async () => {
    const tool = await loadAskTool();
    // First select picks "frontend"; second select picks "backend";
    // third select picks "(done — submit)" to finish.
    const { ctx } = makeUi({
      selectQueue: ["frontend", "backend", "(done — submit)"],
    });
    const res = await tool.execute(
      "id",
      {
        questions: [
          {
            question: "Areas?",
            header: "Areas",
            multiSelect: true,
            options: [
              { label: "frontend", description: "" },
              { label: "backend", description: "" },
              { label: "infra", description: "" },
            ],
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(parseDetails(res).answers["Areas?"].picks).toEqual([
      "frontend",
      "backend",
    ]);
  });

  test("user cancels (select returns undefined) → isError", async () => {
    const tool = await loadAskTool();
    const { ctx } = makeUi({ selectQueue: [undefined] });
    const res = await tool.execute(
      "id",
      {
        questions: [
          {
            question: "A?",
            header: "A",
            options: [
              { label: "x", description: "" },
              { label: "y", description: "" },
            ],
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(parseDetails(res).error).toContain("cancelled");
  });
});
