/**
 * pico CLI entry-point tests.
 *
 * Spawns the real bin/pico.ts as a subprocess and verifies the brand layer,
 * recursion guards, and print-guard exits — none of which the existing suite
 * exercises through an actual process (all prior tests call pure functions).
 *
 * Env isolation: PICO_HOME is redirected to a temp dir per test so the real
 * ~/.pico data root is never touched.
 */
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "..", "bin", "pico.ts");

function runPico(
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const home = mkdtempSync(join(tmpdir(), "pico-cli-home-"));
    const child = execFile(
      "bun",
      ["run", BIN, ...args],
      {
        env: {
          ...process.env,
          PICO_HOME: home,
          PI_SKIP_VERSION_CHECK: "1",
          ...opts.env,
        },
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        rmSync(home, { recursive: true, force: true });
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? (error as { code: number | null }).code ?? null
              : 0;
        resolvePromise({ stdout, stderr, code });
      },
    );
    // execFile's error.code is the exit code for non-zero exits; for signal
    // kills it carries the signal string. Normalize here.
    child.on("exit", (code) => {
      // no-op — the callback handles completion; exit event is informational
      void code;
    });
  });
}

describe("pico CLI --version", () => {
  test("--version prints 'pico <version>' and exits 0", async () => {
    const { stdout, stderr, code } = await runPico(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^pico \d+\.\d+\.\d+/);
    expect(stderr).toBe("");
  });

  test("-v is an alias for --version", async () => {
    const { stdout, code } = await runPico(["-v"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^pico \d+\.\d+\.\d+/);
  });

  test("--version --verbose includes the upstream pi version", async () => {
    const { stdout, code } = await runPico(["--version", "--verbose"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^pico \d+\.\d+\.\d+ \(upstream pi \d+\.\d+\.\d+\)/);
  });

  test("--version wins over the missing-prompt guard", async () => {
    // `pico --version -p` (no prompt) must NOT exit 2 — version short-circuits.
    const { stdout, code } = await runPico(["--version", "-p"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^pico \d+\.\d+\.\d+/);
  });
});

describe("pico CLI --help", () => {
  test("--help prints the branded header and upstream help, exits 0", async () => {
    const { stdout, code } = await runPico(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("pico 特有命令");
    expect(stdout).toContain("pico setup");
    expect(stdout).toContain("以下为上游 pi 的完整参数");
  });

  test("-h is an alias for --help", async () => {
    const { stdout, code } = await runPico(["-h"]);
    expect(code).toBe(0);
    expect(stdout).toContain("pico 特有命令");
  });
});

describe("pico CLI recursion guards", () => {
  test("PICO_HOOK_RECURSION_GUARD=1 refuses to start and exits 1", async () => {
    const { stderr, code } = await runPico(["--version"], {
      env: { PICO_HOOK_RECURSION_GUARD: "1" },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("refusing to start");
    expect(stderr).toContain("hook");
  });

  test("PICO_SUBAGENT_DEPTH=3 refuses to start and exits 1", async () => {
    const { stderr, code } = await runPico(["--version"], {
      env: { PICO_SUBAGENT_DEPTH: "3" },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("refusing to start");
    expect(stderr).toContain("subagent nesting depth");
  });

  test("PICO_SUBAGENT_DEPTH=2 (or unset) starts normally", async () => {
    const { stdout, code } = await runPico(["--version"], {
      env: { PICO_SUBAGENT_DEPTH: "2" },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^pico \d+\.\d+\.\d+/);
  });

  test("PICO_SUBAGENT_DEPTH=99 refuses to start (numeric parse, not string compare)", async () => {
    const { code } = await runPico(["--version"], {
      env: { PICO_SUBAGENT_DEPTH: "99" },
    });
    expect(code).toBe(1);
  });
});

describe("pico CLI -p/--print guard", () => {
  test("-p without a prompt exits 2 with a Chinese diagnostic", async () => {
    const { stderr, code } = await runPico(["-p"]);
    expect(code).toBe(2);
    expect(stderr).toContain("缺少提示词");
  });

  test("--print without a prompt exits 2", async () => {
    const { code } = await runPico(["--print"]);
    expect(code).toBe(2);
  });

  test("-p with a prompt passes the guard (no exit 2)", async () => {
    // The process then starts the upstream agent loop, which fails fast on a
    // missing API key — but it must NOT exit with the guard's code 2.
    const { code, stderr } = await runPico(["-p", "hello", "--offline"], {
      timeoutMs: 30_000,
    });
    expect(code).not.toBe(2);
    // Downstream of a passed guard: upstream reports the missing credentials
    // (or the agent loop starts). Either way the print-guard was satisfied.
    void stderr;
  }, 35_000);
});

describe("pico CLI setup subcommand", () => {
  test("setup --help shows wizard usage and exits 0", async () => {
    const { stdout, code } = await runPico(["setup", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Interactive setup wizard for pico");
    expect(stdout).toContain("Sections:");
  });

  test("setup --non-interactive writes settings.json into PICO_HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "pico-cli-setup-"));
    try {
      const { stdout, code } = await new Promise<{ stdout: string; code: number | null }>(
        (resolvePromise) => {
          execFile(
            "bun",
            ["run", BIN, "setup", "--non-interactive"],
            {
              env: {
                ...process.env,
                PICO_HOME: home,
                PI_SKIP_VERSION_CHECK: "1",
              },
              timeout: 60_000,
              maxBuffer: 4 * 1024 * 1024,
            },
            (error, stdout) => {
              const c =
                error && typeof (error as { code?: unknown }).code === "number"
                  ? (error as { code: number }).code
                  : 0;
              resolvePromise({ stdout, code: c });
            },
          );
        },
      );
      expect(code).toBe(0);
      expect(stdout).toContain("pico setup complete");
      // settings.json must exist under the redirected PICO_HOME
      const settingsPath = join(home, "agent", "settings.json");
      const { existsSync } = await import("node:fs");
      expect(existsSync(settingsPath)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
