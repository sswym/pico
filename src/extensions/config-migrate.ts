/**
 * Legacy user-config migration — pico 用户级配置收敛到 settings.json 命名空间。
 *
 * 背景（2026-08 配置体系整改）：hooks / mcp / lsp / subagent 的用户级
 * 配置曾各自独立文件（~/.pico/hooks.json、~/.pico/mcp-servers.json、
 * ~/.pico/lsp.json、~/.pico/subagent.json），与
 * settings.json 物理分离，用户配置分散。整改后这些用户级配置统一收敛为
 * settings.json 的命名空间键：`hooks` / `mcpServers` / `lsp` / `subagent`，
 * 每个键的值与旧文件顶层对象逐字一致（迁移零转换）。
 *
 * 读取侧规则（各扩展加载器实现）：命名空间键存在 → 用之；不存在 → 回退旧文件
 * （未迁移用户零破坏）。
 *
 * 迁移侧规则：显式迁移（pico setup 每次运行前 / /doctor 触发）。损坏的旧文件
 * 不迁移不删除（保留现状以免丢数据）；settings.json 损坏时拒绝迁移（复用
 * settings.ts 的损坏保护）。迁移幂等：旧文件已删除后再次运行无事发生。
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import {
  picoHooksConfigPath,
  picoLspConfigPath,
  picoMcpConfigPath,
  picoSubagentConfigPath,
} from "./paths.ts";
import { isSettingsDamaged, readSettings, writeSettings } from "./settings.ts";

export type UserConfigNamespace = "hooks" | "mcpServers" | "lsp" | "subagent";

const LEGACY_USER_FILES: Array<{ key: UserConfigNamespace; path: () => string }> = [
  { key: "hooks", path: picoHooksConfigPath },
  { key: "mcpServers", path: picoMcpConfigPath },
  { key: "lsp", path: picoLspConfigPath },
  { key: "subagent", path: picoSubagentConfigPath },
];

/** 旧文件路径，供 doctor 展示与 setup 汇总。 */
export function legacyUserConfigPaths(): Array<{ key: UserConfigNamespace; path: string }> {
  return LEGACY_USER_FILES.map(({ key, path }) => ({ key, path: path() }));
}

/**
 * 一次性迁移：把存在且未被命名空间覆盖的旧配置文件搬进 settings.json 对应键，
 * 成功后删除旧文件。返回迁移摘要行（空数组 = 无事发生）。
 *
 * 幂等：命名空间键已存在 → 跳过（用户已在新格式，旧文件残留由调用方清理）；
 * 旧文件损坏/缺失 → 跳过。settings.json 损坏 → 整体拒绝（防止覆盖丢密钥）。
 */
export function migrateLegacyUserConfigs(): string[] {
  // 先 readSettings() 触发解析——损坏的 settings.json 此时才置 damaged 标志，
  // 之后 isSettingsDamaged() 才可信（若先查标志再读，读到损坏文件时标志还是
  // 上一次解析的旧值，会把损坏文件覆盖成仅含迁移键的对象）。
  const settings = readSettings();
  if (isSettingsDamaged()) return [];
  const migrated: string[] = [];
  const toRemove: string[] = [];

  for (const { key, path } of LEGACY_USER_FILES) {
    const filePath = path();
    if (settings[key] !== undefined) {
      // 命名空间已是权威来源；残留旧文件可安全清理。
      if (existsSync(filePath)) toRemove.push(filePath);
      continue;
    }
    if (!existsSync(filePath)) continue;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue; // 损坏/非对象，不动
      settings[key] = raw;
      migrated.push(`${key} ← ${filePath}`);
      toRemove.push(filePath);
    } catch {
      // 损坏的旧文件保留，让 doctor 提示用户手动处理。
    }
  }

  if (migrated.length > 0) {
    writeSettings(settings);
  }
  // 无论是否迁移新内容，被命名空间取代的旧文件都清理（命名空间已存在时
  // migrated 为空但仍可能有残留旧文件）。
  for (const filePath of toRemove) {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // best-effort
    }
  }
  return migrated;
}

/** 命名空间键是否已由 settings.json 承载（供 setup/doctor 判断来源）。 */
export function hasUserNamespace(key: UserConfigNamespace): boolean {
  return readSettings()[key] !== undefined;
}
