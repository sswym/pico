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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { picoHome } from "../paths.ts";
import { scanSecrets } from "./secrets.ts";
import { extractText, type ExtractableMessage } from "./extract.ts";

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

const INSTRUCTION_PATTERNS = [
  /用\s*memory\s*工具/,
  /请调用|调用\s*memory|action\s*=/,
  /^\s*请\s*(?:用|调用|执行)/,
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

function unique(entries: string[]): string[] {
  return Array.from(new Set(entries));
}

export interface CuratedWriteResult {
  success: boolean;
  message?: string;
  error?: string;
  target: CuratedTarget;
  entryCount: number;
  usage: string;
  currentEntries?: string[];
  driftBackup?: string;
}

export class CuratedMemoryStore {
  readonly dir: string;
  readonly memoryCharLimit: number;
  readonly userCharLimit: number;

  private memoryEntries: string[] = [];
  private userEntries: string[] = [];
  private snapshot: Record<CuratedTarget, string> = { memory: "", user: "" };

  constructor(opts: { dir?: string; memoryCharLimit?: number; userCharLimit?: number } = {}) {
    this.dir = opts.dir ?? defaultDir();
    this.memoryCharLimit = opts.memoryCharLimit ?? 2200;
    this.userCharLimit = opts.userCharLimit ?? 1375;
  }

  loadFromDisk(): void {
    mkdirSync(this.dir, { recursive: true });
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
    if (entries.includes(clean)) return this.result(target, true, "Entry already exists.");

    const next = [...entries, clean];
    const over = this.limitError(target, next);
    if (over) return over;

    this.setEntries(target, next);
    this.write(pathFor(this.dir, target), next);
    return this.result(target, true, "Entry added.");
  }

  replace(target: CuratedTarget, oldText: string, content: string): CuratedWriteResult {
    const cleanOld = oldText.trim();
    const clean = content.trim();
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
    this.write(pathFor(this.dir, target), entries);
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
    this.write(pathFor(this.dir, target), entries);
    return this.result(target, true, "Entry removed.");
  }

  clear(target?: CuratedTarget): void {
    if (!target || target === "memory") {
      this.memoryEntries = [];
      this.write(pathFor(this.dir, "memory"), []);
    }
    if (!target || target === "user") {
      this.userEntries = [];
      this.write(pathFor(this.dir, "user"), []);
    }
  }

  autoExtract(messages: ExtractableMessage[]): number {
    let count = 0;
    for (const msg of messages) {
      if (msg.role !== "user") continue;
      const text = extractText(msg.content).trim();
      if (text.length < 10) continue;
      if (INSTRUCTION_PATTERNS.some((p) => p.test(text))) continue;

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
    return this.result(target, false, undefined, `Memory at ${used}/${limit} chars. Remove or replace entries first.`, this.entriesFor(target));
  }

  private result(
    target: CuratedTarget,
    success: boolean,
    message?: string,
    error?: string,
    currentEntries?: string[],
  ): CuratedWriteResult {
    return {
      success,
      message,
      error,
      target,
      entryCount: this.entriesFor(target).length,
      usage: this.usage(target),
      currentEntries,
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
    return drift;
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

  private write(path: string, entries: string[]): void {
    mkdirSync(this.dir, { recursive: true });
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
