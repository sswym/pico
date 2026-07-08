/**
 * Lightweight regex-based fact extraction.
 *
 * Direct port of hermes' `_auto_extract_facts`
 * (~/hermes-agent/plugins/memory/holographic/__init__.py:359-397).
 *
 * Runs at session shutdown over user messages: matches preference and
 * decision patterns, stores hits as facts. Never throws — extraction is
 * best-effort, and a failure must not break shutdown.
 *
 * Extended with correction, failure, insight, convention, and tool_quirk
 * pattern sets, plus project-scoped storage.
 */
import type { MemoryStore } from "./store.ts";
import type { Category, Scope } from "./schema.ts";
import { CORRECTED_BOOST, SCOPE_GLOBAL, SCOPE_PROJECT } from "./schema.ts";

// ---- Pattern sets (all case-insensitive) --------------------------------

const PREF_PATTERNS = [
  /\bI\s+(?:prefer|like|love|use|want|need)\b/i,
  /\bmy\s+(?:favorite|preferred|default)\s+\w+\s+is\b/i,
  /\bI\s+(?:always|never|usually)\b/i,
  // 中文：偏好/习惯陈述
  /(?:我|咱们)\s*(?:更喜欢|偏好|习惯用|爱用|只用|倾向用|喜欢用)\s*.+/,
  /(?:我|咱们)\s*(?:总是|从不|通常|一般)\s*.+/,
];

const DECISION_PATTERNS = [
  /\bwe\s+(?:decided|agreed|chose)\s+(?:to\s+)?/i,
  /\bthe\s+project\s+(?:uses|needs|requires)\b/i,
  // 中文：项目决策/约定
  /(?:我们|团队|项目)\s*(?:决定|约定|选定|确定|选择)\s*.+/,
  /(?:这个项目|本仓库|代码库)\s*(?:使用|采用|需要|依赖|要求)\s*.+/,
];

