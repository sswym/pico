import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createClaudeLikeFooter,
  renderClaudeLikeFooterLine,
} from "../src/extensions/retro-theme/footer.ts";
import { retroThemeExtension } from "../src/extensions/retro-theme/index.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    model: { id: "claude-sonnet-4.5" },
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: 1234,
              output: 567,
              cost: { total: 0.042 },
            },
          },
        },
      ],
    },
    ...overrides,
  } as any;
}

test("renderClaudeLikeFooterLine includes srcode, statuses, usage, model, and branch", () => {
  const line = renderClaudeLikeFooterLine(120, fakeCtx(), plainTheme as any, {
    getGitBranch: () => "main",
    getExtensionStatuses: () => ["todos 1/3 F7", "LSP: ts ready"],
  });

  expect(line).toContain("srcode");
  expect(line).toContain("todos 1/3 F7");
  expect(line).toContain("LSP: ts ready");
  expect(line).toContain("↑1.2k ↓567");
  expect(line).toContain("$0.042");
  expect(line).toContain("claude-sonnet-4.5");
  expect(line).toContain("git:main");
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
    sessionManager: { getBranch: () => [] },
  });

  expect(calls).toEqual(["theme:retro-terminal", "indicator", "footer"]);
});
