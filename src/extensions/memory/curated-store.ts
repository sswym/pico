/**
 * CuratedMemoryStore — small file-backed memory blocks for prompt injection.
 *
 * This complements the SQLite fact store:
 * - MEMORY.md: agent notes, project conventions, durable lessons.
 * - USER.md: stable user preferences/profile.
 *
 * The store keeps a frozen prompt snapshot after loadFromDisk(). Mid-session
 * writes update disk and live entries, but do not mutate the snapshot; the next
 * session start refreshes it. This preserves prompt-cache stability.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { picoHome } from "../paths.ts";
import { scanSecrets } from "./secrets.ts";
import { extractText, isDurableCandidate, type ExtractableMessage } from "./extract.ts";

export type CuratedTarget = "memory" | "user";

const ENTRY_DELIMITER = "\n§\n";

const USER_PATTERNS = [
  /\bI\s+(?:prefer|like|love|use|want|need)\b/i,
  /\bmy\s+(?:favorite|preferred|default)\s+\w+\s+is\b/i,
  /\bI\s+(?:always|never|usually)\b/i,
  /(?:我|咱们)\s*(?:更喜欢|偏好|习惯用|爱用|只用|倾向用|喜欢用)\s*.+/,
  /(?:我|咱们)\s*(?:总是|从不|通常|一般)\s*.+/,
];

const MEMORY_PATTERNS = [
  /\bwe\s+(?:decided|agreed|chose)\s+(?:to\s+)?/i,
  /\bthe\s+project\s+(?:uses|needs|requires)\b/i,
  /\b(?:note|remember|keep in mind)\s+that\s*[:.]?\s/i,
  /\b(?:insight|lesson|takeaway)\s*:/i,
  /\b(?:that\s+)?(?:didn't|doesn't|won't)\s+work\b/i,
  /\b(?:error|failure|bug)\s*:\s*.+\b/i,
  /\b(?:we\s+)?(?:always|never|must|should)\s+(?:use|follow|write)\s+/i,
  /\b(?:quirk|gotcha|caveat|limitation)\s*:/i,
  /\b(?:doesn't|don't|won't|can't)\s+support\s+/i,
  /(?:我们|团队|项目)\s*(?:决定|约定|选定|确定|选择)\s*.+/,
  /(?:这个项目|本仓库|代码库)\s*(?:使用|采用|需要|依赖|要求)\s*.+/,
  /(?:记住|留意|注意|切记)\s*[:：]?\s*.+/,
  /(?:经验|教训|心得)\s*[:：]/,
  /(?:报错|崩溃|挂了|超时了|不工作|没生效|跑不起来|出错了)\s*(?:了|因为|当|在)?/,
  /(?:规范|标准|风格|约定|规矩)\s*(?:是|为|要求)/,
  /(?:坑|怪癖|限制|注意点|陷阱)\s*[:：]/,
];

function defaultDir(): string {
  return join(picoHome(), "memories");
}

function pathFor(dir: string, target: CuratedTarget): string {
  return join(dir, target === "user" ? "USER.md" : "MEMORY.md");
}

function clampEntry(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 400);
}

/** Normalized identity for dedupe: punctuation/whitespace-insensitive (2.3.13). */
function dedupeKey(entry: string): string {
  return clampEntry(entry).toLowerCase();
}

/**
 * Dedupe by normalized key, keeping the first occurrence — punctuation or
 * whitespace micro-differences ("we use bun" vs "we use  bun") must not each
 * consume a character-limit slot.
 */
