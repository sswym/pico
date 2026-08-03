/**
 * Workspace edit application engine.
 * Pure string transform for text edits; IO-bound apply for workspace edits.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { uriToPath } from "./client.ts";
import type {
  ApplyResult,
  CreateFile,
  DeleteFile,
  DocumentChange,
  RenameFile,
  TextDocumentEdit,
  TextEdit,
} from "./types.ts";

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

/**
 * Apply a workspace edit to the filesystem.
 * Handles both `edit.changes` and `edit.documentChanges`.
 */
export function applyWorkspaceEdit(
  edit: { changes?: Record<string, TextEdit[]>; documentChanges?: DocumentChange[] },
  cwd: string,
): ApplyResult {
  const messages: string[] = [];
  let fileCount = 0;

  try {
    if (edit.changes) {
      for (const [uri, edits] of Object.entries(edit.changes)) {
        const filePath = uriToPath(uri);
        const content = readFileSync(filePath, "utf-8");
        const result = applyTextEditsToString(content, edits);
        writeFileSync(filePath, result, "utf-8");
        fileCount++;
        messages.push(`Applied ${edits.length} edit(s) to ${filePath}`);
      }
    }

    if (edit.documentChanges) {
      for (const change of edit.documentChanges) {
        fileCount++;
        switch ((change as { kind?: string }).kind) {
          case "create": {
            const c = change as CreateFile;
            const filePath = uriToPath(c.uri);
            mkdirSync(dirname(filePath), { recursive: true });
            const exists = existsSync(filePath);
            // LSP semantics: creating an existing file fails unless
            // ignoreIfExists is set (or overwrite explicitly allows it).
            if (exists && c.options?.ignoreIfExists) {
              messages.push(`Skipped create (already exists): ${filePath}`);
              break;
            }
            if (exists && !c.options?.overwrite) {
              throw new Error(`File already exists: ${filePath}`);
            }
            writeFileSync(filePath, "", "utf-8");
            messages.push(`Created ${filePath}`);
            break;
          }
          case "delete": {
            const d = change as DeleteFile;
            const filePath = uriToPath(d.uri);
            if (!existsSync(filePath)) {
              // LSP semantics: deleting a missing file fails unless
              // ignoreIfNotExists tolerates it.
              if (d.options?.ignoreIfNotExists) {
                messages.push(`Skipped delete (already gone): ${filePath}`);
                break;
              }
              throw new Error(`File does not exist: ${filePath}`);
            }
            unlinkSync(filePath);
            messages.push(`Deleted ${filePath}`);
            break;
          }
          case "rename": {
            const r = change as RenameFile;
            const oldPath = uriToPath(r.oldUri);
            const newPath = uriToPath(r.newUri);
            mkdirSync(dirname(newPath), { recursive: true });
            renameSync(oldPath, newPath);
            messages.push(`Renamed ${oldPath} -> ${newPath}`);
            break;
          }
          default: {
            const tde = change as TextDocumentEdit;
            const filePath = uriToPath(tde.textDocument.uri);
            const content = readFileSync(filePath, "utf-8");
            const result = applyTextEditsToString(content, tde.edits);
            writeFileSync(filePath, result, "utf-8");
            messages.push(`Applied ${tde.edits.length} edit(s) to ${filePath}`);
            break;
          }
        }
      }
    }

    return { ok: true, fileCount, messages };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, fileCount, messages, error };
  }
}
