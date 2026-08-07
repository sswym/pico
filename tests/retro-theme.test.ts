import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetFooterStateForTests,
  __test,
  createClaudeLikeFooter,
  createPrimaryStatusWidget,
  renderExtensionStatusLine,
  renderClaudeLikeFooterLine,
  renderPrimaryStatusLine,
} from "../src/extensions/retro-theme/footer.ts";
import { retroThemeExtension } from "../src/extensions/retro-theme/index.ts";
import claudeCodeDarkTheme from "../src/theme/claude-code-dark.json" with { type: "json" };

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("claude code dark theme uses the Claude color system", () => {
  expect(claudeCodeDarkTheme.name).toBe("claude-code-dark");
  // UI colors measured from ~/claude-code/src/utils/theme.ts darkTheme:
  // clawd_background, userMessageBackground, claude (brand orange).
  expect(claudeCodeDarkTheme.vars.bgPrimary).toBe("#000000");
  expect(claudeCodeDarkTheme.vars.bgSecondary).toBe("#373737");
  expect(claudeCodeDarkTheme.vars.claudeAccent).toBe("#d77757");
  expect(claudeCodeDarkTheme.colors.accent).toBe("claudeAccent");
  expect(claudeCodeDarkTheme.colors.border).toBe("border");
  expect(claudeCodeDarkTheme.colors.text).toBe("textPrimary");
  expect(claudeCodeDarkTheme.colors.success).toBe("success");
  expect(claudeCodeDarkTheme.colors.error).toBe("error");
  expect(claudeCodeDarkTheme.colors.warning).toBe("warning");
  expect(claudeCodeDarkTheme.colors.bashMode).toBe("bashBorder");
  // Syntax highlighting is Monokai Extended (measured from
  // ~/claude-code/packages/color-diff-napi MONOKAI_SCOPES).
  expect(claudeCodeDarkTheme.vars.syntaxKeyword).toBe("#f92672");
  expect(claudeCodeDarkTheme.vars.syntaxComment).toBe("#75715e");
  // Markdown heading/link match Claude Code: bold/plain text, no extra tint.
  expect(claudeCodeDarkTheme.colors.mdHeading).toBe("textPrimary");
  expect(claudeCodeDarkTheme.colors.mdLink).toBe("textPrimary");
  // Inline code spans use the permission blue-purple, like Claude Code.
  expect(claudeCodeDarkTheme.colors.mdCode).toBe("permission");
  // Editor border is a fixed gray regardless of thinking level (user request:
  // input box uses #808080 at every thinking depth).
  expect(claudeCodeDarkTheme.vars.thinkingBorder).toBe("#808080");
  expect(claudeCodeDarkTheme.colors.thinkingOff).toBe("thinkingBorder");
  expect(claudeCodeDarkTheme.colors.thinkingHigh).toBe("thinkingBorder");
  expect(claudeCodeDarkTheme.colors.thinkingMax).toBe("thinkingBorder");
  // Diff context and code blocks stay quiet so the accent only marks action.
  expect(claudeCodeDarkTheme.colors.toolDiffContext).toBe("textMuted");
  expect(claudeCodeDarkTheme.colors.mdCodeBlock).toBe("syntaxText");
  // Diff word colors match the official darkTheme diffAddedWord/RemovedWord.
  expect(claudeCodeDarkTheme.vars.diffInsertedWord).toBe("#38a660");
  expect(claudeCodeDarkTheme.vars.diffDeletedWord).toBe("#b3596b");
});

function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    model: { id: "claude-sonnet-4.5" },
    getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 200000 }),
    ...overrides,
  } as any;
}

test("renderClaudeLikeFooterLine includes pico, statuses, context bar, model, and branch", () => {
  const line = renderClaudeLikeFooterLine(120, fakeCtx({
    getContextUsage: () => ({ tokens: 19000, percent: 9.5, contextWindow: 200000 }),
    cwd: "/home/david/pico",
  }), plainTheme as any, {
    getGitBranch: () => "main",
    getExtensionStatuses: () => ["MCP: 1 connected", "LSP: typescript-language-server"],
  }, { staged: 2, unstaged: 1, untracked: 3 }, { getThinkingLevel: () => "medium" });

  expect(line).toContain("dir pico");
  expect(line).toContain("think:med");
  expect(line).toContain("MCP 1 ok");
  expect(line).toContain("LSP: typescript");
  expect(line).toContain("◫ 19k/200k (9.5%)");
  expect(line).not.toContain("↑");
  expect(line).not.toContain("$");
  expect(line).toContain("claude-sonnet-4.5");
  expect(line).toContain("⎇ main *1 +2 ?3");
  expect(line).not.toContain("");
  expect(line).not.toContain("");
});

