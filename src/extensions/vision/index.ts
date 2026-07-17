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
            return {
              content: [{ type: "text" as const, text: `visionAnalyze failed: ${message}` }],
              details: { error: message },
              isError: true,
            };
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
            "srcode vision",
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
      if (!readVisionConfig()) return { action: "continue" as const };

      const results = [];
      for (const image of event.images) {
        results.push(await analyzeImageWithVisionModel(ctx, image, event.text, deps));
      }

      const note = formatVisionNote(results);
      const text = event.text.trim().length > 0
        ? `${event.text}\n\n${note}`
        : note;
      return { action: "transform" as const, text, images: [] };
    });
  };
}

export const visionExtension: ExtensionFactory = createVisionExtension();
