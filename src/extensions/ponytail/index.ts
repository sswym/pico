/**
 * ponytail — 懒惰资深工程师模式（pico 内置扩展）。
 *
 * 移植自 https://github.com/DietrichGebert/ponytail（MIT）pi-extension/index.js
 * v4.9.0。适配点：配置收敛到 settings.json `ponytail` 命名空间（config.ts）；
 * SKILL.md 走内置技能资源（instructions.ts）；注入文本用 PICO_CACHE_STABLE
 * 标记把模式无关段送进 provider 缓存前缀。
 *
 * 行为与上游 pi 扩展一致：before_agent_start 每轮注入规则集、/ponytail* 六个
 * 命令、模式状态写入会话条目（appendEntry "ponytail-mode"）、会话恢复最近
 * 模式、状态栏指示（guarded no-op）。
 */
import type {
  AgentEndEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionStartEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MODE,
  RUNTIME_MODES,
  getDefaultMode,
  getHideStatus,
  getQuietStartup,
  isDeactivationCommand,
  normalizeMode,
  normalizePersistedMode,
  writeDefaultMode,
} from "./config.ts";
import { filterSkillBodyForMode, getPonytailInstructions } from "./instructions.ts";

export { filterSkillBodyForMode };
export const readDefaultMode = getDefaultMode;

const RUNTIME_MODE_LIST = RUNTIME_MODES.join("|");
const PONYTAIL_COMMAND_DESCRIPTION = `Set mode: ${RUNTIME_MODE_LIST}. Commands: status, default <mode>`;

interface SessionEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: { mode?: unknown };
}

/** 从会话历史条目里恢复最近一次持久化的模式；无则用 fallback（默认配置）。 */
export function resolveSessionMode(entries: unknown, fallbackMode = DEFAULT_MODE): string {
  const fallback = normalizePersistedMode(fallbackMode) || DEFAULT_MODE;
  if (!Array.isArray(entries)) return fallback;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as SessionEntryLike | undefined;
    if (entry?.type !== "custom" || entry?.customType !== "ponytail-mode") continue;

    const mode = normalizePersistedMode(entry?.data?.mode);
    if (mode) return mode;
  }

  return fallback;
}

export type PonytailCommand =
  | { type: "set-mode"; mode: string }
  | { type: "status" }
  | { type: "set-default"; mode: string }
  | { type: "invalid"; reason: string; mode?: string };

/** 解析 /ponytail 命令参数（无参数 = 恢复默认模式；review 不能作 default）。 */
export function parsePonytailCommand(text: unknown, defaultMode = DEFAULT_MODE): PonytailCommand {
  const fallback = normalizePersistedMode(defaultMode) || DEFAULT_MODE;
  const normalizedText = String(text || "").trim().toLowerCase();

  if (!normalizedText) {
    return { type: "set-mode", mode: fallback === "off" ? "full" : fallback };
  }

  const [primary, secondary] = normalizedText.split(/\s+/);

  if (primary === "status") return { type: "status" };

  if (primary === "default") {
    // ponytail: default 必须是运行时级别；review 是会话级模式（上游 #377）。
    const mode = normalizeMode(secondary);
    return mode ? { type: "set-default", mode } : { type: "invalid", reason: "invalid-default-mode" };
  }

  const mode = normalizeMode(primary);
  return mode ? { type: "set-mode", mode } : { type: "invalid", reason: "invalid-mode", mode: primary };
}

