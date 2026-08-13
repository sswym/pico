/**
 * Bundled-skills smoke test.
 *
 * pico ships the six ponytail skills under src/skills/ (vendored 2026-08):
 * the loader must report exactly that set with no diagnostics. If bundled
 * skills change, update these assertions to the new skill set.
 */
import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(here, "..", "src", "skills");

test("loadSkillsFromDir reports the six bundled ponytail skills", () => {
  const { skills, diagnostics } = loadSkillsFromDir({ dir: skillsDir, source: "bundled" });

  expect(skills.map((s) => s.name).sort()).toEqual([
    "ponytail",
    "ponytail-audit",
    "ponytail-debt",
    "ponytail-gain",
    "ponytail-help",
    "ponytail-review",
  ]);
  expect(diagnostics).toEqual([]);
});
