import { expect, test } from "bun:test";
import {
  createRtkExtension,
  interpretRtkRewrite,
} from "../src/extensions/rtk/index.ts";

function makeFakePi() {
  const handlers: Record<string, (event: any, ctx?: any) => unknown> = {};
  const commands = new Map<string, any>();
  const messages: any[] = [];
  return {
    handlers,
    commands,
    messages,
    api: {
      on: (event: string, handler: (event: any, ctx?: any) => unknown) => {
        handlers[event] = handler;
      },
      registerCommand: (name: string, opts: any) => {
        commands.set(name, opts);
      },
      sendMessage: (message: any) => {
        messages.push(message);
      },
    },
  };
}

test("interpretRtkRewrite follows rtk rewrite exit code protocol", () => {
  expect(interpretRtkRewrite("git status", {
    exitCode: 0,
    stdout: "rtk git status\n",
    stderr: "",
  })).toEqual({ verdict: "allow", command: "rtk git status" });

  expect(interpretRtkRewrite("echo hi", {
    exitCode: 1,
    stdout: "",
    stderr: "",
  })).toEqual({ verdict: "passthrough" });

  expect(interpretRtkRewrite("rm -rf /", {
    exitCode: 2,
    stdout: "",
    stderr: "",
  })).toEqual({ verdict: "deny", reason: "RTK deny rule matched" });

  expect(interpretRtkRewrite("git log", {
    exitCode: 3,
    stdout: "rtk git log\n",
    stderr: "",
  })).toEqual({ verdict: "ask", command: "rtk git log" });
});

test("rtk extension rewrites bash command input in place", async () => {
  const fake = makeFakePi();
  createRtkExtension({
    rewrite: async (command) => ({
      exitCode: 0,
      stdout: command === "git status" ? "rtk git status\n" : "",
      stderr: "",
    }),
  })(fake.api as any);

  const event = {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "bash",
    input: { command: "git status" },
  };
  const result = await fake.handlers.tool_call!(event);

  expect(result).toEqual({});
  expect(event.input.command).toBe("rtk git status");
});

test("rtk extension blocks bash command when rtk returns deny", async () => {
  const fake = makeFakePi();
  createRtkExtension({
    rewrite: async () => ({ exitCode: 2, stdout: "", stderr: "" }),
  })(fake.api as any);

  const result = await fake.handlers.tool_call!({
    type: "tool_call",
    toolCallId: "t1",
    toolName: "bash",
    input: { command: "danger" },
  }) as { block?: boolean; reason?: string };

  expect(result.block).toBe(true);
  expect(result.reason).toContain("RTK deny rule");
});

test("rtk extension leaves command unchanged when rtk is unavailable", async () => {
  const fake = makeFakePi();
  createRtkExtension({
    rewrite: async () => ({ exitCode: -1, stdout: "", stderr: "rtk not found" }),
  })(fake.api as any);

  const event = {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "bash",
    input: { command: "git status" },
  };
  const result = await fake.handlers.tool_call!(event);

  expect(result).toEqual({});
  expect(event.input.command).toBe("git status");
});

test("/rtk reports probe status", async () => {
  const fake = makeFakePi();
  createRtkExtension({
    rewrite: async () => ({ exitCode: 0, stdout: "rtk git status\n", stderr: "" }),
  })(fake.api as any);

  const notices: Array<{ text: string; level: string }> = [];
  await fake.commands.get("rtk").handler("", {
    ui: {
      notify: (text: string, level: string) => {
        notices.push({ text, level });
      },
    },
  });

  expect(notices).toHaveLength(1);
  expect(notices[0]!.text).toContain("status: available");
  expect(notices[0]!.text).toContain("git status -> rtk git status");
});
