/**
 * Skill catalog — pure skill discovery functions.
 *
 * Upstream pi-coding-agent injects skill *directories* (user, project, and
 * --skill paths) into the system prompt; the model reads SKILL.md files on
 * demand. This module is the pico-side counterpart: it discovers the same
 * directories locally so the skill tool can enumerate them and turn a
 * skill's instructions into an isolated subagent task.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { picoAgentHome } from "../paths.ts";

export type SkillSource = "user" | "project" | "path";

export interface SkillInfo {
  name: string;
  description: string; // 可能为空串
  filePath: string; // SKILL.md 绝对路径
  source: SkillSource;
}

/**
 * Frontmatter block: optional BOM, `---` opener, body, `---` closer.
 * Behavior-aligned with upstream loadSkills' frontmatter parsing; this
 * implementation keeps the block for readSkillInstructions to strip.
 */
const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * 解析单个 SKILL.md：frontmatter（--- 块）取 name/description。
 * 无 frontmatter → null（跳过）；frontmatter 有但缺 name → 用所在目录名
 * （dir 的 basename）兜底；解析失败/文件不可读 → null。description 缺省为空串。
 */
export function parseSkillFile(filePath: string, source: SkillSource): SkillInfo | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return null;

  const frontmatter = match[1] ?? "";
  const fields = new Map<string, string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    if (key.length === 0) continue;
    fields.set(key, stripQuotes(line.slice(sep + 1).trim()));
  }

  const name = (fields.get("name") ?? "").trim() || basename(dirname(filePath));
  return {
    name,
    description: fields.get("description") ?? "",
    filePath,
    source,
  };
}

/** 递归扫描目录下所有 SKILL.md（含子目录），非 .md 文件忽略；目录不存在返回 []。 */
export function scanSkillDir(dir: string, source: SkillSource): SkillInfo[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: SkillInfo[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...scanSkillDir(fullPath, source));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      const info = parseSkillFile(fullPath, source);
      if (info) found.push(info);
    }
  }
  return found;
}

/** 用户级技能目录：join(picoAgentHome(), "skills")。 */
export function userSkillsDir(): string {
  return join(picoAgentHome(), "skills");
}

/** 项目级技能目录：resolve(cwd, ".pico", "skills")。 */
export function projectSkillsDir(cwd: string): string {
  return resolve(cwd, ".pico", "skills");
}

/**
 * 汇总发现：user 目录 + project 目录 + extraDirs（--skill 注入的显式路径，
 * 目录或单个 SKILL.md 文件）。同名冲突 first-wins（user > project > path
 * 顺序加入）。返回按 name 排序。
 */
export function discoverSkills(cwd: string, extraDirs?: string[]): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  const add = (info: SkillInfo | null): void => {
    if (info && !byName.has(info.name)) byName.set(info.name, info);
  };

  for (const info of scanSkillDir(userSkillsDir(), "user")) add(info);
  for (const info of scanSkillDir(projectSkillsDir(cwd), "project")) add(info);
  for (const extra of extraDirs ?? []) {
    if (isFile(extra)) {
      add(parseSkillFile(extra, "path"));
    } else {
      for (const info of scanSkillDir(extra, "path")) add(info);
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** 读取技能说明正文：去掉 frontmatter 块后剩余内容，trim 后返回。 */
export function readSkillInstructions(skill: SkillInfo): string {
  let content: string;
  try {
    content = readFileSync(skill.filePath, "utf-8");
  } catch {
    return "";
  }
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return content.trim();
  return content.slice(match[0].length).trim();
}

/** value 去首尾引号（先 trim 空白再剥引号再 trim）。 */
function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim();
}

/** extraDirs 里显式传入的单个 SKILL.md 文件（非目录）。 */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
