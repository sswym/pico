import { afterEach, expect, test } from "bun:test";
import { buildDoctorReport, doctorExtension } from "../src/extensions/doctor/index.ts";

const savedEnv = {
  plan: process.env.SRCODE_ALLOW_UNATTENDED_PLAN_APPROVAL,
  lsp: process.env.SRCODE_ALLOW_LSP_FORMAT_ON_WRITE,
  hooks: process.env.SRCODE_ENABLE_PROJECT_HOOKS,
  mcp: process.env.SRCODE_ENABLE_PROJECT_MCP,
};

afterEach(() => {
  if (savedEnv.plan === undefined) delete process.env.SRCODE_ALLOW_UNATTENDED_PLAN_APPROVAL;
  else process.env.SRCODE_ALLOW_UNATTENDED_PLAN_APPROVAL = savedEnv.plan;
  if (savedEnv.lsp === undefined) delete process.env.SRCODE_ALLOW_LSP_FORMAT_ON_WRITE;
  else process.env.SRCODE_ALLOW_LSP_FORMAT_ON_WRITE = savedEnv.lsp;
  if (savedEnv.hooks === undefined) delete process.env.SRCODE_ENABLE_PROJECT_HOOKS;
  else process.env.SRCODE_ENABLE_PROJECT_HOOKS = savedEnv.hooks;
  if (savedEnv.mcp === undefined) delete process.env.SRCODE_ENABLE_PROJECT_MCP;
  else process.env.SRCODE_ENABLE_PROJECT_MCP = savedEnv.mcp;
});

test("buildDoctorReport shows safety switches and capabilities", () => {
  process.env.SRCODE_ENABLE_PROJECT_HOOKS = "1";
  delete process.env.SRCODE_ENABLE_PROJECT_MCP;

  const report = buildDoctorReport("/repo");

  expect(report).toContain("srcode doctor");
  expect(report).toContain("cwd: /repo");
  expect(report).toContain("SRCODE_ENABLE_PROJECT_HOOKS: enabled");
  expect(report).toContain("SRCODE_ENABLE_PROJECT_MCP: disabled");
  expect(report).toContain("Project Code Exec (high)");
});

test("doctor extension registers /doctor and sends a visible report", async () => {
  const commands = new Map<string, any>();
  const messages: any[] = [];
  const fakePi = {
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    sendMessage: (message: any) => messages.push(message),
  };

  doctorExtension(fakePi as any);
  await commands.get("doctor").handler("", { cwd: "/repo/app" });

  expect(messages).toHaveLength(1);
  expect(messages[0].customType).toBe("srcode.doctor");
  expect(messages[0].display).toBe(true);
  expect(messages[0].content).toContain("cwd: /repo/app");
});