test("renderPrimaryStatusLine matches the editor-above status direction", () => {
  const line = renderPrimaryStatusLine(120, fakeCtx({
    model: { id: "deepseek-v4-flash-free" },
    getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 200000 }),
    cwd: "/home/david/pico",
  }), plainTheme as any, {
    branch: "ccg",
    staged: 1,
    unstaged: 2,
    untracked: 2,
  }, { getThinkingLevel: () => "medium" });

  expect(line).toContain("deepseek-v4-flash-free");
  expect(line).toContain("think:med");
  expect(line).toContain("dir pico");
  expect(line).toContain("⎇ ccg *2 +1 ?2");
  expect(line).toContain("◫ 0/200k (0.0%) AC");
});

test("renderExtensionStatusLine keeps footer extension statuses focused", () => {
  const line = renderExtensionStatusLine(120, plainTheme as any, {
    getExtensionStatuses: () => [
      "DS cache 21/22",
      "0.73M/0.80M tok (92%) ⚠️ compat",
      "LSP: typescript-language-server",
    ],
  });

  expect(line).toContain("LSP: typescript");
  expect(line).toContain("DS cache 21/22");
});

test("renderClaudeLikeFooterLine shows placeholders when usage is unavailable", () => {
  const line = renderClaudeLikeFooterLine(100, fakeCtx({
    getContextUsage: () => ({ percent: null, contextWindow: 200000 }),
  }), plainTheme as any, {
    getGitBranch: () => "main",
    getExtensionStatuses: () => [],
  });

  // tokens/percent null means the usage is unknown (e.g. right after
  // compaction) — render "?" instead of pretending it is zero.
  expect(line).toContain("◫ ?/200k (?%)");
});

test("renderClaudeLikeFooterLine shows ? for explicit null tokens and percent", () => {
  const line = renderClaudeLikeFooterLine(100, fakeCtx({
    getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 200000 }),
  }), plainTheme as any, {
    getGitBranch: () => "main",
    getExtensionStatuses: () => [],
  });

  expect(line).toContain("◫ ?/200k (?%)");
  expect(line).not.toContain("0/200k");
});

test("renderClaudeLikeFooterLine keeps narrow output within width", () => {
  const line = renderClaudeLikeFooterLine(42, fakeCtx(), plainTheme as any, {
    getGitBranch: () => "feature/compact-footer",
    getExtensionStatuses: () => ["todos 1/3 F7", "LSP: ts ready"],
  });

  expect(visibleWidth(line)).toBeLessThanOrEqual(42);
  expect(line).toContain("pico");
});

test("renderClaudeLikeFooterLine accepts non-array extension statuses", () => {
  const objectLine = renderClaudeLikeFooterLine(100, fakeCtx(), plainTheme as any, {
    getGitBranch: () => "main",
    getExtensionStatuses: () => ({ todo: "todos 1/3 F7", lsp: "LSP: ts ready" }),
  });
  const mapLine = renderClaudeLikeFooterLine(100, fakeCtx(), plainTheme as any, {
    getGitBranch: () => "main",
    getExtensionStatuses: () => new Map([["todo", "todos 1/3 F7"]]),
  });

  expect(objectLine).toContain("todo 1/3 F7");
  expect(objectLine).toContain("LSP: ts ready");
  expect(mapLine).toContain("todo 1/3 F7");
});

test("footer git helpers parse and format dirty status", () => {
  expect(__test.parseGitStatus("M  a.ts\n M b.ts\n?? c.ts\nA  d.ts\n")).toEqual({
    staged: 2,
    unstaged: 1,
    untracked: 1,
  });
  expect(__test.formatGit("main", { staged: 1, unstaged: 2, untracked: 3 })).toBe("⎇ main *2 +1 ?3");
  expect(__test.formatGit("main", { staged: 0, unstaged: 0, untracked: 0 })).toBe("⎇ main");
  expect(__test.parseGitStatus("## ccg...origin/ccg\nM  a.ts\n M b.ts\n?? c.ts\n")).toEqual({
    branch: "ccg",
    staged: 1,
    unstaged: 1,
    untracked: 1,
  });
  expect(__test.compactStatus("LSP: typescript-language-server")).toBe("LSP: typescript");
  expect(__test.compactStatus("MCP: 1 connected")).toBe("MCP 1 ok");
  expect(__test.compactStatus("MCP: 2 ok, 1 failed")).toBe("MCP 2 ok 1 failed");
  expect(__test.compactThinkingLevel("medium")).toBe("think:med");
});

