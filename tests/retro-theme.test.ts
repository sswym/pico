import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  __resetFooterStateForTests,
  __test,
  createClaudeLikeFooter,
  renderExtensionStatusLine,
  renderClaudeLikeFooterLine,
  renderPrimaryStatusLine,
} from "../src/extensions/retro-theme/footer.ts";
import { retroThemeExtension } from "../src/extensions/retro-theme/index.ts";
import retroTheme from "../src/theme/retro-terminal.json" with { type: "json" };

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("retro theme uses powerline-footer inspired color scheme", () => {
  expect(retroTheme.vars.pink).toBe("#d787af");
  expect(retroTheme.vars.amber).toBe("#febc38");
  expect(retroTheme.vars.teal).toBe("#00afaf");
  expect(retroTheme.colors.borderMuted).toBe("warmMuted");
  expect(retroTheme.colors.thinkingOff).toBe("inputGray");
  expect(retroTheme.colors.thinkingMinimal).toBe("inputGray");
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
  expect(line).toContain("MCP 1");
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

test("renderClaudeLikeFooterLine shows an empty context bar when usage is unavailable", () => {
  const line = renderClaudeLikeFooterLine(100, fakeCtx({
    getContextUsage: () => ({ percent: null, contextWindow: 200000 }),
  }), plainTheme as any, {
    getGitBranch: () => "main",
    getExtensionStatuses: () => [],
  });

  expect(line).toContain("◫ 0/200k (0.0%)");
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
  expect(__test.compactStatus("MCP: 1 connected")).toBe("MCP 1");
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

  expect(calls).toEqual(["theme:retro-terminal", "indicator", "widget:pico-primary-status", "footer"]);
});
