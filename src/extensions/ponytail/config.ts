/**
 * ponytail — 配置解析（pico 内置版）。
 *
 * 移植自 https://github.com/DietrichGebert/ponytail（MIT）hooks/ponytail-config.js
 * v4.9.0。适配点：上游读 ~/.config/ponytail/config.json；pico 版按用户级配置
 * 收敛原则（AGENTS.md）改为 settings.json 的 `ponytail` 命名空间，保留
 * PONYTAIL_DEFAULT_MODE / PONYTAIL_QUIET_STARTUP / PONYTAIL_HIDE_STATUS
 * 环境变量优先（ponytail 官方契约）。
 */
import { readSettings, readSettingsObject, writeSettings } from "../settings.ts";

export const DEFAULT_MODE = "full";
export const VALID_MODES = ["off", "lite", "full", "ultra", "review"] as const;
export const RUNTIME_MODES = ["off", "lite", "full", "ultra"] as const;

/** 归一化运行时模式（off/lite/full/ultra）；非法输入返回 null。 */
export function normalizeMode(mode: unknown): string | null {
  if (typeof mode !== "string") return null;
  const normalized = mode.trim().toLowerCase();
  return (RUNTIME_MODES as readonly string[]).includes(normalized) ? normalized : null;
}

/** 归一化可持久化模式（含 review——会话级模式，可出现在历史条目里）。 */
export function normalizeConfigMode(mode: unknown): string | null {
  if (typeof mode !== "string") return null;
  const normalized = mode.trim().toLowerCase();
  return (VALID_MODES as readonly string[]).includes(normalized) ? normalized : null;
}

export function normalizePersistedMode(mode: unknown): string | null {
  return normalizeMode(mode) || normalizeConfigMode(mode);
}

/**
 * "stop ponytail" / "normal mode" 只有整句命令才关 ponytail——匹配子串会
 * 让 "add a normal mode toggle" 这类普通请求中途误触。大小写不敏感、忽略
 * 尾部标点（上游 #384 行为）。
 */
export function isDeactivationCommand(text: unknown): boolean {
  const t = String(text || "").trim().toLowerCase().replace(/[.!?\s]+$/, "");
  return t === "stop ponytail" || t === "normal mode";
}

function envTruthy(name: string): boolean | undefined {
  const env = process.env[name];
  if (env === undefined) return undefined;
  const v = env.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

/**
 * 默认模式解析：env PONYTAIL_DEFAULT_MODE → settings.ponytail.defaultMode →
 * 'full'。default 只接受运行时级别；review 是会话级模式，不能作默认（上游 #377）。
 */
export function getDefaultMode(): string {
  const envMode = process.env.PONYTAIL_DEFAULT_MODE;
  if (envMode && (RUNTIME_MODES as readonly string[]).includes(envMode.toLowerCase())) {
    return envMode.toLowerCase();
  }
  const configured = readSettingsObject("ponytail").defaultMode;
  if (typeof configured === "string" && (RUNTIME_MODES as readonly string[]).includes(configured.toLowerCase())) {
    return configured.toLowerCase();
  }
  return DEFAULT_MODE;
}

/** 静默启动 toast：env 优先，其次 settings.ponytail.quietStartup === true。 */
export function getQuietStartup(): boolean {
  const env = envTruthy("PONYTAIL_QUIET_STARTUP");
  if (env !== undefined) return env;
  return readSettingsObject("ponytail").quietStartup === true;
}

/** 隐藏状态栏指示器：env 优先，其次 settings.ponytail.hideStatus === true。 */
export function getHideStatus(): boolean {
  const env = envTruthy("PONYTAIL_HIDE_STATUS");
  if (env !== undefined) return env;
  return readSettingsObject("ponytail").hideStatus === true;
}

/** 持久化默认模式到 settings.json `ponytail.defaultMode`；review 不能作默认。 */
export function writeDefaultMode(mode: unknown): string | null {
  const normalized = normalizeMode(mode);
  if (!normalized) return null;
  const settings = readSettings();
  settings.ponytail = { ...readSettingsObject("ponytail"), defaultMode: normalized };
  writeSettings(settings);
  return normalized;
}
