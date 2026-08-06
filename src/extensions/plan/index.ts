/**
 * pico plan extension — read-only "plan first, edit later" mode.
 *
 * Mirrors Claude Code's plan mode: while active, the LLM may only research
 * (read/grep/find/ls) and write its plan to a session-scoped markdown file.
 * Calls to bash/edit/write/NotebookEdit are blocked at the `tool_call` event
 * with a reason that points the model at the plan file. The block ends when
 * the model invokes `ExitPlanMode`, which surfaces the plan to the user via
 * `ctx.ui.confirm` and lets the user approve before writes resume.
 *
 * Non-interactive runs stay in plan mode unless
 * PICO_ALLOW_UNATTENDED_PLAN_APPROVAL=1 is set.
 *
 * State is module-level (`planActive`, `planFile`) on purpose — there is one
 * extension instance per pico process, and that process owns one logical
 * plan-mode toggle at a time. Persistence to ~/.pico/plans/<sid>.md
 * means re-entering plan mode in the same session resumes the existing plan.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { renderToolCallText, renderToolResultText } from "../tool-render.ts";
import { picoHome } from "../paths.ts";
import { allowUnattendedPlanApproval } from "../policy.ts";
import { publishExtensionEvent } from "../events.ts";
import { PLAN_MODE_BLOCK } from "./prompt.ts";

const PLAN_ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "EnterPlanMode", "SubmitPlan", "ExitPlanMode"]);

/** Keep other extensions (e.g. the todo panel) in sync with plan mode. */
function publishPlanMode(active: boolean): void {
  publishExtensionEvent("plan_mode_changed", { active });
}

const SESSION_FALLBACK = "default";

// Module-level state: one pico process == one plan-mode toggle. The
// extension factory runs once at startup, so this state lives for the
// process lifetime. We accept the global because pi-coding-agent does not
// expose a per-extension state slot, and threading state through the API
// surface (tools, commands, event handlers) would just repackage the same
// closure variables.
let planActive = false;
let planFile: string | null = null;

