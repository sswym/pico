import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  cacheOptimizerExtension,
  compressSkillsInSystemPrompt,
  formatSkillsForPrompt,
  optimizeProviderPayload,
  optimizeSystemPrompt,
} from "../src/extensions/cache-optimizer/index.ts";

type FakeHandler = (event: any, ctx: any) => any;

function makeFakePi() {
  const handlers: Record<string, FakeHandler[]> = {};
  return {
    handlers,
    on: (event: string, handler: FakeHandler) => {
      (handlers[event] ??= []).push(handler);
    },
  };
}

function makeOpts(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/repo",
    ...overrides,
  } as any;
}

function makeSkill(name: string) {
  return {
    name,
    description: `Detailed description for ${name} that is intentionally long enough to make compression useful.`,
    filePath: `/home/user/.pico/skills/${name}/SKILL.md`,
    disableModelInvocation: false,
  };
}

const savedEnv = { ...process.env };

beforeEach(() => {
  delete process.env.PICO_CACHE_OPTIMIZER_DISABLE;
  delete process.env.PICO_CACHE_OPTIMIZER_NO_PROMPT_REWRITE;
  delete process.env.PICO_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION;
  delete process.env.PICO_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY;
  delete process.env.PICO_CACHE_OPTIMIZER_ALLOW_PROXY_LONG_RETENTION;
  delete process.env.PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE;
  delete process.env.PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION;
  delete process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY;
  delete process.env.PI_CACHE_RETENTION;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

test("compresses verbose skill block into deterministic index", () => {
  const skills = [makeSkill("zeta"), makeSkill("alpha"), makeSkill("memory")] as any;
  const verbose = formatSkillsForPrompt(skills);
  const prompt = `base${verbose}\ntail`;

  const result = compressSkillsInSystemPrompt(prompt, makeOpts({ skills }));

  expect(result).toContain("Skills under /home/user/.pico/skills/<name>/SKILL.md:");
  expect(result).toContain("alpha, memory, zeta");
  expect(result).not.toContain("<available_skills>");
  expect(result.length).toBeLessThan(prompt.length);
});

test("moves unique stable context before dynamic prompt content", () => {
  const stable = "Project convention: use Bun APIs, import types with import type, and keep extension edits narrowly scoped.";
  const prompt = [
    "Dynamic git state changes every turn.",
    `## AGENTS.md\n\n${stable}`,
    "More dynamic context.",
  ].join("\n\n");

  const result = optimizeSystemPrompt(prompt, makeOpts({
    contextFiles: [{ path: "AGENTS.md", content: stable }],
  }));

  expect(result.changed).toBe(true);
  expect(result.systemPrompt.startsWith(`## AGENTS.md\n\n${stable}`)).toBe(true);
  expect(result.systemPrompt).toContain("\n\n---\n\nDynamic git state");
});

test("does not lift ambiguous stable candidates", () => {
  const stable = "Project convention: this exact long stable paragraph appears twice and should not be lifted ambiguously.";
  const block = `## AGENTS.md\n\n${stable}`;
  const prompt = [
    block,
    "Dynamic context quotes it later:",
    block,
  ].join("\n\n");

  const result = optimizeSystemPrompt(prompt, makeOpts({
    contextFiles: [{ path: "AGENTS.md", content: stable }],
  }));

  expect(result.changed).toBe(false);
  expect(result.systemPrompt).toBe(prompt);
});

test("a short candidate nested inside a stable block does not hollow it out", () => {
  // The append prompt is a verbatim (>= 64 char) substring of the AGENTS.md
  // section. Lifting the short candidate first would carve a hole in the
  // block, breaking its match and dropping the rest of its text; the block
  // must survive whole with the snippet still inside it.
  const stable = "Project convention: use Bun APIs, prefer import type over any, keep extension edits narrowly scoped, and never commit generated files.";
  const nested = "use Bun APIs, prefer import type over any, keep extension edits narrowly scoped";
  const prompt = [
    "Dynamic git state.",
    `## AGENTS.md\n\n${stable}`,
    "More dynamic context.",
  ].join("\n\n");

  const result = optimizeSystemPrompt(prompt, makeOpts({
    contextFiles: [{ path: "AGENTS.md", content: stable }],
    appendSystemPrompt: nested,
  }));

  expect(result.changed).toBe(true);
  // The AGENTS.md block survives whole — no hole where the nested snippet was.
  expect(result.systemPrompt).toContain(`## AGENTS.md\n\n${stable}`);
  // The whole block (nested snippet included) is hoisted to the prefix.
  expect(result.systemPrompt.startsWith(`## AGENTS.md\n\n${stable}`)).toBe(true);
});

test("injects prompt_cache_key ONLY for official OpenAI endpoints (2.5.5)", () => {
  const payload = { model: "gpt", messages: [], prompt_cache_retention: "long" };
  const model = {
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
  } as any;

  const result = optimizeProviderPayload(payload, model, "session-123") as any;

  expect(result.prompt_cache_key).toBe("session-123");
  expect(result.prompt_cache_retention).toBe("long");
  expect(payload.prompt_cache_retention).toBe("long");

  // A third-party OpenAI-compatible gateway (vLLM/Ollama/proxy) must NOT
  // receive prompt_cache_key — the field 400s on gateways that don't know it.
  const proxyPayload = { model: "gpt", messages: [], prompt_cache_retention: "long" };
  const proxyModel = {
    provider: "proxy",
    api: "openai-completions",
    baseUrl: "https://proxy.example.test/v1",
  } as any;
  const proxyResult = optimizeProviderPayload(proxyPayload, proxyModel, "session-123") as any;
  expect(proxyResult.prompt_cache_key).toBeUndefined();
  expect(proxyResult.prompt_cache_retention).toBeUndefined();
});

test("preserves existing prompt_cache_key and official OpenAI retention", () => {
  const payload = { prompt_cache_key: "existing", prompt_cache_retention: "long" };
  const model = {
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
  } as any;

  const result = optimizeProviderPayload(payload, model, "session-123");

  expect(result).toBeUndefined();
});

test("provider hook tolerates missing or throwing sessionManager", () => {
  const pi = makeFakePi();
  cacheOptimizerExtension(pi as any);
  const hook = pi.handlers.before_provider_request![0]!;
  const model = {
    provider: "proxy",
    api: "openai-completions",
    baseUrl: "https://proxy.example.test/v1",
  };

  // No sessionManager at all: must not throw and must not inject a key.
  const noManager = hook({ payload: { messages: [] } }, { model }) as Record<string, unknown> | undefined;
  expect(noManager?.prompt_cache_key).toBeUndefined();

  // Throwing sessionManager: must be swallowed, not propagate.
  expect(() =>
    hook({ payload: { messages: [] } }, {
      model,
      sessionManager: { getSessionId: () => { throw new Error("no session"); } },
    }),
  ).not.toThrow();
});

test("extension registers prompt and provider hooks", () => {
  const pi = makeFakePi();
  cacheOptimizerExtension(pi as any);

  expect(process.env.PI_CACHE_RETENTION).toBe("long");
  expect(pi.handlers.before_agent_start).toHaveLength(1);
  expect(pi.handlers.before_provider_request).toHaveLength(1);

  const providerResult = pi.handlers.before_provider_request![0]!({
    payload: { messages: [] },
  }, {
    model: { provider: "proxy", api: "openai-completions", baseUrl: "https://proxy.example.test/v1" },
    sessionManager: { getSessionId: () => "test-session-id" },
  });

  // 2.5.5: proxy gateways must not receive prompt_cache_key.
  expect(providerResult).toBeUndefined();

  const officialResult = pi.handlers.before_provider_request![0]!({
    payload: { messages: [] },
  }, {
    model: { provider: "openai", api: "openai-completions", baseUrl: "https://api.openai.com/v1" },
    sessionManager: { getSessionId: () => "test-session-id" },
  });
  expect(officialResult.prompt_cache_key).toBe("test-session-id");
});

const STABLE_START = "<!-- PICO_CACHE_STABLE:START -->";
const STABLE_END = "<!-- PICO_CACHE_STABLE:END -->";

test("lifts explicitly-marked stable sections into the prefix", () => {
  const marked = `${STABLE_START}\nLazy senior dev ladder: does it need to exist? reuse it. stdlib. native. dependency. one line. minimum.\n${STABLE_END}`;
  const prompt = [
    "Dynamic user context changes every turn.",
    marked,
    "More dynamic context.",
  ].join("\n\n");

  const result = optimizeSystemPrompt(prompt, makeOpts());

  expect(result.changed).toBe(true);
  expect(result.systemPrompt.startsWith(marked)).toBe(true);
  expect(result.systemPrompt).toContain("\n\n---\n\nDynamic user context");
});

test("keeps mode-dependent text outside markers in the dynamic remainder", () => {
  const marked = `${STABLE_START}\nThe ladder is byte-identical in every mode.\n${STABLE_END}`;
  const modeLine = "PONYTAIL MODE ACTIVE — level: ultra";
  const prompt = [marked, modeLine, "Dynamic tail."].join("\n\n");

  const result = optimizeSystemPrompt(prompt, makeOpts());

  expect(result.changed).toBe(true);
  expect(result.systemPrompt.startsWith(marked)).toBe(true);
  const remainder = result.systemPrompt.slice(result.systemPrompt.indexOf("\n\n---\n\n"));
  expect(remainder).toContain(modeLine);
});

test("ignores unterminated stable markers", () => {
  const prompt = [
    "Dynamic context.",
    `${STABLE_START}\nThis block has no end marker.`,
  ].join("\n\n");

  const result = optimizeSystemPrompt(prompt, makeOpts());

  expect(result.changed).toBe(false);
  expect(result.systemPrompt).toBe(prompt);
});

test("does not lift a marked section shorter than the minimum length", () => {
  const marked = `${STABLE_START}${STABLE_END}`;
  const prompt = [marked, "Dynamic tail."].join("\n\n");

  const result = optimizeSystemPrompt(prompt, makeOpts());

  expect(result.changed).toBe(false);
  expect(result.systemPrompt).toBe(prompt);
});

test("preserves structural markers when lifting marked sections", () => {
  const marked = `${STABLE_START}\n<rules>same every turn</rules>\n${STABLE_END}`;
  const prompt = [marked, "Dynamic."].join("\n\n");

  const result = optimizeSystemPrompt(prompt, makeOpts());

  expect(result.changed).toBe(true);
  expect(result.systemPrompt.startsWith(marked)).toBe(true);
  expect(result.systemPrompt).toContain("<rules>same every turn</rules>");
});

test("lifts the whole <project_instructions> wrapper with content intact (D11-F1)", () => {
  // Mirrors the upstream system-prompt builder:
  //   `<project_instructions path="${filePath}">\n${content}\n</project_instructions>`
  // Hoisting the bare `file.content` would hollow the wrapper (empty tag pair
  // left behind, content reordered to the top of the prompt); the wrapper
  // must move into the stable prefix as one block.
  const content = [
    "# AGENTS.md",
    "",
    "> Project conventions for this repo.",
    "- use Bun APIs",
    "- prefer `import type`",
    "- keep extension edits narrowly scoped",
    "",
  ].join("\n");
  const wrapper = `<project_instructions path="/repo/AGENTS.md">\n${content}\n</project_instructions>`;
  const prompt = [
    "<project_context>",
    "",
    "Project-specific instructions and guidelines:",
    "",
    wrapper,
    "",
    "</project_context>",
    "",
    "Dynamic git state changes every turn.",
  ].join("\n");

  const result = optimizeSystemPrompt(prompt, makeOpts({
    contextFiles: [{ path: "/repo/AGENTS.md", content }],
  }));

  expect(result.changed).toBe(true);
  // The complete wrapper — opening tag, content, closing tag, in original
  // order — is hoisted byte-identically into the stable prefix.
  expect(result.stablePrefix).toBe(wrapper);
  expect(result.systemPrompt.startsWith(wrapper)).toBe(true);
  // The tag pair still encloses the full content: nothing was carved out.
  const openTag = '<project_instructions path="/repo/AGENTS.md">';
  const openIdx = result.systemPrompt.indexOf(openTag);
  const closeIdx = result.systemPrompt.indexOf("</project_instructions>");
  expect(openIdx).toBeGreaterThanOrEqual(0);
  expect(closeIdx).toBeGreaterThan(openIdx);
  expect(result.systemPrompt.slice(openIdx + openTag.length, closeIdx)).toBe(`\n${content}\n`);
  // No hollowed wrapper remains anywhere in the prompt.
  expect(result.systemPrompt).not.toContain('<project_instructions path="/repo/AGENTS.md">\n\n</project_instructions>');
  // Dynamic content stays in the remainder after the separator, not reordered
  // above the wrapper.
  const sepIdx = result.systemPrompt.indexOf("\n\n---\n\n");
  expect(sepIdx).toBeGreaterThan(0);
  expect(result.systemPrompt.slice(sepIdx)).toContain("Dynamic git state changes every turn.");
});

test("leaves <project_instructions> wrappers for non-stable files in place (D11-F1)", () => {
  const content = "A long enough non-stable note that must not be hoisted: keep extension edits narrowly scoped and use Bun APIs throughout.";
  const wrapper = `<project_instructions path="/repo/NOTES.md">\n${content}\n</project_instructions>`;
  const prompt = [wrapper, "Dynamic tail."].join("\n\n");

  const result = optimizeSystemPrompt(prompt, makeOpts({
    contextFiles: [{ path: "/repo/NOTES.md", content }],
  }));

  expect(result.changed).toBe(false);
  expect(result.systemPrompt).toBe(prompt);
});
