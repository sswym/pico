/**
 * Tests for the smart /init extension.
 *
 * The extension injects a generate-prompt or audit-prompt depending on
 * whether AGENTS.md already exists in the project root.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initExtension } from "../src/extensions/init/index.ts";
import GENERATE_PROMPT from "../src/extensions/init/prompt.md" with { type: "text" };

// ---------------------------------------------------------------------------
// Prompt content tests
// ---------------------------------------------------------------------------

test("prompt.md centres on AGENTS.md and never recommends CLAUDE.md", () => {
  const agentsMdHits = (GENERATE_PROMPT.match(/AGENTS\.md/g) ?? []).length;
  expect(agentsMdHits).toBeGreaterThanOrEqual(3);

  // CLAUDE.md appears only in the scan checklist (existing .../CLAUDE.md)
  // and the forbid directive (绝不用 CLAUDE.md) — both legitimate.
  const claudeMdHits = (GENERATE_PROMPT.match(/CLAUDE\.md/g) ?? []).length;
  expect(claudeMdHits).toBeLessThanOrEqual(2);

  // Must explicitly forbid CLAUDE.md.
  expect(GENERATE_PROMPT).toMatch(/绝不用|never|禁止|don.*t.*CLAUDE/i);
});

test("prompt.md contains structure, directives, and output sections", () => {
  expect(GENERATE_PROMPT).toContain("<structure>");
  expect(GENERATE_PROMPT).toContain("<directives>");
  expect(GENERATE_PROMPT).toContain("<output>");
});

test("prompt.md references parallel scanning", () => {
  expect(GENERATE_PROMPT).toMatch(/并行|parallel/i);
});

test("prompt.md does not contain YAML frontmatter", () => {
  // The file was moved out of src/prompts/ and the frontmatter stripped
  // since it's now injected as a user message, not a prompt template.
  expect(GENERATE_PROMPT).not.toMatch(/^---\n/);
});

// ---------------------------------------------------------------------------
// Extension wiring tests
// ---------------------------------------------------------------------------

test("initExtension registers exactly the /init command", async () => {
  const commands: string[] = [];
  const fakePi: any = {
    on: () => {},
    registerTool: () => {},
    registerCommand: (n: string) => commands.push(n),
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  await initExtension(fakePi);
  expect(commands).toEqual(["init"]);
});

/**
 * Helper: create a minimal fake Pi with stored handler + sendUserMessage spy.
 */
function createFakePi() {
  let registeredHandler: ((args: string, ctx: any) => Promise<void>) | null = null;
  let lastMessage: unknown = null;

  const fakePi: any = {
    registerCommand: (_n: string, opts: any) => {
      registeredHandler = opts.handler;
    },
    sendUserMessage: (content: unknown) => {
      lastMessage = content;
    },
    on: () => {},
    registerTool: () => {},
    sendMessage: () => {},
  };

  return {
    fakePi,
    getHandler: () => registeredHandler!,
    getLastMessage: () => lastMessage,
  };
}

test("/init handler sends GENERATE_PROMPT when AGENTS.md does not exist", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "srcode-init-test-"));
  const { fakePi, getHandler, getLastMessage } = createFakePi();

  await initExtension(fakePi);
  await getHandler()("", { cwd: tmpDir });

  expect(getLastMessage()).toBe(GENERATE_PROMPT);

  rmSync(tmpDir, { recursive: true, force: true });
});

test("/init handler sends audit instructions when AGENTS.md exists", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "srcode-init-test-"));
  writeFileSync(join(tmpDir, "AGENTS.md"), "# Existing AGENTS.md\n\nSome content");
  const { fakePi, getHandler, getLastMessage } = createFakePi();

  await initExtension(fakePi);
  await getHandler()("", { cwd: tmpDir });

  // Should NOT be the generate prompt
  expect(getLastMessage()).not.toBe(GENERATE_PROMPT);
  // Should contain audit instructions
  expect(typeof getLastMessage()).toBe("string");
  expect((getLastMessage() as string)).toMatch(/AGENTS.md 已存在|审计/);

  rmSync(tmpDir, { recursive: true, force: true });
});
