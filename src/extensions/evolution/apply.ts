/**
 * evolution 落盘：输出校验、技能名消毒、注入检查、SKILL.md 写入 + 清单维护。
 *
 * 安全模型：审查通道 = 外部数据（网页/MCP 内容）→ 辅助模型 → SKILL.md →
 * 下一会话系统提示词注入。技能内容是"指令"，安全等级高于记忆，因此：
 *  - 只写 ~/.pico/agent/skills/ 下自己创建过的技能（.pico-evolved.json 清单），
 *    用户手写技能永不触碰；
 *  - 磁盘 mtime 比清单 updatedAt 新 → 用户改过，跳过本轮；
 *  - 注入特征（ignore previous instructions 等）与用户门禁词（PICO_EVOLUTION_DENY）
 *    命中即拒写。
 *
 * 本模块不做任何模型调用；模型输出永远只经 validate → apply 两步落盘。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { picoAgentHome } from "../paths.ts";
import type { EvolutionConfig } from "./state.ts";
import type { ReviewOutput } from "./review.ts";

export interface ValidatedReview {
  create: Array<{ name: string; description: string; content: string }>;
  update: Array<{ name: string; content: string }>;
}

export interface ApplyResult {
  created: string[];
  updated: string[];
  skipped: Array<{ name: string; reason: string }>;
}

interface ManifestEntry {
  createdAt: string;
  updatedAt: string;
  /** 被 skill action=run 显式调用的累计次数（非自产技能不入清单，永不记录）。 */
  useCount: number;
  /** 最近一次调用的 ISO 时间；从未调用为 null。 */
  lastUsedAt: string | null;
  /** 最近一次调用结果；从未调用为 null。 */
  lastResult: "success" | "error" | null;
}

interface Manifest {
  version: 1;
  skills: Record<string, ManifestEntry>;
}

const MANIFEST_FILE = ".pico-evolved.json";
const ARCHIVE_DIR = ".archive";
/** 手动 curator 的 stale 阈值。 */
export const STALE_DAYS = 30;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LEN = 40;
const MIN_NAME_LEN = 3;
const MAX_DESCRIPTION_LEN = 200;
/** 输出侧注入特征（同 hermes skills_tool.py 的 INJECTION_PATTERNS 思路）。 */
const INJECTION_PATTERNS = [
  "ignore previous instructions",
  "ignore all previous instructions",
  "forget your instructions",
  "new instructions:",
  "disregard previous instructions",
];

/** 与 skill/catalog.ts 的 userSkillsDir 保持一致（join(picoAgentHome(), "skills")）。 */
export function userSkillsDir(): string {
  return join(picoAgentHome(), "skills");
}

export function manifestPath(): string {
  return join(userSkillsDir(), MANIFEST_FILE);
}

function normalizeEntry(e: unknown): ManifestEntry {
  if (!e || typeof e !== "object") {
    return { createdAt: "", updatedAt: "", useCount: 0, lastUsedAt: null, lastResult: null };
  }
  const rec = e as Record<string, unknown>;
  const lastResult = rec.lastResult === "success" || rec.lastResult === "error" ? rec.lastResult : null;
  return {
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : "",
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : "",
    useCount: typeof rec.useCount === "number" && Number.isFinite(rec.useCount) && rec.useCount >= 0 ? rec.useCount : 0,
    lastUsedAt: typeof rec.lastUsedAt === "string" ? rec.lastUsedAt : null,
    lastResult,
  };
}

export function readManifest(): Manifest {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(), "utf-8")) as Partial<Manifest>;
    if (parsed && typeof parsed === "object" && parsed.skills && typeof parsed.skills === "object") {
      const skills: Record<string, ManifestEntry> = {};
      for (const [name, entry] of Object.entries(parsed.skills)) {
        skills[name] = normalizeEntry(entry);
      }
      return { version: 1, skills };
    }
  } catch {
    // 缺失/损坏清单 = 空清单；下次写入自愈。
  }
  return { version: 1, skills: {} };
}

/** 清单内技能被 skill action=run 调用时记录一次使用；非清单技能忽略。 */
export function recordSkillUse(name: string, result: "success" | "error"): boolean {
  const manifest = readManifest();
  const entry = manifest.skills[name];
  if (!entry) return false;
  entry.useCount += 1;
  entry.lastUsedAt = new Date().toISOString();
  entry.lastResult = result;
  writeManifest(manifest);
  return true;
}

