import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDoctorReport, doctorExtension } from "../src/extensions/doctor/index.ts";
import {
  allowProjectHooks,
  allowProjectMcp,
  readSafetySettings,
} from "../src/extensions/policy.ts";

const savedEnv = {
  home: process.env.PICO_HOME,
  plan: process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL,
  lsp: process.env.PICO_ALLOW_LSP_FORMAT_ON_WRITE,
  hooks: process.env.PICO_ENABLE_PROJECT_HOOKS,
  mcp: process.env.PICO_ENABLE_PROJECT_MCP,
};

afterEach(() => {
  if (savedEnv.home === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = savedEnv.home;
  if (savedEnv.plan === undefined) delete process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL;
  else process.env.PICO_ALLOW_UNATTENDED_PLAN_APPROVAL = savedEnv.plan;
  if (savedEnv.lsp === undefined) delete process.env.PICO_ALLOW_LSP_FORMAT_ON_WRITE;
  else process.env.PICO_ALLOW_LSP_FORMAT_ON_WRITE = savedEnv.lsp;
  if (savedEnv.hooks === undefined) delete process.env.PICO_ENABLE_PROJECT_HOOKS;
  else process.env.PICO_ENABLE_PROJECT_HOOKS = savedEnv.hooks;
  if (savedEnv.mcp === undefined) delete process.env.PICO_ENABLE_PROJECT_MCP;
  else process.env.PICO_ENABLE_PROJECT_MCP = savedEnv.mcp;
});

test("buildDoctorReport shows safety switches and capabilities", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-home-"));
  process.env.PICO_HOME = home;
  process.env.PICO_ENABLE_PROJECT_HOOKS = "1";
  delete process.env.PICO_ENABLE_PROJECT_MCP;

  try {
    const report = buildDoctorReport("/repo");

    expect(report).toContain("pico doctor");
    expect(report).toContain("cwd: /repo");
    expect(report).toContain("enableProjectHooks: enabled (env; env PICO_ENABLE_PROJECT_HOOKS)");
    expect(report).toContain("enableProjectMcp: disabled (default; env PICO_ENABLE_PROJECT_MCP)");
    expect(report).toContain("Project Code Exec (high)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("safety settings are read from settings.json and env overrides them", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-doctor-home-"));
  process.env.PICO_HOME = home;
  delete process.env.PICO_ENABLE_PROJECT_HOOKS;
  process.env.PICO_ENABLE_PROJECT_MCP = "0";
  try {
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      safety: {
        enableProjectHooks: true,
        enableProjectMcp: true,
      },
    }));

    expect(readSafetySettings()).toMatchObject({
      enableProjectHooks: true,
      enableProjectMcp: true,
    });
    expect(allowProjectHooks()).toBe(true);
    expect(allowProjectMcp()).toBe(false);

    const report = buildDoctorReport("/repo");
    expect(report).toContain("enableProjectHooks: enabled (settings; env PICO_ENABLE_PROJECT_HOOKS)");
    expect(report).toContain("enableProjectMcp: disabled (env; env PICO_ENABLE_PROJECT_MCP)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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
  expect(messages[0].customType).toBe("pico.doctor");
  expect(messages[0].display).toBe(true);
  expect(messages[0].content).toContain("cwd: /repo/app");
});
