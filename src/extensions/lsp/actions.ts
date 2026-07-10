import { readFileSync } from "node:fs";
import type { Location, Position } from "./types.ts";

export interface HierarchicalSymbol {
  name: string;
  kind: number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
  detail?: string;
  children?: HierarchicalSymbol[];
}

export interface FlatSymbolInfo {
  name: string;
  kind: number;
  location: { uri: string; range: { start: { line: number } } };
  containerName?: string;
}

export interface WorkspaceSymbolItem {
  name: string;
  kind: number;
  location: unknown;
  containerName?: string;
}

export function isHierarchicalSymbolArray(symbols: unknown[]): symbols is HierarchicalSymbol[] {
  return symbols.length > 0 && symbols[0] !== null && typeof symbols[0] === "object" && "selectionRange" in symbols[0];
}

export function isFlatSymbolInfoArray(symbols: unknown[]): symbols is FlatSymbolInfo[] {
  return symbols.length > 0 && symbols[0] !== null && typeof symbols[0] === "object" && "location" in symbols[0];
}

export function isWorkspaceSymbolArray(symbols: unknown[]): symbols is WorkspaceSymbolItem[] {
  return symbols.length > 0 && symbols[0] !== null && typeof symbols[0] === "object" && "location" in symbols[0];
}

export function extractLocationFields(obj: unknown): { uri: string; line: number } | null {
  if (typeof obj !== "object" || obj === null) return null;
  if (!("uri" in obj) || !("range" in obj)) return null;
  const uriVal = obj.uri;
  if (typeof uriVal !== "string") return null;
  const rangeVal = obj.range;
  if (typeof rangeVal !== "object" || rangeVal === null || !("start" in rangeVal)) return null;
  const startVal = rangeVal.start;
  if (typeof startVal !== "object" || startVal === null || !("line" in startVal)) return null;
  const lineVal = startVal.line;
  if (typeof lineVal !== "number") return null;
  return { uri: uriVal, line: lineVal };
}

export function normalizeLocations(result: unknown): Location[] {
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) {
    if (typeof result === "object" && "uri" in result && "range" in result) return [result as Location];
    return [];
  }
  if (result.length === 0) return [];
  const first = result[0]!;
  if (first && typeof first === "object" && "targetUri" in first) {
    return (result as Array<{ targetUri: string; targetRange: { start: Position; end: Position } }>).map((link) => ({
      uri: link.targetUri,
      range: link.targetRange,
    }));
  }
  return result as Location[];
}

export function resolveSymbolColumn(filePath: string, line: number, symbol: string, occurrence: number): number | undefined {
  try {
    const text = readFileSync(filePath, "utf8");
    const lines = text.split("\n");
    const lineText = lines[line - 1];
    if (!lineText) return undefined;
    let idx = 0;
    let count = 0;
    while (true) {
      const found = lineText.indexOf(symbol, idx);
      if (found === -1) return undefined;
      count++;
      if (count >= occurrence) return found;
      idx = found + 1;
    }
  } catch {
    return undefined;
  }
}

