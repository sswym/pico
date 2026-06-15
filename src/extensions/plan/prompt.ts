/**
 * System-prompt block injected while plan mode is active.
 *
 * The model is told to:
 *   1. Stay read-only — only `read`, `grep`, `find`, `ls` are allowed.
 *   2. Write the plan to a file we own (path is appended at injection time).
 *   3. Hand back to the user via the `ExitPlanMode` tool, which prompts the
 *      user to approve the plan before any writes happen.
 */
export const PLAN_MODE_BLOCK = `## Plan Mode is ACTIVE

You are in plan mode. The user has not yet approved any changes.

Hard rules while plan mode is active:
- Do NOT call write-capable tools: bash, edit, write, NotebookEdit. The harness will block them.
- Use only read-only research tools: read, grep, find, ls.
- Investigate the request thoroughly before proposing a plan. Read the
  relevant files, trace the call sites, confirm assumptions.
- Write your plan to the plan file (path provided below) using the read tool
  to inspect existing content if any. The plan should be a numbered list of
  concrete steps with verification criteria.
- When the plan is complete, call \`ExitPlanMode\` to ask the user for
  approval. Only after approval will write tools become available again.

Do not promise diffs in plan mode. Describe what you would change; the user
will explicitly approve before any edits run.`;
