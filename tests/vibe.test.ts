import { expect, test } from "bun:test";
import vibeGuide from "../src/prompts/vibe-system.md" with { type: "text" };
import { vibeExtension } from "../src/extensions/vibe.ts";

test("vibe guide contains delivery-evidence contract and critical block", () => {
  expect(vibeGuide).toContain("## 交付证据与硬约束");
  expect(vibeGuide).toContain("`[INFERENCE]`");
  expect(vibeGuide).toContain("<critical>");
  expect(vibeGuide).toContain("</critical>");
  // critical block is the final section of the appended guide (position matters:
  // oh-my-pi puts its <critical> block at the very end of the system prompt).
  expect(vibeGuide.trimEnd().endsWith("</critical>")).toBe(true);
});

test("vibe extension appends the guide to the base system prompt", () => {
  type VibeHandler = (event: { systemPrompt: string }) => { systemPrompt: string };
  const handlers: Record<string, VibeHandler[]> = {};
  const pi = {
    on: (event: string, handler: VibeHandler) => {
      (handlers[event] ??= []).push(handler);
    },
  };
  vibeExtension(pi as any);

  const handler = handlers["before_agent_start"]?.[0];
  if (!handler) throw new Error("before_agent_start handler not registered");
  const result = handler({ systemPrompt: "base" });
  expect(result.systemPrompt.startsWith("base")).toBe(true);
  expect(result.systemPrompt).toContain("vibe coding");
  expect(result.systemPrompt).toContain("<critical>");
});