test("createClaudeLikeFooter subscribes to branch changes and renders one line", () => {
  __resetFooterStateForTests();
  let branchHandler: (() => void) | undefined;
  let renderRequested = false;
  const footer = createClaudeLikeFooter(fakeCtx())(
    { requestRender: () => { renderRequested = true; } },
    plainTheme as any,
    {
      getGitBranch: () => "main",
      getExtensionStatuses: () => [],
      onBranchChange: (handler) => {
        branchHandler = handler;
        return () => { };
      },
    },
  );

  expect(footer.render(80)).toHaveLength(1);
  branchHandler?.();
  expect(renderRequested).toBe(true);
});

test("onBranchChange drops the cached and pending git status for the cwd", () => {
  __resetFooterStateForTests();
  let branchHandler: (() => void) | undefined;
  const cwd = "/tmp/fake-project";
  __test.cachedGitStatusByCwd.set(cwd, {
    branch: "stale",
    staged: 0,
    unstaged: 0,
    untracked: 0,
    timestamp: Date.now(),
    failed: false,
  });
  __test.pendingGitStatusByCwd.set(cwd, Promise.resolve());

  const footer = createClaudeLikeFooter(fakeCtx({ cwd }))(
    { requestRender: () => {} },
    plainTheme as any,
    {
      getGitBranch: () => "main",
      getExtensionStatuses: () => [],
      onBranchChange: (handler) => {
        branchHandler = handler;
        return () => {};
      },
    },
  );
  expect(footer.render(80)).toHaveLength(1);

  expect(__test.cachedGitStatusByCwd.has(cwd)).toBe(true);
  expect(__test.pendingGitStatusByCwd.has(cwd)).toBe(true);
  branchHandler?.();
  expect(__test.cachedGitStatusByCwd.has(cwd)).toBe(false);
  expect(__test.pendingGitStatusByCwd.has(cwd)).toBe(false);
});

test("branch change invalidates the cached git status so the next render refetches", async () => {
  __resetFooterStateForTests();
  const dir = mkdtempSync(join(tmpdir(), "pico-footer-"));
  try {
    const git = (args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: dir });
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
    };
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    writeFileSync(join(dir, "a.txt"), "x");
    git(["add", "."]);
    git(["commit", "-qm", "init"]);

    const ctx = fakeCtx({ cwd: dir });
    const widget = createPrimaryStatusWidget(ctx)(
      { requestRender: () => {} },
      plainTheme as any,
      {} as any,
    );

    widget.render(120);
    await __test.pendingGitStatusByCwd.get(dir);
    expect(__test.cachedGitStatusByCwd.get(dir)?.branch).toBe("main");

    // External checkout — pi never sees it, so the footer's onBranchChange
    // callback is the only signal. It must drop the stale cache entry.
    git(["switch", "-q", "-c", "feature"]);
    let branchHandler: (() => void) | undefined;
    createClaudeLikeFooter(ctx)({ requestRender: () => {} }, plainTheme as any, {
      getGitBranch: () => undefined,
      getExtensionStatuses: () => [],
      onBranchChange: (handler) => {
        branchHandler = handler;
        return () => {};
      },
    });
    branchHandler?.();
    expect(__test.cachedGitStatusByCwd.has(dir)).toBe(false);

    // Next render refetches and sees the new branch.
    widget.render(120);
    await __test.pendingGitStatusByCwd.get(dir);
    expect(__test.cachedGitStatusByCwd.get(dir)?.branch).toBe("feature");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    __resetFooterStateForTests();
  }
});

test("retroThemeExtension installs theme, working indicator, and footer", async () => {
  // Isolate from the real ~/.pico: a user-configured theme in settings.json
  // must be respected (2.1.1) — the test pins the "no user theme" case.
  const home = mkdtempSync(join(tmpdir(), "pico-theme-"));
  const prevHome = process.env.PICO_HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PICO_HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    let handler: any;
  const fakePi = {
    on: (event: string, h: any) => {
      if (event === "session_start") handler = h;
    },
  };
  const calls: string[] = [];
  const fakeUi = {
    theme: plainTheme,
    setTheme: (name: string) => {
      calls.push(`theme:${name}`);
      return { success: true };
    },
    setWorkingIndicator: () => {
      calls.push("indicator");
    },
    setFooter: (factory: unknown) => {
      calls.push(typeof factory === "function" ? "footer" : "footer:clear");
    },
    setWidget: (key: string) => {
      calls.push(`widget:${key}`);
    },
  };

  retroThemeExtension(fakePi as any);
  await handler({ type: "session_start", reason: "startup" }, {
    ui: fakeUi,
    model: { id: "claude-sonnet-4.5" },
    getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 200000 }),
  });

  expect(calls).toEqual(["theme:claude-code-dark", "indicator", "widget:pico-primary-status", "footer"]);
  } finally {
    if (prevHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = prevHome;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(home, { recursive: true, force: true });
  }
});

