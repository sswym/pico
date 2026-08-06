/**
 * Text edit application engine.
 * Pure string transform for LSP text edits.
 */
import type { TextEdit } from "./types.ts";

/**
 * Apply a list of text edits to a string.
 * Edits are sorted bottom-to-top so earlier edits don't shift later ranges.
 * Throws if any edits overlap.
 */
export function applyTextEditsToString(content: string, edits: TextEdit[]): string {
  const lines = content.split("\n");
  const sorted = [...edits].sort((a, b) => {
    const startDiff = b.range.start.line - a.range.start.line;
    if (startDiff !== 0) return startDiff;
    return b.range.start.character - a.range.start.character;
  });

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]!;
    const next = sorted[i + 1]!;
    const currentStart = current.range.start;
    const nextEnd = next.range.end;
    if (
      nextEnd.line > currentStart.line ||
      (nextEnd.line === currentStart.line && nextEnd.character > currentStart.character)
    ) {
      throw new Error("Overlapping text edits");
    }
  }

  for (const edit of sorted) {
    const startLine = edit.range.start.line;
    const startChar = edit.range.start.character;
    const endLine = edit.range.end.line;
    const endChar = edit.range.end.character;

    if (startLine === endLine) {
      const line = lines[startLine]!;
      lines[startLine] = line.slice(0, startChar) + edit.newText + line.slice(endChar);
    } else {
      const startText = lines[startLine]!.slice(0, startChar);
      const endText = lines[endLine]!.slice(endChar);
      const newLines = (startText + edit.newText + endText).split("\n");
      lines.splice(startLine, endLine - startLine + 1, ...newLines);
    }
  }

  return lines.join("\n");
}
