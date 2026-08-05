/**
 * Smoke tests for the logo extension.
 *
 * The header is a TUI component, so we don't render it pixel-for-pixel.
 * We just verify:
 *   1. Logo registers a session_start handler (and nothing else).
 *   2. The compact Claude-like header survives the full render path.
 *   3. The handler calls ctx.ui.setHeader with a factory that returns a
 *      Container holding our Text. We exercise the factory with a stub
 *      theme to make sure no upstream API was called wrong.
 */
import { expect, test } from "bun:test";
import { LOGO, logoExtension, renderLogoHeader } from "../src/extensions/logo/index.ts";

const stubTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("LOGO has 5 lines and contains the pico silhouette", () => {
  const lines = LOGO.split("\n");
  expect(lines).toHaveLength(5);
  // Pick a couple of unique substrings from the ASCII art so a typo in one
  // line is caught without hard-coding the whole thing here.
  expect(lines[1]).toContain("/  __");
  expect(lines[3]).toContain("|_/|");
});

test("renderLogoHeader renders a boxed welcome header", () => {
  const out = renderLogoHeader(stubTheme, 96, { model: { id: "deepseek-v4-flash-free", provider: "zen-openai" } });
  expect(out).not.toContain(LOGO);
  expect(out).toContain("pico v");
  expect(out).toContain("Welcome back!");
  expect(out).toContain("Tips");
  expect(out).toContain("/ for commands");
  expect(out).toContain("! to run bash");
  expect(out).toContain("Shift+Tab cycle thinking");
  expect(out).toContain("Loaded");
  expect(out).toContain("Recent sessions");
  expect(out).toContain("deepseek-v4-flash-free");
  expect(out).toContain("zen-openai");
});

test("renderLogoHeader uses a compact header on narrow terminals", () => {
  const out = renderLogoHeader(stubTheme, 48);
  expect(out).not.toContain(LOGO);
  expect(out).not.toContain("Welcome back!");
  expect(out).toContain("pico v");
  expect(out).toContain("/ commands");
});

