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
 * Parse `--skill <path>` (separated form only) from argv, mirroring upstream
 * args.js behavior. The bundled skills dir injected by src/runtime/args.ts is
 * therefore picked up automatically. Tolerates `--skill` as the last argv
 * element with no following value (skipped).
 */
function skillPathsFromArgv(): string[] {
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

export function createSkillExtension(execute?: SkillExecutor): ExtensionFactory {
  // The tool runtime's onUpdate is structurally the orchestrator's private
  // OnUpdateCallback; the DI signature widens it to unknown, so narrow back
  // to the exact parameter type at the call site.
  const executor: SkillExecutor =
    execute ??
    ((req, signal, onUpdate, ctx) =>
      runSubagentRequest(req, signal, onUpdate as Parameters<typeof runSubagentRequest>[2], ctx));

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
        const skills = discoverSkills(ctx.cwd, skillPathsFromArgv());

        if (params.action === "run") {
          if (!params.name) {
            throw toolError("invalid_request", "'name' is required for action=run");
          }
          const skill = findSkill(skills, params.name);
          if (!skill) {
            const available = skills.map((s) => s.name);
            throw toolError(
              "invalid_request",
              `Skill "${params.name}" not found. Available skills: ${available.join(", ")}`,
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

export const skillExtension: ExtensionFactory = createSkillExtension();
export default skillExtension;