function unique(entries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    const key = dedupeKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Stale-bak cleanup window: backups older than 7 days are dropped. */
const BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface CuratedWriteResult {
  success: boolean;
  target: CuratedTarget;
  message?: string;
  error?: string;
  entryCount: number;
  usage: string;
  currentEntries?: string[];
  driftBackup?: string;
  /** True when the store is at capacity and consolidation has failed too many
   *  times this turn — the caller should stop retrying memory writes. */
  done?: boolean;
}

/** Thrown by write() when the on-disk file changed since the last read. */
class ConcurrentWriteError extends Error {
  constructor() {
    super("file changed on disk since the last read (concurrent writer)");
    this.name = "ConcurrentWriteError";
  }
}

export class CuratedMemoryStore {
  readonly dir: string;
  readonly memoryCharLimit: number;
  readonly userCharLimit: number;
  /** Per-turn count of at-capacity consolidation failures. Successful writes
   *  reset it; turn boundaries reset it via resetConsolidationFailures(). */
  private consolidationFailures = 0;
  private static readonly _MAX_CONSOLIDATION_FAILURES_PER_TURN = 3;

  private memoryEntries: string[] = [];
  private userEntries: string[] = [];
  private snapshot: Record<CuratedTarget, string> = { memory: "", user: "" };
  /** mtime of each target file at last read — the baseline for write()'s
   *  concurrent-writer guard. */
  private lastSeenMtimes = new Map<string, number>();

  constructor(opts: { dir?: string; memoryCharLimit?: number; userCharLimit?: number } = {}) {
    this.dir = opts.dir ?? defaultDir();
    this.memoryCharLimit = opts.memoryCharLimit ?? 2200;
    this.userCharLimit = opts.userCharLimit ?? 1375;
  }

  loadFromDisk(): void {
    mkdirSync(this.dir, { recursive: true });
    this.cleanupStaleBackups();
    this.memoryEntries = unique(this.read(pathFor(this.dir, "memory")));
    this.userEntries = unique(this.read(pathFor(this.dir, "user")));
    this.snapshot = {
      memory: this.renderBlock("memory", this.sanitizeForSnapshot(this.memoryEntries, "MEMORY.md")),
      user: this.renderBlock("user", this.sanitizeForSnapshot(this.userEntries, "USER.md")),
    };
  }

  formatForSystemPrompt(): string {
    return [this.snapshot.memory, this.snapshot.user].filter(Boolean).join("\n\n");
  }

  list(target?: CuratedTarget): Record<CuratedTarget, string[]> {
    if (target) {
      return {
        memory: target === "memory" ? [...this.memoryEntries] : [],
        user: target === "user" ? [...this.userEntries] : [],
      };
    }
    return { memory: [...this.memoryEntries], user: [...this.userEntries] };
  }

  count(target?: CuratedTarget): number {
    if (target === "memory") return this.memoryEntries.length;
    if (target === "user") return this.userEntries.length;
    return this.memoryEntries.length + this.userEntries.length;
  }

  /** Character usage "used/limit" for a target — surfaced by /memory status. */
  usageOf(target: CuratedTarget): string {
    const limit = this.charLimit(target);
    const entries = this.entriesFor(target);
    const used = entries.length === 0 ? 0 : entries.join(ENTRY_DELIMITER).length;
    return `${used}/${limit}`;
  }

  add(target: CuratedTarget, content: string): CuratedWriteResult {
    // clampEntry mirrors autoExtract: entries are joined by a delimiter, so
    // an entry containing the literal delimiter (or embedded newlines) would
    // corrupt the file format and trip the drift guard on every later write.
    const clean = clampEntry(content);
    const preflight = this.preflight(target, clean);
    if (preflight) return preflight;

    // Same drift handling as replace/remove: silently re-parsing a
    // hand-formatted file would drop the user's formatting.
    const drift = this.reloadLive(target);
    if (drift) return this.driftResult(target, drift);

    const entries = this.entriesFor(target);
    // Dedupe must match loadFromDisk's unique() semantics (case-insensitive
    // dedupeKey) — otherwise "We use bun" then "we use bun" both report
    // "added", and the second silently vanishes on the next load.
    if (entries.some((e) => dedupeKey(e) === dedupeKey(clean))) {
      return this.result(target, true, "Entry already exists.");
    }

    const next = [...entries, clean];
    const over = this.limitError(target, next);
    if (over) return over;

    this.setEntries(target, next);
    try {
      this.write(pathFor(this.dir, target), next);
    } catch (err) {
      if (err instanceof ConcurrentWriteError) {
        return this.result(target, false, undefined, "File was modified by another process — retry to merge the latest state.");
      }
      throw err;
    }
    this.consolidationFailures = 0;
    return this.result(target, true, "Entry added.");
  }

  replace(target: CuratedTarget, oldText: string, content: string): CuratedWriteResult {
    const cleanOld = oldText.trim();
    // Same hygiene as add(): entries are joined by a delimiter, so embedded
    // newlines / the literal delimiter would corrupt the file format and
    // trip the drift guard on every later write.
    const clean = clampEntry(content);
    if (!cleanOld) return this.result(target, false, undefined, "old_text cannot be empty.");
    const preflight = this.preflight(target, clean);
    if (preflight) return preflight;

    const drift = this.reloadLive(target);
    if (drift) return this.driftResult(target, drift);

    const entries = [...this.entriesFor(target)];
    const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(cleanOld));
    if (matches.length === 0) return this.result(target, false, undefined, `No entry matched '${cleanOld}'.`, entries);
    if (new Set(matches.map((m) => m.entry)).size > 1) {
      return this.result(target, false, undefined, `Multiple entries matched '${cleanOld}'. Be more specific.`, matches.map((m) => m.entry));
    }

    entries[matches[0]!.index] = clean;
    const over = this.limitError(target, entries);
    if (over) return over;

    this.setEntries(target, entries);
    try {
      this.write(pathFor(this.dir, target), entries);
    } catch (err) {
      if (err instanceof ConcurrentWriteError) {
        return this.result(target, false, undefined, "File was modified by another process — retry to merge the latest state.");
      }
      throw err;
    }
    this.consolidationFailures = 0;
    return this.result(target, true, "Entry replaced.");
  }

  remove(target: CuratedTarget, oldText: string): CuratedWriteResult {
    const cleanOld = oldText.trim();
    if (!cleanOld) return this.result(target, false, undefined, "old_text cannot be empty.");

    const drift = this.reloadLive(target);
    if (drift) return this.driftResult(target, drift);

    const entries = [...this.entriesFor(target)];
    const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(cleanOld));
    if (matches.length === 0) return this.result(target, false, undefined, `No entry matched '${cleanOld}'.`, entries);
    if (new Set(matches.map((m) => m.entry)).size > 1) {
      return this.result(target, false, undefined, `Multiple entries matched '${cleanOld}'. Be more specific.`, matches.map((m) => m.entry));
    }

    entries.splice(matches[0]!.index, 1);
    this.setEntries(target, entries);
    try {
      this.write(pathFor(this.dir, target), entries);
    } catch (err) {
      if (err instanceof ConcurrentWriteError) {
        return this.result(target, false, undefined, "File was modified by another process — retry to merge the latest state.");
      }
      throw err;
    }
    this.consolidationFailures = 0;
    return this.result(target, true, "Entry removed.");
  }

  clear(target?: CuratedTarget): void {
    if (!target || target === "memory") {
      this.memoryEntries = [];
      // Clear is intentionally destructive — no concurrent-writer guard.
      this.write(pathFor(this.dir, "memory"), [], { guard: false });
    }
    if (!target || target === "user") {
      this.userEntries = [];
      this.write(pathFor(this.dir, "user"), [], { guard: false });
    }
  }

  autoExtract(messages: ExtractableMessage[]): number {
    let count = 0;
    for (const msg of messages) {
      if (msg.role !== "user") continue;
      const text = extractText(msg.content).trim();
      if (text.length < 10) continue;
      // Shared pre-filter with the SQLite path: instructions, help requests,
      // denials and questions are never durable statements.
      if (!isDurableCandidate(text)) continue;

      const target = USER_PATTERNS.some((p) => p.test(text))
        ? "user"
        : MEMORY_PATTERNS.some((p) => p.test(text))
          ? "memory"
          : undefined;
      if (!target) continue;

      const result = this.add(target, clampEntry(text));
      if (result.success && result.message !== "Entry already exists.") count++;
    }
    return count;
  }

  private entriesFor(target: CuratedTarget): string[] {
    return target === "user" ? this.userEntries : this.memoryEntries;
  }

  private setEntries(target: CuratedTarget, entries: string[]): void {
    if (target === "user") this.userEntries = entries;
    else this.memoryEntries = entries;
  }

  /** Purge stale .bak/.tmp spill files older than the retention window. */
  private cleanupStaleBackups(): void {
    try {
      const cutoff = Date.now() - BACKUP_RETENTION_MS;
      for (const name of readdirSync(this.dir)) {
        if (!/\.(?:bak|tmp)\.[^/]*$/.test(name)) continue;
        const full = join(this.dir, name);
        const stat = statSync(full);
        if (stat.mtimeMs < cutoff) rmSync(full, { force: true });
      }
    } catch {
      // best-effort cleanup
    }
  }

  private charLimit(target: CuratedTarget): number {
    return target === "user" ? this.userCharLimit : this.memoryCharLimit;
  }

  private usage(target: CuratedTarget, entries = this.entriesFor(target)): string {
    const limit = this.charLimit(target);
    const used = entries.length === 0 ? 0 : entries.join(ENTRY_DELIMITER).length;
    return `${used}/${limit}`;
  }

  private preflight(target: CuratedTarget, content: string): CuratedWriteResult | null {
    if (!content) return this.result(target, false, undefined, "Content cannot be empty.");
    const scan = scanSecrets(content);
    if (scan.blocked) return this.result(target, false, undefined, scan.reason ?? "Content contains a secret.");
    return null;
  }

  private limitError(target: CuratedTarget, entries: string[]): CuratedWriteResult | null {
    const used = entries.length === 0 ? 0 : entries.join(ENTRY_DELIMITER).length;
    const limit = this.charLimit(target);
    if (used <= limit) return null;
    this.consolidationFailures++;
    if (this.consolidationFailures > CuratedMemoryStore._MAX_CONSOLIDATION_FAILURES_PER_TURN) {
      // Mirrors hermes #42405: an at-capacity retry loop burns context and
      // suppresses the user's reply. Beyond the cap, stop guiding the model
      // back to memory — a failed side effect must not block the turn.
      return this.result(
        target,
        false,
        undefined,
        `Memory consolidation failed ${this.consolidationFailures} times this turn. Stop retrying memory calls — leave memory unchanged for now and continue with your reply. The fact can be saved in a later turn.`,
        this.entriesFor(target),
        true,
      );
    }
    return this.result(target, false, undefined, `Memory at ${used}/${limit} chars. Remove or replace entries first.`, this.entriesFor(target));
  }

  /** Reset the per-turn consolidation-failure counter (call at turn start). */
  resetConsolidationFailures(): void {
    this.consolidationFailures = 0;
  }

  private result(
    target: CuratedTarget,
    success: boolean,
    message?: string,
    error?: string,
    currentEntries?: string[],
    done?: boolean,
  ): CuratedWriteResult {
    return {
      success,
      message,
      error,
      target,
      entryCount: this.entriesFor(target).length,
      usage: this.usage(target),
      currentEntries,
      done,
    };
  }

  private driftResult(target: CuratedTarget, backup: string): CuratedWriteResult {
    return {
      success: false,
      target,
      entryCount: this.entriesFor(target).length,
      usage: this.usage(target),
      driftBackup: backup,
      error: `Refusing to write ${target}: file does not round-trip through the memory parser. Backup saved to ${backup}.`,
    };
  }

  private reloadLive(target: CuratedTarget, opts: { skipDrift?: boolean } = {}): string | null {
    const path = pathFor(this.dir, target);
    const drift = opts.skipDrift ? null : this.detectDrift(target);
    this.setEntries(target, unique(this.read(path)));
    this.recordMtime(path);
    return drift;
  }

  private recordMtime(path: string): void {
    try {
      this.lastSeenMtimes.set(path, statSync(path).mtimeMs);
    } catch {
      this.lastSeenMtimes.set(path, 0); // absent at last read
    }
  }

  private read(path: string): string[] {
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, "utf-8");
      if (!raw.trim()) return [];
      return raw.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private write(path: string, entries: string[], opts: { guard?: boolean } = {}): void {
    mkdirSync(this.dir, { recursive: true });
    if (opts.guard !== false) {
      // Two pico instances writing the same MEMORY.md/USER.md: the second
      // rename would silently clobber the first instance's entries
      // (last-writer-wins). Refuse when the on-disk state moved on since the
      // last read — the caller surfaces this as a visible failure with a
      // retry hint instead of losing data.
      const seen = this.lastSeenMtimes.get(path) ?? 0;
      let current = 0;
      try {
        current = statSync(path).mtimeMs;
      } catch {
        current = 0; // absent
      }
      if (current !== seen) throw new ConcurrentWriteError();
    }
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, entries.length === 0 ? "" : entries.join(ENTRY_DELIMITER), "utf-8");
    renameSync(tmp, path);
  }

  private detectDrift(target: CuratedTarget): string | null {
    const path = pathFor(this.dir, target);
    if (!existsSync(path)) return null;
    let raw = "";
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return null;
    }
    if (!raw.trim()) return null;
    const parsed = raw.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
    const roundtrip = parsed.join(ENTRY_DELIMITER);
    const longest = Math.max(0, ...parsed.map((entry) => entry.length));
    if (raw.trim() === roundtrip && longest <= this.charLimit(target)) return null;

    const backup = `${path}.bak.${Date.now()}`;
    try {
      writeFileSync(backup, raw, "utf-8");
    } catch {
      return `${backup} (backup failed)`;
    }
    return backup;
  }

  private sanitizeForSnapshot(entries: string[], filename: string): string[] {
    return entries.map((entry) => {
      const scan = scanSecrets(entry);
      if (!scan.blocked) return entry;
      return `[BLOCKED: ${filename} entry contained a secret-like pattern and was removed from the prompt snapshot.]`;
    });
  }

  private renderBlock(target: CuratedTarget, entries: string[]): string {
    if (entries.length === 0) return "";
    const title = target === "user" ? "USER PROFILE (stable user preferences)" : "MEMORY (durable agent notes)";
    const content = entries.join(ENTRY_DELIMITER);
    return `${title} [${this.usage(target, entries)} chars]\n${content}`;
  }
}

export function resetCuratedMemoryDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
