/**
 * System-prompt block injected while plan mode is active.
 *
 * The model is told to:
 *   1. Stay read-only — only `read`, `grep`, `find`, `ls` are allowed.
 *   2. Write the plan to a file we own (path is appended at injection time).
 *   3. Hand back to the user via the `ExitPlanMode` tool, which prompts the
 *      user to approve the plan before any writes happen.
 */
import PLAN_MODE_BLOCK from "../../prompts/plan-mode.md" with { type: "text" };

export { PLAN_MODE_BLOCK };