/**
 * .editorconfig parser — extracts indent settings for LSP formatting.
 * Reads indent_size, indent_style, tab_width from .editorconfig.
 * Falls back to sniffing file content indentation.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import type { FormattingOptions } from "./types.ts";

interface EditorConfigSection {
  pattern: string;
  indentSize?: number;
  indentStyle?: "tab" | "space";
  tabWidth?: number;
  insertFinalNewline?: boolean;
  trimTrailingWhitespace?: boolean;
}

/** Parse .editorconfig file into sections. */
function parseEditorConfig(filePath: string): EditorConfigSection[] {
  try {
    const content = readFileSync(filePath, "utf8");
    const sections: EditorConfigSection[] = [];
    let current: EditorConfigSection | null = null;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;

      // Section header
      const sectionMatch = trimmed.match(/^\[(.+)\]$/);
      if (sectionMatch) {
        current = { pattern: sectionMatch[1]! };
        sections.push(current);
        continue;
      }

      if (!current) continue;

      const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
      if (!kvMatch) continue;
      const key = kvMatch[1]!.toLowerCase();
      const value = kvMatch[2]!.trim().toLowerCase();

      switch (key) {
        case "indent_size":
          // editorconfig allows `indent_size = tab`; leave it undefined so
          // resolution falls back to tab_width (parseInt("tab") would be NaN
          // and serialize as a null tabSize in the formatting request).
          current.indentSize = value === "tab" ? undefined : parseInt(value, 10);
          break;
        case "indent_style":
          if (value === "tab" || value === "space") current.indentStyle = value;
          break;
        case "tab_width":
          current.tabWidth = parseInt(value, 10);
          break;
        case "insert_final_newline":
          current.insertFinalNewline = value === "true";
          break;
        case "trim_trailing_whitespace":
          current.trimTrailingWhitespace = value === "true";
          break;
      }
    }

    return sections;
  } catch {
    return [];
  }
}

/** Match a file path against an editorconfig glob pattern (simplified). */
function matchesPattern(filePath: string, pattern: string): boolean {
  const ext = extname(filePath);
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return ext === pattern.slice(1);
  if (pattern === "{*.ts,*.tsx,*.js,*.jsx}") {
    return [".ts", ".tsx", ".js", ".jsx"].includes(ext);
  }
  return false;
}

/** Find the best matching section for a file. */
function findMatchingSection(sections: EditorConfigSection[], filePath: string): EditorConfigSection | null {
  // Reverse search — last matching section wins (editorconfig convention)
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i]!;
    if (matchesPattern(filePath, section.pattern)) return section;
  }
  return null;
}

/** Sniff indentation from file content. */
function sniffIndent(content: string): { insertSpaces: boolean; tabSize: number } {
  const lines = content.split("\n");
  let tabCount = 0;
  let spaceCount = 0;
  let detectedSpaceSize = 0;

  for (const line of lines) {
    if (line.startsWith("\t")) {
      tabCount++;
    } else if (line.startsWith("  ")) {
      spaceCount++;
      if (detectedSpaceSize === 0) {
        const match = line.match(/^( +)/);
        if (match) {
          const len = match[1]!.length;
          detectedSpaceSize = len <= 2 ? 2 : len <= 4 ? 4 : len <= 8 ? 8 : 4;
        }
      }
    }
  }

  if (tabCount > spaceCount) return { insertSpaces: false, tabSize: 4 };
  return { insertSpaces: true, tabSize: detectedSpaceSize || 2 };
}

/** Resolve formatting options for a file. */
export function resolveFormattingOptions(filePath: string): FormattingOptions {
  // Try .editorconfig
  let dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ".";
  for (let depth = 0; depth < 4; depth++) {
    const ecPath = join(dir, ".editorconfig");
    if (existsSync(ecPath)) {
      const sections = parseEditorConfig(ecPath);
      const match = findMatchingSection(sections, filePath);
      if (match) {
        return {
          tabSize: match.indentSize ?? match.tabWidth ?? 2,
          insertSpaces: match.indentStyle !== "tab",
          insertFinalNewline: match.insertFinalNewline,
          trimTrailingWhitespace: match.trimTrailingWhitespace,
        };
      }
    }
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: sniff from file content
  try {
    const content = readFileSync(filePath, "utf8");
    return { ...sniffIndent(content), insertFinalNewline: true, trimTrailingWhitespace: true };
  } catch {
    return { tabSize: 2, insertSpaces: true };
  }
}
