import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { renderToolCallText, renderToolResultText } from "../tool-render.ts";
import {
  analyzeImageWithVisionModel,
  defaultVisionDeps,
  formatVisionNote,
  loadImageFromInput,
  modelSupportsVision,
  readVisionConfig,
  type VisionAnalyzeDeps,
} from "./analyze.ts";

const VisionAnalyzeParams = Type.Object({
  image_path: Type.Optional(Type.String({ description: "Local image path. A leading @ is ignored." })),
  image_base64: Type.Optional(Type.String({ description: "Base64 image data, optionally as a data:image/...;base64 URL." })),
  image_url: Type.Optional(Type.String({ description: "HTTP(S) image URL to fetch and analyze." })),
  mime_type: Type.Optional(Type.String({ description: "Image MIME type when providing raw base64. Default image/jpeg." })),
  question: Type.Optional(Type.String({ description: "Specific question to answer about the image." })),
});

export function createVisionExtension(deps: VisionAnalyzeDeps = defaultVisionDeps): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool(
      defineTool({
        name: "visionAnalyze",
        label: "Vision Analyze",
        description:
          "Analyze an image with the configured auxiliary vision model. " +
          "Use when the active model cannot inspect images directly or when a closer visual reading is needed.",
        promptSnippet:
          "visionAnalyze — inspect an image via the configured auxiliary vision model. Accepts image_path, image_base64, or image_url.",
        promptGuidelines: [
          "Use visionAnalyze when you need visual details from an image and the active model cannot inspect images directly.",
          "SSRF 安全禁令：visionAnalyze 的 image_url 会拒绝私网/内网地址（localhost、127.0.0.1、169.254.169.254 元数据服务、10.x/172.16-31.x/192.168.x 等）。若 image_url 因私网地址被拒，严禁改用 bash curl/wget 等 shell 命令下载该 URL 再通过 image_path 传入绕过防护——私网内容不得经视觉模型外发分析。遇到私网/内网图片地址时必须拒绝并报告拒绝原因，不得尝试绕过。",
        ],
        parameters: VisionAnalyzeParams,
        renderCall(args, theme, context) {
          return renderToolCallText("visionAnalyze", args, theme, context);
        },
        renderResult(result, options, theme, context) {
          return renderToolResultText(result, options, theme, context);
        },
        async execute(_id, params, signal, _onUpdate, ctx) {
          try {
            const image = await loadImageFromInput(params, ctx.cwd, deps, signal);
            const result = await analyzeImageWithVisionModel(ctx, image, params.question, deps);
            return {
              content: [{ type: "text" as const, text: result.analysis }],
              details: result,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Throw so the failure is marked as an error upstream (a returned
            // isError flag is dropped by the agent loop).
            throw new Error(`visionAnalyze failed: ${message}`, { cause: error });
          }
        },
      }),
    );

    pi.registerCommand("vision", {
      description: "Show auxiliary vision model configuration",
      handler: async (_args, ctx) => {
        const config = readVisionConfig();
        const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
        const currentVision = modelSupportsVision(ctx.model) ? "yes" : "no";
        const aux = config ? `${config.provider}/${config.model}` : "(not configured)";
        ctx.ui.notify(
          [
            "pico vision",
            `current model: ${current}`,
            `current model supports image: ${currentVision}`,
            `auxiliary vision model: ${aux}`,
          ].join("\n"),
          config ? "info" : "warning",
        );
      },
    });

    pi.on("input", async (event, ctx) => {
      if (!event.images || event.images.length === 0) return { action: "continue" as const };
      if (event.source === "extension") return { action: "continue" as const };
      if (modelSupportsVision(ctx.model)) return { action: "continue" as const };

      // 2.5.9: the active model cannot see images AND no auxiliary vision
      // model is configured — sending the image would silently produce a
      // vision-less answer. Say so explicitly instead of pretending.
      if (!readVisionConfig()) {
        return {
          action: "transform" as const,
          text: `${event.text.trim()}\n\n[附带了 ${event.images.length} 张图片，但当前模型不支持图像且未配置辅助视觉模型（auxiliary.vision），图片内容无法分析。如需要可配置 PICO_VISION_MODEL。]`,
          images: [],
        };
      }

      // Per-image try/catch: one failing image must not discard the analyses
      // that already succeeded — keep them and append a failure note.
      const count = event.images.length;
      try {
        pi.sendMessage({
          customType: "pico.vision.progress",
          content: `Analyzing ${count} attached image${count === 1 ? "" : "s"} with the auxiliary vision model…`,
          display: true,
        });
      } catch {
        // non-TUI mode may drop custom messages
      }
      const results: Array<{ analysis: string; model: string; provider: string }> = [];
      const failures: string[] = [];
      for (const image of event.images) {
        try {
          results.push(await analyzeImageWithVisionModel(ctx, image, event.text, deps));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // 2.5.9: a failed image is dropped from the prompt — mark it
          // visibly so the model knows the visual content is missing.
          failures.push(`[image analysis failed: ${message} — this image was NOT included in the prompt]`);
        }
      }

      const note = formatVisionNote(results);
      const failureNote = failures.join("\n");
      const parts = [event.text.trim(), note, failureNote].filter((p) => p.length > 0);
      return { action: "transform" as const, text: parts.join("\n\n"), images: [] };
    });
  };
}

export const visionExtension: ExtensionFactory = createVisionExtension();
