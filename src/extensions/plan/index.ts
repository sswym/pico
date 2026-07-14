/**
 * srcode plan extension — read-only "plan first, edit later" mode.
 *
 * Mirrors Claude Code's plan mode: while active, the LLM may only research
 * (read/grep/find/ls) and write its plan to a session-scoped markdown file.
 * Calls to bash/edit/write/NotebookEdit are blocked at the `tool_call` event
 * with a reason that points the model at the plan file. The block ends when
 * the model invokes `ExitPlanMode`, which surfaces the plan to the user via
 * `ctx.ui.confirm` and lets the user approve before writes resume.
 *
 * Non-interactive runs stay in plan mode unless
 * SRCODE_ALLOW_UNATTENDED_PLAN_APPROVAL=1 is set.
 *
 * State is module-level (`planActive`, `planFile`) on purpose — there is one
 * extension instance per srcode process, and that process owns one logical
 * plan-mode toggle at a time. Persistence to ~/.srcode/plans/<sid>.md
 * means re-entering plan mode in the same session resumes the existing plan.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { renderToolCallText, renderToolResultText } from "../tool-render.ts";
import { srcodeHome } from "../paths.ts";
import { allowUnattendedPlanApproval } from "../policy.ts";
import { PLAN_MODE_BLOCK } from "./prompt.ts";

// Tools that mutate the world. Blocked while plan mode is active.
const WRITE_TOOLS = new Set(["bash", "edit", "write", "NotebookEdit"]);

const SESSION_FALLBACK = "default";

// Module-level state: one srcode process == one plan-mode toggle. The
// extension factory runs once at startup, so this state lives for the
// process lifetime. We accept the global because pi-coding-agent does not
// expose a per-extension state slot, and threading state through the API
// surface (tools, commands, event handlers) would just repackage the same
// closure variables.
let planActive = false;
let planFile: string | null = null;

function plansDir(): string {
  return join(srcodeHome(), "plans");
}

function resolvePlanFile(ctx: ExtensionContext): string {
  let sid: string | undefined;
  try {
    sid = ctx.sessionManager?.getSessionId?.();
  } catch {
    sid = undefined;
  }
  const safe = (sid && sid.trim().length > 0 ? sid : SESSION_FALLBACK).replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(plansDir(), `${safe}.md`);
}

const PLAN_TEMPLATE = `# Plan

_Plan mode is active. Replace this placeholder with your numbered plan and call \`ExitPlanMode\` when ready._

## Goal

(Describe the desired outcome.)

## Steps

1.
`;

async function ensurePlanFile(path: string): Promise<void> {
  mkdirSync(plansDir(), { recursive: true });
  if (!existsSync(path)) {
    await Bun.write(path, PLAN_TEMPLATE);
  }
}

async function readPlanFile(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

const EmptyParams = Type.Object({});

export const planExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  // ---- EnterPlanMode ----------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "EnterPlanMode",
      label: "EnterPlanMode",
      description:
        "Enter plan mode. While in plan mode, only read/grep/find/ls are usable; bash/edit/write are blocked. Write your plan to the plan file path returned by this call, then call ExitPlanMode for user approval.",
      promptSnippet:
        "EnterPlanMode — switch to read-only research; bash/edit/write are blocked until ExitPlanMode is approved.",
      parameters: EmptyParams,
      renderCall(args, theme, context) {
        return renderToolCallText("EnterPlanMode", args, theme, context);
      },
      renderResult(result, options, theme, context) {
        return renderToolResultText(result, options, theme, context);
      },
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        planActive = true;
        planFile = resolvePlanFile(ctx);
        await ensurePlanFile(planFile);
        const text =
          `Plan mode enabled. Plan file: ${planFile}\n` +
          `Use read/grep/find/ls only. Write the plan to that file, then call ExitPlanMode.`;
        return {
          content: [{ type: "text" as const, text }],
          details: { planActive: true, planFile },
        };
      },
    }),
  );

  // ---- ExitPlanMode -----------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "ExitPlanMode",
      label: "ExitPlanMode",
      description:
        "Exit plan mode. Reads the plan file, asks the user to approve it, and (on approval) re-enables write tools so the plan can be executed.",
      promptSnippet:
        "ExitPlanMode — surface the plan to the user for approval; only call after the plan file is complete.",
      parameters: EmptyParams,
      renderCall(args, theme, context) {
        return renderToolCallText("ExitPlanMode", args, theme, context);
      },
      renderResult(result, options, theme, context) {
        return renderToolResultText(result, options, theme, context);
      },
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const path = planFile ?? resolvePlanFile(ctx);
        const plan = await readPlanFile(path);
        const summary = plan.trim().length === 0 ? "(plan file is empty)" : plan;

        let approved = false;
        if (ctx.hasUI) {
          try {
            approved = await ctx.ui.confirm(
              "Approve plan?",
              `Plan from ${path}:\n\n${summary}\n\nApprove and exit plan mode?`,
            );
          } catch {
            approved = false;
          }
        } else if (allowUnattendedPlanApproval()) {
          approved = true;
        }

        if (approved) {
          planActive = false;
        }

        const text = approved
          ? `Plan approved. Plan mode disabled.\n\n${summary}`
          : ctx.hasUI
            ? `Plan rejected. Stay in plan mode and refine ${path}.`
            : `Plan requires interactive approval. Stay in plan mode and refine ${path}, or set SRCODE_ALLOW_UNATTENDED_PLAN_APPROVAL=1 for batch runs.`;

        return {
          content: [{ type: "text" as const, text }],
          details: { approved, planFile: path, plan: summary },
        };
      },
    }),
  );

  // ---- /plan command (user-initiated equivalent of EnterPlanMode) -------
  pi.registerCommand("plan", {
    description: "Enter plan mode (read-only research; ExitPlanMode to resume writes)",
    handler: async (_args, ctx) => {
      planActive = true;
      planFile = resolvePlanFile(ctx);
      await ensurePlanFile(planFile);
      try {
        ctx.ui.notify(`Plan mode enabled. Plan file: ${planFile}`, "info");
      } catch {}
    },
  });

  // ---- system prompt injection -----------------------------------------
  // Append the plan-mode rules + plan file path to the system prompt while
  // active. When planActive flips false, the injection drops automatically.
  pi.on("before_agent_start", (event) => {
    if (!planActive) return;
    const base = event.systemPrompt ?? "";
    const trailer = planFile ? `\n\nWrite/append your plan to: ${planFile}` : "";
    return { systemPrompt: `${base}\n\n${PLAN_MODE_BLOCK}${trailer}` };
  });

  // ---- block writes while plan mode is active ---------------------------
  pi.on("tool_call", (event) => {
    if (!planActive) return;
    if (!WRITE_TOOLS.has(event.toolName)) return;
    const target = planFile ?? "(plan file not yet initialised)";
    return {
      block: true,
      reason:
        `In plan mode. Use read/grep/find/ls to research, then write your plan to ${target}. ` +
        `Call ExitPlanMode for user approval before any writes.`,
    };
  });
};

// Test-only helpers. Tests can import these to reset module-level state
// between cases without re-importing the module.
export function __resetPlanStateForTests(): void {
  planActive = false;
  planFile = null;
}

export function __getPlanStateForTests(): { planActive: boolean; planFile: string | null } {
  return { planActive, planFile };
}

export default planExtension;
