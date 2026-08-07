/**
 * Help extension tests: offline /help command registration and the
 * unknown-slash-command context guard.
 */
import { expect, test } from "bun:test";
import {
  BUILTIN_COMMANDS,
  buildHelpText,
  buildUnknownCommandGuidance,
  helpExtension,
  KEYBOARD_SHORTCUTS,
} from "../src/extensions/help/index.ts";

function makeFakePi() {
  const commands = new Map<string, any>();
  const messages: any[] = [];
  const handlers: Record<string, Array<(event: any, ctx?: any) => any>> = {};
  const extCommands = [
    { name: "doctor", description: "Show pico safety switches and capability boundaries" },
    { name: "memory", description: "Long-term memory read/write" },
  ];
  const fakePi = {
    commands,
    messages,
    handlers,
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    sendMessage: (message: any) => messages.push(message),
    getCommands: () => extCommands,
    on: (event: string, handler: (event: any, ctx?: any) => any) => {
      (handlers[event] ??= []).push(handler);
    },
  };
  return fakePi;
}

test("help extension registers the /help command and sends an offline report", async () => {
  const fakePi = makeFakePi() as any;
  helpExtension(fakePi);

  const helpCommand = fakePi.commands.get("help");
  expect(helpCommand).toBeDefined();
  expect(helpCommand.description).toContain("offline");

  await helpCommand.handler("", { hasUI: true });
  expect(fakePi.messages).toHaveLength(1);
  expect(fakePi.messages[0].customType).toBe("pico.help");
  expect(fakePi.messages[0].display).toBe(true);
  expect(fakePi.messages[0].content).toContain("/quit");
});

test("help text lists builtins, extension commands, shortcuts, and the unknown-command note", () => {
  const text = buildHelpText([
    { name: "doctor", description: "Show pico safety switches" },
    { name: "memory" },
  ]);

  expect(text).toContain("/doctor  Show pico safety switches");
  expect(text).toContain("/memory");
  expect(text).toContain("上游内置命令");
  for (const cmd of BUILTIN_COMMANDS) {
    expect(text).toContain(`/${cmd.name}`);
  }
  expect(text).toContain("/hotkeys");
  for (const shortcut of KEYBOARD_SHORTCUTS) {
    expect(text).toContain(shortcut.keys);
    expect(text).toContain(shortcut.description);
  }
  expect(text).toContain("会被当作普通消息发送给模型");
});

test("unknown /cmd triggers guidance injection, builtins and known commands do not", () => {
  const fakePi = makeFakePi() as any;
  helpExtension(fakePi);
  const contextHandlers = fakePi.handlers["context"];
  expect(contextHandlers).toBeDefined();

  const run = (messages: any[]) => contextHandlers[0]({ messages }, undefined) ?? {};

  // Unknown command -> one guidance message appended (user role: AgentMessage
  // has no system role; unknown roles are dropped by the LLM converter).
  const unknown = run([{ role: "user", content: [{ type: "text", text: "/foobar do something" }] }]);
  expect(unknown.messages).toHaveLength(2);
  expect(unknown.messages[1].role).toBe("user");
  expect(unknown.messages[1].content[0].text).toContain("不是用户的新请求");
  expect(unknown.messages[1].content[0].text).toContain('"foobar"');
  expect(unknown.messages[1].content[0].text).toContain("/help");

  // Same command again -> no duplicate injection (handler returns nothing).
  const again = run([{ role: "user", content: "/foobar again" }]);
  expect(again.messages).toBeUndefined();

  // Builtin -> untouched.
  const builtin = run([{ role: "user", content: "/quit" }]);
  expect(builtin.messages).toBeUndefined();

  // Registered extension command -> untouched.
  const ext = run([{ role: "user", content: "/doctor" }]);
  expect(ext.messages).toBeUndefined();

  // Non-slash message -> untouched.
  const plain = run([{ role: "user", content: "hello" }]);
  expect(plain.messages).toBeUndefined();
});

test("context guard only inspects the last user message and ignores non-user tails", () => {
  const fakePi = makeFakePi() as any;
  helpExtension(fakePi);
  const handler = fakePi.handlers["context"][0];

  const result = handler(
    { messages: [{ role: "assistant", content: [{ type: "text", text: "reply" }] }] },
    undefined,
  );
  expect(result).toBeUndefined();

  const empty = handler({ messages: [] }, undefined);
  expect(empty).toBeUndefined();
});

test("buildUnknownCommandGuidance instructs a one-line answer without guessing", () => {
  const guidance = buildUnknownCommandGuidance("foobar");
  expect(guidance).toContain('"foobar" 不是已注册命令');
  expect(guidance).toContain("不要猜测");
  expect(guidance).toContain("/help");
});
