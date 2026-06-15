---
name: recap
description: Summarise recent work and stored project memory.
---

Use this skill when the user asks "what have we been doing", "where
were we", or otherwise wants a recap of recent work in the current
project. The goal is a tight summary the user can scan in 30 seconds —
not a transcript.

## Procedure

1. **Pull stored decisions from memory.** Call the `memory` tool with
   `action: "search"` and a short query that matches the active topic
   (e.g. `query: "auth refactor"` or whatever the user's last few
   prompts have been about). If no topic is obvious, search for the
   project name or `recent`. Read the top 3-5 hits — these are the
   load-bearing decisions and should anchor the recap.
2. **List recently changed files.** Look at the git log / working tree
   to see what's been edited. Group related files together (e.g. "auth
   extension: 3 files" rather than listing each).
3. **Synthesize.** Combine the memory hits and the file list into a
   short narrative: what was decided, what got built, what's still
   open.

## Output shape

Three sections, each tight:

- **Context** (1-2 lines): what the user was working on
- **Recent changes** (3-5 bullets): grouped file edits with one-line why
- **Suggested next steps** (3-5 bullets): concrete actions, each
  phrased as a verb the user can act on ("write tests for X",
  "decide whether Y", not "consider thinking about Z")

Skip anything you can't ground in the memory hits or the file changes —
better to return a short honest recap than a padded one.
