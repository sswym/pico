/**
 * ponytail — 规则文本构建（pico 内置版）。
 *
 * 移植自 https://github.com/DietrichGebert/ponytail（MIT）hooks/ponytail-instructions.js
 * v4.9.0。适配点：SKILL.md 改为读 pico 内置技能（编译模式嵌入式资源优先，
 * 源码模式磁盘 fallback）；注入文本用 PICO_CACHE_STABLE 标记把模式无关段
 * 送进 provider 缓存前缀——模式相关片段（模式行、Current level、Intensity
 * 表格）留在标记外，切换 lite/full/ultra 不会使整前缀缓存失效。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getEmbeddedContent } from "../embedded-assets.ts";
import { DEFAULT_MODE, normalizeMode, normalizePersistedMode } from "./config.ts";

const INDEPENDENT_MODES = new Set(["review"]);

/** 稳定段标记：cache-optimizer 会把标记内的文本提取进缓存前缀。 */
const STABLE_START = "<!-- PICO_CACHE_STABLE:START -->";
const STABLE_END = "<!-- PICO_CACHE_STABLE:END -->";

/** 内置技能资源 key（scripts/build.ts 以 skills/<rel> 嵌入 src/skills/ 下文件）。 */
const EMBEDDED_SKILL_KEY = "skills/ponytail/SKILL.md";
/** 源码模式磁盘路径：src/extensions/ponytail/instructions.ts → src/skills/ponytail/SKILL.md。 */
const DISK_SKILL_PATH = resolve(import.meta.dir, "..", "..", "skills", "ponytail", "SKILL.md");

let cachedSkillBody: string | null | undefined;

/**
 * 按模式过滤 SKILL.md 正文：只保留当前模式的 Intensity 表格行和 worked
 * example，其余规则逐字保留（上游逻辑原样）。
 */
export function filterSkillBodyForMode(body: string, mode: string): string {
  const effectiveMode = normalizeMode(mode) || DEFAULT_MODE;
  const withoutFrontmatter = String(body || "").replace(/^---[\s\S]*?---\s*/, "");

  // 只有 Intensity 表格行和 worked examples 是模式相关的，且都以模式名为
  // key；标签不是模式名的行（如 "No unrequested abstractions: ..."）是普通
  // 规则，必须逐字保留。
  return withoutFrontmatter
    .split(/\r?\n/)
    .filter((line) => {
      const tableLabel = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|/);
      if (tableLabel) {
        const labelMode = normalizeMode(tableLabel[1]!.trim());
        if (labelMode) return labelMode === effectiveMode;
      }

      // 要求带引号的值：每个 worked example 都是 `- lite: "..."`。没有这个
      // 条件，恰好以模式词开头的普通规则行（如 "- Full: ..."）会在其它模式
      // 下被静默丢弃——它看起来像 example 但实为逐字保留的散文。
      const exampleLabel = line.match(/^-\s*([^:]+):\s*"/);
      if (exampleLabel) {
        const labelMode = normalizeMode(exampleLabel[1]!.trim());
        if (labelMode) return labelMode === effectiveMode;
      }

      return true;
    })
    .join("\n");
}

/**
 * 拆分模式过滤后的正文：stable = 跨 lite/full/ultra 字节一致的部分（除模式
 * 行、Current level 行、整个 Intensity 段外的一切）；modeSpecific = 随模式
 * 变化的部分。稳定段进缓存前缀，模式段留在标记外。
 */
