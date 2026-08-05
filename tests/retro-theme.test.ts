import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  expect(claudeCodeDarkTheme.vars.bgPrimary).toBe("#151413");
  expect(claudeCodeDarkTheme.vars.bgSecondary).toBe("#1d1b19");
  expect(claudeCodeDarkTheme.vars.claudeAccent).toBe("#d19a66");
  expect(claudeCodeDarkTheme.colors.accent).toBe("claudeAccent");
  expect(claudeCodeDarkTheme.colors.border).toBe("border");
  expect(claudeCodeDarkTheme.colors.text).toBe("textPrimary");
  expect(claudeCodeDarkTheme.colors.success).toBe("success");
  expect(claudeCodeDarkTheme.colors.error).toBe("error");
  expect(claudeCodeDarkTheme.colors.warning).toBe("warning");
  expect(claudeCodeDarkTheme.colors.bashMode).toBe("claudeAccent");
  expect(claudeCodeDarkTheme.colors.thinkingMax).toBe("claudeAccentHover");
  // Diff context and code blocks stay quiet so the accent only marks action.
  expect(claudeCodeDarkTheme.colors.toolDiffContext).toBe("textMuted");
  expect(claudeCodeDarkTheme.colors.mdCodeBlock).toBe("syntaxText");
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
});
