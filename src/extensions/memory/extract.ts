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
  // 中文：极简偏好（"别用 npm"、"不要用 X"）——无主语也成立
  /^\s*(?:别用|不要用|禁用|别加|别写)\s*\S+/,
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
  /\bthat'?s\s+(?:wrong|incorrect|not\s+right|not\s+what\s+I\s+meant)\b/i,
  /\byou\s+(?:said|told\s+me)\s+[^.]{0,80}?\b(?:wrong|incorrect|not\s+right)\b/i,
  /\bdon't\s+(?:do|use|write|put|add)\s+that\b/i,
  /\bI\s+(?:never\s+)?said\s+(?:that|this|it)\b/i,
  /\bwrong[.!]?\s+(?:it(?:'s| is)|that(?:'s| is))\s+(?:should be|supposed to be)\b/i,
  /\b(?:fix|correct)\s+(?:that|this|it)\b/i,
  // 中文：明确指向先前内容的纠错
  /(?:之前|刚才|上面|你(?:刚才|之前)?(?:说|写|记|给的|介绍的))[^。！？]{0,24}(?:不对|错了|有误|说错了)/,
  /(?:不对|错了|搞错了|说错了|理解错了)[,，!！.]?\s*(?:我|我们|你|是|应该|要用|是它)/,
  /(?:不要用|别用|别写|别加|去掉)\s*\S+\s*(?:了|吧)?[,，]?\s*(?:改[成用]|用|换成)\s*.+/,
];

/**
 * Contextual correction patterns — these match common polite turns
 * ("actually, I want…", "I meant…") that are NOT necessarily corrections of
 * a prior claim. They only count when the message is short (a real
 * correction is usually terse) and not a question.
 */
const CONTEXTUAL_CORRECTION_PATTERNS = [
  /\b(?:actually|instead|rather),?\s+(?:I\s+)?(?:want|need|prefer|use|meant)\b/i,
  /\bI\s+(?:meant|said)\s+/i,
  /(?:实际上|其实|准确地说|更正一下)[,.]?\s*(?:我|我们|应该|要用|是)\s*.+/,
];

/** True when the message is a question — questions are never corrections. */
function isQuestion(text: string): boolean {
  return /[?？]/.test(text);
}

/** Help / one-time-request intents that must never be stored as durable facts. */
const HELP_PATTERNS = [
  /\bI\s+want\s+to\s+(?:fix|solve|build|do|install|migrate)\b/i,
  /\bI\s+want\s+to\s+(?:tell|mention|share|note|report)\b/i,
  /(?:帮我|麻烦你|请教|求助|求求)/,
  /(?:怎么办|怎么(?:修|解决|做|处理)|如何(?:修|解决|做|处理))/,
];

/** Explicit denials that must never invert into preferences ("I never said that"). */
const DENIAL_PATTERNS = [
  /\bI\s+never\s+said\b/i,
  /\bI\s+didn'?t\s+say\b/i,
  /我没(?:有)?说过|不是我说的/,
];

/**
 * Decide whether a message is a genuine correction. Strong patterns are
 * referential (they point at a prior claim); contextual patterns additionally
 * require the message to be short and non-question, otherwise everyday
 * "actually I want X" chatter gets stored as 0.7-trust corrections and
 * systematically docks real memories.
 */
export function isLikelyCorrection(text: string): boolean {
  if (isQuestion(text)) return false;
  if (CORRECTION_PATTERNS.some((p) => p.test(text))) return true;
  return text.length <= 200 && CONTEXTUAL_CORRECTION_PATTERNS.some((p) => p.test(text));
}

/** Messages that are one-time requests/help calls — skip extraction entirely. */
function isHelpRequest(text: string): boolean {
  return HELP_PATTERNS.some((p) => p.test(text));
}

