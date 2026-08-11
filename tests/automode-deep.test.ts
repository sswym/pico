/**
 * Deep coverage for the automode extension: shell-lexer hard-deny rule table,
 * path resolution/protection, denial state, classifier parsing/retry/staging
 * (with injected fake complete fns — no real LLM), and the tool_call /
 * /automode command pipelines (injected classifyAction/loadConfig).
 *
 * Complements tests/automode.test.ts (config precedence, fast paths, fail
 * closed) and tests/coverage-gap.test.ts (model spec, transcript, classifier
 * basics, logger) by covering their untested branches.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPiAutomode } from "../src/extensions/automode/extension.ts";
import { deterministicHardDeny, isRootHomeOrSystemPath } from "../src/extensions/automode/hard-deny.ts";
import {
  buildClassifierPrompt,
  classifierCacheSessionId,
  classifierReasoningForConfig,
  classifyInStages,
  classifyWithRetry,
  createClassifierCompletionPlan,
  defaultClassifyAction,
  parseClassifierDecision,
} from "../src/extensions/automode/classifier.ts";
import { buildEffectiveConfigFromSources } from "../src/extensions/automode/config.ts";
import { HOME } from "../src/extensions/automode/constants.ts";
import {
  expandHomePattern,
  extractInputPath,
  isInside,
  isProfileOrAuthorizedKeysPath,
  isProtectedPath,
  isSafetyControlPath,
  matchesProtectedPath,
  normalizePathForMatch,
  resolveInputPath,
  resolvePathForPolicy,
  shellPathTokenToPath,
} from "../src/extensions/automode/paths.ts";
import { parseToolPattern } from "../src/extensions/automode/permissions.ts";
import {
  actionSummary,
  formatDenials,
  pushDenial,
  restoreState,
  statusText,
} from "../src/extensions/automode/state.ts";
import type { AutoModeState, ClassifyResult, DenialRecord, EffectiveConfig } from "../src/extensions/automode/types.ts";

// ── helpers ───────────────────────────────────────────────────────────────

function makeFakePi() {
  const handlers: Record<string, Array<(event: any, ctx: any) => unknown>> = {};
  const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
  return {
    handlers,
    commands,
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand: (name: string, opts: { description: string; handler: (args: string, ctx: any) => Promise<void> }) =>
      commands.set(name, opts),
    appendEntry: () => {},
  };
}

function makeFakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp/automode-proj",
    hasUI: false,
    signal: undefined,
    sessionManager: {
      getSessionId: () => "s1",
      getEntries: () => [],
      getSessionFile: () => undefined,
      getSessionDir: () => "/tmp",
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      confirm: async () => true,
      theme: { fg: (_color: string, text: string) => text },
    },
    modelRegistry: {
      find: (_provider: string, _id: string) => undefined as unknown,
      getApiKeyAndHeaders: async (_model: unknown) => ({ ok: false }),
    },
    ...overrides,
  };
}

function baseConfig(): EffectiveConfig {
  return { ...buildEffectiveConfigFromSources({}), enabled: true };
}

async function runToolCall(
  ext: ReturnType<typeof createPiAutomode>,
  pi: ReturnType<typeof makeFakePi>,
  event: { toolName: string; input: Record<string, unknown> },
  ctx = makeFakeCtx(),
) {
  await pi.handlers.session_start?.[0]?.({}, ctx);
  return (await pi.handlers.tool_call?.[0]?.(event, ctx)) as
    | { block: boolean; reason?: string }
    | undefined;
}

function noticeCollector() {
  const notices: Array<[string, string]> = [];
  return {
    notices,
    ui: { notify: (message: string, type: string) => notices.push([message, type]) },
  };
}

// ── hard-deny: shell lexer + rule table ──────────────────────────────────

describe("automode shell lexer splits segments", () => {
  const deny = (command: string) => deterministicHardDeny("bash", { command }, "/tmp/proj");

  test("splits on ; newline && || and pipe so a risky suffix is seen", () => {
    expect(deny("echo a; rm -rf /")).toBe("irreversible deletion of home/root/system paths is hard-denied");
    expect(deny("echo a\nrm -rf /")).toBe("irreversible deletion of home/root/system paths is hard-denied");
    expect(deny("echo a && rm -rf /")).toBe("irreversible deletion of home/root/system paths is hard-denied");
    expect(deny("false || rm -rf /")).toBe("irreversible deletion of home/root/system paths is hard-denied");
    expect(deny("echo a | rm -rf /")).toBe("irreversible deletion of home/root/system paths is hard-denied");
  });

  test("keeps quoted and escaped separators inside a segment", () => {
    expect(deny('rm -rf "a;b"')).toBeUndefined();
    expect(deny("rm -rf a\\;b")).toBeUndefined();
  });

  test("extracts detached and attached redirect targets and guards them", () => {
    expect(deny("echo x > ~/.bashrc")).toBe("shell profile modification is hard-denied");
    expect(deny("echo x >> /etc/environment")).toBe("shell profile modification is hard-denied");
    expect(deny("echo x >/tmp/auto-mode.json")).toBe(
      "auto-mode or permission safety-control modification is hard-denied",
    );
    expect(deny("ls > /proj/.pico/automode.json")).toBe(
      "auto-mode or permission safety-control modification is hard-denied",
    );
    // fd-number redirects and 2>&1 are lexed as redirect ops but harmless
    expect(deny("echo x 2> /tmp/out")).toBeUndefined();
    expect(deny("echo hi 2>&1")).toBeUndefined();
  });

  test("commandName/commandArgs skip KEY=value prefixes", () => {
    expect(deny("FOO=bar curl -k https://x")).toBe("certificate verification weakening is hard-denied");
    // env-only command has no command name → no rule fires
    expect(deny("FOO=bar")).toBeUndefined();
  });

  test("isRecursiveRmArg accepts -rf -fr -r and --recursive, not plain -f", () => {
    expect(deny("rm -rf /")).toBe("irreversible deletion of home/root/system paths is hard-denied");
    expect(deny("rm --recursive /usr")).toBe("irreversible deletion of home/root/system paths is hard-denied");
    expect(deny("rm -fr /var")).toBe("irreversible deletion of home/root/system paths is hard-denied");
    expect(deny("rm -r /bin")).toBe("irreversible deletion of home/root/system paths is hard-denied");
    expect(deny("rm -f /tmp/x")).toBeUndefined();
    expect(deny("rm /tmp/x")).toBeUndefined();
  });

  test("weakens TLS via env words is hard-denied", () => {
    expect(deny("NODE_TLS_REJECT_UNAUTHORIZED=0 node s.js")).toBe("TLS verification weakening is hard-denied");
    expect(deny("GIT_SSL_NO_VERIFY=true git clone https://x")).toBe("TLS verification weakening is hard-denied");
  });

  test("curl/wget insecure flags are hard-denied", () => {
    expect(deny("curl -k https://x")).toBe("certificate verification weakening is hard-denied");
    expect(deny("wget --no-check-certificate https://x")).toBe(
      "certificate verification weakening is hard-denied",
    );
    expect(deny("curl https://x")).toBeUndefined();
  });

  test("npm/yarn/pnpm config strict-ssl false or cafile null is hard-denied", () => {
    expect(deny("npm config set strict-ssl false")).toBe("package-manager TLS weakening is hard-denied");
    expect(deny("yarn config set cafile null")).toBe("package-manager TLS weakening is hard-denied");
    expect(deny("npm config set strict-ssl true")).toBeUndefined();
  });

  test("git sslverify false is hard-denied case-insensitively", () => {
    expect(deny("git config http.sslverify false")).toBe("git TLS verification weakening is hard-denied");
    expect(deny("git config sslVerify false")).toBe("git TLS verification weakening is hard-denied");
    expect(deny("git config http.sslverify true")).toBeUndefined();
  });

  test("crontab/launchctl/systemctl persistence mutations are hard-denied", () => {
    expect(deny("crontab /tmp/job")).toBe("persistence or system service mutation is hard-denied");
    expect(deny("crontab -l")).toBeUndefined();
    expect(deny("launchctl load /Library/LaunchAgents/x.plist")).toBe(
      "persistence or system service mutation is hard-denied",
    );
    expect(deny("launchctl bootstrap system /x")).toBe("persistence or system service mutation is hard-denied");
    expect(deny("launchctl enable system/x")).toBe("persistence or system service mutation is hard-denied");
    expect(deny("launchctl list")).toBeUndefined();
    expect(deny("systemctl enable nginx")).toBe("persistence or system service mutation is hard-denied");
    expect(deny("systemctl disable nginx")).toBe("persistence or system service mutation is hard-denied");
    expect(deny("systemctl status nginx")).toBeUndefined();
  });

  test("platform security weakening commands are hard-denied", () => {
    expect(deny("security add-trusted-cert -d /tmp/c.pem")).toBe("platform security weakening is hard-denied");
    expect(deny("security find-certificate -a")).toBeUndefined();
    expect(deny("spctl --master-disable")).toBe("platform security weakening is hard-denied");
    expect(deny("csrutil disable")).toBe("platform security weakening is hard-denied");
  });

  test("rm -rf and find -delete on root/home/system paths are hard-denied", () => {
    expect(deny("find / -delete")).toBe("system-wide delete is hard-denied");
    expect(deny("find /tmp -delete")).toBeUndefined();
    // $HOME alone expands to the home root and is still blocked
    expect(deny("rm -rf $HOME")).toBe("irreversible deletion of home/root/system paths is hard-denied");
  });

  test("chmod/chown on system or ssh paths are hard-denied", () => {
    expect(deny("chmod 755 /etc/passwd")).toBe("system or SSH permission mutation is hard-denied");
    expect(deny("chown root /usr/bin/x")).toBe("system or SSH permission mutation is hard-denied");
    expect(deny(`chmod 600 $HOME/.ssh/id_rsa`)).toBe("system or SSH permission mutation is hard-denied");
    expect(deny("chmod +x /tmp/x.sh")).toBeUndefined();
  });

  test("tee/mv/cp/python/node/sed writes to automode or permission files", () => {
    expect(deny("tee /proj/.pi/automode.json")).toBe(
      "auto-mode or permission safety-control modification is hard-denied",
    );
    expect(deny("sed -i s/a/b/ /proj/.pi/extensions/auto.json")).toBe(
      "auto-mode or permission safety-control modification is hard-denied",
    );
    expect(deny("node /tmp/auto-mode.json")).toBe(
      "auto-mode or permission safety-control modification is hard-denied",
    );
    expect(deny("echo x > /tmp/pi-automode.txt")).toBeUndefined();
  });
});

describe("automode deterministicHardDeny write/edit branch", () => {
  test("write/edit to profile, authorized_keys and safety-control paths", () => {
    expect(deterministicHardDeny("write", { path: resolve(HOME, ".bashrc") }, "/tmp/proj")).toBe(
      "shell profile modification is hard-denied",
    );
    expect(deterministicHardDeny("write", { path: resolve(HOME, ".ssh/authorized_keys") }, "/tmp/proj")).toBe(
      "SSH authorized_keys modification is hard-denied",
    );
    expect(deterministicHardDeny("write", { path: "/tmp/automode-proj/.pico/automode.json" }, "/tmp/automode-proj")).toBe(
      "auto-mode or permission safety-control modification is hard-denied",
    );
    expect(deterministicHardDeny("edit", { path: "/tmp/pi-automode/config.json" }, "/tmp/proj")).toBe(
      "auto-mode or permission safety-control modification is hard-denied",
    );
    expect(deterministicHardDeny("write", { path: "/tmp/auto-mode.json" }, "/tmp/proj")).toBe(
      "auto-mode or permission safety-control modification is hard-denied",
    );
  });

  test("non-path tools, non-string paths/commands and safe writes pass", () => {
    expect(deterministicHardDeny("glob", { command: "rm -rf /" }, "/tmp/proj")).toBeUndefined();
    expect(deterministicHardDeny("bash", { command: 42 }, "/tmp/proj")).toBeUndefined();
    expect(deterministicHardDeny("write", { path: 42 }, "/tmp/proj")).toBeUndefined();
    expect(deterministicHardDeny("write", { path: "/tmp/automode-proj/src/util.ts" }, "/tmp/automode-proj")).toBeUndefined();
  });
});

describe("isRootHomeOrSystemPath", () => {
  const home = "/home/u";
  test("flags root, home root and system roots; exempts the home subtree", () => {
    expect(isRootHomeOrSystemPath("/", home)).toBe(true);
    expect(isRootHomeOrSystemPath(home, home)).toBe(true);
    expect(isRootHomeOrSystemPath("/bin", home)).toBe(true);
    expect(isRootHomeOrSystemPath("/dev", home)).toBe(true);
    expect(isRootHomeOrSystemPath("/private", home)).toBe(true);
    expect(isRootHomeOrSystemPath("/sys", home)).toBe(true);
    expect(isRootHomeOrSystemPath("/usr/local", home)).toBe(true);
    expect(isRootHomeOrSystemPath("/var", home)).toBe(true);
    expect(isRootHomeOrSystemPath("/home/u/proj", home)).toBe(false);
    // Silverblue-style HOME under /var stays exempt
    expect(isRootHomeOrSystemPath("/var/home/u/proj", "/var/home/u")).toBe(false);
  });
});

// ── paths ─────────────────────────────────────────────────────────────────

describe("automode path helpers", () => {
  test("resolveInputPath rejects non-strings and resolves @/absolute/relative", () => {
    expect(resolveInputPath("/c", 42)).toBeUndefined();
    expect(resolveInputPath("/c", "")).toBeUndefined();
    expect(resolveInputPath("/c", "   ")).toBeUndefined();
    expect(resolveInputPath("/c", null)).toBeUndefined();
    expect(resolveInputPath("/c", "@/abs/x")).toBe("/abs/x");
    expect(resolveInputPath("/c", "/abs/x")).toBe("/abs/x");
    expect(resolveInputPath("/c", "rel/x")).toBe("/c/rel/x");
  });

  test("extractInputPath only returns non-empty path for path-bearing tools", () => {
    expect(extractInputPath("bash", { path: "/x" })).toBeUndefined();
    expect(extractInputPath("write", { path: " " })).toBeUndefined();
    expect(extractInputPath("write", { path: "a" })).toBe("a");
  });

  test("expandHomePattern expands ~, $HOME, ${HOME} with and without suffixes", () => {
    expect(expandHomePattern("~")).toBe(HOME);
    expect(expandHomePattern("$HOME")).toBe(HOME);
    expect(expandHomePattern("${HOME}")).toBe(HOME);
    expect(expandHomePattern("~/x")).toBe(`${HOME}/x`);
    expect(expandHomePattern("$HOME/x")).toBe(`${HOME}/x`);
    expect(expandHomePattern("${HOME}/x")).toBe(`${HOME}/x`);
    expect(expandHomePattern("no-match")).toBe("no-match");
    expect(expandHomePattern("$HOME2/x")).toBe("$HOME2/x");
  });

  test("normalizePathForMatch and isInside", () => {
    expect(normalizePathForMatch("/tmp/proj/src/a.ts", "/tmp/proj")).toBe("src/a.ts");
    expect(normalizePathForMatch("/elsewhere/x", "/tmp/proj")).toBe("/elsewhere/x");
    expect(isInside("/a/b", "/a")).toBe(true);
    expect(isInside("/a", "/a")).toBe(true);
    expect(isInside("/ab", "/a")).toBe(false);
    expect(isInside("/a", "/a/b")).toBe(false);
  });

  test("resolvePathForPolicy resolves, follows symlinks, walks up missing ancestors", () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-deep-paths-"));
    try {
      mkdirSync(join(dir, "real"), { recursive: true });
      writeFileSync(join(dir, "real", "f.txt"), "x");
      writeFileSync(join(dir, "file.txt"), "y");
      symlinkSync(join(dir, "real"), join(dir, "link"));
      expect(resolvePathForPolicy(join(dir, "real", "f.txt"))).toBe(join(dir, "real", "f.txt"));
      // symlink recursion with a missing tail segment
      expect(resolvePathForPolicy(join(dir, "link", "f.txt"))).toBe(join(dir, "real", "f.txt"));
      // ENOENT ancestors are walked up to the first existing parent
      expect(resolvePathForPolicy(join(dir, "nonexistent", "deep", "x"))).toBe(
        join(dir, "nonexistent", "deep", "x"),
      );
      // ENOTDIR walks up too; a file in the middle short-circuits to undefined
      symlinkSync(join(dir, "loop"), join(dir, "link1"));
      symlinkSync(join(dir, "link1"), join(dir, "loop"));
      expect(resolvePathForPolicy(join(dir, "loop", "x"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("matchesProtectedPath and isProtectedPath inside/outside the project", () => {
    expect(matchesProtectedPath(".git/config", [".git"])).toBe(true);
    expect(matchesProtectedPath(".git", [".git"])).toBe(true);
    expect(matchesProtectedPath("src/a.ts", [".git"])).toBe(false);
    expect(matchesProtectedPath("a\\b", ["a/b"])).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "pico-deep-prot-"));
    try {
      expect(isProtectedPath(join(dir, ".git", "config"), dir, [".git"])).toBe(true);
      expect(isProtectedPath(join(dir, "src", "a.ts"), dir, [".git"])).toBe(false);
      expect(isProtectedPath("/other-proj/.git/config", dir, [".git"])).toBe(true);
      expect(isProtectedPath("/other-proj/src/x.ts", dir, [".git"])).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("isSafetyControlPath covers auto-mode.json, .pico/extensions, pi-automode, in-tree auto-mode files", () => {
    expect(isSafetyControlPath("/tmp/auto-mode.json", "/proj")).toBe(true);
    expect(isSafetyControlPath("/proj/.pico/extensions/auto-fix.ts", "/proj")).toBe(true);
    expect(isSafetyControlPath("/proj/.pico/extensions/helper.ts", "/proj")).toBe(false);
    expect(isSafetyControlPath("/proj/.pico/automode-custom.json", "/proj")).toBe(true);
    expect(isSafetyControlPath("/opt/pi-automode/x.json", "/proj")).toBe(true);
    expect(isSafetyControlPath("/proj/auto-mode-notes.md", "/proj")).toBe(true);
    expect(isSafetyControlPath("/other/auto-mode-notes.md", "/proj")).toBe(false);
  });

  test("shellPathTokenToPath expands ~ and $HOME, ignores - & and empty tokens", () => {
    expect(shellPathTokenToPath("-", "/c")).toBeUndefined();
    expect(shellPathTokenToPath("&x", "/c")).toBeUndefined();
    expect(shellPathTokenToPath("  ", "/c")).toBeUndefined();
    expect(shellPathTokenToPath("$HOME/x", "/c")).toBe(join(HOME, "x"));
    expect(shellPathTokenToPath("${HOME}/x", "/c")).toBe(join(HOME, "x"));
    expect(shellPathTokenToPath("~/x", "/c")).toBe(join(HOME, "x"));
    expect(shellPathTokenToPath("$HOME", "/c")).toBe(HOME);
    expect(shellPathTokenToPath("/abs", "/c")).toBe("/abs");
    expect(shellPathTokenToPath("rel", "/c")).toBe("/c/rel");
  });

  test("isProfileOrAuthorizedKeysPath", () => {
    expect(isProfileOrAuthorizedKeysPath(join(HOME, ".bashrc"))).toBe(
      "shell profile modification is hard-denied",
    );
    expect(isProfileOrAuthorizedKeysPath(join(HOME, ".ssh", "authorized_keys"))).toBe(
      "SSH authorized_keys modification is hard-denied",
    );
    expect(isProfileOrAuthorizedKeysPath("/etc/profile")).toBe("shell profile modification is hard-denied");
    expect(isProfileOrAuthorizedKeysPath("/tmp/normal")).toBeUndefined();
  });
});

// ── state ─────────────────────────────────────────────────────────────────

describe("automode state", () => {
  test("pushDenial keeps at most DENIAL_HISTORY_LIMIT entries", () => {
    const state: AutoModeState = {
      checkedActions: 0,
      blockedActions: 0,
      classifierAllowed: 0,
      classifierDenied: 0,
      recentDenials: [] as DenialRecord[],
    };
    for (let i = 0; i < 20; i += 1) {
      pushDenial(state, { timestamp: i, toolName: "t", reason: `r${i}`, action: `a${i}`, kind: "classifier" });
    }
    expect(state.recentDenials).toHaveLength(12);
    expect(state.recentDenials[0]?.reason).toBe("r8");
    expect(state.recentDenials[11]?.reason).toBe("r19");
  });

  test("statusText renders every field", () => {
    const cfg = baseConfig();
    cfg.classifierModel = "p1/m1";
    cfg.classifierReasoningLevel = "high";
    cfg.permissionDeny = [parseToolPattern("bash(rm *)")!];
    cfg.permissionAsk = [parseToolPattern("bash(git push *)")!];
    cfg.environment = ["e1"];
    cfg.allow = ["a1"];
    cfg.softDeny = ["s1"];
    cfg.hardDeny = ["h1"];
    const text = statusText(cfg, {
      enabledOverride: true,
      lastDecision: "block",
      lastReason: "why",
      checkedActions: 5,
      blockedActions: 2,
      classifierAllowed: 1,
      classifierDenied: 3,
      recentDenials: [],
    });
    expect(text).toContain("enabled: yes");
    expect(text).toContain("classifier: p1/m1");
    expect(text).toContain("classifier reasoning: high");
    expect(text).toContain("checked actions: 5");
    expect(text).toContain("blocked actions: 2");
    expect(text).toContain("classifier allowed: 1");
    expect(text).toContain("classifier denied: 3");
    expect(text).toContain("permissions.deny rules: 1");
    expect(text).toContain("permissions.ask rules: 1");
    expect(text).toContain("environment entries: 1");
    expect(text).toContain("allow entries: 1");
    expect(text).toContain("soft_deny entries: 1");
    expect(text).toContain("hard_deny entries: 1");
    expect(text).toContain("last decision: block");
    expect(text).toContain("last reason: why");
  });

  test("statusText defaults when no override or model is set", () => {
    const text = statusText(buildEffectiveConfigFromSources({}), {
      checkedActions: 0,
      blockedActions: 0,
      classifierAllowed: 0,
      classifierDenied: 0,
      recentDenials: [],
    });
    expect(text).toContain("enabled: no");
    expect(text).toContain("classifier: current session model");
    expect(text).toContain("classifier reasoning: server default");
    expect(text).toContain("last decision: none");
    expect(text).toContain("last reason: none");
  });

  test("formatDenials handles empty, reverse order and truncates long actions", () => {
    expect(formatDenials({ recentDenials: [] } as never)).toBe("No recent auto-mode denials.");
    const long = "x".repeat(500);
    const state = {
      recentDenials: [
        { timestamp: 1000, toolName: "write", reason: "older", action: "old", kind: "classifier" },
        { timestamp: 2000, toolName: "bash", reason: "blocked", action: long, kind: "deterministic-hard-deny" },
      ],
    } as never;
    const text = formatDenials(state);
    expect(text.indexOf("blocked")).toBeLessThan(text.indexOf("older"));
    expect(text).toContain("bash");
    expect(text).toContain("…");
  });

  test("actionSummary caps JSON at 6000 chars", () => {
    const summary = actionSummary("write", { path: "/a", content: "y".repeat(2000) });
    expect(summary.startsWith("write {")).toBe(true);
    expect(summary.length).toBeLessThan(6000);
    expect(summary).toContain("…");
    const big = actionSummary("write", {
      a: "x".repeat(2000),
      b: "x".repeat(2000),
      c: "x".repeat(2000),
      d: "x".repeat(2000),
      e: "x".repeat(2000),
    });
    expect(big.length).toBeLessThanOrEqual(6000);
  });

  test("restoreState defaults, skips non-matching entries and maps fields", () => {
    const empty = { sessionManager: { getEntries: () => [] } } as never;
    expect(restoreState(empty)).toEqual({
      checkedActions: 0,
      blockedActions: 0,
      classifierAllowed: 0,
      classifierDenied: 0,
      recentDenials: [],
    });
    const skips = {
      sessionManager: {
        getEntries: () => [
          { type: "message" },
          { type: "custom", customType: "other" },
          { type: "custom", customType: "pico-automode-state", data: undefined },
        ],
      },
    } as never;
    expect(restoreState(skips).checkedActions).toBe(0);
    const mapped = restoreState({
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "pico-automode-state",
            data: {
              enabledOverride: true,
              lastDecision: "block",
              lastReason: "why",
              checkedActions: 9,
              blockedActions: 1,
              classifierAllowed: 2,
              classifierDenied: 3,
              recentDenials: "nope",
            },
          },
        ],
      },
    } as never);
    expect(mapped.enabledOverride).toBe(true);
    expect(mapped.lastDecision).toBe("block");
    expect(mapped.lastReason).toBe("why");
    expect(mapped.checkedActions).toBe(9);
    expect(mapped.blockedActions).toBe(1);
    expect(mapped.classifierAllowed).toBe(2);
    expect(mapped.classifierDenied).toBe(3);
    expect(mapped.recentDenials).toEqual([]);
  });

  test("restoreState slices recentDenials to the limit and lets the newest entry win", () => {
    const many = Array.from({ length: 30 }, (_v, i) => ({ timestamp: i }));
    const sliced = restoreState({
      sessionManager: {
        getEntries: () => [{ type: "custom", customType: "pico-automode-state", data: { recentDenials: many } }],
      },
    } as never);
    expect(sliced.recentDenials).toHaveLength(12);
    const newest = restoreState({
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "pico-automode-state", data: { checkedActions: 1 } },
          { type: "custom", customType: "pico-automode-state", data: { checkedActions: 2 } },
        ],
      },
    } as never);
    expect(newest.checkedActions).toBe(2);
  });
});

// ── classifier (fake completeFn only) ─────────────────────────────────────

describe("automode classifier prompt & completion plan", () => {
  test("buildClassifierPrompt replaces all four placeholders", () => {
    const cfg = baseConfig();
    cfg.environment = ["env1", "env2"];
    cfg.allow = ["allow1"];
    cfg.softDeny = ["sd1"];
    cfg.hardDeny = ["hd1", "hd2"];
    const prompt = buildClassifierPrompt(cfg);
    expect(prompt).toContain("- env1");
    expect(prompt).toContain("- allow1");
    expect(prompt).toContain("- sd1");
    expect(prompt).toContain("- hd2");
    expect(prompt).not.toContain("<ENVIRONMENT>");
    expect(prompt).not.toContain("<ALLOW_RULES>");
    expect(prompt).not.toContain("<SOFT_DENY_RULES>");
    expect(prompt).not.toContain("<HARD_DENY_RULES>");
    expect(buildClassifierPrompt(buildEffectiveConfigFromSources({}))).not.toContain("<ALLOW_RULES>");
  });

  test("classifierReasoningForConfig maps undefined and explicit levels", () => {
    expect(classifierReasoningForConfig(undefined)).toEqual({ mode: "server-default" });
    expect(classifierReasoningForConfig("high")).toEqual({ mode: "explicit", requestedLevel: "high" });
  });

  test("createClassifierCompletionPlan: undefined → raw, off → simple, explicit → simple + level", () => {
    const raw = async () => ({}) as never;
    const simple = async () => ({}) as never;
    const undef = createClassifierCompletionPlan({} as never, undefined, raw, simple);
    expect(undef.completeFn).toBe(raw);
    expect(undef.reasoning).toEqual({ mode: "server-default" });
    const off = createClassifierCompletionPlan({} as never, "off" as never, raw, simple);
    expect(off.completeFn).toBe(simple);
    expect((off.reasoning as { effectiveLevel: string }).effectiveLevel).toBe("off");
    expect(off.reasoningLevel).toBeUndefined();
    const explicit = createClassifierCompletionPlan({ reasoning: {} } as never, "low", raw, simple);
    expect(explicit.completeFn).toBe(simple);
    expect(explicit.reasoningLevel).toBe("low");
    expect(explicit.reasoning).toEqual({
      mode: "explicit",
      requestedLevel: "low",
      effectiveLevel: "low",
    });
    // unsupported xhigh clamps down to the nearest supported level
    const clamped = createClassifierCompletionPlan({ reasoning: {} } as never, "xhigh", raw, simple);
    expect(clamped.reasoningLevel).toBe("high");
    expect((clamped.reasoning as { effectiveLevel: string }).effectiveLevel).toBe("high");
  });
});

describe("automode parseClassifierDecision edges", () => {
  const base = (text: string) => ({ content: [{ type: "text", text }] }) as never;

  test("rejects duplicate keys, arrays, extra keys, bad decision/tier and bad combos", () => {
    expect(
      parseClassifierDecision(base('{"decision":"allow","tier":"allow","reason":"x","decision":"block"}')),
    ).toBeUndefined();
    expect(parseClassifierDecision(base('[{"decision":"allow","tier":"allow","reason":"x"}]'))).toBeUndefined();
    expect(
      parseClassifierDecision(base('{"decision":"allow","tier":"allow","reason":"x","extra":"y"}')),
    ).toBeUndefined();
    expect(parseClassifierDecision(base('{"decision":"maybe","tier":"allow","reason":"x"}'))).toBeUndefined();
    expect(parseClassifierDecision(base('{"decision":"allow","tier":"weird","reason":"x"}'))).toBeUndefined();
    expect(parseClassifierDecision(base('{"decision":"allow","tier":"soft_deny","reason":"x"}'))).toBeUndefined();
    expect(parseClassifierDecision(base('{"decision":"allow","tier":"allow","reason":42}'))).toBeUndefined();
  });

  test("malformed JSON falls into the catch path and whitespace is trimmed", () => {
    expect(
      parseClassifierDecision(base('{"decision":"allow","tier":"allow","reason":"x"')),
    ).toBeUndefined();
    const ok = JSON.stringify({ decision: "allow", tier: "allow", reason: "x" });
    expect(parseClassifierDecision(base(`\n${ok}\n`))).toEqual({
      decision: "allow",
      tier: "allow",
      reason: "x",
    });
  });
});

describe("automode classifyWithRetry", () => {
  const R = { model: {} } as never;
  const P = { systemPrompt: "s", messages: [] } as never;
  const okResp = () =>
    ({
      stopReason: "stop",
      content: [{ type: "text", text: '{"decision":"allow","tier":"allow","reason":"fine"}' }],
    }) as never;

  test("provider throw fails closed and reports via onAttempt", async () => {
    const attempts: Array<{ stage: string; attempt: number; error?: string }> = [];
    const decision = await classifyWithRetry(
      (async () => {
        throw new Error("boom");
      }) as never,
      R,
      P,
      undefined,
      { onAttempt: (a: { stage: string; attempt: number; error?: string }) => attempts.push(a) } as never,
    );
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("boom");
    expect(attempts[0]?.stage).toBe("detailed");
    expect(attempts[0]?.attempt).toBe(1);
    expect(attempts[0]?.error).toBe("boom");
  });

  test("stopReason length retries and then succeeds", async () => {
    let calls = 0;
    const decision = await classifyWithRetry(
      (async () => {
        calls += 1;
        return calls === 1
          ? ({ stopReason: "length", content: [] }) as never
          : okResp();
      }) as never,
      R,
      P,
      undefined,
      {},
    );
    expect(calls).toBe(2);
    expect(decision).toMatchObject({ decision: "allow", tier: "allow", reason: "fine" });
  });

  test("non-stop stopReasons short-circuit to block without retrying", async () => {
    let calls = 0;
    const run = (resp: unknown) =>
      classifyWithRetry(
        (async () => {
          calls += 1;
          return resp;
        }) as never,
        R,
        P,
        undefined,
        { maxAttempts: 3 },
      );
    const aborted = await run({ stopReason: "aborted" });
    expect(aborted.decision).toBe("block");
    expect(aborted.reason).toContain("was aborted");
    expect(calls).toBe(1);
    const errored = await run({ stopReason: "error" });
    expect(errored.reason).toContain("returned an error response");
    expect(calls).toBe(2);
    const unclean = await run({ stopReason: "weird" });
    expect(unclean.reason).toContain("did not stop cleanly (weird)");
    expect(calls).toBe(3);
  });

  test("retries exhausted on persistent length fails closed with the truncated reason", async () => {
    const decision = await classifyWithRetry(
      (async () => ({ stopReason: "length", content: [] })) as never,
      R,
      P,
      undefined,
      { maxAttempts: 3 },
    );
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("truncated");
  });

  test("unparseable stop responses retry until valid JSON", async () => {
    let calls = 0;
    const decision = await classifyWithRetry(
      (async () => {
        calls += 1;
        return calls === 2
          ? okResp()
          : ({ stopReason: "stop", content: [{ type: "text", text: "garbage" }] }) as never;
      }) as never,
      R,
      P,
      undefined,
      {},
    );
    expect(calls).toBe(2);
    expect(decision.decision).toBe("allow");
  });
});

describe("automode classifyInStages", () => {
  const R = { model: {} } as never;
  const ctxM = { systemPrompt: "s", contextMessage: { role: "user", content: "c" } } as never;

  test("fast-stage throw fails closed and records the error attempt", async () => {
    const attempts: Array<{ stage: string; error?: string }> = [];
    const decision = await classifyInStages(
      (async () => {
        throw new Error("fastboom");
      }) as never,
      R,
      ctxM,
      undefined,
      {
        sessionId: "s1",
        onAttempt: (a: { stage: string; error?: string }) => attempts.push(a),
      } as never,
    );
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("fastboom");
    expect(attempts[0]?.stage).toBe("fast");
    expect(attempts[0]?.error).toBe("fastboom");
  });

  test("fast response that is neither 0 nor 1 fails closed", async () => {
    const decision = await classifyInStages(
      (async () => ({ stopReason: "stop", content: [{ type: "text", text: "2" }] })) as never,
      R,
      ctxM,
      undefined,
      { sessionId: "s1" } as never,
    );
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("not 0 or 1");
  });

  test("fast stage with non-stop stopReason fails closed without detailed retry", async () => {
    let calls = 0;
    const decision = await classifyInStages(
      (async () => {
        calls += 1;
        return { stopReason: "length", content: [] };
      }) as never,
      R,
      ctxM,
      undefined,
      { sessionId: "s1" } as never,
    );
    expect(calls).toBe(1);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("did not stop cleanly");
  });

  test("fast '1' escalates to a detailed stage that fails closed on throw", async () => {
    let calls = 0;
    const decision = await classifyInStages(
      (async () => {
        calls += 1;
        if (calls === 1) {
          return { stopReason: "stop", content: [{ type: "text", text: "1" }] };
        }
        throw new Error("detailed boom");
      }) as never,
      R,
      ctxM,
      undefined,
      { sessionId: "s1" } as never,
    );
    expect(calls).toBe(2);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("detailed boom");
  });
});

describe("automode classifier cache id", () => {
  test("falls back getSessionId → getSessionFile → cwd and digests", () => {
    const fromSession = classifierCacheSessionId({
      cwd: "/w",
      sessionManager: { getSessionId: () => "abc" },
    } as never);
    const fromFile = classifierCacheSessionId({
      cwd: "/w",
      sessionManager: { getSessionFile: () => "/f.json" },
    } as never);
    const fromCwd = classifierCacheSessionId({ cwd: "/w", sessionManager: {} } as never);
    expect(fromSession).toMatch(/^pi-automode-[0-9a-f]{32}$/);
    expect(fromSession).toBe("pi-automode-ba7816bf8f01cfea414140de5dae2223");
    expect(fromFile).not.toBe(fromSession);
    expect(fromCwd).not.toBe(fromSession);
    expect(fromCwd).toMatch(/^pi-automode-[0-9a-f]{32}$/);
  });
});

describe("defaultClassifyAction fails closed without model or API key", () => {
  const cfg = baseConfig();

  test("no model and no configured classifierModel", async () => {
    const result = await defaultClassifyAction(
      { model: undefined, modelRegistry: {}, sessionManager: {} } as never,
      cfg,
      "write /x",
      "",
    );
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("No classifier model/API key available");
    expect(result.reasoning).toEqual({ mode: "server-default" });
  });

  test("configured model that modelRegistry.find cannot resolve", async () => {
    const result = await defaultClassifyAction(
      {
        model: undefined,
        modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false, error: "x" }) },
        sessionManager: {},
      } as never,
      { ...cfg, classifierModel: "p1/m1" },
      "write /x",
      "",
    );
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("No classifier model/API key available");
  });

  test("model resolved but getApiKeyAndHeaders fails", async () => {
    const result = await defaultClassifyAction(
      {
        model: undefined,
        modelRegistry: {
          find: () => ({ provider: "p1", id: "m1" }),
          getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
        },
        sessionManager: {},
      } as never,
      { ...cfg, classifierModel: "p1/m1" },
      "write /x",
      "",
    );
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("No classifier model/API key available");
  });
});

// ── extension: tool_call pipeline ─────────────────────────────────────────

describe("automode tool_call pipeline", () => {
  const allowDecision = async () => ({ decision: "allow" as const, tier: "allow" as const, reason: "safe" });

  test("an aborted signal blocks immediately", async () => {
    const pi = makeFakePi();
    const ext = createPiAutomode({ loadConfig: () => baseConfig(), classifyAction: allowDecision });
    ext(pi as any);
    const result = await runToolCall(
      ext,
      pi,
      { toolName: "read", input: { path: "/tmp/x" } },
      makeFakeCtx({ signal: { aborted: true } }),
    );
    expect(result).toEqual({ block: true, reason: "Cancelled" });
  });

  test("permissions.ask with no UI blocks; confirm false blocks; confirm true continues", async () => {
    const withAsk = () => {
      const cfg = baseConfig();
      cfg.permissionAsk = [parseToolPattern("bash(curl *)")!];
      return cfg;
    };
    const noUi = makeFakePi();
    const noUiExt = createPiAutomode({ loadConfig: withAsk, classifyAction: allowDecision });
    noUiExt(noUi as any);
    const noUiResult = await runToolCall(
      noUiExt,
      noUi,
      { toolName: "bash", input: { command: "curl https://x" } },
      makeFakeCtx(),
    );
    expect(noUiResult?.reason).toContain("but no UI is available");

    const declined = makeFakePi();
    const declinedExt = createPiAutomode({ loadConfig: withAsk, classifyAction: allowDecision });
    declinedExt(declined as any);
    const declinedResult = await runToolCall(
      declinedExt,
      declined,
      { toolName: "bash", input: { command: "curl https://x" } },
      makeFakeCtx({
        hasUI: true,
        ui: {
          notify: () => {},
          setStatus: () => {},
          confirm: async () => false,
          theme: { fg: (_color: string, text: string) => text },
        },
      }),
    );
    expect(declinedResult?.reason).toContain("Declined permissions.ask");

    const accepted = makeFakePi();
    let classified = false;
    const acceptedExt = createPiAutomode({
      loadConfig: withAsk,
      classifyAction: async () => {
        classified = true;
        return { decision: "allow" as const, tier: "allow" as const, reason: "safe" };
      },
    });
    acceptedExt(accepted as any);
    const acceptedResult = await runToolCall(
      acceptedExt,
      accepted,
      { toolName: "bash", input: { command: "curl https://x" } },
      makeFakeCtx({
        hasUI: true,
        ui: {
          notify: () => {},
          setStatus: () => {},
          confirm: async () => true,
          theme: { fg: (_color: string, text: string) => text },
        },
      }),
    );
    expect(acceptedResult).toBeUndefined();
    expect(classified).toBe(true);
  });

  test("deterministic hard deny blocks through the pipeline", async () => {
    const pi = makeFakePi();
    const ext = createPiAutomode({ loadConfig: () => baseConfig(), classifyAction: allowDecision });
    ext(pi as any);
    const result = await runToolCall(ext, pi, { toolName: "bash", input: { command: "curl -k https://x" } });
    expect(result?.reason).toContain("certificate verification weakening");
  });

  test("deniedPaths match blocks before any fast path", async () => {
    const pi = makeFakePi();
    const cfg = baseConfig();
    cfg.deniedPaths = ["*secret*"];
    const ext = createPiAutomode({ loadConfig: () => cfg, classifyAction: allowDecision });
    ext(pi as any);
    const result = await runToolCall(ext, pi, {
      toolName: "write",
      input: { path: "/tmp/automode-proj/secret.txt", content: "x" },
    });
    expect(result?.reason).toContain("Path denied by policy");
  });

  test("allowInsideWorkingDirectory: protected in-tree write still reaches the classifier", async () => {
    const pi = makeFakePi();
    const cfg = baseConfig();
    cfg.allowInsideWorkingDirectory = true;
    let classified = false;
    const ext = createPiAutomode({
      loadConfig: () => cfg,
      classifyAction: async () => {
        classified = true;
        return { decision: "allow" as const, tier: "allow" as const, reason: "safe" };
      },
    });
    ext(pi as any);
    const result = await runToolCall(ext, pi, {
      toolName: "write",
      input: { path: "/tmp/automode-proj/.git/config", content: "x" },
    });
    expect(result).toBeUndefined();
    expect(classified).toBe(true);
  });

  test("allowInsideWorkingDirectory: plain in-tree write takes the deterministic allow", async () => {
    const pi = makeFakePi();
    const cfg = baseConfig();
    cfg.allowInsideWorkingDirectory = true;
    let classified = false;
    const ext = createPiAutomode({
      loadConfig: () => cfg,
      classifyAction: async () => {
        classified = true;
        return { decision: "allow" as const, tier: "allow" as const, reason: "safe" };
      },
    });
    ext(pi as any);
    const result = await runToolCall(ext, pi, {
      toolName: "write",
      input: { path: "/tmp/automode-proj/src/a.ts", content: "x" },
    });
    expect(result).toBeUndefined();
    expect(classified).toBe(false);
  });

  test("allowInsideWorkingDirectory: outside-CWD reads bypass the read-only fast path", async () => {
    const pi = makeFakePi();
    const cfg = baseConfig();
    cfg.allowInsideWorkingDirectory = true;
    let classified = false;
    const ext = createPiAutomode({
      loadConfig: () => cfg,
      classifyAction: async () => {
        classified = true;
        return { decision: "allow" as const, tier: "allow" as const, reason: "safe" };
      },
    });
    ext(pi as any);
    const result = await runToolCall(ext, pi, { toolName: "read", input: { path: "/tmp/outside/x.txt" } });
    expect(result).toBeUndefined();
    expect(classified).toBe(true);
  });
});

// ── extension: logger I/O ─────────────────────────────────────────────────

describe("automode logClassifierIo", () => {
  function ioResult(): ClassifyResult {
    return {
      decision: "allow",
      tier: "allow",
      reason: "ok",
      reasoning: { mode: "server-default" },
      io: {
        model: "p1/m1",
        reasoning: { mode: "server-default" },
        prompt: { system: "s", context: "c", fastInstruction: "f", detailedInstruction: "d" },
        attempts: [
          {
            stage: "fast",
            attempt: 1,
            response: {
              stopReason: "stop",
              text: "0",
              model: "p1/m1",
              timestamp: Date.now(),
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
            durationMs: 1,
          },
        ],
        durationMs: 1,
      },
    };
  }

  test("writes usage message entries and a classifier entry when fully enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-deep-log-"));
    try {
      const pi = makeFakePi();
      const cfg = baseConfig();
      cfg.log = { enabled: true, classifierIo: true };
      const ext = createPiAutomode({ loadConfig: () => cfg, classifyAction: async () => ioResult() });
      ext(pi as any);
      await runToolCall(
        ext,
        pi,
        { toolName: "write", input: { path: "/tmp/automode-proj/a.ts", content: "x" } },
        makeFakeCtx({ sessionManager: { getSessionId: () => "s1", getEntries: () => [], getSessionFile: () => undefined, getSessionDir: () => dir } }),
      );
      const content = readFileSync(join(dir, "s1-pi-automode.jsonl"), "utf8");
      expect(content).toContain('"type":"classifier"');
      expect(content).toContain('"type":"message"');
      expect(content).toContain("p1/m1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("classifierIo=false keeps message entries but drops classifier entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-deep-log2-"));
    try {
      const pi = makeFakePi();
      const cfg = baseConfig();
      cfg.log = { enabled: true, classifierIo: false };
      const ext = createPiAutomode({ loadConfig: () => cfg, classifyAction: async () => ioResult() });
      ext(pi as any);
      await runToolCall(
        ext,
        pi,
        { toolName: "write", input: { path: "/tmp/automode-proj/a.ts", content: "x" } },
        makeFakeCtx({ sessionManager: { getSessionId: () => "s1", getEntries: () => [], getSessionFile: () => undefined, getSessionDir: () => dir } }),
      );
      const content = readFileSync(join(dir, "s1-pi-automode.jsonl"), "utf8");
      expect(content).toContain('"type":"message"');
      expect(content).not.toContain('"type":"classifier"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("disabled logger writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-deep-log3-"));
    try {
      const pi = makeFakePi();
      const cfg = baseConfig();
      cfg.log = { enabled: false, classifierIo: false };
      const ext = createPiAutomode({ loadConfig: () => cfg, classifyAction: async () => ioResult() });
      ext(pi as any);
      await runToolCall(
        ext,
        pi,
        { toolName: "write", input: { path: "/tmp/automode-proj/a.ts", content: "x" } },
        makeFakeCtx({ sessionManager: { getSessionId: () => "s1", getEntries: () => [], getSessionFile: () => undefined, getSessionDir: () => dir } }),
      );
      expect(existsSync(join(dir, "s1-pi-automode.jsonl"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── extension: lifecycle & UI ─────────────────────────────────────────────

describe("automode lifecycle & UI", () => {
  test("before_agent_start injects guidance when enabled and passes through when disabled", () => {
    const pi = makeFakePi();
    const ext = createPiAutomode({ loadConfig: () => baseConfig() });
    ext(pi as any);
    const injected = pi.handlers.before_agent_start?.[0]?.(
      { systemPrompt: "orig", systemPromptOptions: {} },
      makeFakeCtx(),
    ) as { systemPrompt: string } | undefined;
    expect(injected?.systemPrompt).toContain("Auto Mode Active");
    expect(injected?.systemPrompt.startsWith("orig")).toBe(true);

    const piOff = makeFakePi();
    const cfg = baseConfig();
    cfg.enabled = false;
    createPiAutomode({ loadConfig: () => cfg })(piOff as any);
    expect(piOff.handlers.before_agent_start?.[0]?.(
      { systemPrompt: "orig", systemPromptOptions: {} },
      makeFakeCtx(),
    )).toBeUndefined();
  });

  test("session_start restores state so /automode status reflects it", async () => {
    const pi = makeFakePi();
    const ext = createPiAutomode({ loadConfig: () => baseConfig() });
    ext(pi as any);
    const { notices, ui } = noticeCollector();
    const ctx = makeFakeCtx({
      sessionManager: {
        getSessionId: () => "s1",
        getEntries: () => [
          {
            type: "custom",
            customType: "pico-automode-state",
            data: { checkedActions: 7, blockedActions: 3, enabledOverride: false },
          },
        ],
      },
      ui,
    });
    await pi.handlers.session_start?.[0]?.({}, ctx);
    const handler = pi.commands.get("automode")!.handler;
    await handler("status", ctx);
    expect(notices[0]?.[0]).toContain("enabled: no");
    expect(notices[0]?.[0]).toContain("checked actions: 7");
    expect(notices[0]?.[0]).toContain("blocked actions: 3");
  });

  test("updateUi paints the status line accent when enabled and dim when disabled", async () => {
    const statuses: Array<[string, unknown]> = [];
    const colors: string[] = [];
    const ui = {
      notify: () => {},
      setStatus: (key: string, value: unknown) => statuses.push([key, value]),
      theme: { fg: (color: string, text: string) => {
        colors.push(color);
        return text;
      } },
    };
    const ctx = makeFakeCtx({ hasUI: true, ui });

    const pi = makeFakePi();
    createPiAutomode({ loadConfig: () => baseConfig() })(pi as any);
    await pi.handlers.session_start?.[0]?.({}, ctx);
    expect(statuses).toEqual([["automode", "⏵⏵ auto mode on"]]);
    expect(colors).toEqual(["accent"]);

    const piOff = makeFakePi();
    const cfg = baseConfig();
    cfg.enabled = false;
    createPiAutomode({ loadConfig: () => cfg })(piOff as any);
    await piOff.handlers.session_start?.[0]?.({}, ctx);
    expect(colors).toEqual(["accent", "dim"]);
  });
});

// ── extension: /automode command ──────────────────────────────────────────

describe("automode command", () => {
  function commandHarness(opts: {
    loadConfig?: () => EffectiveConfig;
    saveClassifierModel?: (spec: string) => void;
  } = {}) {
    const pi = makeFakePi();
    const ext = createPiAutomode({
      loadConfig: opts.loadConfig ?? (() => baseConfig()),
      saveClassifierModel: opts.saveClassifierModel,
    });
    ext(pi as any);
    const { notices, ui } = noticeCollector();
    const ctx = makeFakeCtx({ ui });
    return { pi, notices, ctx, handler: pi.commands.get("automode")!.handler };
  }

  test("status/on/off/reload/reset/defaults/config/denials and unknown usage", async () => {
    const { handler, ctx, notices } = commandHarness();
    await handler("", ctx);
    expect(notices[0]?.[0]).toContain("enabled: yes");
    expect(notices[0]?.[1]).toBe("info");

    await handler("on", ctx);
    expect(notices[1]).toEqual(["automode 已为本会话启用", "info"]);
    await handler("off", ctx);
    expect(notices[2]).toEqual(["automode 已为本会话禁用", "warning"]);
    await handler("reload", ctx);
    expect(notices[3]).toEqual(["automode 配置已重载", "info"]);
    await handler("reset", ctx);
    expect(notices[4]).toEqual(["automode 计数已重置", "info"]);

    await handler("defaults", ctx);
    expect(notices[5]?.[0]).toContain("environment");
    expect(notices[5]?.[0]).toContain("hard_deny");
    expect(notices[5]?.[1]).toBe("info");

    await handler("config", ctx);
    expect(notices[6]?.[0]).toContain("config");
    expect(notices[6]?.[0]).toContain("logFile");
    expect(notices[6]?.[1]).toBe("info");

    await handler("denials", ctx);
    expect(notices[7]).toEqual(["No recent auto-mode denials.", "info"]);

    await handler("frobnicate", ctx);
    expect(notices[8]?.[0]).toContain("Usage: /automode");
    expect(notices[8]?.[1]).toBe("error");
  });

  test("model with an unresolvable spec notifies Model not found", async () => {
    const { handler, ctx, notices } = commandHarness();
    await handler("model p1/m1", ctx);
    expect(notices[0]).toEqual(["Model not found: p1/m1", "error"]);
  });

  test("model with failing getApiKeyAndHeaders surfaces the auth error", async () => {
    const { handler, ctx, notices } = commandHarness();
    ctx.modelRegistry = {
      find: () => ({ provider: "p1", id: "m1" }),
      getApiKeyAndHeaders: async () => ({ ok: false, error: "no key for p1" }),
    };
    await handler("model p1/m1", ctx);
    expect(notices).toEqual([["no key for p1", "error"]]);
  });

  test("model save failure notifies instead of throwing", async () => {
    const { handler, ctx, notices } = commandHarness({
      saveClassifierModel: () => {
        throw new Error("disk full");
      },
    });
    ctx.modelRegistry = {
      find: () => ({ provider: "p1", id: "m1" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
    };
    await handler("model p1/m1", ctx);
    expect(notices[0]).toEqual(["Failed to save classifier model: disk full", "error"]);
  });

  test("model with remainder saves and confirms the active model", async () => {
    const cfg = baseConfig();
    const { handler, ctx, notices } = commandHarness({
      loadConfig: () => cfg,
      saveClassifierModel: (spec: string) => {
        cfg.classifierModel = spec;
      },
    });
    ctx.modelRegistry = {
      find: () => ({ provider: "p1", id: "m1" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
    };
    await handler("model p1/m1", ctx);
    expect(notices[0]).toEqual(["automode 分类器已全局保存: p1/m1", "info"]);
  });
});
