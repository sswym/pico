import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { rmSync } from "node:fs";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { buildRuntimeArgs, isNonTuiArg } from "../src/runtime/args.ts";
import { prepareEmbeddedRuntime } from "../src/runtime/embedded-runtime.ts";
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
  ]);
});

test("buildRuntimeArgs defaults to fullscreen TUI only when interactive and unset", () => {
  const promptsDir = resolve(import.meta.dir, "..", "src", "prompts");

  // Explicit separated and equals forms are preserved, not duplicated.
  expect(buildRuntimeArgs({
    rawArgs: ["--tui-mode", "regular"],
    entryMetaUrl,
    isBunBinary: false,
  })).toEqual(["--tui-mode", "regular", "--prompt-template", promptsDir]);

  expect(buildRuntimeArgs({
    rawArgs: ["--tui-mode=regular"],
    entryMetaUrl,
    isBunBinary: false,
  })).toEqual(["--tui-mode=regular", "--prompt-template", promptsDir]);

  // Non-TUI output modes never get the TUI flag.
  expect(buildRuntimeArgs({
    rawArgs: ["-p", "hi"],
    entryMetaUrl,
    isBunBinary: false,
  })).toEqual(["-p", "hi", "--prompt-template", promptsDir]);

  expect(buildRuntimeArgs({
    rawArgs: ["--mode", "json"],
    entryMetaUrl,
    isBunBinary: false,
  })).toEqual(["--mode", "json", "--prompt-template", promptsDir]);
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
