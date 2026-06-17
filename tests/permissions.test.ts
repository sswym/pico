import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetWarnedPaths, loadPermissionConfig, permissionConfigPaths } from "../src/extensions/permissions/config.ts";
import { decidePermission } from "../src/extensions/permissions/decide.ts";
import { bashRuleMatches, ruleMatchesInput } from "../src/extensions/permissions/match.ts";
import { permissionRuleValueFromString, permissionRuleValueToString } from "../src/extensions/permissions/parser.ts";
import { createPermissionsExtension } from "../src/extensions/permissions/index.ts";
import { PermissionStore } from "../src/extensions/permissions/store.ts";

let workdir: string;
let homeRoot: string;
let prevHome: string | undefined;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "srcode-permissions-"));
  homeRoot = mkdtempSync(join(tmpdir(), "srcode-permissions-home-"));
  prevHome = process.env.SRCODE_HOME;
  process.env.SRCODE_HOME = homeRoot;
  __resetWarnedPaths();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SRCODE_HOME;
  else process.env.SRCODE_HOME = prevHome;
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  try { rmSync(homeRoot, { recursive: true, force: true }); } catch {}
});

function writeHomeConfig(content: unknown): void {
  writeFileSync(join(homeRoot, "permissions.json"), JSON.stringify(content));
}