function splitModeSpecific(body: string): { stable: string; modeSpecific: string } {
  const lines = String(body || "").split(/\r?\n/);
  const stable: string[] = [];
  const modeSpecific: string[] = [];
  let inIntensity = false;
  for (const line of lines) {
    if (/^##\s+Intensity\s*$/.test(line)) inIntensity = true;
    else if (/^##\s+/.test(line)) inIntensity = false;
    if (inIntensity || /^PONYTAIL MODE ACTIVE — level:/.test(line.trim()) || /^Current level:\s*\*\*/.test(line.trim())) {
      modeSpecific.push(line);
    } else {
      stable.push(line);
    }
  }
  return {
    stable: stable.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    modeSpecific: modeSpecific.join("\n").trim(),
  };
}

function assembleInstructions(effectiveMode: string, body: string): string {
  const { stable, modeSpecific } = splitModeSpecific(body);
  return (
    `PONYTAIL MODE ACTIVE — level: ${effectiveMode}\n\n` +
    `${STABLE_START}\n${stable}\n${STABLE_END}` +
    (modeSpecific ? `\n\n${modeSpecific}` : "")
  );
}

/** SKILL.md 读取失败时的兜底规则文本（与上游 fallback 逐字一致）。 */
function getFallbackInstructions(mode: string): string {
  return (
    "PONYTAIL MODE ACTIVE — level: " + mode + "\n\n" +
    "You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.\n\n" +
    "## Persistence\n\n" +
    'ACTIVE EVERY RESPONSE. No drift back to over-building. Still active if unsure. Off only: "stop ponytail" / "normal mode".\n\n' +
    "Current level: **" + mode + "**. Switch: `/ponytail lite|full|ultra`.\n\n" +
    "## The ladder\n\n" +
    "Before any code, stop at the first rung that holds (the ladder runs after you understand the problem, not instead of it — read the code it touches and trace the real flow first):\n" +
    "1. Does this need to be built at all? (YAGNI)\n" +
    "2. Does it already exist in this codebase? Reuse what is already here, do not re-write it.\n" +
    "3. Does the standard library do this? Use it.\n" +
    "4. Does a native platform feature cover it? Use it.\n" +
    "5. Does an already-installed dependency solve it? Use it.\n" +
    "6. Can this be one line? Make it one line.\n" +
    "7. Only then: write the minimum code that works.\n\n" +
    "Bug fix = root cause, not symptom: grep every caller of the function you touch and fix the shared function once (a smaller diff than one guard per caller); patching only the path the ticket names leaves a sibling caller broken.\n\n" +
    "## Rules\n\n" +
    "No abstractions that were not requested. No avoidable dependencies. No boilerplate nobody asked for. " +
    "Deletion over addition. Boring over clever. Fewest files possible. " +
    "Ship the lazy version and question the complex request in the same response — never stall. " +
    "Between two same-size stdlib options, pick the one correct on edge cases. " +
    "Mark deliberate simplifications that cut a real corner with a known ceiling, using a `ponytail:` comment that names the ceiling and upgrade path.\n\n" +
    "## Output\n\n" +
    "Code first. Then at most three short lines: what was skipped, when to add it. " +
    "If the explanation is longer than the code, delete the explanation. " +
    "Explanation the user explicitly asked for is not debt, give it in full.\n\n" +
    "## When NOT to be lazy\n\n" +
    "Never simplify away: understanding the problem (read it fully and trace the real flow before picking a rung — a small diff you do not understand is just laziness dressed up as efficiency), input validation at trust boundaries, error handling that prevents data loss, " +
    "security measures, accessibility basics, the calibration real hardware needs (the platform is never the spec ideal), anything the user explicitly asked to keep. " +
    "Lazy code without its check is unfinished: non-trivial logic leaves ONE runnable check behind (assert-based demo/self-check or one small test file; no frameworks). Trivial one-liners need no test.\n\n" +
    "## Boundaries\n\n" +
    'Ponytail governs what you build, not how you talk. "stop ponytail" or "normal mode": revert. Level persists until changed or session end.'
  );
}

/**
 * 读内置 SKILL.md 正文：嵌入式资源优先（编译二进制），磁盘 fallback（源码
 * 模式）。都不可得返回 null（调用方走 fallback 规则文本）。
 */
export function readPonytailSkillBody(): string | null {
  if (cachedSkillBody !== undefined) return cachedSkillBody;
  let body: string | null = null;
  const embedded = getEmbeddedContent(EMBEDDED_SKILL_KEY);
  if (embedded !== null) {
    body = embedded;
  } else {
    try {
      body = readFileSync(DISK_SKILL_PATH, "utf8");
    } catch {
      body = null;
    }
  }
  cachedSkillBody = body;
  return body;
}

/** 测试钩子：清空技能内容缓存（pico 测试约定 __reset*ForTests）。 */
export function __resetPonytailSkillCacheForTests(): void {
  cachedSkillBody = undefined;
}

/** 按模式生成注入 system prompt 的规则文本。 */
export function getPonytailInstructions(mode: string): string {
  const configuredMode = normalizePersistedMode(mode) || DEFAULT_MODE;

  if (INDEPENDENT_MODES.has(configuredMode)) {
    return `PONYTAIL MODE ACTIVE — level: ${configuredMode}. Behavior defined by /ponytail-${configuredMode} skill.`;
  }

  const effectiveMode = normalizeMode(configuredMode) || DEFAULT_MODE;

  const body = readPonytailSkillBody();
  if (body !== null) {
    return assembleInstructions(effectiveMode, filterSkillBodyForMode(body, effectiveMode));
  }
  return assembleInstructions(effectiveMode, getFallbackInstructions(effectiveMode));
}