/** Messages that negate a prior statement — never store as preference. */
function isDenial(text: string): boolean {
  return DENIAL_PATTERNS.some((p) => p.test(text));
}

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
 *  never be auto-extracted as a memory fact.
 *
 *  Beyond meta-commands, this covers common one-time task directives
 *  ("在 wt 目录下运行 bun test"、"解释 X 如何工作"、"把 foo.ts 改成 …").
 *  These are imperative requests, not durable preferences/decisions — the
 *  observed failure mode was entire task prompts getting frozen into
 *  long-term memory as "insight" facts. Action-shaped patterns match
 *  anywhere in the text (not only at the start): a message that mixes a
 *  directive with a "记住：…" tail is still a task, not a fact.
 */
const INSTRUCTION_PATTERNS = [
  /用\s*memory\s*工具/,
  /请调用|调用\s*memory|action\s*=/,
  /回复\s*(?:done|收到|确认|ok)/,
  /帮我\s*(?:调用|执行|运行|记)/,
  /^\s*请\s*(?:用|调用|执行|使用|让|派|安排)\s+\S+/,
  // ---- 一次性任务指令（祈使句），全文匹配 ----
  // "在 <路径> 目录下/里 运行 <命令>"
  /(?:在|去|到)\s*[^\s，。:：]{1,60}\s*(?:目录|文件夹|仓库)?\s*(?:下|里|中|内|下面)?\s*(?:运行|执行|启动|安装)\s+\S+/,
  // "把 <文件> 改成/删掉 <…>"
  /(?:把|将)\s+[^\s，。]{1,80}(?:\s*的\s*)?(?:内容|文件|代码)?\s*(?:改成|改为|修改成|替换成|删掉|删除|移除|移到|移动)/,
  // "解释 <X> 如何/怎么 <Y>"
  /(?:解释|说明|介绍一下|分析|解读|讲讲)\s+.+(?:如何|怎么|怎样|是什么|工作原理)/,
  // "数一下 / 列出 / 查一下 / 检查一下 …"
  /(?:数一下|数数|统计一下|列出|找出|搜一下|搜索|查一下|看看|检查一下|确认一下)\s+/,
  // "优化/重构 <X>"
  /(?:优化|改进|重构)(?:一下|下|了)?\s*\S+/,
  // "新增/修复 <X> …然后(运行|验证|提交|告诉我)"
  /(?:新增|创建|添加|补上|删掉|删除|移除|修复|实现|完成)(?:一下|下|了)?\s+\S+.{0,80}?(?:然后|并|再|同时|，|。)?\s*(?:运行|测试|验证|提交|告诉我|输出)/,
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
 * Pre-filter shared by every extraction path: instructions, help requests,
 * denials and questions are never durable statements, regardless of whether
 * they happen to match a preference/decision pattern.
 */
export function isDurableCandidate(text: string): boolean {
  const t = text.trim();
  if (t.length < 4) return false;
  if (INSTRUCTION_PATTERNS.some((p) => p.test(t))) return false;
  if (isHelpRequest(t)) return false;
  if (isDenial(t)) return false;
  if (isQuestion(t)) return false;
  return true;
}

/**
 * Full durability gate for a single user message. Returns the fact category
 * when the text is a durable statement worth storing, or undefined when it
 * should never be auto-extracted (instructions, help requests, denials,
 * questions, and anything that matches no durable pattern).
 *
 * Shared by the agent_end extraction path and the session-end topic summary
 * (builtin-provider.ts) so both agree on what is a storeable statement.
 */
export function classifyMessage(text: string): Category | undefined {
  if (!isDurableCandidate(text)) return undefined;
  const t = text.trim();

  if (isLikelyCorrection(t)) return "correction";
  if (FAILURE_PATTERNS.some((p) => p.test(t))) return "failure";
  if (INSIGHT_PATTERNS.some((p) => p.test(t))) return "insight";
  if (PREF_PATTERNS.some((p) => p.test(t))) return "user_pref";
  if (CONVENTION_PATTERNS.some((p) => p.test(t))) return "convention";
  if (TOOL_QUIRK_PATTERNS.some((p) => p.test(t))) return "tool_quirk";
  if (DECISION_PATTERNS.some((p) => p.test(t))) return "project";
  return undefined;
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
    const category = classifyMessage(text);
    if (!category) continue;

    try {
      store.add(text.slice(0, 200), {
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
