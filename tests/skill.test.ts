/**
 * skill extension tests — catalog discovery + tool factory driven by a fake
 * executor (no subprocesses, no real model calls).
 *
 * Env isolation follows tests/observability.test.ts: PICO_HOME redirected to
 * a mkdtemp directory in beforeEach, restored in afterEach.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SubagentRequest } from "../src/extensions/subagent/orchestrator.ts";
import { ToolError } from "../src/extensions/errors.ts";
import {
  discoverSkills,
  parseSkillFile,
  projectSkillsDir,
  readSkillInstructions,
  scanSkillDir,
  userSkillsDir,
  type SkillInfo,
} from "../src/extensions/skill/catalog.ts";
import { createSkillExtension, type SkillExecutor } from "../src/extensions/skill/index.ts";

let homeDir: string;
let oldPicoHome: string | undefined;

/** 写入 <dir>/<name>/SKILL.md（name 用作目录名兜底），返回文件绝对路径。 */
function writeSkill(dir: string, name: string, frontmatter: string, body = ""): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const filePath = join(skillDir, "SKILL.md");
  writeFileSync(filePath, `${frontmatter}\n\n${body}`);
  return filePath;
}

function makeSkillFile(dir: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  writeFileSync(filePath, content);
  return filePath;
}

beforeEach(() => {
  oldPicoHome = process.env.PICO_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "pico-skill-"));
  process.env.PICO_HOME = homeDir;
});

