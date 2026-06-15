/**
 * logo extension — replaces pi-coding-agent's built-in startup header with
 * srcode's ASCII logo + a one-line keybinding strip.
 *
 * Why a custom header (not just an extra widget):
 *   pi's default header already renders "pi v0.79.3" + the long hint block.
 *   Layering our logo on top would just stack two brand strings. So we use
 *   `ctx.ui.setHeader(factory)` (see ExtensionUIContext in
 *   pi-coding-agent/dist/core/extensions/types.d.ts) which fully replaces
 *   the built-in header inside the existing headerContainer.
 *
 * setHeader is a no-op until pi has built `builtInHeader`. That happens
 * during interactive-mode startup, before extensions get `session_start`
 * fired (see interactive-mode.js:497 — "Start the UI before initializing
 * extensions"). So `session_start` is the right event to install the
 * header from. We also re-install on `reason: "reload"` because pi can
 * reset the header during config reloads.
 *
 * Modes other than interactive (rpc / json / print) never call
 * `setExtensionHeader`, so the call is a silent no-op there — no need to
 * mode-guard.
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Spacer, Text, Container } from "@earendil-works/pi-tui";
import pkg from "../../../package.json" with { type: "json" };

// 5-line ASCII logo. Kept in a const so tests can pin it. We use plain
// string literals with doubled backslashes — `String.raw\`...\\\`` would
// look cleaner, but a trailing backslash before the closing backtick
// confuses Bun's TS lexer.
const LOGO_LINES = [
  " ____  ____  ____  ____  ____  _____",
  "/ ___\\/  __\\/   _\\/  _ \\/  _ \\/  __/",
  "|    \\|  \\/||  /  | / \\|| | \\||  \\  ",
  "\\___ ||    /|  \\_ | \\_/|| |_/||  /_ ",
  "\\____/\\_/\\_\\\\____/\\____/\\____/\\____\\",
];

export const LOGO = LOGO_LINES.join("\n");

/**
 * Build the rendered header string. Exposed for testing — the live
 * extension wraps this in a Text component via setHeader().
 *
 * Format:
 *   <accent logo, 5 lines>
 *   <blank>
 *   srcode v<srcode-version> · / commands · ! bash
 *
 * Colours degrade gracefully — the upstream `theme.fg` is a no-op when the
 * terminal can't render ANSI.
 */
export function renderLogoHeader(theme: {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}): string {
  const logo = LOGO_LINES.map((line) => theme.bold(theme.fg("accent", line))).join("\n");
  const srcodeVersion = (pkg as { version?: string }).version ?? "0.0.0";
  const tagline =
    theme.bold(theme.fg("accent", "srcode")) +
    theme.fg("dim", ` v${srcodeVersion}`) +
    theme.fg("muted", " · ") +
    theme.fg("dim", "/ commands") +
    theme.fg("muted", " · ") +
    theme.fg("dim", "! bash");
  return `${logo}\n\n${tagline}`;
}

export const logoExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const install = (ctx: { ui: { setHeader: (factory: any) => void } }) => {
    ctx.ui.setHeader((_tui: unknown, theme: any) => {
      // The header lives inside pi's headerContainer, which already adds
      // surrounding Spacers. Wrap in our own Container so we can tweak
      // spacing if needed without touching pi's layout.
      const container = new Container();
      container.addChild(new Spacer(1));
      container.addChild(new Text(renderLogoHeader(theme), 1, 0));
      container.addChild(new Spacer(1));
      return container;
    });
  };

  pi.on("session_start", (_event, ctx) => {
    install(ctx);
  });
};
