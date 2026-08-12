/**
 * Bundled-skills smoke test.
 *
 * pico no longer ships bundled skills under src/skills/ (removed in
 * ed277d3): the loader must report an empty set with no diagnostics, and
 * this test pins that contract. If bundled skills are re-added, update
 * these assertions to the new skill set.
 */
import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(here, "..", "src", "skills");

test("loadSkillsFromDir reports no bundled skills and no diagnostics", () => {
  const { skills, diagnostics } = loadSkillsFromDir({ dir: skillsDir, source: "bundled" });

  expect(skills).toHaveLength(0);
  expect(diagnostics).toEqual([]);
});