test("retroThemeExtension does not override a user-configured theme (2.1.1)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pico-theme-"));
  const prevHome = process.env.PICO_HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PICO_HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "carbon" }), "utf-8");
    let handler: any;
    const fakePi = {
      on: (event: string, h: any) => {
        if (event === "session_start") handler = h;
      },
    };
    const calls: string[] = [];
    retroThemeExtension(fakePi as any);
    await handler({ type: "session_start", reason: "startup" }, {
      ui: {
        theme: plainTheme,
        setTheme: (name: string) => {
          calls.push(`theme:${name}`);
          return { success: true };
        },
        setWorkingIndicator: () => {},
        setFooter: () => {},
        setWidget: () => {},
      },
      model: { id: "claude-sonnet-4.5" },
      getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 200000 }),
    });
    expect(calls).not.toContain("theme:claude-code-dark");
  } finally {
    if (prevHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = prevHome;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(home, { recursive: true, force: true });
  }
});

test("narrow footer drops trailing segments instead of hard-truncating them", () => {
  const ctx = fakeCtx({
    model: { id: "deepseek-v4-flash" },
    getContextUsage: () => ({ tokens: 21000, percent: 10.5, contextWindow: 200000 }),
    cwd: "/home/david/pico",
  });
  const git = { branch: "feature/long-branch-name", staged: 1, unstaged: 2, untracked: 3 };
  const footerData = {
    getGitBranch: () => "feature/long-branch-name",
    getExtensionStatuses: () => ["MCP: 1 connected"],
  };
  const options = { getThinkingLevel: () => "max" };

  // At 60 columns the git details and context usage may be dropped, but the
  // leading segments (model, thinking, dir) must stay intact — no mid-string
  // truncation of the model name.
  const line60 = renderClaudeLikeFooterLine(60, ctx, plainTheme as any, footerData, git, options);
  expect(visibleWidth(line60)).toBeLessThanOrEqual(60);
  expect(line60).toContain("deepseek-v4-flash");
  expect(line60).toContain("think:max");

  // At 32 columns the primary line keeps only what fits, still starting with
  // the model and never exceeding the width.
  const line32 = renderPrimaryStatusLine(32, ctx, plainTheme as any, git, options);
  expect(visibleWidth(line32)).toBeLessThanOrEqual(32);
  expect(line32).toContain("deepseek-v4-flash");

  // At 15 columns even the model itself must truncate with an ellipsis.
  const line15 = renderPrimaryStatusLine(15, ctx, plainTheme as any, git, options);
  expect(visibleWidth(line15)).toBeLessThanOrEqual(15);
  expect(line15).toContain("...");
});

test("retroThemeExtension notifies and marks footer on failed turns", async () => {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const fakePi = {
    on: (event: string, h: (event: any, ctx: any) => void) => handlers.set(event, h),
  };
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const fakeUi = {
    theme: plainTheme,
    notify: (message: string, type?: string) => notifications.push({ message, type }),
    setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
  };

  retroThemeExtension(fakePi as any);

  await handlers.get("turn_start")!({}, { ui: fakeUi });
  expect(statuses).toEqual([["pico.lastError", undefined]]);
  statuses.length = 0;

  await handlers.get("turn_end")!(
    {
      type: "turn_end",
      turnIndex: 0,
      message: { role: "assistant", stopReason: "error", errorMessage: 'Error: 400: {"message":"Upstream failed"}' },
      toolResults: [],
    },
    { ui: fakeUi },
  );
  expect(notifications).toHaveLength(1);
  expect(notifications[0]!.type).toBe("error");
  expect(notifications[0]!.message).toContain("Upstream failed");
  expect(statuses).toEqual([["pico.lastError", "!failed"]]);
});

test("retroThemeExtension ignores non-error turns", async () => {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const fakePi = {
    on: (event: string, h: (event: any, ctx: any) => void) => handlers.set(event, h),
  };
  const notifications: Array<{ message: string; type?: string }> = [];
  retroThemeExtension(fakePi as any);

  await handlers.get("turn_end")!(
    { type: "turn_end", turnIndex: 0, message: { role: "assistant", stopReason: "end_turn" }, toolResults: [] },
    { ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) } },
  );
  await handlers.get("turn_end")!(
    { type: "turn_end", turnIndex: 1, message: { role: "assistant", stopReason: "error" }, toolResults: [] },
    { ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) } },
  );
  expect(notifications).toHaveLength(0);
});