function writeProjectConfig(content: unknown): void {
  const dir = join(workdir, ".srcode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "permissions.json"), JSON.stringify(content));
}

test("permissionRuleValueFromString parses whole-tool and content rules", () => {
  expect(permissionRuleValueFromString("Bash")).toEqual({ toolName: "Bash" });
  expect(permissionRuleValueFromString("Bash(npm:*)")).toEqual({ toolName: "Bash", ruleContent: "npm:*" });
  expect(permissionRuleValueFromString("Edit(./src/**)")).toEqual({ toolName: "Edit", ruleContent: "./src/**" });
});

test("permission rule parser handles escaped parens and empty content", () => {
  const parsed = permissionRuleValueFromString(String.raw`Bash(python -c "print\(1\)")`)!;
  expect(parsed).toEqual({ toolName: "Bash", ruleContent: String.raw`python -c "print(1)"` });
  expect(permissionRuleValueToString(parsed)).toBe(String.raw`Bash(python -c "print\(1\)")`);
  expect(permissionRuleValueFromString("Bash() ")).toEqual({ toolName: "Bash" });
  expect(permissionRuleValueFromString("Bash(*)")).toEqual({ toolName: "Bash" });
});

test("loadPermissionConfig returns paths and merges home/project rules", () => {
  const [home, project] = permissionConfigPaths(workdir);
  expect(home!.path).toBe(join(homeRoot, "permissions.json"));
  expect(project!.path).toBe(join(workdir, ".srcode", "permissions.json"));

  writeHomeConfig({ permissions: { allow: ["Bash(npm:*)"], defaultMode: "acceptEdits" } });
  writeProjectConfig({ permissions: { deny: ["Bash(rm:*)"], ask: ["Write(./dist/**)"] } });

  const config = loadPermissionConfig(workdir);
  expect(config.defaultMode).toBe("acceptEdits");
  expect(config.rules.map((r) => `${r.behavior}:${permissionRuleValueToString(r.value)}`)).toEqual([
    "allow:Bash(npm:*)",
    "deny:Bash(rm:*)",
    "ask:Write(./dist/**)",
  ]);
});

test("bashRuleMatches supports exact, prefix, wildcard, env vars and wrappers", () => {
  expect(bashRuleMatches("git status", "git status")).toBe(true);
  expect(bashRuleMatches("npm:*", "npm install")).toBe(true);
  expect(bashRuleMatches("npm:*", "npmx install")).toBe(false);
  expect(bashRuleMatches("git * main", "git push origin main")).toBe(true);
  expect(bashRuleMatches("npm:*", "NODE_ENV=test timeout 5 npm test")).toBe(true);
  expect(bashRuleMatches("cd:*", "cd src && rm -rf /tmp/x")).toBe(false);
});

test("ruleMatchesInput handles whole-tool, mcp namespace, bash and file rules", () => {
  expect(ruleMatchesInput({ source: "userSettings", behavior: "allow", root: workdir, value: { toolName: "bash" } }, "bash", { command: "whoami" }, workdir)).toBe(true);
  expect(ruleMatchesInput({ source: "userSettings", behavior: "allow", root: workdir, value: { toolName: "mcp__srv" } }, "mcp__srv__tool", {}, workdir)).toBe(true);
  expect(ruleMatchesInput({ source: "userSettings", behavior: "allow", root: workdir, value: { toolName: "Bash", ruleContent: "npm:*" } }, "bash", { command: "npm test" }, workdir)).toBe(true);
  expect(ruleMatchesInput({ source: "projectSettings", behavior: "allow", root: workdir, value: { toolName: "Edit", ruleContent: "./src/**" } }, "edit", { path: join(workdir, "src", "x.ts") }, workdir)).toBe(true);
});

test("decidePermission enforces deny > ask > bypass > allow and default ask", () => {
  writeProjectConfig({ permissions: { allow: ["Bash(npm:*)"], deny: ["Bash(npm publish)"], ask: ["Bash(npm install)"] } });
  const store = new PermissionStore();
  store.reload(workdir);

  expect(decidePermission("bash", { command: "npm publish" }, workdir, store).behavior).toBe("deny");
  expect(decidePermission("bash", { command: "npm install" }, workdir, store).behavior).toBe("ask");
  expect(decidePermission("bash", { command: "npm test" }, workdir, store).behavior).toBe("allow");
  expect(decidePermission("bash", { command: "echo hi" }, workdir, store).behavior).toBe("ask");
  expect(decidePermission("bash", { command: "echo hi" }, workdir, store, "bypassPermissions").behavior).toBe("allow");
});

test("decidePermission turns ask into deny in dontAsk mode and accepts edits inside cwd", () => {
  const store = new PermissionStore();
  store.reload(workdir);

  const denied = decidePermission("bash", { command: "echo hi" }, workdir, store, "dontAsk");
  expect(denied.behavior).toBe("deny");
  expect(denied.reason).toContain("dontAsk");

  const edit = decidePermission("edit", { path: join(workdir, "src", "x.ts") }, workdir, store, "acceptEdits");
  expect(edit.behavior).toBe("allow");
});

interface FakePi {
  handlers: Record<string, Array<(event: any, ctx: any) => any>>;
  commands: Map<string, any>;
  messages: any[];
}

function makeFakePi(): FakePi & {
  on: (event: string, handler: (event: any, ctx: any) => any) => void;
  registerCommand: (name: string, opts: any) => void;
  sendMessage: (msg: any) => void;
} {
  const handlers: FakePi["handlers"] = {};
  const commands = new Map<string, any>();
  const messages: any[] = [];
  return {
    handlers,
    commands,
    messages,
    on: (event, handler) => { (handlers[event] ??= []).push(handler); },
    registerCommand: (name, opts) => commands.set(name, opts),
    sendMessage: (msg) => messages.push(msg),
  };
}

function makeCtx(select: (title: string, options: string[]) => Promise<string | undefined>, hasUI = true) {
  return {
    cwd: workdir,
    hasUI,
    signal: undefined,
    ui: {
      select,
      notify: () => {},
    },
  };
}

test("permissions extension blocks asks without UI", async () => {
  const pi = makeFakePi();
  const factory = createPermissionsExtension({ cwd: () => workdir });
  factory(pi as any);
  const result = await pi.handlers.tool_call![0]!({ type: "tool_call", toolName: "bash", input: { command: "echo hi" } }, makeCtx(async () => "Yes", false));
  expect(result.block).toBe(true);
  expect(result.reason).toContain("no UI");
});

test("permissions extension supports Yes and session allow", async () => {
  const pi = makeFakePi();
  const factory = createPermissionsExtension({ cwd: () => workdir });
  factory(pi as any);
  const handler = pi.handlers.tool_call![0]!;

  const first = await handler({ type: "tool_call", toolName: "bash", input: { command: "echo hi" } }, makeCtx(async () => "Yes, allow for this session"));
  expect(first).toEqual({});

  const second = await handler({ type: "tool_call", toolName: "bash", input: { command: "another command" } }, makeCtx(async () => {
    throw new Error("should not prompt after session allow");
  }));
  expect(second).toEqual({});
});
