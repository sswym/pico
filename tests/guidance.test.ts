import { expect, test } from "bun:test";
import { buildHelpText, guidanceExtension } from "../src/extensions/guidance/index.ts";

function makeFakePi() {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
  const sent: Array<{ customType: string; content: string }> = [];
  const pi = {
    registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => {
      commands.set(name, opts);
    },
    sendMessage: (message: { customType: string; content: string }) => {
      sent.push(message);
    },
  };
  return { pi: pi as any, commands, sent };
}

test("/help command is registered and renders offline command list", async () => {
  const { pi, commands, sent } = makeFakePi();
  guidanceExtension(pi);

  const help = commands.get("help");
  expect(help).toBeDefined();
  await help!.handler("", {});

  expect(sent.length).toBe(1);
  expect(sent[0]!.customType).toBe("pico.help");
  expect(sent[0]!.content).toContain("/doctor");
  expect(sent[0]!.content).toContain("/memory");
  expect(sent[0]!.content).toContain("F7");
  expect(buildHelpText()).toContain("/help");
});

test("guidance extension registers help and commands aliases", () => {
  const { pi, commands } = makeFakePi();
  guidanceExtension(pi);
  expect(commands.has("help")).toBe(true);
  expect(commands.has("commands")).toBe(true);
});
