/**
 * input-history extension: persists every submitted input to
 * ~/.pico/agent/input-history.jsonl and preloads it for up/down arrow
 * navigation in the input box.
 *
 * The persistence + editor machinery lives in ../persistent-editor.ts so
 * other extensions that replace the editor component (undo-redo) can build on
 * the same behavior instead of silently dropping it.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PersistentHistoryEditor } from "../persistent-editor.ts";

export {
  appendInputHistory,
  compactHistory,
  normalizeHistoryText,
  parseHistoryFile,
  PersistentHistoryEditor,
  readInputHistory,
  serializeHistoryFile,
  writeInputHistory,
} from "../persistent-editor.ts";

export function inputHistoryExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new PersistentHistoryEditor(tui, theme, keybindings),
    );
  });
}