test("logoExtension only subscribes to session_start and model_select", () => {
  const events: string[] = [];
  const tools: string[] = [];
  const commands: string[] = [];
  const fakePi: any = {
    on: (name: string) => events.push(name),
    registerTool: (t: { name: string }) => tools.push(t.name),
    registerCommand: (n: string) => commands.push(n),
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  logoExtension(fakePi);
  expect(events).toEqual(["session_start", "model_select"]);
  expect(tools).toEqual([]);
  expect(commands).toEqual([]);
});

test("session_start handler installs a header factory that renders the logo", () => {
  let capturedFactory: any = null;
  const fakeUi = {
    setHeader: (factory: any) => {
      capturedFactory = factory;
    },
  };
  let handler: any = null;
  const fakePi: any = {
    on: (name: string, h: any) => {
      if (name === "session_start") handler = h;
    },
    registerTool: () => {},
    registerCommand: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  logoExtension(fakePi);
  handler({ type: "session_start", reason: "startup" }, { ui: fakeUi, model: { id: "deepseek-v4-flash-free", provider: "zen-openai" } });
  expect(typeof capturedFactory).toBe("function");

  // Render the factory: should produce a Container with at least one Text
  // child carrying the compact header.
  const component = capturedFactory({ terminal: { columns: 80 } }, stubTheme);
  const lines = component.render(80);
  const joined = lines.join("\n");
  expect(joined).toContain("Welcome back!");
  expect(joined).toContain("Tips");
  expect(joined).toContain("deepseek-v4-flash-free");
});

test("model_select updates the header model and triggers a re-render", () => {
  let sessionHandler: ((event: any, ctx?: any) => void) | undefined;
  let modelSelectHandler: ((event: any) => void) | undefined;
  const fakePi: any = {
    on: (name: string, handler: (event: any) => void) => {
      if (name === "session_start") sessionHandler = handler;
      if (name === "model_select") modelSelectHandler = handler;
    },
    registerTool: () => {},
    registerCommand: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  logoExtension(fakePi);

  let capturedFactory: any = null;
  const fakeUi = {
    setHeader: (factory: any) => {
      capturedFactory = factory;
    },
  };
  sessionHandler?.(
    { type: "session_start", reason: "startup" },
    { ui: fakeUi, model: { id: "old-model", provider: "old-provider" } },
  );
  expect(typeof capturedFactory).toBe("function");

  let rendersRequested = 0;
  const tui = {
    requestRender: () => {
      rendersRequested++;
    },
    terminal: { columns: 80 },
  };
  const component = capturedFactory(tui, stubTheme);
  expect(component.render(80).join("\n")).toContain("old-model");

  modelSelectHandler?.({
    type: "model_select",
    model: { id: "new-model", provider: "new-provider" },
    previousModel: { id: "old-model", provider: "old-provider" },
    source: "set",
  });
  expect(rendersRequested).toBeGreaterThan(0);

  // The header rebuilds from the updated model on the next render.
  const fresh = component.render(80).join("\n");
  expect(fresh).toContain("new-model");
  expect(fresh).toContain("new-provider");
  expect(fresh).not.toContain("old-model");
});

// ---- first-run copy + real recent sessions (P2) --------------------------

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasAnySession, recentSessions } from "../src/extensions/logo/index.ts";

test("renderLogoHeader greets first-run users differently from returning users", () => {
  const theme = stubTheme;
  expect(renderLogoHeader(theme, 96, undefined, { firstRun: true })).toContain("Welcome to pico!");
  expect(renderLogoHeader(theme, 96, undefined, { firstRun: false })).toContain("Welcome back!");
  expect(renderLogoHeader(theme, 96, undefined, { firstRun: true })).not.toContain("Welcome back!");
});

test("renderLogoHeader shows real recent sessions or a first-run hint", () => {
  const theme = stubTheme;
  const header = renderLogoHeader(theme, 96, undefined, {
    recent: [{ label: "demo-app", path: "/x" }],
  });
  expect(header).toContain("• demo-app");
  expect(header).not.toContain("• pico");

  const empty = renderLogoHeader(theme, 96, undefined, { recent: [] });
  expect(empty).toContain("no sessions yet");
});

test("recentSessions lists newest session files with cwd labels", () => {
  const dir = mkdtempSync(join(tmpdir(), "pico-logo-sessions-"));
  try {
    const older = join(dir, "2026-01-01T00-00-00-000Z_old.jsonl");
    const newer = join(dir, "2026-02-01T00-00-00-000Z_new.jsonl");
    writeFileSync(older, JSON.stringify({ type: "session", cwd: "/home/user/old-app" }) + "\n");
    writeFileSync(newer, JSON.stringify({ type: "session", cwd: "/home/user/new-app" }) + "\n");
    writeFileSync(join(dir, "not-a-session.txt"), "x");

    const sessions = recentSessions(2, dir);
    expect(sessions.map((s) => s.label)).toEqual(["new-app", "old-app"]);
    expect(hasAnySession(dir)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recentSessions and hasAnySession tolerate an empty or missing dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "pico-logo-empty-"));
  try {
    expect(recentSessions(2, dir)).toEqual([]);
    expect(hasAnySession(dir)).toBe(false);
    expect(recentSessions(2, join(dir, "missing"))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setExpanded(false) at startup keeps the full logo banner (regression)", () => {
  let capturedFactory: any = null;
  const fakeUi = {
    setHeader: (factory: any) => {
      capturedFactory = factory;
    },
  };
  let handler: any = null;
  const fakePi: any = {
    on: (name: string, h: any) => {
      if (name === "session_start") handler = h;
    },
    registerTool: () => {},
    registerCommand: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  logoExtension(fakePi);
  handler({ type: "session_start", reason: "startup" }, { ui: fakeUi, model: { id: "deepseek-v4-flash-free", provider: "zen-openai" } });
  const component = capturedFactory({ terminal: { columns: 96 } }, stubTheme);

  // Upstream calls setExpanded(toolOutputExpanded=false) right after the
  // factory returns — the full logo must still render (it must NOT be
  // collapsed by the default false).
  component.setExpanded(false);
  const full = component.render(96).join("\n");
  expect(full).toContain("Welcome");
  expect(full).toContain("pico");
  expect(full).not.toContain("✻");

  // Expanding tool output (Ctrl+O → setExpanded(true)) collapses to one line.
  component.setExpanded(true);
  const collapsed = component.render(96).join("\n");
  expect(collapsed).toContain("✻");
  expect(collapsed).not.toContain("Welcome");
});