afterEach(() => {
  if (oldPicoHome === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = oldPicoHome;
  rmSync(homeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseSkillFile
// ---------------------------------------------------------------------------

test("parseSkillFile reads name and description from frontmatter (quotes stripped)", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-parse-"));
  try {
    const filePath = makeSkillFile(dir, '---\nname: my-skill\ndescription: "Does things"\n---\n\nBody');
    expect(parseSkillFile(filePath, "user")).toEqual({
      name: "my-skill",
      description: "Does things",
      filePath,
      source: "user",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseSkillFile returns null when there is no frontmatter", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-parse-"));
  try {
    const filePath = makeSkillFile(dir, "# No frontmatter\n\njust body text");
    expect(parseSkillFile(filePath, "path")).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseSkillFile falls back to the directory basename when frontmatter lacks a name", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-parse-"));
  try {
    const filePath = writeSkill(dir, "review-skill", "---\ndescription: no name here\n---");
    const info = parseSkillFile(filePath, "user");
    expect(info?.name).toBe("review-skill");
    expect(info?.description).toBe("no name here");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseSkillFile defaults description to an empty string", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-parse-"));
  try {
    const filePath = writeSkill(dir, "bare", "---\nname: bare\n---");
    expect(parseSkillFile(filePath, "user")?.description).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseSkillFile returns null for unreadable or non-frontmatter files", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-parse-"));
  try {
    // 不可读（不存在）。
    expect(parseSkillFile(join(dir, "missing", "SKILL.md"), "user")).toBeNull();
    // 非 md 且无 frontmatter。
    const txtPath = join(dir, "notes.txt");
    writeFileSync(txtPath, "plain text, no frontmatter");
    expect(parseSkillFile(txtPath, "path")).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanSkillDir
// ---------------------------------------------------------------------------

test("scanSkillDir discovers nested SKILL.md files and ignores other .md files", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-scan-"));
  try {
    mkdirSync(join(dir, "a", "nested"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    writeSkill(dir, "root-skill", "---\nname: root-skill\n---");
    writeSkill(join(dir, "a", "nested"), "deep-skill", "---\nname: deep\n---");
    writeSkill(join(dir, "b"), "bee", "---\nname: bee\n---");
    writeFileSync(join(dir, "ignored.md"), "---\nname: ignored\n---\nbody");

    const found = scanSkillDir(dir, "user");
    expect(found.map((s) => s.name).sort()).toEqual(["bee", "deep", "root-skill"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanSkillDir returns [] for an empty or missing directory", () => {
  const empty = mkdtempSync(join(tmpdir(), "skill-empty-"));
  expect(scanSkillDir(empty, "user")).toEqual([]);
  expect(scanSkillDir(join(empty, "does-not-exist"), "user")).toEqual([]);
});

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

test("discoverSkills merges user, project, and path sources with first-wins dedupe, sorted by name", () => {
  const projectCwd = mkdtempSync(join(tmpdir(), "skill-proj-"));
  try {
    // user 目录：name=zeta（与 project 冲突，user 优先）
    const userDir = userSkillsDir();
    makeSkillFile(userDir, "---\nname: zeta\n---\nuser body");

    // project 目录：name=beta（与 path 冲突，project 优先）+ name=zeta（冲突，输给 user）
    const projDir = projectSkillsDir(projectCwd);
    makeSkillFile(projDir, "---\nname: beta\n---\nproject body");
    writeSkill(projDir, "zeta-dup", "---\nname: zeta\n---\nproject zeta body");

    // extraDirs 目录：name=alpha（仅此来源）+ name=beta（冲突，输给 project）
    const extraDir = mkdtempSync(join(tmpdir(), "skill-extra-"));
    makeSkillFile(extraDir, "---\nname: alpha\n---\npath body");
    writeSkill(extraDir, "beta-dup", "---\nname: beta\n---\npath beta body");

    const found = discoverSkills(projectCwd, [extraDir]);
    expect(found.map((s) => s.name)).toEqual(["alpha", "beta", "zeta"]);
    const byName = new Map(found.map((s) => [s.name, s]));
    expect(byName.get("alpha")?.source).toBe("path");
    expect(byName.get("beta")?.source).toBe("project");
    expect(byName.get("zeta")?.source).toBe("user");
  } finally {
    rmSync(projectCwd, { recursive: true, force: true });
  }
});

test("discoverSkills accepts a single SKILL.md file as an extra path", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-extra-file-"));
  try {
    const filePath = writeSkill(dir, "solo", "---\nname: solo\n---\nbody");
    const found = discoverSkills(dir, [filePath]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "solo", source: "path", filePath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverSkills ignores a missing extra dir and finds nothing when no skills exist", () => {
  const projectCwd = mkdtempSync(join(tmpdir(), "skill-noproj-"));
  try {
    expect(discoverSkills(projectCwd, [join(projectCwd, "nope")])).toEqual([]);
  } finally {
    rmSync(projectCwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readSkillInstructions
// ---------------------------------------------------------------------------

test("readSkillInstructions returns the body without the frontmatter block", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-read-"));
  try {
    const filePath = makeSkillFile(dir, "---\nname: x\n---\n\nDo the thing.\n\nThen stop.\n");
    const info = parseSkillFile(filePath, "user")!;
    expect(info).not.toBeNull();
    expect(readSkillInstructions(info)).toBe("Do the thing.\n\nThen stop.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// createSkillExtension — tool factory with a fake executor
// ---------------------------------------------------------------------------

interface FakePi {
  tools: Map<string, Record<string, unknown>>;
  registerTool: (tool: Record<string, unknown>) => void;
}

function makeFakePi(): FakePi {
  const tools = new Map<string, Record<string, unknown>>();
  return {
    tools,
    registerTool: (tool) => {
      tools.set(tool.name as string, tool);
    },
  };
}

type ExecResult = AgentToolResult<unknown> & { isError?: boolean };

function runTool(
  tool: Record<string, unknown>,
  params: Record<string, unknown>,
  cwd: string,
): Promise<ExecResult> {
  const execute = tool.execute as unknown as (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<ExecResult>;
  return execute("call_1", params, undefined, undefined, { cwd });
}

/** 绝不允许被调用的 fake：错误路径不应触达 executor。 */
const neverCalled: SkillExecutor = async () => {
  throw new Error("fake executor must not be called");
};

test("factory registers the skill tool", () => {
  const factory = createSkillExtension(neverCalled);
  const fakePi = makeFakePi();
  factory(fakePi as unknown as Parameters<typeof factory>[0]);
  expect(fakePi.tools.has("skill")).toBe(true);
  const tool = fakePi.tools.get("skill")!;
  expect(tool.name).toBe("skill");
  expect(tool.label).toBe("Skill");
});

test("action=run dispatches to the executor with the skill instructions and User goal", async () => {
  const userDir = userSkillsDir();
  makeSkillFile(userDir, "---\nname: zap\n---\nZap instructions body.");

  let captured: SubagentRequest | undefined;
  const fakeExecute: SkillExecutor = async (req) => {
    captured = req;
    return { content: [{ type: "text", text: "executed ok" }], details: {} };
  };
  const factory = createSkillExtension(fakeExecute);
  const fakePi = makeFakePi();
  factory(fakePi as unknown as Parameters<typeof factory>[0]);

  const projectCwd = mkdtempSync(join(tmpdir(), "skill-run-"));
  try {
    const result = await runTool(fakePi.tools.get("skill")!, { action: "run", name: "zap", goal: "make it so" }, projectCwd);
    expect(captured).toEqual({
      agent: "worker",
      task: 'You are executing the skill "zap". Follow its instructions.\n\nZap instructions body.\n\nUser goal: make it so',
      cwd: projectCwd,
    });
    expect(result.content[0]).toEqual({ type: "text", text: "executed ok" });
    expect(result.details).toEqual({ action: "run", skill: "zap" });
  } finally {
    rmSync(projectCwd, { recursive: true, force: true });
  }
});

test("action=run matches skill names case-insensitively and honors the cwd param", async () => {
  const userDir = userSkillsDir();
  makeSkillFile(userDir, "---\nname: Zap\n---\nZap body.");

  let captured: SubagentRequest | undefined;
  const fakeExecute: SkillExecutor = async (req) => {
    captured = req;
    return { content: [{ type: "text", text: "ok" }], details: {} };
  };
  const factory = createSkillExtension(fakeExecute);
  const fakePi = makeFakePi();
  factory(fakePi as unknown as Parameters<typeof factory>[0]);

  const projectCwd = mkdtempSync(join(tmpdir(), "skill-run-"));
  try {
    // 无 goal → 任务省略 "User goal" 行；cwd 参数覆盖 ctx.cwd。
    const result = await runTool(fakePi.tools.get("skill")!, { action: "run", name: "zap", cwd: "/override" }, projectCwd);
    expect(captured?.task).toBe('You are executing the skill "Zap". Follow its instructions.\n\nZap body.');
    expect(captured?.task).not.toContain("User goal");
    expect(captured?.cwd).toBe("/override");
    expect(result.details).toEqual({ action: "run", skill: "Zap" });
  } finally {
    rmSync(projectCwd, { recursive: true, force: true });
  }
});

test("action=run without name throws invalid_request", async () => {
  const factory = createSkillExtension(neverCalled);
  const fakePi = makeFakePi();
  factory(fakePi as unknown as Parameters<typeof factory>[0]);

  try {
    await runTool(fakePi.tools.get("skill")!, { action: "run" }, "/tmp");
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("invalid_request");
    expect((err as ToolError).message).toBe("'name' is required for action=run");
  }
});

test("action=run with an unknown skill name throws invalid_request listing available skills", async () => {
  const userDir = userSkillsDir();
  makeSkillFile(userDir, "---\nname: zap\n---\nZap body.");

  const factory = createSkillExtension(neverCalled);
  const fakePi = makeFakePi();
  factory(fakePi as unknown as Parameters<typeof factory>[0]);

  try {
    await runTool(fakePi.tools.get("skill")!, { action: "run", name: "nope" }, "/tmp");
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("invalid_request");
    expect((err as ToolError).message).toContain('Skill "nope" not found');
    expect((err as ToolError).message).toContain("Available skills: zap");
    expect((err as ToolError).structured).toEqual({ code: "invalid_request", available: ["zap"] });
  }
});

test("action=run with an isError executor result throws server_error with the result text", async () => {
  const userDir = userSkillsDir();
  makeSkillFile(userDir, "---\nname: zap\n---\nZap body.");

  const failingExecute: SkillExecutor = async () =>
    ({ content: [{ type: "text", text: "boom output" }], details: {}, isError: true }) as ExecResult;
  const factory = createSkillExtension(failingExecute);
  const fakePi = makeFakePi();
  factory(fakePi as unknown as Parameters<typeof factory>[0]);

  try {
    await runTool(fakePi.tools.get("skill")!, { action: "run", name: "zap" }, "/tmp");
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("server_error");
    expect((err as ToolError).message).toBe("boom output");
  }
});

test("action=list returns the discovered skill names and count", async () => {
  const userDir = userSkillsDir();
  makeSkillFile(userDir, "---\nname: zap\ndescription: Zaps things\n---\nZap body.");
  writeSkill(userDir, "wow", "---\nname: wow\n---\nWow body.");

  const factory = createSkillExtension(neverCalled);
  const fakePi = makeFakePi();
  factory(fakePi as unknown as Parameters<typeof factory>[0]);

  const projectCwd = mkdtempSync(join(tmpdir(), "skill-list-"));
  try {
    const result = await runTool(fakePi.tools.get("skill")!, { action: "list" }, projectCwd);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Available skills (2):");
    expect(text).toContain("  zap — Zaps things");
    expect(text).toContain("  wow");
    expect(result.details).toEqual({ action: "list", count: 2 });
  } finally {
    rmSync(projectCwd, { recursive: true, force: true });
  }
});

test("action=list with no skills suggests where to place SKILL.md files", async () => {
  const factory = createSkillExtension(neverCalled);
  const fakePi = makeFakePi();
  factory(fakePi as unknown as Parameters<typeof factory>[0]);

  const emptyCwd = mkdtempSync(join(tmpdir(), "skill-none-"));
  try {
    const result = await runTool(fakePi.tools.get("skill")!, { action: "list" }, emptyCwd);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Available skills (0):");
    expect(text).toContain("Place SKILL.md files in ~/.pico/agent/skills/ or <project>/.pico/skills/.");
    expect(result.details).toEqual({ action: "list", count: 0 });
  } finally {
    rmSync(emptyCwd, { recursive: true, force: true });
  }
});
