---
name: agents-init
description: Audit existing AGENTS.md and propose targeted edits (do not overwrite).
---

Use this skill when an `AGENTS.md` already exists in the project and
the user wants it improved. This is the audit-and-patch counterpart to
`/init`: `/init` writes a fresh file from scratch; this skill reads
what's there, identifies gaps, and proposes a diff.

## Hard rules

- Do **not** overwrite `AGENTS.md`. Propose changes; let the user
  apply them (or apply them as a focused Edit after they say yes).
- Do **not** "rewrite for clarity" sections that are already accurate.
  Drift is the failure mode here — the existing AGENTS.md is what
  callers rely on.
- If `AGENTS.md` doesn't exist, stop and tell the user to run `/init`
  instead. This skill is purely for audit.

## Procedure

1. Read the existing `AGENTS.md` end-to-end.
2. Spot-check it against reality:
   - Build / test / lint commands → does `package.json` actually
     define them, with the same names?
   - Directory layout claims → does the tree match?
   - Style notes → do recent files in `src/` follow them, or has the
     code drifted?
   - Tooling notes (Bun vs Node, package manager, etc.) → do the
     scripts and lockfile agree?
3. Note any major area of the project that AGENTS.md doesn't mention
   yet (new extensions, new top-level commands, new skills).

## Output shape

Return a numbered list of proposed edits, each with:

- **Where**: section heading or `file:line` anchor in AGENTS.md
- **Why**: the mismatch or gap, in one sentence
- **Suggested change**: the exact text to add/replace (short — one
  paragraph max per edit)

End with a one-line summary: "N edits proposed; apply with /edit?"
Wait for the user before changing the file.