function plansDir(): string {
  return join(picoHome(), "plans");
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
const SubmitPlanParams = Type.Object({
  content: Type.String({ description: "Complete plan text to save for user approval." }),
});

export const planExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  // ---- EnterPlanMode ----------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "EnterPlanMode",
      label: "EnterPlanMode",
      description:
        "Enter plan mode. While in plan mode, only read/grep/find/ls and plan tools are usable. Call SubmitPlan with your complete plan, then call ExitPlanMode for user approval.",
      promptSnippet:
        "EnterPlanMode — switch to read-only research; submit the plan with SubmitPlan before ExitPlanMode.",
      parameters: EmptyParams,
      renderCall(args, theme, context) {
        return renderToolCallText("EnterPlanMode", args, theme, context);
      },
      renderResult(result, options, theme, context) {
        return renderToolResultText(result, options, theme, context);
      },
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const path = resolvePlanFile(ctx);
        // Create the plan file BEFORE activating: if the write fails (read-only
        // plans dir, disk full), plan mode must not stay locked with no way to
        // submit a plan.
        await ensurePlanFile(path);
        planActive = true;
        planFile = path;
        publishPlanMode(true);
        const text =
          `Plan mode enabled. Plan file: ${planFile}\n` +
          `Use read/grep/find/ls only. Call SubmitPlan with the complete plan, then call ExitPlanMode.`;
        return {
          content: [{ type: "text" as const, text }],
          details: { planActive: true, planFile },
        };
      },
    }),
  );

  // ---- SubmitPlan ------------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "SubmitPlan",
      label: "SubmitPlan",
      description:
        "Save the complete plan while plan mode is active. This is the only write-like action allowed before ExitPlanMode approval.",
      promptSnippet:
        "SubmitPlan — save the complete plan for ExitPlanMode approval while plan mode is active.",
      parameters: SubmitPlanParams,
      renderCall(args, theme, context) {
        return renderToolCallText("SubmitPlan", args, theme, context);
      },
      renderResult(result, options, theme, context) {
        return renderToolResultText(result, options, theme, context);
      },
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (!planActive) {
          throw new Error("Plan mode is not active.");
        }
        const path = planFile ?? resolvePlanFile(ctx);
        planFile = path;
        await ensurePlanFile(path);
        const content = params.content.trimEnd();
        // Atomic write: a crash or full disk mid-write must not truncate the
        // previously approved plan.
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, content.length > 0 ? `${content}\n` : "", "utf8");
        renameSync(tmp, path);
        return {
          content: [{ type: "text" as const, text: `Plan saved to ${path}. Call ExitPlanMode when ready for approval.` }],
          details: { planActive: true, planFile: path },
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
        if (!planActive) {
          // Calling ExitPlanMode outside plan mode would pop a pointless
          // approval dialog and report a state change that never happened.
          throw new Error("Plan mode is not active. Call EnterPlanMode first.");
        }
        const path = planFile ?? resolvePlanFile(ctx);
        const plan = await readPlanFile(path);
        // A model-submitted plan can be arbitrarily large; the approval
        // dialog must not render megabytes of text into the TUI.
        const MAX_SUMMARY_CHARS = 4000;
        // Slice by code points, not UTF-16 units: a raw slice can split a
        // surrogate pair and render a lone half-emoji in the dialog.
        const planChars = Array.from(plan);
        const summary = plan.trim().length === 0
          ? "(plan file is empty)"
          : planChars.length > MAX_SUMMARY_CHARS
            ? `${planChars.slice(0, MAX_SUMMARY_CHARS).join("")}\n…[plan truncated for display — full text stays in ${path}]`
            : plan;

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
          publishPlanMode(false);
        } else if (!ctx.hasUI) {
          // 2.5.6: non-interactive runs without PICO_ALLOW_UNATTENDED_PLAN_APPROVAL
          // used to deadlock — ExitPlanMode always answered "needs interactive
          // approval" and the model was stuck in read-only plan mode forever,
          // only killable by killing the process. Auto-release the lock:
          // the batch run gets an explicit "not approved" and writes are
          // re-enabled; the model may re-enter plan mode if it needs to.
          planActive = false;
          publishPlanMode(false);
        }

        const text = approved
          ? `Plan approved. Plan mode disabled.\n\n${summary}`
          : !ctx.hasUI
            ? `Plan NOT approved (non-interactive). Plan mode disabled and write tools re-enabled. ` +
              `For automatic approval in batch runs, set PICO_ALLOW_UNATTENDED_PLAN_APPROVAL=1.`
            : `Plan rejected. Stay in plan mode and refine ${path}.`;

        return {
          content: [{ type: "text" as const, text }],
          details: { approved, planFile: path, plan: summary },
        };
      },
    }),
  );

  // ---- /plan command (user-initiated equivalent of EnterPlanMode) -------
  pi.registerCommand("plan", {
    description: "Enter plan mode (read-only research; ExitPlanMode to resume writes). /plan off exits plan mode.",
    handler: async (args, ctx) => {
      // 2.5.6: `/plan` could previously only ENTER plan mode — a user who
      // wanted out had no command (only /reload). `/plan off` now exits.
      if (args.trim().toLowerCase() === "off" || args.trim().toLowerCase() === "exit") {
        if (!planActive) {
          try { ctx.ui.notify("Plan mode is not active.", "info"); } catch {}
          return;
        }
        planActive = false;
        planFile = null;
        publishPlanMode(false);
        try {
          ctx.ui.notify("Plan mode disabled. Write tools re-enabled.", "info");
        } catch {}
        return;
      }
      const path = resolvePlanFile(ctx);
      await ensurePlanFile(path);
      planActive = true;
      planFile = path;
      publishPlanMode(true);
      try {
        ctx.ui.notify(`Plan mode enabled. Plan file: ${planFile}`, "info");
      } catch {}
    },
  });

  // Leaving a session must not carry plan mode (or its stale plan file) into
  // the next session — writes would stay blocked against the wrong file.
  pi.on("session_before_switch", () => {
    if (planActive) publishPlanMode(false);
    planActive = false;
    planFile = null;
    return {};
  });
  pi.on("session_before_fork", () => {
    if (planActive) publishPlanMode(false);
    planActive = false;
    planFile = null;
    return {};
  });

  // ---- system prompt injection -----------------------------------------
  // Append the plan-mode rules + plan file path to the system prompt while
  // active. When planActive flips false, the injection drops automatically.
  pi.on("before_agent_start", (event) => {
    if (!planActive) return;
    const base = event.systemPrompt ?? "";
    const trailer = planFile ? `\n\nSubmitPlan will save the plan for review at: ${planFile}` : "";
    return { systemPrompt: `${base}\n\n${PLAN_MODE_BLOCK}${trailer}` };
  });

  // ---- block non-plan, non-read tools while plan mode is active ---------
  pi.on("tool_call", (event) => {
    if (!planActive) return;
    if (PLAN_ALLOWED_TOOLS.has(event.toolName)) return;
    const target = planFile ?? "(plan file not yet initialised)";
    return {
      block: true,
      reason:
        `In plan mode. Use read/grep/find/ls to research, then call SubmitPlan to save the plan to ${target}. ` +
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