/** 长期未用判定（手动 curator 的 stale 标记）：最近相关时间（使用或创建）距今超过阈值。 */
export function isSkillStale(entry: ManifestEntry, nowMs: number = Date.now()): boolean {
  // 从未用过 → 以创建时间起算；否则以最近使用起算。刚创建的技能不立即误报 stale。
  const ts = Date.parse(entry.lastUsedAt ?? entry.createdAt);
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts > STALE_DAYS * 24 * 60 * 60 * 1000;
}

function writeManifest(manifest: Manifest): void {
  mkdirSync(userSkillsDir(), { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
}

/** 小写 kebab-case，3–40 字符；非法返回 null。 */
export function sanitizeSkillName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  if (name.length < MIN_NAME_LEN || name.length > MAX_NAME_LEN) return null;
  if (!SKILL_NAME_RE.test(name)) return null;
  return name;
}

export function containsInjection(content: string, denyPatterns: string[]): boolean {
  const lower = content.toLowerCase();
  const patterns = [...INJECTION_PATTERNS, ...denyPatterns];
  return patterns.some((p) => p.length > 0 && lower.includes(p));
}

/** 纯格式校验：名字/大小/注入/create 上限/content 不得自带 frontmatter。 */
export function validateReviewOutput(out: ReviewOutput, config: EvolutionConfig): ValidatedReview {
  const v: ValidatedReview = { create: [], update: [] };
  for (const item of out.create.slice(0, 1)) {
    const name = sanitizeSkillName(item.name);
    if (!name) continue;
    const description = item.description.trim();
    if (description.length === 0) continue;
    // description 仅用于技能索引展示（上游索引本就截断），超长截断而非拒绝。
    const clipped = description.length > MAX_DESCRIPTION_LEN ? description.slice(0, MAX_DESCRIPTION_LEN) : description;
    if (item.content.length > config.maxSkillBytes) continue;
    if (containsInjection(item.content, config.denyPatterns)) continue;
    if (item.content.trimStart().startsWith("---")) continue; // frontmatter 由 apply 生成
    v.create.push({ name, description: clipped, content: item.content });
  }
  for (const item of out.update) {
    const name = sanitizeSkillName(item.name);
    if (!name) continue;
    if (item.content.length > config.maxSkillBytes) continue;
    if (containsInjection(item.content, config.denyPatterns)) continue;
    if (item.content.trimStart().startsWith("---")) continue;
    v.update.push({ name, content: item.content });
  }
  return v;
}

/**
 * YAML 双引号标量序列化。description 来自审查模型，常含 `": "`（"X: Y" 式概括），
 * 裸写会把 frontmatter 变成非法 YAML（上游 yaml.parse 抛 "Nested mappings are not
 * allowed in compact mappings" → loadSkillFromFile 吞错 → 技能被跳过，自进化闭环失效）。
 * 双引号包裹并转义 `"`、`\` 与控制字符（换行/制表符等）；其余字符在双引号标量内
 * 无需转义（含冒号+空格、`#`、行首指示符、U+2028 等，见 YAML 1.2 c-printable）。
 */
function yamlQuote(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  out += '"';
  return out;
}

function renderSkillFile(name: string, description: string, content: string): string {
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${yamlQuote(description)}`,
    "x-pico-evolved: true",
    "---",
    "",
  ].join("\n");
  return `${frontmatter}${content.trimEnd()}\n`;
}

/** 从已有 SKILL.md 提取 description（update 时保留原 frontmatter 的 description）。 */
function readSkillDescription(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!m) return "";
    for (const line of m[1]!.split(/\r?\n/)) {
      const sep = line.indexOf(":");
      if (sep < 0) continue;
      if (line.slice(0, sep).trim().toLowerCase() === "description") {
        const raw = line.slice(sep + 1).trim();
        // 兼容 renderSkillFile 写入的双引号样式：剥掉外层引号并反转义（`\"`、`\\`、
        // `\n`/`\r`/`\t`、`\xHH`），保证 update 路径字段值保真；其他值维持原 strip 行为。
        if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
          return raw
            .slice(1, -1)
            // 先反转义 `\\`/`\"`/`\n`/`\r`/`\t`（`\\x` 不在此列，留给下一步），
            // 再处理 `\xHH` 控制字符；顺序不能反，否则字面 `\x41` 会被误吞转义反斜杠。
            .replace(/\\(["\\nrt])/g, (m, ch: string) => {
              switch (ch) {
                case '"':
                  return '"';
                case "\\":
                  return "\\";
                case "n":
                  return "\n";
                case "r":
                  return "\r";
                case "t":
                  return "\t";
                default:
                  return m;
              }
            })
            .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
        }
        return raw.replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // ignore
  }
  return "";
}

