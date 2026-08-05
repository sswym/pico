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
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Spacer, Text, Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import pkg from "../../../package.json" with { type: "json" };
import { picoSessionDir } from "../paths.ts";

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

export interface SessionSummary {
  /** Short human label: "<cwd-basename> · <MM-DD HH:mm>" (local time). */
  label: string;
  /** Absolute path of the session file. */
  path: string;
}

function sessionLabelFromFile(file: string, dir: string): string {
  try {
    // Session files can be MBs long (large tool results) — only the first
    // line is needed for the label, so read a bounded head.
    const fd = openSync(join(dir, file), "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, 4096, 0);
      const firstLine = buf.subarray(0, Math.max(0, n)).toString("utf-8").split("\n")[0];
      if (firstLine) {
        const parsed = JSON.parse(firstLine) as { cwd?: string };
        if (typeof parsed?.cwd === "string" && parsed.cwd.length > 0) {
          return basename(parsed.cwd);
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // Unreadable/empty session file: fall back to the timestamp prefix.
  }
  return file.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z?_/, "").replace(/\.jsonl$/, "").slice(0, 24);
}

/** Newest session files under the pico session dir, most recent first. */
export function recentSessions(limit = 2, dir = picoSessionDir()): SessionSummary[] {
  try {
    const files = readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => ({ file, mtime: statSync(join(dir, file)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
    return files.map(({ file }) => ({ label: sessionLabelFromFile(file, dir), path: join(dir, file) }));
  } catch {
    return [];
  }
}

/** True when any session file exists (first-run detection). */
export function hasAnySession(dir = picoSessionDir()): boolean {
  try {
    return readdirSync(dir).some((file) => file.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

// ── Render-cache ───────────────────────────────────────────────────────────

const SESSION_CACHE_TTL_MS = 5_000;
let sessionsCache: { firstRun: boolean; recent: SessionSummary[]; at: number } | null = null;

/**
 * Session info is computed on EVERY header render frame (streaming output +
 * activity ticks re-render multiple times per second) — readdirSync/statSync
 * per frame is wasteful and full-file reads for the first line are worse.
 * Cache for a few seconds; invalidate on session_start.
 */
export function cachedSessionInfo(now = Date.now()): { firstRun: boolean; recent: SessionSummary[] } {
  if (sessionsCache && now - sessionsCache.at < SESSION_CACHE_TTL_MS) return sessionsCache;
  const info = { firstRun: !hasAnySession(), recent: recentSessions(2) };
  sessionsCache = { ...info, at: now };
  return info;
}

export function invalidateSessionCacheForTests(): void {
  sessionsCache = null;
}

/**
 * Build the rendered header string. Exposed for testing — the live
 * extension wraps this in a Text component via setHeader().
 */
export function renderLogoHeader(
  theme: {
    fg: (color: string, text: string) => string;
    bold: (text: string) => string;
  },
  width = 96,
  ctx?: { model?: { id?: string; provider?: string } },
  options: { firstRun?: boolean; recent?: SessionSummary[] } = {},
): string {
  const picoVersion = (pkg as { version?: string }).version ?? "0.0.0";
  const firstRun = options.firstRun ?? false;
  const recent = options.recent ?? [];
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
    theme.bold(theme.fg("accent", firstRun ? "Welcome to pico!" : "Welcome back!")),
    "",
    ...BLOCK_LOGO.map((line) => theme.fg("accent", line)),
    "",
    theme.fg("text", modelIdFromCtx(ctx)),
    theme.fg("dim", ctx?.model?.provider ?? ""),
    "",
  ];
  const recentRows = recent.length > 0
    ? recent.map((session) => theme.fg("text", `• ${session.label}`))
    : [theme.fg("dim", "no sessions yet — say hi!")];
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
    ...recentRows,
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
  let headerTui: { requestRender?: (force?: boolean) => void } | undefined;
  const install = (ctx: { ui: { setHeader: (factory: any) => void } }) => {
    ctx.ui.setHeader((tui: unknown, theme: any) => {
      headerTui = tui as { requestRender?: (force?: boolean) => void };
      // The header lives inside pi's headerContainer, which already adds
      // surrounding Spacers. Wrap in our own Container so we can tweak
      // spacing if needed without touching pi's layout. Rebuild the Text on
      // every render so currentCtx (e.g. after a model switch) is reflected.
      return {
        render(width: number): string[] {
          const container = new Container();
          const effectiveWidth =
            (tui as { terminal?: { columns?: number } } | undefined)?.terminal?.columns ?? width;
          container.addChild(
            new Text(
              renderLogoHeader(theme, effectiveWidth, currentCtx, cachedSessionInfo()),
              1,
              0,
            ),
          );
          container.addChild(new Spacer(1));
          return container.render(effectiveWidth);
        },
        invalidate(): void {},
      };
    });
  };

  pi.on("session_start", (_event, ctx) => {
    sessionsCache = null;
    currentCtx = ctx;
    install(ctx);
  });

  pi.on("model_select", (event) => {
    currentCtx = { ...currentCtx, model: { id: event.model.id, provider: event.model.provider } };
    headerTui?.requestRender?.();
  });
};
