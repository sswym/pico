import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteRtkCommand, rtkExtension, shouldRewriteWithRtk } from "../src/extensions/rtk/index.ts";
import {
  __resetBashSpawnHooksForTests,
  composeBashSpawnHooks,
  registerBashSpawnHook,
} from "../src/extensions/bash-hooks.ts";

const ORIG_PICO_HOME = process.env.PICO_HOME;
const ORIG_PICO_RTK = process.env.PICO_RTK;
let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "pico-rtk-home-"));
  process.env.PICO_HOME = testHome;
  delete process.env.PICO_RTK;
  __resetBashSpawnHooksForTests();
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  if (ORIG_PICO_HOME === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = ORIG_PICO_HOME;
  if (ORIG_PICO_RTK === undefined) delete process.env.PICO_RTK;
  else process.env.PICO_RTK = ORIG_PICO_RTK;
  __resetBashSpawnHooksForTests();
});

test("registerBashSpawnHook feeds composeBashSpawnHooks in registration order", () => {
  expect(composeBashSpawnHooks()).toBeUndefined();

  registerBashSpawnHook((context) => ({ ...context, command: `a ${context.command}` }));
  registerBashSpawnHook((context) => ({ ...context, command: `b ${context.command}` }));

  const compose = composeBashSpawnHooks();
  expect(compose).toBeDefined();
  expect(compose!({ command: "x", cwd: "/tmp", env: {} }).command).toBe("b a x");
});

test("rtkExtension registers the bash tool with the spawn hook chain", () => {
  // Upstream treats duplicate extension tool names across extensions as a
  // FATAL startup error, so "bash" has exactly one extension owner. With
  // undo-redo removed, rtk owns that registration and composes the
  // bash-hooks spawn chain into its tool.
  const agentDir = join(testHome, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      integrations: { rtk: { enabled: true, command: "bun" } },
    }),
    "utf8",
  );

  const registeredTools: string[] = [];
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => void>> = {};
  const fakePi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
  } as any;

  rtkExtension(fakePi);

  // The bash tool is registered (the single bash owner).
  expect(registeredTools).toEqual(["bash"]);

  // The hook rewrites eligible commands through the configured binary…
  const compose = composeBashSpawnHooks();
  expect(compose).toBeDefined();
  expect(compose!({ command: "git status", cwd: "/tmp", env: {} }).command).toBe("bun git status");
  // …and leaves ineligible commands untouched.
  expect(compose!({ command: "cd ..", cwd: "/tmp", env: {} }).command).toBe("cd ..");

  // Session notification wiring is still installed.
  expect(handlers["session_start"]).toBeDefined();
});

test("shouldRewriteWithRtk accepts compact shell commands", () => {
  expect(shouldRewriteWithRtk("git status")).toBe(true);
  expect(shouldRewriteWithRtk("rg foo src")).toBe(true);
  expect(shouldRewriteWithRtk("cargo test")).toBe(true);
});

test("shouldRewriteWithRtk skips already wrapped or interactive commands", () => {
  expect(shouldRewriteWithRtk("rtk git status")).toBe(false);
  expect(shouldRewriteWithRtk("cd ..")).toBe(false);
  expect(shouldRewriteWithRtk("source .env")).toBe(false);
  expect(shouldRewriteWithRtk("bun run start")).toBe(false);
});

test("rewriteRtkCommand prepends rtk only when eligible", () => {
  expect(rewriteRtkCommand("git status")).toBe("rtk git status");
  expect(rewriteRtkCommand("rtk git status")).toBe("rtk git status");
  expect(rewriteRtkCommand("echo hello")).toBe("echo hello");
});

test("shouldRewriteWithRtk skips long-running variants of supported commands", () => {
  expect(shouldRewriteWithRtk("tail --follow")).toBe(false);
  expect(shouldRewriteWithRtk("tail -f")).toBe(false);
  expect(shouldRewriteWithRtk("jest --watch")).toBe(false);
  expect(shouldRewriteWithRtk("vitest --watch")).toBe(false);
  expect(shouldRewriteWithRtk("playwright --watch")).toBe(false);
  expect(shouldRewriteWithRtk("bun --hot")).toBe(false);
  expect(shouldRewriteWithRtk("npm run dev-server")).toBe(false);
  expect(shouldRewriteWithRtk("bun run dev")).toBe(false);
  expect(rewriteRtkCommand("tail --follow")).toBe("tail --follow");
  expect(rewriteRtkCommand("jest --watch")).toBe("jest --watch");
});

