import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { createVisionExtension } from "../src/extensions/vision/index.ts";
import {
  __resetVisionCacheForTests,
  loadImageFromInput,
  modelSupportsVision,
  readVisionConfig,
} from "../src/extensions/vision/analyze.ts";

const savedEnv = {
  home: process.env.SRCODE_HOME,
  provider: process.env.SRCODE_VISION_PROVIDER,
  model: process.env.SRCODE_VISION_MODEL,
};

afterEach(() => {
  if (savedEnv.home === undefined) delete process.env.SRCODE_HOME;
  else process.env.SRCODE_HOME = savedEnv.home;
  if (savedEnv.provider === undefined) delete process.env.SRCODE_VISION_PROVIDER;
  else process.env.SRCODE_VISION_PROVIDER = savedEnv.provider;
  if (savedEnv.model === undefined) delete process.env.SRCODE_VISION_MODEL;
  else process.env.SRCODE_VISION_MODEL = savedEnv.model;
  __resetVisionCacheForTests();
});

function makeModel(provider: string, id: string, input: Array<"text" | "image">) {
  return {
    id,
    name: id,
    provider,
    api: "openai-completions",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function makeFakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers: Record<string, Array<(event: any, ctx: any) => Promise<any> | any>> = {};
  return {
    tools,
    commands,
    handlers,
    on: (event: string, handler: any) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
}

function makeCtx(opts?: { currentInput?: Array<"text" | "image"> }) {
  const visionModel = makeModel("openai", "gpt-vision", ["text", "image"]);
  const currentModel = makeModel("local", "text-only", opts?.currentInput ?? ["text"]);
  return {
    cwd: "/repo",
    model: currentModel,
    signal: undefined,
    modelRegistry: {
      find(provider: string, model: string) {
        return provider === "openai" && model === "gpt-vision" ? visionModel : undefined;
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "test-key", headers: { "x-test": "1" }, env: { TEST_ENV: "1" } };
      },
    },
    ui: { notify() {} },
  };
}

function configureVisionHome(): string {
  const home = mkdtempSync(join(tmpdir(), "srcode-vision-home-"));
  process.env.SRCODE_HOME = home;
  mkdirSync(join(home, "agent"), { recursive: true });
  writeFileSync(join(home, "agent", "settings.json"), JSON.stringify({
    auxiliary: {
      vision: {
        provider: "openai",
        model: "gpt-vision",
      },
    },
  }));
  return home;
}

test("readVisionConfig reads settings and env overrides", () => {
  const home = configureVisionHome();
  try {
    expect(readVisionConfig()).toEqual({ provider: "openai", model: "gpt-vision" });
    process.env.SRCODE_VISION_PROVIDER = "google";
    process.env.SRCODE_VISION_MODEL = "gemini";
    expect(readVisionConfig()).toEqual({ provider: "google", model: "gemini" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("modelSupportsVision checks image input capability", () => {
  expect(modelSupportsVision(makeModel("p", "m", ["text"]))).toBe(false);
  expect(modelSupportsVision(makeModel("p", "m", ["text", "image"]))).toBe(true);
  expect(modelSupportsVision(undefined)).toBe(false);
});

test("loadImageFromInput accepts data URLs and local paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "srcode-vision-image-"));
  try {
    const path = join(dir, "sample.png");
    writeFileSync(path, Buffer.from("png-bytes"));
    const fromPath = await loadImageFromInput({ image_path: path }, dir);
    expect(fromPath.mimeType).toBe("image/png");
    expect(Buffer.from(fromPath.data, "base64").toString()).toBe("png-bytes");

    const fromDataUrl = await loadImageFromInput({
      image_base64: "data:image/webp;base64,aGVsbG8=",
    }, dir);
    expect(fromDataUrl.mimeType).toBe("image/webp");
    expect(Buffer.from(fromDataUrl.data, "base64").toString()).toBe("hello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("visionAnalyze tool calls configured vision model", async () => {
  const home = configureVisionHome();
  const calls: any[] = [];
  const fakePi = makeFakePi();
  createVisionExtension({
    fetchImpl: fetch,
    complete: (async (_model: any, context: any, options: any) => {
      calls.push({ context, options });
      return {
        role: "assistant",
        content: [{ type: "text", text: "The image shows a terminal." }],
        api: "openai-completions",
        provider: "openai",
        model: "gpt-vision",
        usage: {},
        stopReason: "stop",
        timestamp: Date.now(),
      };
    }) as any,
  })(fakePi as any);

  try {
    const tool = fakePi.tools.get("visionAnalyze");
    const result = await tool.execute(
      "tool-1",
      { image_base64: "aW1hZ2U=", mime_type: "image/png", question: "What is this?" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("The image shows a terminal.");
    expect(calls).toHaveLength(1);
    expect(calls[0].context.messages[0].content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(calls[0].options.apiKey).toBe("test-key");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("input handler transforms images for non-vision main model", async () => {
  const home = configureVisionHome();
  const fakePi = makeFakePi();
  createVisionExtension({
    fetchImpl: fetch,
    complete: (async () => ({
      role: "assistant",
      content: [{ type: "text", text: "A login screen with a blue button." }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-vision",
      usage: {},
      stopReason: "stop",
      timestamp: Date.now(),
    })) as any,
  })(fakePi as any);

  const image: ImageContent = { type: "image", data: "aW1n", mimeType: "image/png" };
  try {
    const result = await fakePi.handlers["input"]![0]!({
      type: "input",
      text: "What do you see?",
      images: [image],
      source: "interactive",
    }, makeCtx());

    expect(result.action).toBe("transform");
    expect(result.images).toEqual([]);
    expect(result.text).toContain("What do you see?");
    expect(result.text).toContain("[Image 1 analyzed by openai/gpt-vision]");
    expect(result.text).toContain("A login screen with a blue button.");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("input handler leaves images alone for vision-capable main model", async () => {
  const home = configureVisionHome();
  const fakePi = makeFakePi();
  createVisionExtension({
    fetchImpl: fetch,
    complete: (async () => {
      throw new Error("should not call auxiliary vision");
    }) as any,
  })(fakePi as any);

  try {
    const result = await fakePi.handlers["input"]![0]!({
      type: "input",
      text: "native",
      images: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
      source: "interactive",
    }, makeCtx({ currentInput: ["text", "image"] }));

    expect(result).toEqual({ action: "continue" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
