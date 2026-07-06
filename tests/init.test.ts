/**
 * Tests for the /init extension with the redesigned markdown prompt.
 *
 * The prompt.md is a concise markdown file with frontmatter that replaces
 * the old verbose prompt.ts. These tests verify:
 *   - Frontmatter parsing (name, description, thinking-level)
 *   - Content guarantees (AGENTS.md focus, no CLAUDE.md recommendation)
 *   - Command-registration wiring
 */
import { expect, test } from "bun:test";
import { initExtension } from "../src/extensions/init/index.ts";

// Bun imports markdown with { type: "text" } as a plain string
import PROMPT_MD from "../src/prompts/init.md" with { type: "text" };

/**
 * Minimal frontmatter parser for testing purposes.
 */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const fm: Record<string, unknown> = {};
  for (const line of match[1]!.split("\n")) {
    const sep = line.indexOf(": ");
    if (sep > 0) {
      const key = line.slice(0, sep).trim();
      const value: unknown = line.slice(sep + 2).trim();
      fm[key] = value;
    }
  }
  return fm;
}

// ---------------------------------------------------------------------------
// Frontmatter tests
// ---------------------------------------------------------------------------

test("prompt.md has valid frontmatter with name and description", () => {
  const fm = parseFrontmatter(PROMPT_MD);
  expect(fm).not.toBeNull();
  expect(fm!.name).toBe("init");
  expect(typeof fm!.description).toBe("string");
  expect((fm!.description as string).length).toBeGreaterThan(0);
});

test("prompt.md has thinking-level medium", () => {
  const fm = parseFrontmatter(PROMPT_MD);
  expect(fm).not.toBeNull();
  expect(fm!["thinking-level"]).toBe("medium");
});

// ---------------------------------------------------------------------------
// Content guarantee tests
// ---------------------------------------------------------------------------

test("prompt.md centres on AGENTS.md and never recommends CLAUDE.md", () => {
  const agentsMdHits = (PROMPT_MD.match(/AGENTS\.md/g) ?? []).length;
  expect(agentsMdHits).toBeGreaterThanOrEqual(3);

  // CLAUDE.md appears in the scan checklist (existing AGENTS.md/CLAUDE.md)
  // and the forbid directive (绝不用 CLAUDE.md) — both legitimate.
  const claudeMdHits = (PROMPT_MD.match(/CLAUDE\.md/g) ?? []).length;
  expect(claudeMdHits).toBeLessThanOrEqual(2);

  // Must explicitly forbid CLAUDE.md.
  expect(PROMPT_MD).toMatch(/绝不用|never|禁止|don.*t.*CLAUDE/i);
});

test("prompt.md contains structure, directives, and output sections", () => {
  expect(PROMPT_MD).toContain("<structure>");
  expect(PROMPT_MD).toContain("<directives>");
  expect(PROMPT_MD).toContain("<output>");
});

test("prompt.md references parallel scanning", () => {
  expect(PROMPT_MD).toMatch(/并行|parallel/i);
});

test("prompt.md does not use askUserQuestion (automatic mode)", () => {
  // The minimalist oh-my-pi style prompt does not interactively ask the user.
  expect(PROMPT_MD).not.toMatch(/askUserQuestion|askUser/i);
});

// ---------------------------------------------------------------------------
// Extension wiring tests
// ---------------------------------------------------------------------------

test("initExtension registers exactly the /init command", async () => {
  const tools: Array<{ name: string }> = [];
  const commands: string[] = [];
  const events: string[] = [];
  const fakePi: any = {
    on: (n: string) => events.push(n),
    registerTool: (t: { name: string }) => tools.push(t),
    registerCommand: (n: string) => commands.push(n),
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  await initExtension(fakePi);
  expect(tools).toEqual([]);
  expect(commands).toEqual(["init"]);
  expect(events).toEqual([]);
});

test("/init handler enqueues the prompt as a user message", async () => {
  let lastUserMessage: unknown = null;
  let registered: any = null;
  const fakePi: any = {
    on: () => {},
    registerTool: () => {},
    registerCommand: (_n: string, opts: any) => {
      registered = opts;
    },
    sendMessage: () => {},
    sendUserMessage: (content: unknown) => {
      lastUserMessage = content;
    },
  };
  await initExtension(fakePi);
  await registered.handler("");
  expect(lastUserMessage).toBe(PROMPT_MD);
});
