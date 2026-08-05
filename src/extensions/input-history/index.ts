import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { picoInputHistoryPath } from "../paths.ts";

const DEFAULT_LIMIT = 100;

interface HistoryEntry {
  text?: unknown;
}

type SubmitHandler = ((text: string) => void | Promise<void>) | undefined;

function padToWidth(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

export function normalizeHistoryText(text: string): string {
  return text.trim();
}

export function compactHistory(entries: string[], limit = DEFAULT_LIMIT): string[] {
  const compacted: string[] = [];
  for (const entry of entries) {
    const text = normalizeHistoryText(entry);
    if (!text) continue;
    if (compacted[compacted.length - 1] === text) continue;
    compacted.push(text);
  }
  return compacted.slice(Math.max(0, compacted.length - limit));
}

export function parseHistoryFile(raw: string, limit = DEFAULT_LIMIT): string[] {
  const entries: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as HistoryEntry;
      if (typeof parsed.text === "string") entries.push(parsed.text);
    } catch {
      // Ignore corrupt lines so a partial write never disables history.
    }
  }
  return compactHistory(entries, limit);
}

export function serializeHistoryFile(entries: string[]): string {
  return entries.map((text) => JSON.stringify({ text })).join("\n") + (entries.length > 0 ? "\n" : "");
}

export function readInputHistory(path = picoInputHistoryPath(), limit = DEFAULT_LIMIT): string[] {
  try {
    return parseHistoryFile(readFileSync(path, "utf-8"), limit);
  } catch {
    return [];
  }
}

export function writeInputHistory(entries: string[], path = picoInputHistoryPath(), limit = DEFAULT_LIMIT): void {
  const compacted = compactHistory(entries, limit);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, serializeHistoryFile(compacted), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmpPath, path);
}

const TRIM_LOCK_STALE_MS = 30_000;

/**
 * Serialize the read-modify-write trim across pico instances sharing one
 * history file (mkdir is atomic). Returns a release function, or null when
 * another instance holds the lock — the append already succeeded, so the
 * trim is simply skipped and the next append tries again.
 */
function tryAcquireTrimLock(path: string): (() => void) | null {
  const lockDir = `${path}.trim-lock`;
  const acquire = (): (() => void) | null => {
    try {
      mkdirSync(lockDir);
      return () => {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
      };
    } catch {
      return null;
    }
  };
  const release = acquire();
  if (release) return release;
  // Lock held by a crashed instance — break it once it looks stale.
  try {
    const st = statSync(lockDir);
    if (Date.now() - st.mtimeMs > TRIM_LOCK_STALE_MS) {
      rmSync(lockDir, { recursive: true, force: true });
      return acquire();
    }
  } catch {
    // Lock dir vanished between the failed mkdir and the stat — treat as free.
  }
  return null;
}

export function appendInputHistory(text: string, path = picoInputHistoryPath(), limit = DEFAULT_LIMIT): void {
  const normalized = normalizeHistoryText(text);
  if (!normalized) return;
  mkdirSync(dirname(path), { recursive: true });
  // Append a single JSONL line: small single-line writes are atomic on POSIX,
  // so concurrent instances no longer drop entries via the old read-modify-
  // write race. { mode: 0o600 } only applies on first creation.
  appendFileSync(path, `${JSON.stringify({ text: normalized })}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    // Trim to the newest `limit` entries once the file grows past the cap.
    // The trim is a read-modify-write, so it must be serialized against other
    // instances' trims (a concurrent trim's rename would clobber this one's
    // entries). The lock is best-effort: a missed trim just leaves the file
    // slightly over the cap until the next append.
    const release = tryAcquireTrimLock(path);
    if (!release) return;
    try {
      const raw = readFileSync(path, "utf-8");
      if (raw.split("\n").filter((line) => line.trim().length > 0).length > limit) {
        writeInputHistory(parseHistoryFile(raw, limit), path, limit);
      }
    } finally {
      release();
    }
  } catch {
    // Read-back is best-effort; the append itself already succeeded.
  }
}

export class PersistentHistoryEditor extends CustomEditor {
  private submitHandler: SubmitHandler;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly historyPath = picoInputHistoryPath(),
    options?: EditorOptions,
  ) {
    super(tui, theme, keybindings, options);

    for (const entry of readInputHistory(this.historyPath)) {
      this.addToHistory(entry);
    }

    Object.defineProperty(this, "onSubmit", {
      configurable: true,
      enumerable: true,
      get: () => this.submitHandler,
      set: (handler: SubmitHandler) => {
        this.submitHandler = handler
          ? (text: string) => {
            appendInputHistory(text, this.historyPath);
            return handler(text);
          }
          : undefined;
      },
    });
  }

  override render(width: number): string[] {
    if (width <= 2) return super.render(width);

    // 2.1.6: the editor must wrap at (width − prefixWidth) so the cursor's
    // wrap point matches the visual column of the decorated output. The
    // prompt width is measured (visibleWidth), not hardcoded — a wide glyph
    // ("❯" can render 1 or 2 columns) previously produced an off-by-one
    // between the cursor line and the visual wrap point.
    const prompt = this.borderColor("❯");
    const prefixWidth = visibleWidth(prompt) + 1;
    const lines = super.render(Math.max(1, width - prefixWidth));
    if (lines.length < 2) return lines;
    const continuation = " ".repeat(prefixWidth);
    const decorated = lines.map((line, index) => {
      if (index === 0 || index === lines.length - 1) return padToWidth(line, width);
      return padToWidth(`${index === 1 ? `${prompt} ` : continuation}${line}`, width);
    });

    if (this.getText().trim().length === 0 && !this.isShowingAutocomplete()) {
      return [decorated[0] ?? "", decorated[1] ?? "", decorated[decorated.length - 1] ?? ""];
    }

    return decorated;
  }
}

export function inputHistoryExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new PersistentHistoryEditor(tui, theme, keybindings),
    );
  });
}
