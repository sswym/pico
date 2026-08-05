import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { completeSimple, type Api, type ImageContent, type Model, type TextContent } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readSettingsObject } from "../settings.ts";
import { isPrivateHost, withTimeoutSignal } from "../web/fetch.ts";

const DEFAULT_PROMPT =
  "Describe everything visible in this image in thorough detail. Include any text, code, UI, data, objects, layouts, colors, and notable visual information.";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_REDIRECTS = 5;

export interface VisionConfig {
  provider: string;
  model: string;
}

export interface VisionAnalyzeInput {
  image_path?: string;
  image_base64?: string;
  image_url?: string;
  mime_type?: string;
  question?: string;
}

export interface VisionAnalyzeDeps {
  complete: typeof completeSimple;
  fetchImpl: typeof fetch;
}

export const defaultVisionDeps: VisionAnalyzeDeps = {
  complete: completeSimple,
  fetchImpl: fetch,
};

const cache = new Map<string, string>();
/** Bound the analysis cache so long sessions don't grow it without limit. */
const MAX_CACHE_ENTRIES = 200;

function cacheSet(key: string, analysis: string): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, analysis);
}

export function __resetVisionCacheForTests(): void {
  cache.clear();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readVisionConfig(): VisionConfig | null {
  const envProvider = stringValue(process.env.PICO_VISION_PROVIDER);
  const envModel = stringValue(process.env.PICO_VISION_MODEL);
  if (envProvider && envModel) return { provider: envProvider, model: envModel };

  const auxiliary = readSettingsObject("auxiliary");
  const vision = auxiliary.vision;
  if (!vision || typeof vision !== "object" || Array.isArray(vision)) return null;

  const provider = stringValue((vision as Record<string, unknown>).provider);
  const model = stringValue((vision as Record<string, unknown>).model);
  if (!provider || !model || provider === "auto") return null;
  return { provider, model };
}

export function modelSupportsVision(model: Model<Api> | undefined): boolean {
  return Array.isArray(model?.input) && model.input.includes("image");
}

function mimeTypeFromPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".jpg":
    case ".jpeg":
    default:
      return "image/jpeg";
  }
}

function normalizeBase64(data: string): { data: string; mimeType?: string } {
  const match = data.match(/^data:([^;,]+);base64,(.*)$/s);
  if (match?.[1] && match[2]) {
    return { mimeType: match[1], data: match[2].replace(/\s+/g, "") };
  }
  return { data: data.replace(/\s+/g, "") };
}

async function imageFromUrl(url: string, deps: VisionAnalyzeDeps, signal?: AbortSignal): Promise<ImageContent> {
  // Bound the whole fetch (headers + body) — a server that accepts the
  // connection and then stalls must not hang the agent loop forever.
  const timeout = withTimeoutSignal(signal, IMAGE_FETCH_TIMEOUT_MS);
  try {
    let currentUrl = url;
    for (let hop = 0; ; hop++) {
      const parsed = new URL(currentUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("image_url must use http or https");
      }
      // Mirror webFetch's private-network guard on EVERY hop: a public URL
      // that 302s to loopback or cloud metadata must not be fetched (the
      // content is forwarded to the vision provider and could leak through
      // the analysis text). `redirect: "manual"` below is what makes the
      // per-hop re-check possible.
      if (isPrivateHost(parsed.hostname)) {
        throw new Error("Refusing to fetch image from localhost or private network address");
      }

      const response = await deps.fetchImpl(currentUrl, { signal: timeout.signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`image_url redirect (${response.status}) without Location`);
        if (hop >= MAX_IMAGE_REDIRECTS) throw new Error("Too many redirects fetching image_url");
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) throw new Error(`image_url fetch failed: HTTP ${response.status}`);
      return await readImageResponse(response);
    }
  } finally {
    timeout.cleanup();
  }
}