export function ponytailExtension(pi: ExtensionAPI): void {
  let currentMode = DEFAULT_MODE;
  let configuredDefaultMode = getDefaultMode();
  let hideStatus = getHideStatus();
  let isActive = false;
  let lastCtx: ExtensionContext | null = null;

  // -- Status bar --
  function syncStatus(ctx?: ExtensionContext): void {
    if (ctx) lastCtx = ctx;
    const c = ctx ?? lastCtx;
    // ponytail: 隐藏指示器但保持规则集激活（#324）。
    if (hideStatus) return;
    if (!c?.ui?.setStatus) return;
    // ponytail: try/catch 防 pi-web theme proxy 在 initTheme 前抛错。
    let theme: Theme;
    try {
      theme = c.ui.theme;
      if (!theme?.fg) return;
    } catch {
      return;
    }
    if (currentMode === "off") {
      c.ui.setStatus("ponytail", "");
      return;
    }
    const levelIcons: Record<string, string> = { lite: "🌿", full: "⚡", ultra: "🔥" };
    const icon = levelIcons[currentMode] || "";
    const label = currentMode.toUpperCase();
    const indicator = isActive ? theme.fg("accent", "●") : theme.fg("dim", "○");
    c.ui.setStatus("ponytail", indicator + " 🐴 " + theme.fg("muted", "ponytail: ") + theme.fg("text", icon + " " + label));
  }

  const setMode = (mode: string, ctx?: ExtensionContext): void => {
    const normalized = normalizePersistedMode(mode);
    if (!normalized) return;

    currentMode = normalized;
    pi.appendEntry("ponytail-mode", { mode: normalized });
    syncStatus(ctx);
    ctx?.ui?.notify?.(`Ponytail mode set to ${normalized}.`, "info");
  };

  const sendAlias = (skillName: string, args: string, ctx?: ExtensionContext): void => {
    const normalized = String(args || "").trim();
    const message = normalized ? `${skillName} ${normalized}` : skillName;

    if (ctx?.isIdle?.() === false) {
      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx?.ui?.notify?.(`${skillName} queued as follow-up.`, "info");
      return;
    }

    pi.sendUserMessage(message);
  };

  pi.registerCommand("ponytail", {
    description: PONYTAIL_COMMAND_DESCRIPTION,
    handler: async (args: string, ctx: ExtensionContext) => {
      const parsed = parsePonytailCommand(args, configuredDefaultMode);

      if (parsed.type === "status") {
        ctx?.ui?.notify?.(`Ponytail: current ${currentMode} • default ${configuredDefaultMode}`, "info");
        return;
      }

      if (parsed.type === "set-default") {
        try {
          const written = writeDefaultMode(parsed.mode);
          if (written) {
            configuredDefaultMode = getDefaultMode();
            const message = configuredDefaultMode === written
              ? `Default Ponytail mode set to ${written}.`
              : `Saved default ${written}, but env override keeps default at ${configuredDefaultMode}.`;
            ctx?.ui?.notify?.(message, "info");
          }
        } catch (e) {
          ctx?.ui?.notify?.(`Failed to save default mode: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      if (parsed.type === "set-mode") {
        setMode(parsed.mode, ctx);
        return;
      }

      ctx?.ui?.notify?.("Unknown or unsupported /ponytail mode.", "warning");
    },
  });

  const aliasCommand = (skillName: string) => ({
    description: `Run /skill:${skillName}`,
    handler: async (_args: string, ctx: ExtensionContext) => {
      sendAlias(`/skill:${skillName}`, "", ctx);
    },
  });

  pi.registerCommand("ponytail-review", aliasCommand("ponytail-review"));
  pi.registerCommand("ponytail-audit", aliasCommand("ponytail-audit"));
  pi.registerCommand("ponytail-gain", aliasCommand("ponytail-gain"));
  pi.registerCommand("ponytail-debt", aliasCommand("ponytail-debt"));
  pi.registerCommand("ponytail-help", aliasCommand("ponytail-help"));

  pi.on("input", async (event: InputEvent, _ctx: ExtensionContext) => {
    if (event?.source === "extension") return;

    const text = String(event?.text || "");
    if (currentMode !== "off" && isDeactivationCommand(text)) {
      setMode("off");
    }
  });

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
    configuredDefaultMode = getDefaultMode();
    hideStatus = getHideStatus();
    currentMode = resolveSessionMode(entries, configuredDefaultMode);
    syncStatus(ctx);
    if (!getQuietStartup()) {
      ctx?.ui?.notify?.(`Ponytail loaded: ${currentMode}`, "info");
    }
  });

  pi.on("agent_start", async (_event: AgentStartEvent, ctx: ExtensionContext) => {
    isActive = true;
    syncStatus(ctx);
  });

  pi.on("agent_end", async (_event: AgentEndEvent, ctx: ExtensionContext) => {
    isActive = false;
    syncStatus(ctx);
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, _ctx: ExtensionContext) => {
    if (!currentMode || currentMode === "off") return;
    // 防 null/undefined event 或缺失 systemPrompt：不崩溃、不注入字面 "undefined"
    // （上游 #439、#440）。
    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
    return { systemPrompt: `${base}${getPonytailInstructions(currentMode)}` };
  });
}
