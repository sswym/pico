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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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
}

interface Manifest {
  version: 1;
  skills: Record<string, ManifestEntry>;
}

const MANIFEST_FILE = ".pico-evolved.json";
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

export function readManifest(): Manifest {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(), "utf-8")) as Partial<Manifest>;
    if (parsed && typeof parsed === "object" && parsed.skills && typeof parsed.skills === "object") {
      return { version: 1, skills: parsed.skills as Record<string, ManifestEntry> };
    }
  } catch {
    // 缺失/损坏清单 = 空清单；下次写入自愈。
  }
  return { version: 1, skills: {} };
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

export function applyReview(v: ValidatedReview): ApplyResult {
  const result: ApplyResult = { created: [], updated: [], skipped: [] };
  const manifest = readManifest();
  const now = new Date().toISOString();
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
    manifest.skills[item.name] = { createdAt: now, updatedAt: String(statSync(target).mtimeMs) };
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
    writeFileSync(target, renderSkillFile(item.name, description, item.content), { mode: 0o644 });
    manifest.skills[item.name] = { createdAt: entry.createdAt, updatedAt: String(statSync(target).mtimeMs) };
    writeManifest(manifest);
    result.updated.push(item.name);
  }

  return result;
}
