# Multi-Agent Workflow Principles

> These guidelines apply when orchestrating subagents for complex, multi-phase work.

## Core Principles

1. **Plan before code.** For non-trivial tasks, plan first, execute second, verify last. Keep each phase explicit and verifiable.

2. **Delegate by role.** Use specialized agents for their strengths:
   - `architect` — architecture decisions and tradeoffs
   - `planner` — task decomposition and dependency mapping
   - `product` — PRD-level scoping and acceptance criteria
   - `consultant` — strategic analysis and decision frameworks
   - `consensus` — converging on one option from many
   - `executor` — implementation and refactoring
   - `reviewer` — code review and quality checks
   - `verifier` — acceptance testing and regression checks
   - `debugger` — problem diagnosis and root cause
   - `researcher` — documentation lookup and technical research
   - `director` — multi-role team orchestration
   - `editor` — final output assembly and polishing
   - `quick` — tiny, low-risk fixes

3. **Minimize context load.** Read only what the current step needs. Summarize before handing off to another agent.

4. **Always verify at the end.** Run relevant tests and checks. Report changed files, known risks, and follow-up actions.

5. **Gate on intent when scope is unclear.** Classify tasks into planning, execution, verification, or research before acting. If acceptance criteria are missing, don't jump to implementation.

## Team Pipeline (for complex work)

When a task spans architecture, implementation, and verification:

1. **Plan** — `architect` + `planner` decompose the task and map dependencies.
2. **Scope** — `product` locks down scope, constraints, and acceptance criteria.
3. **Execute** — `executor` implements one verified slice at a time.
4. **Verify** — `reviewer` + `verifier` check correctness, regressions, and acceptance criteria.
5. **Fix** — If verification fails, `debugger` + `executor` fix issues, then re-verify.

Repeat Execute → Verify → Fix until acceptance criteria pass or a blocking issue is escalated.

## Safety Guards

- Never claim completion without verified evidence.
- Never declare "done" when there are unresolved blocking issues or failed verification gates.
- Stop the autonomous loop when blocked by missing requirements, missing permissions, or repeated failures.
- Surface blockers explicitly — don't hide or suppress them.
