import { dirname } from "node:path";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type UnknownRecord = Record<string, unknown>;
type PiModel = NonNullable<ExtensionContext["model"]>;

const PI_CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";
const LONG_CACHE_RETENTION_VALUE = "long";
const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const SKILL_COMPRESSION_MIN_COUNT = 3;
const MIN_STABLE_CANDIDATE_LENGTH = 64;

/**
 * Extensions that inject always-on guidance into the system prompt can wrap
 * the parts that are byte-identical across turns in these markers; the
 * optimizer lifts them into the cacheable stable prefix. Mode-dependent
 * fragments (a level line that changes on /ponytail lite|full|ultra) must
 * stay OUTSIDE the markers — putting them inside invalidates the whole prefix
 * cache on every mode switch. Both markers match the structural-marker safety
 * net regex, so a lifted block keeps them verbatim.
 */
const STABLE_SECTION_START = "<!-- PICO_CACHE_STABLE:START -->";
const STABLE_SECTION_END = "<!-- PICO_CACHE_STABLE:END -->";

const DISABLE_ENV = "PICO_CACHE_OPTIMIZER_DISABLE";
const NO_PROMPT_REWRITE_ENV = "PICO_CACHE_OPTIMIZER_NO_PROMPT_REWRITE";
const NO_SKILL_COMPRESSION_ENV = "PICO_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION";
const NO_OPENAI_CACHE_KEY_ENV = "PICO_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY";
const ALLOW_PROXY_LONG_RETENTION_ENV = "PICO_CACHE_OPTIMIZER_ALLOW_PROXY_LONG_RETENTION";

function isEnabledEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no" && normalized !== "off";
}

function optimizerDisabled(): boolean {
  return isEnabledEnv(process.env[DISABLE_ENV]) || isEnabledEnv(process.env.PI_CACHE_OPTIMIZER_DISABLE);
}

function promptRewriteDisabled(): boolean {
  return isEnabledEnv(process.env[NO_PROMPT_REWRITE_ENV]) ||
    isEnabledEnv(process.env.PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE);
}

function skillCompressionDisabled(): boolean {
  return isEnabledEnv(process.env[NO_SKILL_COMPRESSION_ENV]) ||
    isEnabledEnv(process.env.PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION);
}

function openAICacheKeyDisabled(): boolean {
  return isEnabledEnv(process.env[NO_OPENAI_CACHE_KEY_ENV]) ||
    isEnabledEnv(process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY);
}

function requestLongCacheRetention(): void {
  if (!process.env[PI_CACHE_RETENTION_ENV]) {
    process.env[PI_CACHE_RETENTION_ENV] = LONG_CACHE_RETENTION_VALUE;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function isStableContextFilePath(path: string): boolean {
  const normalized = normalizedPath(path);
  const name = normalized.split("/").pop();
  return (
    name === "agents.md" ||
    name === "claude.md" ||
    name === "gemini.md" ||
    name === "cursor.md" ||
    normalized.startsWith(".trellis/spec/") ||
    normalized.includes("/.trellis/spec/")
  );
}

export function formatSkillsForPrompt(skills: NonNullable<BuildSystemPromptOptions["skills"]>): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description ?? "")}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath ?? "")}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

export function formatSkillsForPromptCompressed(skills: NonNullable<BuildSystemPromptOptions["skills"]>): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";

  const groups = new Map<string, string[]>();
  for (const skill of visibleSkills) {
    if (!skill.filePath) continue;
    const root = dirname(dirname(skill.filePath));
    const list = groups.get(root) ?? [];
    list.push(skill.name);
    groups.set(root, list);
  }

  const lines = [
    "",
    "",
    "The following skills provide specialized instructions for specific tasks. When a skill name matches the task you are doing, read the SKILL.md at the listed location to load the full instructions. When a SKILL.md references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
  ];

  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [root, names] of sortedGroups) {
    names.sort((a, b) => a.localeCompare(b));
    lines.push("");
    lines.push(`Skills under ${root}/<name>/SKILL.md:`);
    lines.push(`  ${names.join(", ")}`);
  }

  return lines.join("\n");
}

export function compressSkillsInSystemPrompt(prompt: string, opts: BuildSystemPromptOptions): string {
  if (skillCompressionDisabled()) return prompt;
  const skills = opts.skills ?? [];
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length < SKILL_COMPRESSION_MIN_COUNT) return prompt;

  const verbose = formatSkillsForPrompt(skills);
  if (!verbose || !prompt.includes(verbose)) return prompt;

  const compressed = formatSkillsForPromptCompressed(skills);
  if (!compressed || compressed.length >= verbose.length) return prompt;

  return prompt.replace(verbose, compressed);
}

