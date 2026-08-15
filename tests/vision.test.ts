import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createVisionExtension } from "../src/extensions/vision/index.ts";
import {
  __resetVisionCacheForTests,
  loadImageFromInput,
  modelSupportsVision,
  readVisionConfig,
} from "../src/extensions/vision/analyze.ts";

const savedEnv = {
  home: process.env.PICO_HOME,
  provider: process.env.PICO_VISION_PROVIDER,
  model: process.env.PICO_VISION_MODEL,
};

afterEach(() => {
  if (savedEnv.home === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = savedEnv.home;
  if (savedEnv.provider === undefined) delete process.env.PICO_VISION_PROVIDER;
  else process.env.PICO_VISION_PROVIDER = savedEnv.provider;
  if (savedEnv.model === undefined) delete process.env.PICO_VISION_MODEL;
  else process.env.PICO_VISION_MODEL = savedEnv.model;
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
  const home = mkdtempSync(join(tmpdir(), "pico-vision-home-"));
  process.env.PICO_HOME = home;
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
    process.env.PICO_VISION_PROVIDER = "google";
    process.env.PICO_VISION_MODEL = "gemini";
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
  const dir = mkdtempSync(join(tmpdir(), "pico-vision-image-"));
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

test("loadImageFromInput refuses private-network image URLs", async () => {
  await expect(
    loadImageFromInput({ image_url: "http://127.0.0.1:8080/img.png" }, "/repo"),
  ).rejects.toThrow(/private network/i);
  await expect(
    loadImageFromInput({ image_url: "http://169.254.169.254/latest/meta-data/" }, "/repo"),
  ).rejects.toThrow(/private network/i);
  await expect(
    loadImageFromInput({ image_url: "http://localhost/img.png" }, "/repo"),
  ).rejects.toThrow(/private network/i);
});

test("visionAnalyze tool guidance bans shell-download SSRF bypass", () => {
  // D16-M16 regression: the private-network guard only protects the tool's own
  // fetch — the agent loop can otherwise curl the URL and hand the file to
  // visionAnalyze via image_path. The tool guidance must forbid that bypass.
  const fakePi = makeFakePi();
  // Structural stand-in for ExtensionAPI; the fake only covers the surface the
  // extension under test touches.
  createVisionExtension()(fakePi as unknown as ExtensionAPI);
  const tool = fakePi.tools.get("visionAnalyze") as
    | { promptGuidelines?: string[] }
    | undefined;
  expect(tool).toBeDefined();
  const guidelines = (tool?.promptGuidelines ?? []).join("\n");
  expect(guidelines).toMatch(/禁止|严禁|不得/);
  expect(guidelines).toMatch(/curl|wget|bash/);
  expect(guidelines).toMatch(/私网|内网/);
  expect(guidelines).toMatch(/拒绝/);
});

test("loadImageFromInput re-checks the private-network guard on every redirect hop", async () => {
  // A public URL that 302s to loopback must be refused — redirect: "follow"
  // would silently fetch the internal content and forward it to the provider.
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://public.example/img.png") {
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/secret.png" } });
    }
    if (url === "https://public.example/two.png") {
      return new Response(null, { status: 302, headers: { location: "https://public.example/three.png" } });
    }
    if (url === "https://public.example/three.png") {
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  await expect(
    loadImageFromInput({ image_url: "https://public.example/img.png" }, "/repo", { complete: undefined as never, fetchImpl }),
  ).rejects.toThrow(/private network/i);

  // Second-hop redirect into the metadata service is equally refused.
  await expect(
    loadImageFromInput({ image_url: "https://public.example/two.png" }, "/repo", { complete: undefined as never, fetchImpl }),
  ).rejects.toThrow(/private network/i);
});

test("loadImageFromInput follows public redirects and caps the redirect count", async () => {
  let hops = 0;
  const fetchImpl = (async () => {
    hops++;
    if (hops <= 3) {
      return new Response(null, { status: 302, headers: { location: `https://cdn.example/${hops}.png` } });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
  }) as unknown as typeof fetch;

  const img = await loadImageFromInput({ image_url: "https://public.example/a.png" }, "/repo", {
    complete: undefined as never,
    fetchImpl,
  });
  expect(img.mimeType).toBe("image/png");
  expect(Buffer.from(img.data, "base64").length).toBe(3);

  // Unbounded loops are impossible: 6 redirects reject.
  const endless = (async () => new Response(null, { status: 302, headers: { location: "https://cdn.example/loop.png" } })) as unknown as typeof fetch;
  await expect(
    loadImageFromInput({ image_url: "https://public.example/loop.png" }, "/repo", { complete: undefined as never, fetchImpl: endless }),
  ).rejects.toThrow(/Too many redirects/);
});

test("loadImageFromInput propagates a pre-aborted caller signal without fetching", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = (async () => {
    throw new Error("must not fetch");
  }) as unknown as typeof fetch;
  await expect(
    loadImageFromInput({ image_url: "https://public.example/a.png" }, "/repo", {
      complete: undefined as never,
      fetchImpl,
    }, controller.signal),
  ).rejects.toThrow();
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