/** Patterns that indicate the user is correcting the agent. */
export const CORRECTION_PATTERNS = [
  /\bno[,.]?\s+(?:that'?s?\s+)?(?:wrong|incorrect|not right|not what I meant)\b/i,
  /\b(?:actually|instead|rather),?\s+(?:I\s+)?(?:want|need|prefer|use|meant)\b/i,
  /\bdon't\s+(?:do|use|write|put|add)\s+that\b/i,
  /\bI\s+(?:said|meant)\s+/i,
  /\bwrong[.!]?\s+(?:it(?:'s| is)|that(?:'s| is))\s+(?:should be|supposed to be)\b/i,
  /\b(?:fix|correct)\s+(?:that|this|it)\b/i,
  // 中文：纠错/纠正
  /(?:不对|错了|搞错了|说错了|理解错了)[,.]?\s*.+/,
  /(?:实际上|其实|准确地说|更正一下)[,.]?\s*(?:我|我们|应该|要用|是)\s*.+/,
  /(?:之前|刚才|上面)\s*(?:说|写|记|说的)\s*(?:不对|错了|有误)/,
  /(?:不要用|别用|别写|别加|去掉)\s*\S+\s*(?:了|吧)?[,，]?\s*(?:改[成用]|用|换成)\s*.+/,
];

/** Patterns that capture learnings from experience. */
const INSIGHT_PATTERNS = [
  /\b(?:note|remember|keep in mind)\s+that\s*[:.]?\s/i,
  /\b(?:insight|lesson|takeaway)\s*:/i,
  /\b(?:this\s+)?(?:always|never)\s+(?:fails|happens|works)\s+(?:because|when|if)\b/i,
  // 中文：经验/教训
  /(?:记住|留意|注意|切记)\s*[:：]?\s*.+/,
  /(?:经验|教训|心得)\s*[:：]/,
  /(?:总是|从来|一般)\s*(?:失败|出错|有效|好用)\s*(?:因为|当|如果)/,
];

/** Patterns that indicate something didn't work. */
const FAILURE_PATTERNS = [
  /\b(?:that\s+)?(?:didn't|doesn't|won't)\s+work\b/i,
  /\b(?:error|failure|bug)\s*:\s*.+\b/i,
  /\b(?:crash\w*|timeout|hang)\s+(?:when|if|on)\b/i,
  // 中文：失败/报错（独立成词即可，不强制后接特定字）
  /(?:报错|崩溃|挂了|超时了|不工作|没生效|跑不起来|出错了)\s*(?:了|因为|当|在)?/,
  /(?:错误|异常|bug)\s*[:：]/,
];

/** Patterns that indicate project conventions. */
const CONVENTION_PATTERNS = [
  /\b(?:we\s+)?(?:always|never|must|should)\s+(?:use|follow|write)\s+/i,
  /\bour\s+(?:convention|standard|style|pattern)\s+(?:is|for)\b/i,
  /\b(?:by convention|as a rule|as standard)\b/i,
  // 中文：规范/约定
  /(?:我们|团队|项目|仓库)\s*(?:总是|从不|必须|应该|一律)\s*(?:用|遵循|写|采用)/,
  /(?:我们的)?\s*(?:规范|标准|风格|约定|规矩)\s*(?:是|为|要求)/,
  /(?:按规范|按惯例|按标准|作为规范)/,
];

/** Patterns that capture tool-specific quirks or gotchas. */
const TOOL_QUIRK_PATTERNS = [
  /\b(?:works|behaves)\s+(?:differently|oddly|unexpectedly)\s+(?:in|on|with|when)\b/i,
  /\b(?:quirk|gotcha|caveat|limitation)\s*:/i,
  /\b(?:doesn't|don't|won't|can't)\s+support\s+/i,
  /\b(?:this|the|that)\s+\w+\s+(?:doesn't|don't|won't)\s+support\b/i,
  // 中文：工具怪癖/限制
  /\S+\s*(?:在|对于|上)\s*\S*\s*(?:表现|行为|处理方式)\s*(?:不同|奇怪|异常|不一致)/,
  /(?:坑|怪癖|限制|注意点|陷阱)\s*[:：]/,
  /\S+\s*(?:不支持|没法|无法|不能)\s*(?:做|处理|用|运行|解析)/,
];

/** Patterns indicating the message is an instruction TO the agent (meta-command),
 *  not a durable user statement. Seen in --print mode prompts like
 *  "use memory tool action=add ..." or "please call memory". Such text must
 *  never be auto-extracted as a memory fact. */
const INSTRUCTION_PATTERNS = [
  /用\s*memory\s*工具/,
  /请调用|调用\s*memory|action\s*=/,
  /回复\s*(?:done|收到|确认|ok)/,
  /帮我\s*(?:调用|执行|运行|记)/,
  /^\s*请\s*(?:用|调用|执行)/,
];

// ---- Message helpers -----------------------------------------------------

export interface ExtractableMessage {
  role: string;
  content: unknown;
}

/** Extract plain text from a message content field (string or content block array). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => (c as { text?: string }).text ?? "")
      .join(" ");
  }
  return "";
}

// ---- Extraction ----------------------------------------------------------

export interface ExtractOptions {
  cwd?: string;
}

/**
 * Scan user messages for extractable patterns and store them as facts.
 * Returns the count of newly extracted facts.
 *
 * Pattern priority: correction > failure > insight > preference > convention >
 * tool_quirk > decision > (skip). First matching group wins.
 */
export function autoExtractFromMessages(
  store: MemoryStore,
  messages: ExtractableMessage[],
  opts?: ExtractOptions,
): number {
  let extracted = 0;
  const scope: Scope = opts?.cwd ? SCOPE_PROJECT : SCOPE_GLOBAL;

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const text = extractText(msg.content).trim();
    if (text.length < 10) continue;

    // Skip messages that are instructions TO the agent (meta-commands like
    // "use memory tool action=add ..."), not durable user statements.
    if (INSTRUCTION_PATTERNS.some((p) => p.test(text))) continue;

    let category: Category | undefined;
    if (CORRECTION_PATTERNS.some((p) => p.test(text))) category = "correction";
    else if (FAILURE_PATTERNS.some((p) => p.test(text))) category = "failure";
    else if (INSIGHT_PATTERNS.some((p) => p.test(text))) category = "insight";
    else if (PREF_PATTERNS.some((p) => p.test(text))) category = "user_pref";
    else if (CONVENTION_PATTERNS.some((p) => p.test(text))) category = "convention";
    else if (TOOL_QUIRK_PATTERNS.some((p) => p.test(text))) category = "tool_quirk";
    else if (DECISION_PATTERNS.some((p) => p.test(text))) category = "project";
    if (!category) continue;

    try {
      store.add(text.slice(0, 400), {
        category,
        scope,
        cwd: opts?.cwd,
        source: "auto",
        trust: category === "correction" ? CORRECTED_BOOST : undefined,
      });
      extracted++;
    } catch {
      // duplicate / invalid — skip silently
    }
  }
  return extracted;
}
