/**
 * env ↔ settings 权威映射表（2026-08 配置收敛）。
 *
 * pico 的功能开关/路径既可通过环境变量也可通过 settings.json 配置。历史上各
 * 扩展各自实现读取（有的 env-only、有的 settings-only、有的两者 env 优先），
 * 无集中登记，用户不知道"改哪一处生效"。本表集中登记面向用户的 PICO_* 键：
 *   - env:          环境变量名
 *   - settingsPath: 对应 settings.json 键（null = env-only，无 settings 对应）
 *   - precedence:   env 优先于 settings / settings 优先 / 仅 env
 *   - internal:     内部护栏变量，用户不应手动设置
 *   - description:  一句话说明
 *
 * /doctor 据此渲染"配置来源视图"，帮助用户定位生效入口。新增 PICO_* 环境
 * 变量时请在此登记，避免再次出现无文档可查的双入口。
 */

export type EnvPrecedence = "env-first" | "settings-first" | "env-only";

export interface EnvSettingMapping {
  env: string;
  settingsPath: string | null;
  precedence: EnvPrecedence;
  description: string;
  internal?: boolean;
}

export const ENV_SETTING_MAPPINGS: readonly EnvSettingMapping[] = [
  // ── 路径类 ────────────────────────────────────────────────────────────
  { env: "PICO_HOME", settingsPath: null, precedence: "env-only", description: "pico 数据根目录（默认 ~/.pico）" },
  { env: "PICO_MEMORY_DB", settingsPath: null, precedence: "env-only", description: "记忆 SQLite 路径（仅 builtin 后端）" },
  { env: "PICO_HOLOGRAPHIC_MEMORY_PATH", settingsPath: null, precedence: "env-only", description: "holographic 记忆 JSON 路径" },
  { env: "PICO_SUPERVISOR_CHANNEL_ROOT", settingsPath: null, precedence: "env-only", description: "子代理监督通道根目录" },
  { env: "PICO_SUPERVISOR_ASK_TIMEOUT_MS", settingsPath: null, precedence: "env-only", description: "监督提问超时（毫秒）" },

  // ── 安全开关（policy.ts 统一解析：env 优先于 settings.safety）─────────
  { env: "PICO_ALLOW_UNATTENDED_PLAN_APPROVAL", settingsPath: "safety.allowUnattendedPlanApproval", precedence: "env-first", description: "非交互模式自动批准 ExitPlanMode" },
  { env: "PICO_ALLOW_LSP_FORMAT_ON_WRITE", settingsPath: "safety.allowLspFormatOnWrite", precedence: "env-first", description: "LSP 写后自动格式化" },
  { env: "PICO_ENABLE_PROJECT_HOOKS", settingsPath: "safety.enableProjectHooks", precedence: "env-first", description: "启用项目级 hooks" },
  { env: "PICO_ENABLE_PROJECT_MCP", settingsPath: "safety.enableProjectMcp", precedence: "env-first", description: "启用项目级 MCP" },
  { env: "PICO_ENABLE_PROJECT_LSP", settingsPath: "safety.enableProjectLsp", precedence: "env-first", description: "启用项目级 LSP" },
  { env: "PICO_ALLOW_UNATTENDED_PROJECT_AGENTS", settingsPath: null, precedence: "env-only", description: "非交互模式放行项目级子代理（仅 env，无 settings 项）" },

  // ── 功能开关 ──────────────────────────────────────────────────────────
  { env: "PICO_RTK", settingsPath: "integrations.rtk.enabled", precedence: "env-first", description: "关闭 RTK 集成（=0 时忽略 settings.integrations.rtk）" },
  { env: "PICO_VISION_PROVIDER", settingsPath: "auxiliary.vision.provider", precedence: "env-first", description: "辅助视觉模型 provider" },
  { env: "PICO_VISION_MODEL", settingsPath: "auxiliary.vision.model", precedence: "env-first", description: "辅助视觉模型 model" },
  { env: "PICO_SEARCH_PROVIDER", settingsPath: null, precedence: "env-only", description: "搜索引擎（exa | tavily）" },
  { env: "TAVILY_API_KEY", settingsPath: "env.TAVILY_API_KEY", precedence: "env-first", description: "Tavily 搜索 API 密钥（settings.env 在启动时水合）" },
  { env: "PICO_MEMORY_DENY", settingsPath: null, precedence: "env-only", description: "记忆写入门禁关键词（逗号分隔）" },
  { env: "PICO_CACHE_OPTIMIZER_DISABLE", settingsPath: null, precedence: "env-only", description: "关闭 cache-optimizer" },
  { env: "PICO_CACHE_OPTIMIZER_NO_PROMPT_REWRITE", settingsPath: null, precedence: "env-only", description: "关闭 cache-optimizer 提示词重写" },
  { env: "PICO_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION", settingsPath: null, precedence: "env-only", description: "关闭 cache-optimizer 技能压缩" },
  { env: "PICO_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY", settingsPath: null, precedence: "env-only", description: "关闭 OpenAI cache key 注入" },
  { env: "PICO_CACHE_OPTIMIZER_ALLOW_PROXY_LONG_RETENTION", settingsPath: null, precedence: "env-only", description: "允许代理长缓存保留" },
  { env: "PICO_AUTO_THINKING_DISABLE", settingsPath: null, precedence: "env-only", description: "关闭 auto-thinking 扩展" },
  { env: "PICO_ULTRATHINK_NOTICE_ONLY", settingsPath: null, precedence: "env-only", description: "auto-thinking 只注入 notice 不提升等级" },
  { env: "PICO_CONTEXT_PRUNER_DISABLE", settingsPath: null, precedence: "env-only", description: "关闭 context-pruner" },

  // ── 自进化（evolution 扩展）──────────────────────────────────────────
  { env: "PICO_EVOLUTION_ENABLED", settingsPath: "evolution.enabled", precedence: "env-first", description: "启用自进化审查（会话后自动沉淀技能）" },
  { env: "PICO_EVOLUTION_PROVIDER", settingsPath: "evolution.provider", precedence: "env-first", description: "审查模型 provider（默认跟随主模型）" },
  { env: "PICO_EVOLUTION_MODEL", settingsPath: "evolution.model", precedence: "env-first", description: "审查模型 model（默认跟随主模型）" },
  { env: "PICO_EVOLUTION_DENY", settingsPath: null, precedence: "env-only", description: "审查输出门禁关键词（逗号分隔，命中拒写技能）" },
  { env: "PICO_EVOLUTION_REVIEW_EVERY_TURNS", settingsPath: "evolution.reviewEveryTurns", precedence: "env-first", description: "审查触发回合间隔（默认 6）" },

  // ── 可观测性 ───────────────────────────────────────────────────────────
  { env: "PICO_LOG_LEVEL", settingsPath: null, precedence: "env-only", description: "日志级别（debug|info|warn|error，默认 warn）" },
  { env: "PICO_LOG_FILE", settingsPath: null, precedence: "env-only", description: "日志落盘文件（相对路径落 $PICO_HOME/logs/，空则仅 stderr）" },
  { env: "PICO_LOG_DIR", settingsPath: null, precedence: "env-only", description: "日志目录（默认 $PICO_HOME/logs）" },

  // ── 内部护栏（勿手动设置）────────────────────────────────────────────
  { env: "PICO_HOOK_RECURSION_GUARD", settingsPath: null, precedence: "env-only", description: "hook 递归护栏（系统自动维护）", internal: true },
  { env: "PICO_SUBAGENT_DEPTH", settingsPath: null, precedence: "env-only", description: "子代理嵌套深度护栏（系统自动维护）", internal: true },
];

/** 当前生效值：env 已设置时显示 env 值，否则显示 settings 值（仅展示用）。 */
export function envSettingEffectiveValue(mapping: EnvSettingMapping, settings: Record<string, unknown>): string {
  if (mapping.env in process.env) {
    const v = process.env[mapping.env];
    return v && v.length > 0 ? v : "(empty)";
  }
  if (mapping.settingsPath) {
    const value = lookupSettingsPath(settings, mapping.settingsPath);
    if (value !== undefined) return String(value);
    return "(default)";
  }
  return "(unset)";
}

function lookupSettingsPath(settings: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = settings;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
