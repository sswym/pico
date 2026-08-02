/**
 * logo extension — replaces pi-coding-agent's built-in startup header with
 * a compact Claude Code-like pico header + a one-line keybinding strip.
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
import { Spacer, Text, Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

const BLOCK_LOGO = [
  "██████████",
  "████  ████",
  "████  ████",
  "████████  ████",
  "████      ████",
  "████      ████",
];

function padVisible(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function centerVisible(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  const left = Math.floor(Math.max(0, width - visibleWidth(clipped)) / 2);
  return padVisible(`${" ".repeat(left)}${clipped}`, width);
}

function modelIdFromCtx(ctx?: { model?: { id?: string; provider?: string } }): string {
  return ctx?.model?.id ?? "no-model";
}

/**
 * Build the rendered header string. Exposed for testing — the live
 * extension wraps this in a Text component via setHeader().
 *
 * Format:
 *   ✻ pico v<pico-version>
 *   / commands · ! bash · F7 todos
 *
 * Colours degrade gracefully — the upstream `theme.fg` is a no-op when the
 * terminal can't render ANSI.
 */
export function renderLogoHeader(theme: {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}, width = 96, ctx?: { model?: { id?: string; provider?: string } }): string {
  const picoVersion = (pkg as { version?: string }).version ?? "0.0.0";
  if (width < 72) {
    const brand =
      theme.fg("accent", "✻ ") +
      theme.bold(theme.fg("accent", "pico")) +
      theme.fg("dim", ` v${picoVersion}`);
    const hints = theme.fg("dim", "/ commands") + theme.fg("muted", " · ") + theme.fg("dim", "! bash");
    return `${brand}\n${hints}`;
  }

  const boxWidth = Math.min(width, 98);
  const innerWidth = boxWidth - 2;
  const leftWidth = Math.max(24, Math.min(30, Math.floor(innerWidth * 0.32)));
  const rightWidth = innerWidth - leftWidth - 1;
  const leftRows = [
    "",
    theme.bold(theme.fg("accent", "Welcome back!")),
    "",
    ...BLOCK_LOGO.map((line) => theme.fg("accent", line)),
    "",
    theme.fg("text", modelIdFromCtx(ctx)),
    theme.fg("dim", ctx?.model?.provider ?? ""),
    "",
  ];
  const rightRows = [
    theme.bold(theme.fg("accent", "Tips")),
    theme.fg("text", "/ for commands"),
    theme.fg("text", "! to run bash"),
    theme.fg("text", "Shift+Tab cycle thinking"),
    theme.fg("muted", "─".repeat(Math.max(0, rightWidth - 2))),
    theme.bold(theme.fg("accent", "Loaded")),
    theme.fg("text", "- extensions active"),
    theme.fg("text", "- context tracked by session"),
    theme.fg("text", "- status in footer"),
    theme.fg("muted", "─".repeat(Math.max(0, rightWidth - 2))),
    theme.bold(theme.fg("accent", "Recent sessions")),
    theme.fg("text", "• pico"),
    "",
  ];
  const rowCount = Math.max(leftRows.length, rightRows.length);
  const title = `─── pico v${picoVersion} `;
  const lines = [theme.fg("border", `╭${title}${"─".repeat(Math.max(0, boxWidth - visibleWidth(title) - 2))}╮`)];
  for (let index = 0; index < rowCount; index++) {
    const left = centerVisible(leftRows[index] ?? "", leftWidth);
    const right = padVisible(` ${rightRows[index] ?? ""}`, rightWidth);
    lines.push(theme.fg("border", "│") + left + theme.fg("border", "│") + right + theme.fg("border", "│"));
  }
  lines.push(theme.fg("border", `╰${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}╯`));
  return lines.join("\n");
}

export const logoExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  let currentCtx: { model?: { id?: string; provider?: string } } | undefined;
  const install = (ctx: { ui: { setHeader: (factory: any) => void } }) => {
    ctx.ui.setHeader((tui: unknown, theme: any) => {
      // The header lives inside pi's headerContainer, which already adds
      // surrounding Spacers. Wrap in our own Container so we can tweak
      // spacing if needed without touching pi's layout.
      const container = new Container();
      const width = (tui as { terminal?: { columns?: number } } | undefined)?.terminal?.columns ?? 80;
      container.addChild(new Text(renderLogoHeader(theme, width, currentCtx), 1, 0));
      container.addChild(new Spacer(1));
      return container;
    });
  };

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    install(ctx);
  });
};