/**
 * Extract explicitly-marked stable sections from a prompt.
 *
 * A section is everything from a START marker to its first END marker
 * (markers included), so the structural-marker safety net keeps both. A
 * START without a following END is ignored and its content stays in place.
 * Returns [] when no complete section exists.
 */
function extractMarkedStableSections(prompt: string): string[] {
  const sections: string[] = [];
  let searchFrom = 0;
  while (true) {
    const startIdx = prompt.indexOf(STABLE_SECTION_START, searchFrom);
    if (startIdx < 0) break;
    const endIdx = prompt.indexOf(STABLE_SECTION_END, startIdx + STABLE_SECTION_START.length);
    if (endIdx < 0) break; // unterminated marker: leave everything from here as-is
    sections.push(prompt.slice(startIdx, endIdx + STABLE_SECTION_END.length));
    searchFrom = endIdx + STABLE_SECTION_END.length;
  }
  return sections;
}

function buildStableCandidates(opts: BuildSystemPromptOptions): string[] {
  const candidates: string[] = [];
  if (opts.customPrompt) candidates.push(opts.customPrompt);
  if (opts.appendSystemPrompt) candidates.push(opts.appendSystemPrompt);

  const toolLines = (opts.selectedTools ?? [])
    .filter((name) => opts.toolSnippets?.[name])
    .map((name) => `- ${name}: ${opts.toolSnippets?.[name]}`);
  if (toolLines.length > 0) {
    candidates.push(`Available tools:\n${toolLines.join("\n")}`);
  }

  for (const guideline of opts.promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized) candidates.push(`- ${normalized}`);
  }

  for (const file of opts.contextFiles ?? []) {
    if (!isStableContextFilePath(file.path)) continue;
    candidates.push(`## ${file.path}\n\n${file.content}`);
    candidates.push(file.content);
  }

  if (opts.skills && opts.skills.length > 0) {
    candidates.push(formatSkillsForPrompt(opts.skills));
    candidates.push(formatSkillsForPromptCompressed(opts.skills));
  }

  return candidates;
}

function extractStructuralMarkers(prompt: string): Set<string> {
  const markers = new Set<string>();
  for (const match of prompt.matchAll(/<\/?([a-z][a-z0-9_-]*)>/gi)) {
    markers.add(match[0].toLowerCase());
  }
  for (const match of prompt.matchAll(/<!--\s*([A-Z][A-Z0-9_-]*):(START|END)\s*-->/g)) {
    markers.add(`${match[1]}:${match[2]}`);
  }
  return markers;
}

export interface OptimizedSystemPrompt {
  systemPrompt: string;
  stablePrefix: string;
  changed: boolean;
}

export function optimizeSystemPrompt(original: string, opts: BuildSystemPromptOptions): OptimizedSystemPrompt {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...buildStableCandidates(opts), ...extractMarkedStableSections(original)]) {
    const part = candidate.trim();
    if (!part || part.length < MIN_STABLE_CANDIDATE_LENGTH || seen.has(part)) continue;
    seen.add(part);
    candidates.push(part);
  }

  const occurrenceCount = new Map<string, number>();
  for (const part of candidates) {
    let count = 0;
    let searchFrom = 0;
    while (searchFrom < original.length) {
      const index = original.indexOf(part, searchFrom);
      if (index < 0) break;
      count++;
      if (count > 1) break;
      searchFrom = index + 1;
    }
    occurrenceCount.set(part, count);
  }

  // Extract longer candidates FIRST: a short candidate that is a verbatim
  // substring of a longer stable block (e.g. a guideline sentence copied
  // inside an AGENTS.md section) would otherwise be carved out of the
  // block's middle, breaking the block match and silently dropping the rest
  // of its text from the prompt.
  const ordered = [...candidates].sort((a, b) => b.length - a.length);
  const stableParts: string[] = [];
  let rest = original;
  for (const part of ordered) {
    if (occurrenceCount.get(part) !== 1) continue;
    const index = rest.indexOf(part);
    if (index < 0) continue;
    stableParts.push(part);
    rest = rest.slice(0, index) + rest.slice(index + part.length);
  }

  if (stableParts.length === 0) {
    return { systemPrompt: original, stablePrefix: "", changed: false };
  }

  const stablePrefix = stableParts.join("\n\n");
  const dynamicRemainder = rest.trim();
  const systemPrompt = stablePrefix + (dynamicRemainder ? `\n\n---\n\n${dynamicRemainder}` : "");

  const originalMarkers = extractStructuralMarkers(original);
  const resultMarkers = extractStructuralMarkers(systemPrompt);
  for (const marker of originalMarkers) {
    if (!resultMarkers.has(marker)) {
      return { systemPrompt: original, stablePrefix: "", changed: false };
    }
  }

  return { systemPrompt, stablePrefix, changed: true };
}