async function readImageResponse(response: Response): Promise<ImageContent> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image is too large (${bytes.length} bytes)`);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
    const mimeType = contentType?.startsWith("image/") ? contentType : "image/jpeg";
    return { type: "image", data: bytes.toString("base64"), mimeType };
  }

  // Stream the body so oversized images are aborted while downloading
  // instead of being fully buffered first.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error(`image is too large (${total} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, total);
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
  const mimeType = contentType?.startsWith("image/") ? contentType : "image/jpeg";
  return { type: "image", data: bytes.toString("base64"), mimeType };
}

export async function loadImageFromInput(
  input: VisionAnalyzeInput,
  cwd: string,
  deps: VisionAnalyzeDeps = defaultVisionDeps,
  signal?: AbortSignal,
): Promise<ImageContent> {
  if (input.image_base64) {
    const normalized = normalizeBase64(input.image_base64);
    const byteLength = Buffer.byteLength(normalized.data, "base64");
    if (byteLength > MAX_IMAGE_BYTES) throw new Error(`image is too large (${byteLength} bytes)`);
    return {
      type: "image",
      data: normalized.data,
      mimeType: input.mime_type ?? normalized.mimeType ?? "image/jpeg",
    };
  }

  if (input.image_path) {
    const path = resolve(cwd, input.image_path.replace(/^@/, ""));
    const bytes = readFileSync(path);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image is too large (${bytes.length} bytes)`);
    return {
      type: "image",
      data: bytes.toString("base64"),
      mimeType: input.mime_type ?? mimeTypeFromPath(path),
    };
  }

  if (input.image_url) {
    return imageFromUrl(input.image_url, deps, signal);
  }

  throw new Error("Provide image_path, image_base64, or image_url");
}

function cacheKey(image: ImageContent, prompt: string, model: Model<Api>): string {
  return createHash("sha256")
    .update(model.provider)
    .update("\0")
    .update(model.id)
    .update("\0")
    .update(image.mimeType)
    .update("\0")
    .update(image.data)
    .update("\0")
    .update(prompt)
    .digest("hex");
}

function assistantText(message: Awaited<ReturnType<typeof completeSimple>>): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

export async function analyzeImageWithVisionModel(
  ctx: ExtensionContext,
  image: ImageContent,
  question?: string,
  deps: VisionAnalyzeDeps = defaultVisionDeps,
): Promise<{ analysis: string; model: string; provider: string; cached: boolean }> {
  const config = readVisionConfig();
  if (!config) {
    throw new Error(
      "No auxiliary vision model configured. Set auxiliary.vision.provider/model in ~/.pico/agent/settings.json or PICO_VISION_PROVIDER/PICO_VISION_MODEL.",
    );
  }

  const model = ctx.modelRegistry.find(config.provider, config.model);
  if (!model) throw new Error(`Vision model not found: ${config.provider}/${config.model}`);
  if (!modelSupportsVision(model)) throw new Error(`Configured vision model does not declare image input: ${config.provider}/${config.model}`);

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const prompt = question?.trim() || DEFAULT_PROMPT;
  const key = cacheKey(image, prompt, model);
  const cached = cache.get(key);
  if (cached) return { analysis: cached, model: model.id, provider: model.provider, cached: true };

  const response = await deps.complete(
    model,
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            image,
          ],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      env: auth.env,
      headers: auth.headers,
      signal: ctx.signal,
      maxTokens: 2048,
    },
  );

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? `Vision model stopped with ${response.stopReason}`);
  }

  const analysis = assistantText(response);
  if (!analysis) throw new Error("Vision model returned no text");
  cacheSet(key, analysis);
  return { analysis, model: model.id, provider: model.provider, cached: false };
}

export function formatVisionNote(results: Array<{ analysis: string; model: string; provider: string }>): string {
  const blocks = results.map((result, index) => {
    return [
      `[Image ${index + 1} analyzed by ${result.provider}/${result.model}]`,
      result.analysis,
    ].join("\n");
  });
  return blocks.join("\n\n");
}
