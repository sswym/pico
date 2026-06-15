/**
 * Smoke tests for the /init extension.
 *
 * The interactive multi-phase logic runs inside the LLM, so unit-testable
 * surface is small: the prompt's content guarantees and the command-
 * registration wiring.
 */
import { expect, test } from "bun:test";
import { initExtension } from "../src/extensions/init/index.ts";
import { INIT_PROMPT } from "../src/extensions/init/prompt.ts";

test("INIT_PROMPT centres on AGENTS.md and never recommends CLAUDE.md", () => {
  // The prompt should reference AGENTS.md repeatedly across phases.
  const agentsMdHits = (INIT_PROMPT.match(/AGENTS\.md/g) ?? []).length;
  expect(agentsMdHits).toBeGreaterThanOrEqual(3);

  // CLAUDE.md may appear up to 3 times in the prompt body:
  //   1) Phase 2 sweep checklist (so scouts notice an existing CLAUDE.md
  //      authored before the user moved to AGENTS.md)
  //   2-3) the explicit forbid-rule at the bottom (mentions CLAUDE.md twice
  //      in one sentence: "uses AGENTS.md, never CLAUDE.md. Do NOT write a
  //      CLAUDE.md file …")
  const claudeMdHits = (INIT_PROMPT.match(/CLAUDE\.md/g) ?? []).length;
  expect(claudeMdHits).toBeLessThanOrEqual(3);

  // We must instruct the model to use srcode's lower-camel tool name.
  expect(INIT_PROMPT).toContain("askUserQuestion");

  // .claude/rules/ should not leak through — we use .srcode/.
  expect(INIT_PROMPT).not.toContain(".claude/rules");

  // skills go under .srcode/skills/, not .claude/skills/
  expect(INIT_PROMPT).toContain(".srcode/skills");
  expect(INIT_PROMPT).not.toContain(".claude/skills");
});

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
  expect(lastUserMessage).toBe(INIT_PROMPT);
});