function apiName(model: PiModel | undefined): string {
  return String(model?.api ?? "").toLowerCase();
}

function shouldBypassPromptRewrite(model: PiModel | undefined): boolean {
  const api = apiName(model);
  return api.includes("openai-responses") || api.includes("codex-responses");
}

function shouldInjectOpenAIPromptCacheKey(model: PiModel | undefined): boolean {
  if (openAICacheKeyDisabled()) return false;
  const api = apiName(model);
  if (!api.includes("openai-completions")) return false;
  // 2.5.5: the api name alone is not enough — vLLM, Ollama, and self-hosted
  // OpenAI-compatible gateways all advertise "openai-completions" and would
  // 400 on the unknown `prompt_cache_key` field. Only official OpenAI
  // endpoints (api.openai.com) get the field.
  return isOfficialOpenAIBaseUrl(model);
}

function clampPromptCacheKey(key: string | undefined): string | undefined {
  const normalized = key?.trim();
  if (!normalized) return undefined;
  const chars = Array.from(normalized);
  return chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH
    ? normalized
    : chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

function getSessionPromptCacheKey(ctx: ExtensionContext): string | undefined {
  // sessionManager may be absent or throw on some hosts; the cache key is an
  // optimization, so a missing one must never break the provider request.
  try {
    return clampPromptCacheKey(ctx.sessionManager.getSessionId());
  } catch {
    return undefined;
  }
}

function hasEffectivePromptCacheKey(record: UnknownRecord): boolean {
  return isNonEmptyString(record.prompt_cache_key) || isNonEmptyString(record.promptCacheKey);
}

function isOfficialOpenAIBaseUrl(model: PiModel | undefined): boolean {
  if (!model) return false;
  const provider = String(model.provider ?? "").toLowerCase();
  const baseUrl = String(model.baseUrl ?? "").trim().toLowerCase();
  if (!baseUrl) return provider === "openai";

  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return baseUrl === "api.openai.com" || baseUrl.startsWith("api.openai.com/");
  }
}

export function optimizeProviderPayload(payload: unknown, model: PiModel | undefined, cacheKey: string | undefined): unknown | undefined {
  if (!isRecord(payload)) return undefined;

  let next: UnknownRecord | undefined;
  const mutable = (): UnknownRecord => {
    next ??= { ...payload };
    return next;
  };

  if (
    typeof payload.prompt_cache_retention === "string" &&
    !isOfficialOpenAIBaseUrl(model) &&
    !isEnabledEnv(process.env[ALLOW_PROXY_LONG_RETENTION_ENV])
  ) {
    delete mutable().prompt_cache_retention;
  }

  if (shouldInjectOpenAIPromptCacheKey(model) && !hasEffectivePromptCacheKey(payload)) {
    const normalizedCacheKey = clampPromptCacheKey(cacheKey);
    if (normalizedCacheKey) {
      mutable().prompt_cache_key = normalizedCacheKey;
    }
  }

  return next;
}

export const cacheOptimizerExtension = (pi: ExtensionAPI): void => {
  if (!optimizerDisabled()) requestLongCacheRetention();

  pi.on("before_agent_start", (event, ctx) => {
    if (optimizerDisabled() || promptRewriteDisabled() || shouldBypassPromptRewrite(ctx.model)) return {};

    const compressed = compressSkillsInSystemPrompt(event.systemPrompt, event.systemPromptOptions);
    const optimized = optimizeSystemPrompt(compressed, event.systemPromptOptions);

    if (optimized.changed && optimized.systemPrompt.trim()) {
      return { systemPrompt: optimized.systemPrompt };
    }
    if (compressed !== event.systemPrompt && compressed.trim()) {
      return { systemPrompt: compressed };
    }
    return {};
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (optimizerDisabled()) return undefined;
    return optimizeProviderPayload(event.payload, ctx.model, getSessionPromptCacheKey(ctx));
  });
};
