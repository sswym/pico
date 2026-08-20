/**
 * Skill tool — list discovered skills or dispatch one to an isolated
 * subagent that executes the skill's SKILL.md instructions.
 *
 * Upstream pi-coding-agent already injects skill directories (user
 * ~/.pico/agent/skills, project <cwd>/.pico/skills, and --skill paths) into
 * the system prompt for the model to read inline. This extension adds the
 * missing "isolated execution" capability: action=run turns a skill's
 * instructions into a task for a worker subagent, so the skill runs in a
 * clean context instead of inline in the main context.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolError } from "../errors.ts";
// Deliberate cross-extension reuse: the skill tool needs the subagent's
// synchronous result — the event bus (events.ts) is a fire-and-forget channel
// with no response, and re-implementing process.ts's spawn hardening
// (SIGTERM→SIGKILL / hangTimer / stderr cap) is unacceptable — so reuse the
// orchestrator's exported entry directly.
import { runSubagentRequest, type SubagentRequest, type SubagentRunContext } from "../subagent/orchestrator.ts";
import { discoverSkills, readSkillInstructions, type SkillInfo } from "./catalog.ts";

/** DI 注入点：默认用 subagent 的 runSubagentRequest；测试注入 fake。 */
export type SkillExecutor = (
  req: SubagentRequest,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: SubagentRunContext,
) => Promise<AgentToolResult<unknown>>;

const SkillParams = Type.Object({
  action: StringEnum(["list", "run"] as const, {
    description: '"list" to enumerate discovered skills; "run" to execute one in an isolated subagent',
  }),
  name: Type.Optional(Type.String({ description: "Skill name to execute (required for action=run)" })),
  goal: Type.Optional(Type.String({ description: "User goal appended to the skill's subagent task (for action=run)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the skill's subagent (for action=run)" })),
});

/**
 * 定位内置技能目录（src/skills）。
 *
 * bin/pico.ts 通过 buildRuntimeArgs() 把 `--skill <dir>` 追加进传给 main() 的
 * 参数数组，上游 main 从不改写 process.argv —— 从 process.argv 读必然落空。
 * 改为按运行形态自定位同一目录：
 * - 编译二进制模式：prepareEmbeddedRuntime 把嵌入资源解到 $PI_PACKAGE_DIR/skills；
 * - 源码模式：相对本文件（src/extensions/skill/index.ts）上溯两级到 src/skills。
 */
function bundledSkillsDir(): string | undefined {
  const packageDir = process.env.PI_PACKAGE_DIR;
  if (packageDir) {
    const extracted = resolve(packageDir, "skills");
    if (existsSync(extracted)) return extracted;
  }
  const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
  if (existsSync(sourceDir)) return sourceDir;
  return undefined;
}

/**
 * 用户显式传的 `--skill <path>`（separated form only，与上游 args.js 一致）。
 * 与 bundledSkillsDir 互补：注入的内置目录不进 process.argv，显式参数会进。
 * Tolerates `--skill` as the last argv element with no following value (skipped).
 */
function explicitSkillPathsFromArgv(): string[] {
  const paths: string[] = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--skill") {
      const value = argv[i + 1];
      if (value !== undefined) paths.push(value);
    }
  }
  return paths;
}

/** `--no-skills`/`-ns` 时上游不加载内置技能，工具侧同步跳过。 */
function hasNoSkillsFlag(): boolean {
  return process.argv.includes("--no-skills") || process.argv.includes("-ns");
}

/**
 * 默认额外技能目录：内置 src/skills（存在时）+ 用户显式 `--skill` 路径。
 * 测试可通过 createSkillExtension 的 options.extraSkillDirs 注入覆盖。
 */
function defaultSkillDirs(): string[] {
  const dirs: string[] = [];
  if (!hasNoSkillsFlag()) {
    const bundled = bundledSkillsDir();
    if (bundled) dirs.push(bundled);
  }
  dirs.push(...explicitSkillPathsFromArgv());
  return dirs;
}

/** 精确匹配优先，再大小写不敏感。 */
function findSkill(skills: SkillInfo[], name: string): SkillInfo | undefined {
  return (
    skills.find((skill) => skill.name === name) ??
    skills.find((skill) => skill.name.toLowerCase() === name.toLowerCase())
  );
}

function formatSkillList(skills: SkillInfo[]): string {
  if (skills.length === 0) {
    return "Available skills (0):\nPlace SKILL.md files in ~/.pico/agent/skills/ or <project>/.pico/skills/.";
  }
  const lines = skills.map((skill) =>
    skill.description ? `  ${skill.name} — ${skill.description}` : `  ${skill.name}`,
  );
  return `Available skills (${skills.length}):\n${lines.join("\n")}`;
}

function joinTextContent(content: readonly (TextContent | ImageContent)[] | undefined): string {
  return (content ?? [])
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export interface SkillExtensionOptions {
  /**
   * 额外技能目录（内置 src/skills + 显式 --skill 参数的默认值）。
   * 测试注入 `[]` 可模拟无内置技能的干净环境。
   */
  extraSkillDirs?: string[];
}

export function createSkillExtension(execute?: SkillExecutor, options?: SkillExtensionOptions): ExtensionFactory {
  // The tool runtime's onUpdate is structurally the orchestrator's private
  // OnUpdateCallback; the DI signature widens it to unknown, so narrow back
  // to the exact parameter type at the call site.
  const executor: SkillExecutor =
    execute ??
    ((req, signal, onUpdate, ctx) =>
      runSubagentRequest(req, signal, onUpdate as Parameters<typeof runSubagentRequest>[2], ctx));

  // 工厂创建时解析一次：内置目录与 argv 在运行期不变。
  const extraDirs = options?.extraSkillDirs ?? defaultSkillDirs();

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "skill",
      label: "Skill",
      description: [
        "List available skills or dispatch a skill to an isolated subagent (worker) that follows the skill's instructions.",
        "Skills are discovered from ~/.pico/agent/skills/, <project>/.pico/skills/, and --skill paths.",
        "action=list enumerates skills; action=run executes <name> in a dedicated subagent with the skill's instructions as its task.",
      ].join(" "),
      parameters: SkillParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const skills = discoverSkills(ctx.cwd, extraDirs);

        if (params.action === "run") {
          if (!params.name) {
            throw toolError("invalid_request", "'name' is required for action=run");
          }
          const skill = findSkill(skills, params.name);
          if (!skill) {
            const available = skills.map((s) => s.name);
            const listed =
              available.length > 0
                ? available.join(", ")
                : "none. Place SKILL.md files in ~/.pico/agent/skills/ or <project>/.pico/skills/.";
            throw toolError(
              "invalid_request",
              `Skill "${params.name}" not found. Available skills: ${listed}`,
              { structured: { available } },
            );
          }

          const instructions = readSkillInstructions(skill);
          let task = `You are executing the skill "${skill.name}". Follow its instructions.\n\n${instructions}`;
          if (params.goal) task += `\n\nUser goal: ${params.goal}`;

          const result = await executor(
            { agent: "worker", task, cwd: params.cwd ?? ctx.cwd },
            signal,
            onUpdate,
            ctx as SubagentRunContext,
          );
          const text = joinTextContent(result.content);
          if ((result as { isError?: boolean }).isError) {
            throw toolError("server_error", text || "Skill execution failed");
          }
          return { content: [{ type: "text", text }], details: { action: "run", skill: skill.name } };
        }

        // action === "list"
        const text = formatSkillList(skills);
        return { content: [{ type: "text", text }], details: { action: "list", count: skills.length } };
      },
    });
  };
}

export default createSkillExtension();
