import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type {
  ClassifierIo,
  ClassifierIoAttempt,
  ClassifierReasoningLog,
  ClassificationDecision,
  DecisionKind,
} from "./types.ts";

/** A final allow/block decision for a tool call. */
export type DecisionLogEntry = {
  type: "decision";
  ts: string;
  decisionId: string;
  sessionId?: string;
  cwd: string;
  tool: string;
  summary: string;
  kind: DecisionKind;
  outcome: "allow" | "block";
  reason: string;
  classifierModel?: string;
  reasoning: ClassifierReasoningLog;
};

/** The classifier prompt, raw responses, and parsed decision for one action. */
export type ClassifierLogEntry = {
  type: "classifier";
  ts: string;
  decisionId: string;
  model: string;
  reasoning: ClassifierIo["reasoning"];
  prompt: ClassifierIo["prompt"];
  attempts: ClassifierIoAttempt[];
  durationMs: number;
  parsed: ClassificationDecision;
};

/** A ccusage-compatible record for one classifier model response. */
export type ClassifierUsageLogEntry = {
  type: "message";
  timestamp: string;
  message: {
    role: "assistant";
    model: string;
    usage: NonNullable<ClassifierIoAttempt["response"]>["usage"];
  };
};

export type LogEntry =
  | DecisionLogEntry
  | ClassifierLogEntry
  | ClassifierUsageLogEntry;

export type Logger = {
  enabled: boolean;
  classifierIo: boolean;
  append(entry: LogEntry): void;
};

export type LoggerOptions = {
  enabled: boolean;
  classifierIo: boolean;
  sessionFile?: string;
  sessionDir: string;
  sessionId: string;
};

/** Short id linking a classifier entry to its decision entry in the same file. */
export function newDecisionId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Derive the log file path from the current session: the session file's
 * directory with `-pi-automode` inserted before the extension. Falls back to
 * `<sessionDir>/<sessionId>-pi-automode.jsonl` when no session file is set.
 */
export function resolveLogPath(
  sessionFile: string | undefined,
  sessionDir: string,
  sessionId: string,
): string {
  if (sessionFile) {
    const ext = extname(sessionFile);
    const stem = ext ? basename(sessionFile, ext) : basename(sessionFile);
    return join(dirname(sessionFile), `${stem}-pi-automode${ext}`);
  }
  return join(sessionDir, `${sessionId}-pi-automode.jsonl`);
}

/** Append one JSON object as a line. Failures are swallowed: logging must
 *  never change a safety decision. */
function appendJsonl(path: string, entry: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Fail open.
  }
}

/** Build a logger bound to one session's log path. No-ops when disabled. */
export function createLogger(opts: LoggerOptions): Logger {
  const { enabled, classifierIo } = opts;
  const path = resolveLogPath(opts.sessionFile, opts.sessionDir, opts.sessionId);
  return {
    enabled,
    classifierIo,
    append(entry) {
      if (!enabled) return;
      if (entry.type === "classifier" && !classifierIo) return;
      appendJsonl(path, entry);
    },
  };
}
