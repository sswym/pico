import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { srcodeInputHistoryPath } from "../paths.ts";

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

export function readInputHistory(path = srcodeInputHistoryPath(), limit = DEFAULT_LIMIT): string[] {
  try {
    return parseHistoryFile(readFileSync(path, "utf-8"), limit);
  } catch {
    return [];
  }
}

export function writeInputHistory(entries: string[], path = srcodeInputHistoryPath(), limit = DEFAULT_LIMIT): void {
  const compacted = compactHistory(entries, limit);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, serializeHistoryFile(compacted), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmpPath, path);
}

export function appendInputHistory(text: string, path = srcodeInputHistoryPath(), limit = DEFAULT_LIMIT): void {
  const normalized = normalizeHistoryText(text);
  if (!normalized) return;
  writeInputHistory([...readInputHistory(path, limit), normalized], path, limit);
}

export class PersistentHistoryEditor extends CustomEditor {
  private submitHandler: SubmitHandler;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly historyPath = srcodeInputHistoryPath(),
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

    const lines = super.render(width - 2);
    if (lines.length < 2) return lines;
    const prompt = this.borderColor("❯");
    const continuation = " ".repeat(visibleWidth(prompt) + 1);
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
