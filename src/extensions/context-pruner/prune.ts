/**
 * Context pruning — pure logic for the `context` event.
 *
 * Mirrors oh-my-pi `session-maintenance.ts #pruneStaleToolResults`
 * (superseded-read elision): when the same file is read again, the earlier
 * full-file read result is replaced with a short marker so the LLM stops
 * carrying stale bytes for a file it already re-read.
 *
 * Conservative by design:
 * - Only *full* reads (no offset/limit) are prunable — partial range reads
 *   are complementary views and are kept.
 * - Only the *non-latest* full read of a path is replaced; the newest one
 *   is left intact so the model always has the freshest copy.
 * - Messages are mutated in place on the structured-cloned array handed to
 *   `context` handlers; roles, toolCallIds, and isError flags are preserved.
 */

import { normalize } from "node:path";

const MARKER = "[Superseded by a newer read of this file]";

interface ReadRecord {
  /** Index into the messages array of the toolResult message. */
  messageIndex: number;
  /** Absolute, normalized path of the file read. */
  path: string;
  /** True when the read covered the whole file (no offset/limit args). */
  full: boolean;
}

export function normalizeReadPath(path: string | undefined, cwd: string): string | null {
  if (typeof path !== "string" || path.trim() === "") return null;
  if (path.startsWith("artifact://") || path.startsWith("http://") || path.startsWith("https://")) return null;
  const absolute = path.startsWith("/") ? path : joinSafe(cwd, path);
  return normalize(absolute);
}

function joinSafe(cwd: string, path: string): string {
  return `${cwd.replace(/\/+$/, "")}/${path}`;
}

/** Extract the `path` argument from a tool call's arguments object. */
export function readPathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const raw = record.path ?? record.file_path;
  return typeof raw === "string" ? raw : undefined;
}

function isFullRead(args: unknown): boolean {
  if (!args || typeof args !== "object") return true;
  const record = args as Record<string, unknown>;
  return record.offset === undefined && record.limit === undefined;
}

function replaceTextContent(message: unknown, marker: string): boolean {
  if (!message || typeof message !== "object") return false;
  const m = message as { content?: unknown };
  if (!Array.isArray(m.content)) return false;
  const replaced = m.content.map((block) => {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      return { ...(block as object), text: marker };
    }
    return block;
  });
  m.content = replaced;
  return true;
}

/**
 * Replace non-latest full reads of the same file with a superseded marker.
 *
 * @param messages provider-level message array (role: user/assistant/toolResult)
 * @param cwd session working directory for relative-path resolution
 * @returns the (possibly mutated) message array
 */
export function pruneSupersededReads<T>(messages: T[], cwd: string): T[] {
  // Pass 1: collect read records, mapping toolCallId -> args from assistant messages.
  const argsByToolCallId = new Map<string, unknown>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const m = message as { role?: string; content?: unknown };
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; id?: string; arguments?: unknown };
      if (b.type === "toolCall" && typeof b.id === "string") {
        argsByToolCallId.set(b.id, b.arguments);
      }
    }
  }

  // Pass 2: find the latest full-read index per normalized path.
  const records: ReadRecord[] = [];
  const latestFullIndex = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const m = message as { role?: string; toolName?: string; toolCallId?: string };
    if (m.role !== "toolResult" || m.toolName !== "read") continue;
    const args = argsByToolCallId.get(String(m.toolCallId));
    const path = normalizeReadPath(readPathFromArgs(args), cwd);
    if (path === null) continue;
    const full = isFullRead(args);
    records.push({ messageIndex: i, path, full });
    if (full) latestFullIndex.set(path, i);
  }

  // Pass 3: replace non-latest full reads. A read is stale iff the same
  // normalized path has a newer full read *anywhere* after it.
  for (const record of records) {
    if (!record.full) continue;
    const latest = latestFullIndex.get(record.path);
    if (latest === undefined || latest === record.messageIndex) continue;
    replaceTextContent(messages[record.messageIndex], MARKER);
  }

  return messages;
}
