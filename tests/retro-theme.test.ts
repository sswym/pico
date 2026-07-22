import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createClaudeLikeFooter,
  renderClaudeLikeFooterLine,
} from "../src/extensions/retro-theme/footer.ts";
import { retroThemeExtension } from "../src/extensions/retro-theme/index.ts";
import retroTheme from "../src/theme/retro-terminal.json" with { type: "json" };

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("retro theme uses white-gray editor borders", () => {
  expect(retroTheme.vars.inputGray).toBe("#d6d3cc");
  expect(retroTheme.colors.borderMuted).toBe("inputGray");
  expect(retroTheme.colors.thinkingOff).toBe("inputGray");
  expect(retroTheme.colors.thinkingMinimal).toBe("inputGray");
});

function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    model: { id: "claude-sonnet-4.5" },
    getContextUsage: () => ({ percent: 0, contextWindow: 200000 }),
    ...overrides,
  } as any;
}

test("renderClaudeLikeFooterLine includes srcode, statuses, context bar, model, and branch", () => {
  const line = renderClaudeLikeFooterLine(120, fakeCtx({
    getContextUsage: () => ({ percent: 50, contextWindow: 200000 }),
  }), plainTheme as any, {
    getGitBranch: () => "main",
    getExtensionStatuses: () => ["todos 1/3 F7", "LSP: ts ready"],
  });

  expect(line).toContain("srcode");
  expect(line).toContain("todos 1/3 F7");
  expect(line).toContain("LSP: ts ready");
  expect(line).toContain("████████░░░░░░░░ 50% ctx");
  expect(line).not.toContain("↑");
  expect(line).not.toContain("$");
  expect(line).toContain("claude-sonnet-4.5");
  expect(line).toContain("git:main");
});

test("renderClaudeLikeFooterLine shows an empty context bar when usage is unavailable", () => {
  const line = renderClaudeLikeFooterLine(100, fakeCtx({
    getContextUsage: () => ({ percent: null, contextWindow: 200000 }),
  }), plainTheme as any, {
    getGitBranch: () => "main",
    getExtensionStatuses: () => [],
  });

  expect(line).toContain("░░░░░░░░░░░░░░░░ 0% ctx");
});

test("renderClaudeLikeFooterLine keeps narrow output within width", () => {
  const line = renderClaudeLikeFooterLine(42, fakeCtx(), plainTheme as any, {
    getGitBranch: () => "feature/compact-footer",
    getExtensionStatuses: () => ["todos 1/3 F7", "LSP: ts ready"],
  });

  expect(visibleWidth(line)).toBeLessThanOrEqual(42);
  expect(line).toContain("srcode");
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

  expect(objectLine).toContain("todos 1/3 F7");
  expect(objectLine).toContain("LSP: ts ready");
  expect(mapLine).toContain("todos 1/3 F7");
});

test("createClaudeLikeFooter subscribes to branch changes and renders one line", () => {
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
        return () => {};
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
  };

  retroThemeExtension(fakePi as any);
  await handler({ type: "session_start", reason: "startup" }, {
    ui: fakeUi,
    model: { id: "claude-sonnet-4.5" },
    getContextUsage: () => ({ percent: 0, contextWindow: 200000 }),
  });

  expect(calls).toEqual(["theme:retro-terminal", "indicator", "footer"]);
});
