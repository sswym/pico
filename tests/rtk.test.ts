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

test("shouldRewriteWithRtk covers the full rtk 0.45.0 supported surface", () => {
  // 文件与检索
  expect(shouldRewriteWithRtk("ls -la")).toBe(true);
  expect(shouldRewriteWithRtk("tree src")).toBe(true);
  expect(shouldRewriteWithRtk("cat package.json")).toBe(true);
  expect(shouldRewriteWithRtk("head -20 log")).toBe(true);
  expect(shouldRewriteWithRtk("tail -n 20 app.log")).toBe(true);
  expect(shouldRewriteWithRtk("find src -name '*.ts'")).toBe(true);
  expect(shouldRewriteWithRtk("grep foo src")).toBe(true);
  expect(shouldRewriteWithRtk("wc -l package.json")).toBe(true);
  expect(shouldRewriteWithRtk("diff a b")).toBe(true);
  // VCS 与平台
  expect(shouldRewriteWithRtk("glab mr list")).toBe(true);
  expect(shouldRewriteWithRtk("aws s3 ls")).toBe(true);
  expect(shouldRewriteWithRtk("psql -c select")).toBe(true);
  // 包管理器：pnpm 全系、npm 仅 run
  expect(shouldRewriteWithRtk("pnpm install")).toBe(true);
  expect(shouldRewriteWithRtk("pnpm run build")).toBe(true);
  expect(shouldRewriteWithRtk("npm run build")).toBe(true);
  expect(shouldRewriteWithRtk("npm list")).toBe(false);
  expect(shouldRewriteWithRtk("npm test")).toBe(false);
  expect(shouldRewriteWithRtk("npx tsc --noEmit")).toBe(true);
  expect(shouldRewriteWithRtk("pip install x")).toBe(true);
  expect(shouldRewriteWithRtk("uv run pytest")).toBe(true);
  // 容器与云
  expect(shouldRewriteWithRtk("oc get pods")).toBe(true);
  expect(shouldRewriteWithRtk("dotnet build")).toBe(true);
  expect(shouldRewriteWithRtk("docker images")).toBe(true);
  expect(shouldRewriteWithRtk("wget https://x")).toBe(true);
  expect(shouldRewriteWithRtk("curl -s https://x")).toBe(true);
  // 语言测试与静态分析
  expect(shouldRewriteWithRtk("vitest run")).toBe(true);
  expect(shouldRewriteWithRtk("mypy src")).toBe(true);
  expect(shouldRewriteWithRtk("phpunit tests")).toBe(true);
  expect(shouldRewriteWithRtk("phpstan analyse src")).toBe(true);
  expect(shouldRewriteWithRtk("pest")).toBe(true);
  expect(shouldRewriteWithRtk("paratest")).toBe(true);
  expect(shouldRewriteWithRtk("ecs")).toBe(true);
  expect(shouldRewriteWithRtk("pint")).toBe(true);
  expect(shouldRewriteWithRtk("rake test")).toBe(true);
  expect(shouldRewriteWithRtk("rubocop lib")).toBe(true);
  expect(shouldRewriteWithRtk("rspec spec")).toBe(true);
  expect(shouldRewriteWithRtk("go build ./...")).toBe(true);
  expect(shouldRewriteWithRtk("ruff check src")).toBe(true);
  expect(shouldRewriteWithRtk("lint src")).toBe(true);
  expect(shouldRewriteWithRtk("prettier --check src")).toBe(true);
  expect(shouldRewriteWithRtk("next build")).toBe(true);
  expect(shouldRewriteWithRtk("prisma generate")).toBe(true);
  expect(shouldRewriteWithRtk("gradlew assembleDebug")).toBe(true);
  expect(shouldRewriteWithRtk("mvn test")).toBe(true);
  expect(shouldRewriteWithRtk("make build")).toBe(true);
  expect(shouldRewriteWithRtk("swift test")).toBe(true);
  expect(shouldRewriteWithRtk("sbt test")).toBe(true);
  expect(shouldRewriteWithRtk("gt log")).toBe(true);
  expect(shouldRewriteWithRtk("golangci-lint run")).toBe(true);
  expect(shouldRewriteWithRtk("php artisan list")).toBe(true);
});

test("shouldRewriteWithRtk rejects heads rtk 0.45.0 does not support", () => {
  // bun 全系不在此列：实测 `rtk bun test` 仅是 passthrough（原样执行无压缩）。
  expect(shouldRewriteWithRtk("bun test")).toBe(false);
  expect(shouldRewriteWithRtk("bun run build")).toBe(false);
  expect(shouldRewriteWithRtk("bun install")).toBe(false);
  // gradle 无 rtk 子命令（官方 rewrite 路由到 gradlew，pico 前缀机制无此映射）。
  expect(shouldRewriteWithRtk("gradle build")).toBe(false);
});

test("shouldRewriteWithRtk matches supported heads even for unsupported subcommands", () => {
  // head 级匹配：php/dotnet 在名单内，其官方不支持的子命令变体仍被包一层
  // rtk（rtk 对未匹配 filter 的调用 passthrough，无破坏、无压缩收益）。
  expect(shouldRewriteWithRtk("php -v")).toBe(true);
  expect(shouldRewriteWithRtk("dotnet test")).toBe(true);
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
  // 0.45.0 新增 head 的长驻变体
  expect(shouldRewriteWithRtk("next dev")).toBe(false);
  expect(shouldRewriteWithRtk("next start")).toBe(false);
  expect(shouldRewriteWithRtk("next build")).toBe(true);
  expect(shouldRewriteWithRtk("dotnet watch run")).toBe(false);
  expect(shouldRewriteWithRtk("dotnet run")).toBe(false);
  expect(shouldRewriteWithRtk("dotnet build")).toBe(true);
  expect(shouldRewriteWithRtk("gradlew run")).toBe(false);
  expect(shouldRewriteWithRtk("gradlew bootRun")).toBe(false);
  expect(shouldRewriteWithRtk("gradlew assembleDebug")).toBe(true);
  expect(shouldRewriteWithRtk("sbt ~test")).toBe(false);
  expect(shouldRewriteWithRtk("sbt console")).toBe(false);
  expect(shouldRewriteWithRtk("sbt test")).toBe(true);
  expect(shouldRewriteWithRtk("php artisan serve")).toBe(false);
  expect(shouldRewriteWithRtk("php artisan list")).toBe(true);
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
