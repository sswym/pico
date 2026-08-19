import { AssistantMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { Container, Spacer, Text, Markdown, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";

/**
 * Collapsible thinking blocks for assistant messages — ccstyle companion.
 *
 * Upstream renders thinking content either fully expanded or (hideThinkingBlock)
 * as one inert "Thinking..." label with no interaction. We patch
 * AssistantMessageComponent.prototype.updateContent so each run of thinking
 * blocks renders as a 1-line header that toggles open/closed on mouse click
 * (wired through ccstyle/mouse.ts hit-testing), mirroring the tool-card
 * click-to-expand interaction. Per-run state lives on the component instance
 * (lost on chat rebuild, same as tool-card expansion).
 *
 * Patch is install-safe across /reload and value-snapshots the original
 * method for teardown (same pattern as render.ts). When ccstyle is disabled
 * (`/ccstyle off`) the patch renders thinking natively (full expansion), so
 * the prototype swap is invisible until re-enabled.
 */

const PICO_THINKING_KEY = Symbol("pico.ccstyle.thinking-block");
const PICO_THINKING_EXPANDED_KEY = Symbol("pico.ccstyle.thinking-expanded");

type MarkdownTransformer = (
  markdown: string,
  context: { messageType: string; isStreaming: boolean; availableWidth: number },
) => string | undefined | void;

/** Runtime shape of AssistantMessageComponent internals (d.ts marks them private). */
export interface ThinkingOwner {
  contentContainer: Container;
  lastMessage?: AssistantMessage;
  isStreaming: boolean;
  hideThinkingBlock: boolean;
  hiddenThinkingLabel: string;
  outputPad: number;
  markdownTheme: MarkdownTheme;
  markdownTransformers?: readonly MarkdownTransformer[];
  hasToolCalls: boolean;
  updateContent(message: AssistantMessage, isStreaming?: boolean): void;
  [PICO_THINKING_EXPANDED_KEY]?: Set<number>;
}

/** A collapsible thinking block — a plain Container carrying a click marker. */
export interface ThinkingBlock extends Container {
  [PICO_THINKING_KEY]: { owner: ThinkingOwner; runIndex: number };
}

/** Boundary cast: thin wrapper container around one thinking run. */
export function asThinkingBlock(value: Component): { owner: ThinkingOwner; runIndex: number } | undefined {
  if (!(value instanceof Container)) return undefined;
  return (value as ThinkingBlock)[PICO_THINKING_KEY];
}

let currentTheme: Theme | undefined;

const noopTheme = {
  fg: (_color: string, text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme;

function themed(): Theme {
  return currentTheme ?? noopTheme;
}

export function setThinkingTheme(theme: Theme): void {
  currentTheme = theme;
}

function expandedSet(owner: ThinkingOwner): Set<number> {
  let set = owner[PICO_THINKING_EXPANDED_KEY];
  if (!set) {
    set = new Set();
    owner[PICO_THINKING_EXPANDED_KEY] = set;
  }
  return set;
}

/** Flip a block's expanded state and re-render its message. */
export function toggleThinkingBlock(
  mark: { owner: ThinkingOwner; runIndex: number },
  requestRender: () => void,
): void {
  const { owner, runIndex } = mark;
  if (!owner.lastMessage) return;
  const set = expandedSet(owner);
  if (set.has(runIndex)) set.delete(runIndex);
  else set.add(runIndex);
  owner.updateContent(owner.lastMessage);
  requestRender();
}

/** Reimplements createMarkdownTransform from upstream markdown-transform.js (unexported). */
function markdownTransform(
  messageType: string,
  isStreaming: boolean,
  transformers: readonly MarkdownTransformer[] | undefined,
): ((markdown: string, availableWidth: number) => string) | undefined {
  if (!transformers || transformers.length === 0) return undefined;
  return (markdown, availableWidth) => {
    let transformed = markdown;
    for (const transformer of transformers) {
      try {
        const result = transformer(transformed, { messageType, isStreaming, availableWidth });
        if (typeof result === "string") transformed = result;
      } catch {
        // Keep the current Markdown and continue with the next transformer.
      }
    }
    return transformed;
  };
}

type ContentPart = TextContent | ThinkingContent | ToolCall;

type UpdateContentMethod = (message: AssistantMessage, isStreaming?: boolean) => void;

/**
 * Patched updateContent — same flow as upstream assistant-message.js, except
 * thinking runs render as collapsible blocks when ccstyle is enabled (and as
 * inert labels when hideThinkingBlock, preserving upstream ctrl+t semantics).
 */
function patchedUpdateContent(
  this: ThinkingOwner,
  message: AssistantMessage,
  isStreaming = this.isStreaming,
): void {
  const internals = this as unknown as ThinkingOwner;
  internals.lastMessage = message;
  internals.isStreaming = isStreaming;
  internals.contentContainer.clear();

  const hasVisibleContent = message.content.some(
    (c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
  );
  if (hasVisibleContent) internals.contentContainer.addChild(new Spacer(1));

  const t = themed();
  const textTransform = markdownTransform("assistant", isStreaming, internals.markdownTransformers);
  const thinkingTransform = markdownTransform("assistant-thinking", isStreaming, internals.markdownTransformers);

  const content: ContentPart[] = message.content;
  let runIndex = 0;
  for (let i = 0; i < content.length; i++) {
    const part = content[i]!;
    if (part.type === "text" && part.text.trim()) {
      internals.contentContainer.addChild(
        new Markdown(part.text.trim(), internals.outputPad, 0, internals.markdownTheme, undefined, {
          transform: textTransform,
        }),
      );
    } else if (part.type === "thinking") {
      const thinkingBlocks: string[] = [];
      for (; i < content.length; i++) {
        const thinkingContent = content[i]!;
        if (thinkingContent.type !== "thinking") break;
        const thinking = thinkingContent.thinking.trim();
        if (thinking) thinkingBlocks.push(thinking);
      }
      i--;
      if (thinkingBlocks.length === 0) continue;

      const hasVisibleContentAfter = content
        .slice(i + 1)
        .some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

      if (internals.hideThinkingBlock) {
        // Upstream semantics: one inert label per run when hidden.
        internals.contentContainer.addChild(
          new Text(t.italic(t.fg("thinkingText", internals.hiddenThinkingLabel)), internals.outputPad, 0),
        );
      } else if (!enabled()) {
        // ccstyle off: upstream native rendering — full expansion, no header.
        internals.contentContainer.addChild(
          new Markdown(
            thinkingBlocks.join("\n\n"),
            internals.outputPad,
            0,
            internals.markdownTheme,
            { color: (text) => t.fg("thinkingText", text), italic: true },
            { transform: thinkingTransform },
          ),
        );
      } else {
        runIndex++;
        const block = new Container() as ThinkingBlock;
        block[PICO_THINKING_KEY] = { owner: this, runIndex };
        if (expandedSet(this).has(runIndex)) {
          block.addChild(
            new Markdown(
              thinkingBlocks.join("\n\n"),
              internals.outputPad,
              0,
              internals.markdownTheme,
              { color: (text) => t.fg("thinkingText", text), italic: true },
              { transform: thinkingTransform },
            ),
          );
        } else {
          const hint = t.fg("dim", " · click to expand");
          block.addChild(
            new Text(
              `${t.italic(t.fg("thinkingText", internals.hiddenThinkingLabel))}${hint}`,
              internals.outputPad,
              0,
            ),
          );
        }
        internals.contentContainer.addChild(block);
      }
      if (hasVisibleContentAfter) internals.contentContainer.addChild(new Spacer(1));
    }
  }

  const hasToolCalls = content.some((c) => c.type === "toolCall");
  internals.hasToolCalls = hasToolCalls;
  if (message.stopReason === "length") {
    internals.contentContainer.addChild(new Spacer(1));
    internals.contentContainer.addChild(new Text(t.fg("error", "Response was truncated before completion."), internals.outputPad, 0));
  } else if (!hasToolCalls) {
    if (message.stopReason === "aborted") {
      const abortMessage =
        message.errorMessage && message.errorMessage !== "Request was aborted"
          ? message.errorMessage
          : "Operation aborted";
      internals.contentContainer.addChild(new Spacer(1));
      internals.contentContainer.addChild(new Text(t.fg("error", abortMessage), internals.outputPad, 0));
    } else if (message.stopReason === "error") {
      const errorMsg = message.errorMessage || "Unknown error";
      internals.contentContainer.addChild(new Spacer(1));
      internals.contentContainer.addChild(new Text(t.fg("error", `Error: ${errorMsg}`), internals.outputPad, 0));
    }
  }
}

// ── install / teardown ───────────────────────────────────────────────────────

export type ThinkingCollapseHooks = {
  shutdown(): void;
};

let enabled: () => boolean = () => true;
let currentPatch: { original: UpdateContentMethod; installed: UpdateContentMethod } | undefined;
let currentHooks: ThinkingCollapseHooks | undefined;

export function installThinkingCollapse(getEnabled: () => boolean = () => true): ThinkingCollapseHooks {
  enabled = getEnabled;
  const prototype = AssistantMessageComponent.prototype as unknown as { updateContent?: UpdateContentMethod };
  const original = prototype.updateContent ?? patchedUpdateContent;
  const installed = patchedUpdateContent;
  prototype.updateContent = installed;
  currentPatch = { original, installed };
  const hooks: ThinkingCollapseHooks = {
    shutdown() {
      if (currentPatch && prototype.updateContent === currentPatch.installed) {
        prototype.updateContent = currentPatch.original;
      }
      currentPatch = undefined;
      currentHooks = undefined;
    },
  };
  currentHooks = hooks;
  return hooks;
}

/** Test hook: release the prototype patch and reset shared state. */
export function __resetThinkingCollapseForTests(): void {
  currentHooks?.shutdown();
  currentHooks = undefined;
  currentTheme = undefined;
  enabled = () => true;
}