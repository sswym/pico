import { expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { buildRuntimeArgs, isNonTuiArg } from "../src/runtime/args.ts";
import { cleanupStaleEmbeddedDirs, prepareEmbeddedRuntime } from "../src/runtime/embedded-runtime.ts";
import { ExtensionRegistry } from "../src/runtime/extensions.ts";

const entryMetaUrl = pathToFileURL(resolve(import.meta.dir, "..", "bin", "pico.ts")).href;

test("buildRuntimeArgs injects bundled prompts in source mode", () => {
  const args = buildRuntimeArgs({
    rawArgs: [],
    entryMetaUrl,
    isBunBinary: false,
  });

  expect(args).toEqual([
    "--tui-mode",
    "fullscreen",
    "--prompt-template",
    resolve(import.meta.dir, "..", "src", "prompts"),
    "--skill",
    resolve(import.meta.dir, "..", "src", "skills"),
  ]);
});

test("buildRuntimeArgs defaults to fullscreen TUI only when interactive and unset", () => {
  const promptsDir = resolve(import.meta.dir, "..", "src", "prompts");
  const skillsDir = resolve(import.meta.dir, "..", "src", "skills");

  // Explicit separated and equals forms are preserved, not duplicated.
  expect(buildRuntimeArgs({
    rawArgs: ["--tui-mode", "regular"],
    entryMetaUrl,
    isBunBinary: false,
  })).toEqual(["--tui-mode", "regular", "--prompt-template", promptsDir, "--skill", skillsDir]);

  expect(buildRuntimeArgs({
    rawArgs: ["--tui-mode=regular"],
    entryMetaUrl,
    isBunBinary: false,
  })).toEqual(["--tui-mode=regular", "--prompt-template", promptsDir, "--skill", skillsDir]);

  // Non-TUI output modes never get the TUI flag.
  expect(buildRuntimeArgs({
    rawArgs: ["-p", "hi"],
    entryMetaUrl,
    isBunBinary: false,
  })).toEqual(["-p", "hi", "--prompt-template", promptsDir, "--skill", skillsDir]);

  expect(buildRuntimeArgs({
    rawArgs: ["--mode", "json"],
    entryMetaUrl,
    isBunBinary: false,
  })).toEqual(["--mode", "json", "--prompt-template", promptsDir, "--skill", skillsDir]);
});

test("buildRuntimeArgs respects opt-out and package-management commands", () => {
  expect(buildRuntimeArgs({
    rawArgs: ["--no-skills", "--no-prompt-templates"],
    entryMetaUrl,
    isBunBinary: false,
  })).toEqual(["--no-skills", "--no-prompt-templates", "--tui-mode", "fullscreen"]);

  expect(buildRuntimeArgs({
    rawArgs: ["install", "example"],
    entryMetaUrl,
    isBunBinary: false,
  })).toEqual(["install", "example"]);
});

test("prepareEmbeddedRuntime defers signal handling to the host", () => {
  const sigintBefore = process.listenerCount("SIGINT");
  const sigtermBefore = process.listenerCount("SIGTERM");
  const oldPkgDir = process.env.PI_PACKAGE_DIR;
  const dirs = prepareEmbeddedRuntime(true);
  try {
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
  } finally {
    if (oldPkgDir === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = oldPkgDir;
    if (dirs) rmSync(dirname(dirs.promptsDir), { recursive: true, force: true });
  }
});

test("buildRuntimeArgs does not duplicate existing bundled paths", () => {
  const promptsDir = resolve(import.meta.dir, "..", "src", "prompts");
  const skillsDir = resolve(import.meta.dir, "..", "src", "skills");

  expect(buildRuntimeArgs({
    rawArgs: ["--prompt-template", promptsDir, "--skill", skillsDir],
    entryMetaUrl,
    isBunBinary: false,
  })).toEqual(["--prompt-template", promptsDir, "--skill", skillsDir, "--tui-mode", "fullscreen"]);
});

test("buildRuntimeArgs resolves --theme names to theme files (M2)", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-args-theme-"));
  const agentDir = join(home, "agent");
  mkdirSync(join(agentDir, "themes"), { recursive: true });
  writeFileSync(
    join(agentDir, "themes", "claude-code-dark.json"),
    JSON.stringify({ name: "claude-code-dark", colors: {} }),
    "utf-8",
  );
  const prevHome = process.env.PICO_HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PICO_HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const args = buildRuntimeArgs({
      rawArgs: ["--theme", "claude-code-dark"],
      entryMetaUrl,
      isBunBinary: false,
    });
    // The bare name must be rewritten to the custom theme file's absolute
    // path so upstream does not treat it as a cwd-relative path.
    expect(args[0]).toBe("--theme");
    expect(args[1]).toBe(join(agentDir, "themes", "claude-code-dark.json"));
  } finally {
    if (prevHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = prevHome;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildRuntimeArgs resolves builtin theme names via PI_PACKAGE_DIR (M2)", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-args-theme-"));
  const agentDir = join(home, "agent");
  mkdirSync(agentDir, { recursive: true });
  const upstream = resolve(import.meta.dir, "..", "node_modules", "@earendil-works", "pi-coding-agent");
  const builtinTheme = join(upstream, "dist", "modes", "interactive", "theme", "light.json");
  const prevHome = process.env.PICO_HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPkgDir = process.env.PI_PACKAGE_DIR;
  process.env.PICO_HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_PACKAGE_DIR = upstream;
  try {
    const args = buildRuntimeArgs({
      rawArgs: ["--theme", "light"],
      entryMetaUrl,
      isBunBinary: false,
    });
    expect(args[1]).toBe(builtinTheme);
  } finally {
    if (prevHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = prevHome;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPkgDir === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = prevPkgDir;
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildRuntimeArgs leaves theme paths and unknown names untouched (M2)", () => {
  const home = mkdtempSync(join(tmpdir(), "pico-args-theme-"));
  const agentDir = join(home, "agent");
  mkdirSync(agentDir, { recursive: true });
  const prevHome = process.env.PICO_HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PICO_HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    // Absolute paths are the user's own files — passed through verbatim.
    const absolute = buildRuntimeArgs({
      rawArgs: ["--theme", "/abs/path/theme.json"],
      entryMetaUrl,
      isBunBinary: false,
    });
    expect(absolute[1]).toBe("/abs/path/theme.json");

    // Unknown names resolve to nothing — upstream reports its own
    // "theme path does not exist" diagnostic instead.
    const unknown = buildRuntimeArgs({
      rawArgs: ["--theme", "no-such-theme"],
      entryMetaUrl,
      isBunBinary: false,
    });
    expect(unknown[1]).toBe("no-such-theme");
  } finally {
    if (prevHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = prevHome;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(home, { recursive: true, force: true });
  }
});

test("cleanupStaleEmbeddedDirs removes SIGKILLed residue but keeps live and legacy dirs", () => {
  // Beyond pid_max → provably no such process (ESRCH), simulating a
  // SIGKILLed pico whose exit cleanup never ran.
  const deadPid = 2147483647;
  const staleName = `pico-${deadPid}-${randomBytes(6).toString("hex")}`;
  const liveName = `pico-${process.pid}-${randomBytes(6).toString("hex")}`;
  const legacyName = `pico-${randomBytes(6).toString("hex")}`;
  const staleDir = join(tmpdir(), staleName);
  const liveDir = join(tmpdir(), liveName);
  const legacyDir = join(tmpdir(), legacyName);
  mkdirSync(staleDir, { recursive: true });
  mkdirSync(liveDir, { recursive: true });
  mkdirSync(legacyDir, { recursive: true });
  try {
    cleanupStaleEmbeddedDirs();
    expect(existsSync(staleDir)).toBe(false);
    // A live process (our own pid) must never be touched.
    expect(existsSync(liveDir)).toBe(true);
    // Legacy pre-PID dirs carry no owner marker — left alone.
    expect(existsSync(legacyDir)).toBe(true);
  } finally {
    rmSync(staleDir, { recursive: true, force: true });
    rmSync(liveDir, { recursive: true, force: true });
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

test("isNonTuiArg catches separated AND equals-form non-TUI flags", () => {
  // Separated forms (upstream's canonical spelling).
  expect(isNonTuiArg("--mode")).toBe(true);
  expect(isNonTuiArg("--print")).toBe(true);
  expect(isNonTuiArg("-p")).toBe(true);
  // Equals forms — a miss here lets console.clear() corrupt RPC/JSON stdout
  // for consumers running in a TTY.
  expect(isNonTuiArg("--mode=json")).toBe(true);
  expect(isNonTuiArg("--mode=rpc")).toBe(true);
  expect(isNonTuiArg("--print=hello")).toBe(true);
  // Ordinary flags and values stay clear.
  expect(isNonTuiArg("--verbose")).toBe(false);
  expect(isNonTuiArg("json")).toBe(false);
});

test("ExtensionRegistry returns named hidden inline extensions in order", () => {
  const first: ExtensionFactory = () => {};
  const second: ExtensionFactory = () => {};

  const registry = new ExtensionRegistry([
    { name: "first", factory: first, phase: "tools" },
    { name: "second", factory: second, phase: "runtime", dependsOn: ["first"] },
  ]);

  expect(registry.names()).toEqual(["first", "second"]);
  // Named + hidden inline extensions: upstream then shows no <inline:N>
  // placeholder rows in the startup Extensions listing.
  expect(registry.factories()).toEqual([
    { name: "first", factory: first, hidden: true },
    { name: "second", factory: second, hidden: true },
  ]);
});

test("ExtensionRegistry rejects duplicates and unmet ordered dependencies", () => {
  const factory: ExtensionFactory = () => {};

  expect(() => new ExtensionRegistry([
    { name: "same", factory, phase: "tools" },
    { name: "same", factory, phase: "tools" },
  ])).toThrow("Duplicate pico extension registered: same");

  expect(() => new ExtensionRegistry([
    { name: "late", factory, phase: "tools", dependsOn: ["missing"] },
  ])).toThrow("Extension late depends on missing");
});