test("shouldRewriteWithRtk still rewrites one-shot commands", () => {
  expect(shouldRewriteWithRtk("ls")).toBe(true);
  expect(shouldRewriteWithRtk("git status")).toBe(true);
  expect(shouldRewriteWithRtk("tail -n 20 app.log")).toBe(true);
  expect(shouldRewriteWithRtk("jest")).toBe(true);
});

test("shouldRewriteWithRtk skips long-running variants of extended heads", () => {
  expect(shouldRewriteWithRtk("kubectl logs -f app")).toBe(false);
  expect(shouldRewriteWithRtk("kubectl logs --follow")).toBe(false);
  // Without a follow flag kubectl logs exits — safe to wrap.
  expect(shouldRewriteWithRtk("kubectl logs app")).toBe(true);
  expect(shouldRewriteWithRtk("docker logs -f web")).toBe(false);
  expect(shouldRewriteWithRtk("docker compose up")).toBe(false);
  expect(shouldRewriteWithRtk("docker compose -f dev.yml up")).toBe(false);
  expect(shouldRewriteWithRtk("tsc --watch")).toBe(false);
  expect(shouldRewriteWithRtk("cargo watch -x test")).toBe(false);
  expect(shouldRewriteWithRtk("eslint --watch src")).toBe(false);
  // Non-following docker compose builds are still wrapped.
  expect(shouldRewriteWithRtk("docker compose build")).toBe(true);
  expect(shouldRewriteWithRtk("kubectl get pods")).toBe(true);
});

test("isRtkAvailable caches the PATH probe result", () => {
  const { __resetRtkAvailabilityForTests, isRtkAvailable } = require("../src/extensions/rtk/index.ts") as typeof import("../src/extensions/rtk/index.ts");
  try {
    // bun itself is definitely on PATH.
    expect(isRtkAvailable("bun")).toBe(true);
    expect(isRtkAvailable("bun")).toBe(true); // cached — no second probe
    expect(isRtkAvailable("definitely-not-a-real-binary-xyz")).toBe(false);
  } finally {
    __resetRtkAvailabilityForTests();
  }
});

test("rtk skips pipelines, redirections, and chains (2.5.10)", () => {
  expect(shouldRewriteWithRtk("git log | head -20")).toBe(false);
  expect(shouldRewriteWithRtk("git diff > /tmp/x")).toBe(false);
  expect(shouldRewriteWithRtk("git add . && git commit -m x")).toBe(false);
  expect(shouldRewriteWithRtk("ls -la || true")).toBe(false);
  expect(shouldRewriteWithRtk("grep foo src/x.ts")).toBe(true);
});

test("rtk skips long-running run commands (2.5.10)", () => {
  expect(shouldRewriteWithRtk("cargo run")).toBe(false);
  expect(shouldRewriteWithRtk("cargo build")).toBe(true);
  expect(shouldRewriteWithRtk("go run server.go")).toBe(false);
});

function makeRtkHarness(settings: Record<string, unknown>) {
  const agentDir = join(testHome, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify(settings),
    "utf8",
  );
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => void>> = {};
  const notifies: Array<{ message: string; level: string }> = [];
  const fakePi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: () => {},
  } as any;
  rtkExtension(fakePi);
  return {
    sessionStart: handlers.session_start![0]!,
    notifies,
    ctx: {
      hasUI: true,
      ui: { notify: (message: string, level: string) => notifies.push({ message, level }) },
    },
  };
}

test("rtk notice is suppressed when quietStartup is enabled", () => {
  const { sessionStart, notifies, ctx } = makeRtkHarness({
    quietStartup: true,
    integrations: { rtk: { enabled: true, command: "bun" } },
  });

  sessionStart({}, ctx);

  expect(notifies).toEqual([]);
});

test("rtk notice still shows when quietStartup is unset", () => {
  const { sessionStart, notifies, ctx } = makeRtkHarness({
    integrations: { rtk: { enabled: true, command: "bun" } },
  });

  sessionStart({}, ctx);

  expect(notifies).toHaveLength(1);
  expect(notifies[0]!.message).toContain("rtk 输出压缩已启用");
});
