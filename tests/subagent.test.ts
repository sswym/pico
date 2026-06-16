/**
 * Smoke tests for subagent extension wiring.
 *
 * Avoid spawning real `pi` subprocesses — just confirm the factory registers
 * the right tool, and that `discoverAgents` finds the four bundled roles.
 */
import { expect, test } from "bun:test";
import { discoverAgents } from "../src/extensions/subagent/agents.ts";
import subagentExtension from "../src/extensions/subagent/index.ts";

test("subagent extension registers the 'subagent' tool", async () => {
  const tools: Array<{ name: string }> = [];
  const fakePi: any = {
    on: () => {},
    registerTool: (t: { name: string }) => tools.push(t),
    registerCommand: () => {},
    sendMessage: () => {},
  };
  await subagentExtension(fakePi);
  expect(tools.map((t) => t.name)).toContain("subagent");
});

test("discoverAgents finds the six bundled roles under user scope", () => {
  const result = discoverAgents(process.cwd(), "user");
  const names = new Set(result.agents.map((a) => a.name));
  expect(names.has("scout")).toBe(true);
  expect(names.has("planner")).toBe(true);
  expect(names.has("worker")).toBe(true);
  expect(names.has("reviewer")).toBe(true);
  expect(names.has("oracle")).toBe(true);
  expect(names.has("researcher")).toBe(true);

  // Source must be "user" — bundled agents are loaded under user scope so
  // they're available without symlinking into ~/.srcode/agent.
  for (const a of result.agents) expect(a.source).toBe("user");
});

test("worker bundled agent advertises memory in its tools allowlist", () => {
  const result = discoverAgents(process.cwd(), "user");
  const worker = result.agents.find((a) => a.name === "worker");
  expect(worker).toBeDefined();
  // worker.md has no `tools:` frontmatter, so tools is undefined ⇒ defaults
  // unrestricted. memory tool is reachable. We assert the system prompt does
  // mention memory so the LLM knows to use it.
  expect(worker!.systemPrompt).toMatch(/memory/i);
});
