---
name: verify
description: Run lint + typecheck + tests; report failures concisely.
---

Use this skill after making code changes to confirm the project still
lints, typechecks, and tests cleanly. The point is verification, not
exploration — run the project's own checks, then report.

## Procedure

1. Read `package.json` first. Run scripts the project actually defines,
   in this order, skipping any that don't exist:
   - lint:    `bun run lint` (or fall back to the repo's configured linter)
   - types:   `bunx tsc --noEmit`
   - tests:   `bun test`
2. If a step fails, stop the chain — there's no point running tests on
   code that doesn't compile. Surface the failure first.
3. Don't "fix" anything. This skill verifies; remediation is a separate
   decision the user makes after reading the report.

## Reporting

For each step, print one of:
- `lint: ok`
- `types: ok`
- `tests: 42 pass / 0 fail`

For failures, include the failing locations as `path/to/file.ts:42`
references (clickable in most terminals) plus the one-line error. Trim
stack traces — the file:line and message are what matter. If output is
long, keep the first 2-3 failures and note `(+N more)`.

## What this skill does NOT do

- Run formatters that rewrite files (`prettier --write`, etc.)
- Update snapshots, regenerate fixtures, or change test expectations
- Skip steps because "it probably still passes"
