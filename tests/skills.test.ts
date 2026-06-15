/**
 * Bundled-skills smoke test.
 *
 * srcode ships three skills under src/skills/ that bin/srcode.ts wires
 * into the agent via `--skill`. We don't test the wiring here (that's a
 * shell-arg concern); we just confirm the on-disk skills load cleanly
 * through pi-coding-agent's own loader, with the metadata downstream
 * consumers (system-prompt formatter, /skill commands) rely on.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(here, "..", "src", "skills");

test("loadSkillsFromDir returns the three bundled skills with non-empty descriptions", () => {
  const { skills, diagnostics } = loadSkillsFromDir({ dir: skillsDir, source: "bundled" });

  expect(diagnostics).toEqual([]);
  expect(skills).toHaveLength(3);

  const names = skills.map((s) => s.name).sort();
  expect(names).toEqual(["agents-init", "recap", "verify"]);

  for (const skill of skills) {
    expect(skill.description.length).toBeGreaterThan(0);
  }
});

test("each bundled SKILL.md body has substantive content (>=100 chars after frontmatter)", () => {
  const { skills } = loadSkillsFromDir({ dir: skillsDir, source: "bundled" });

  for (const skill of skills) {
    const raw = readFileSync(skill.filePath, "utf8");
    // Strip the leading frontmatter block before measuring body length so
    // we're checking the actual instructions, not the metadata header.
    const body = raw.replace(/^---[\s\S]*?---\s*/, "");
    expect(body.length).toBeGreaterThanOrEqual(100);
  }
});
