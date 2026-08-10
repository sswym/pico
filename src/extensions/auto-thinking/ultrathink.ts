/**
 * UltraThink keyword detection — pure prose-boundary helpers.
 *
 * Mirrors oh-my-pi `modes/ultrathink.ts` + `magic-keyword-boundary.ts`:
 * the `ultrathink` keyword only counts when it appears as a standalone
 * lowercase word in *prose* — never inside fenced code blocks, inline
 * code spans, or XML-like tag sections.
 *
 * Kept dependency-free so tests can exercise detection without a live
 * ExtensionAPI.
 */

/**
 * Standalone lowercase word: neighbours must not be letters, digits,
 * underscores, or hyphens (so `super-ultrathink` and `ultrathinkable`
 * do not match, while `(ultrathink)` and `ultrathink,` do).
 */
const ULTRATHINK_RE = /(^|[^\p{L}\p{N}_-])ultrathink($|[^\p{L}\p{N}_-])/u;

const FENCE_RE = /^(```+|~~~+)/;
const FENCE_CLOSE_RE = /^(```+|~~~+)\s*$/;
const INLINE_CODE_RE = /`[^`]*`/g;
/** XML-ish tag pair regions such as <system-notice>…</system-notice>. */
const XML_BLOCK_RE = /<[a-z][a-z0-9_-]*>[\s\S]*?<\/[a-z][a-z0-9_-]*>/g;

/**
 * True when `text` contains the `ultrathink` keyword in prose.
 *
 * Scans line-by-line so fenced code regions can be skipped even when the
 * fence spans multiple lines; inline code spans and XML tag blocks are
 * stripped per line / per whole text respectively.
 */
export function containsUltrathink(text: string): boolean {
  if (!text) return false;
  const xmlStripped = text.replace(XML_BLOCK_RE, "");

  let inFence = false;
  let fenceChar = "";
  for (const rawLine of xmlStripped.split("\n")) {
    const trimmed = rawLine.trim();
      const fence = trimmed.match(FENCE_RE);
      if (fence) {
        const char = fence[1]![0] ?? "";
        if (!inFence) {
          inFence = true;
          fenceChar = char;
        } else if (char === fenceChar && FENCE_CLOSE_RE.test(trimmed)) {
          inFence = false;
        }
        continue;
      }
    if (inFence) continue;
    const prose = rawLine.replace(INLINE_CODE_RE, "");
    if (ULTRATHINK_RE.test(prose)) return true;
  }
  return false;
}

/**
 * The hidden reasoning notice injected into the system prompt when the
 * keyword fires (see oh-my-pi `prompts/system/ultrathink-notice.md`).
 */
export function buildUltrathinkNotice(): string {
  return [
    "",
    "<system-notice>",
    "This task involves multi-step reasoning. Think carefully through the problem before responding.",
    "</system-notice>",
    "",
  ].join("\n");
}