function isWithinSkillsDir(target: string): boolean {
  const root = userSkillsDir();
  return target === root || target.startsWith(root + sep);
}

/**
 * 覆盖前把旧 SKILL.md 归档到 skills/.archive/<name>/<mtime>.md，保留回退历史。
 * 归档文件不是 SKILL.md 且位于嵌套目录，skill/catalog.ts 扫描天然忽略，
 * 不会进入后续系统提示词注入。
 */
function archiveSkill(target: string, name: string, mtimeMs: number): void {
  const dir = join(userSkillsDir(), ARCHIVE_DIR, name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(target, join(dir, `${mtimeMs}.md`));
}

/** 清单条目写入：保留已有统计字段（update 不丢使用数据），create 从零开始。 */
function manifestEntry(prev: ManifestEntry | undefined, updatedAtMs: number): ManifestEntry {
  return {
    createdAt: prev?.createdAt ?? new Date().toISOString(),
    updatedAt: String(updatedAtMs),
    useCount: prev?.useCount ?? 0,
    lastUsedAt: prev?.lastUsedAt ?? null,
    lastResult: prev?.lastResult ?? null,
  };
}

export function applyReview(v: ValidatedReview): ApplyResult {
  const result: ApplyResult = { created: [], updated: [], skipped: [] };
  const manifest = readManifest();
  const root = userSkillsDir();

  for (const item of v.create) {
    const target = join(root, item.name, "SKILL.md");
    if (!isWithinSkillsDir(target)) {
      result.skipped.push({ name: item.name, reason: "path-escape" });
      continue;
    }
    if (manifest.skills[item.name]) {
      result.skipped.push({ name: item.name, reason: "already-evolved" });
      continue;
    }
    if (existsSync(target)) {
      // 磁盘上已存在但不在清单内 → 用户手写技能，永不触碰。
      result.skipped.push({ name: item.name, reason: "user-skill-exists" });
      continue;
    }
    mkdirSync(join(root, item.name), { recursive: true });
    writeFileSync(target, renderSkillFile(item.name, item.description, item.content), { mode: 0o644 });
    manifest.skills[item.name] = manifestEntry(manifest.skills[item.name], statSync(target).mtimeMs);
    writeManifest(manifest);
    result.created.push(item.name);
  }

  for (const item of v.update) {
    const target = join(root, item.name, "SKILL.md");
    if (!isWithinSkillsDir(target)) {
      result.skipped.push({ name: item.name, reason: "path-escape" });
      continue;
    }
    const entry = manifest.skills[item.name];
    if (!entry) {
      result.skipped.push({ name: item.name, reason: "not-evolved" });
      continue;
    }
    let mtimeMs: number | undefined;
    try {
      mtimeMs = statSync(target).mtimeMs;
    } catch {
      result.skipped.push({ name: item.name, reason: "missing" });
      continue;
    }
    const listedAt = Number.parseFloat(entry.updatedAt);
    // updatedAt 存的是上次写入后的文件 mtime（毫秒浮点）；磁盘比清单新 1ms 以上
    // 视为用户改过（+1ms 容差防同毫秒边界误判）。旧版 ISO 字符串解析为 NaN → 保守跳过。
    if (!Number.isFinite(listedAt) || mtimeMs > listedAt + 1) {
      // 磁盘比清单新 → 用户改过，跳过（防覆盖用户的手动修改）。
      result.skipped.push({ name: item.name, reason: "user-modified" });
      continue;
    }
    const description = readSkillDescription(target);
    archiveSkill(target, item.name, mtimeMs);
    writeFileSync(target, renderSkillFile(item.name, description, item.content), { mode: 0o644 });
    manifest.skills[item.name] = manifestEntry(entry, statSync(target).mtimeMs);
    writeManifest(manifest);
    result.updated.push(item.name);
  }

  return result;
}
