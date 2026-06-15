#!/usr/bin/env bun
/**
 * build.ts — Compile srcode into a standalone binary with all assets.
 *
 * Usage:
 *   bun run scripts/build.ts                          # default: linux-x64
 *   bun run scripts/build.ts --target windows-x64     # cross-compile
 *   bun run scripts/build.ts --out ./dist             # custom output dir
 *
 * Output layout (e.g., build/):
 *   build/
 *   ├── srcode                  # compiled binary (srcode.exe on Windows)
 *   ├── package.json            # generated package.json (sets APP_NAME=srcode)
 *   ├── theme/                  # built-in theme files
 *   │   ├── dark.json
 *   │   └── light.json
 *   ├── export-html/            # HTML export templates
 *   │   ├── template.css
 *   │   ├── template.html
 *   │   ├── template.js
 *   │   └── vendor/
 *   ├── assets/                 # interactive assets
 *   │   └── clankolas.png
 *   ├── prompts/                # bundled subagent workflow prompts
 *   │   ├── implement.md
 *   │   ├── implement-and-review.md
 *   │   └── scout-and-plan.md
 *   └── skills/                 # bundled srcode skills
 *       ├── agents-init/SKILL.md
 *       ├── recap/SKILL.md
 *       └── verify/SKILL.md
 */

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_DIST = resolve(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
const PI_PKG = resolve(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(): { target: string; outDir: string } {
  const args = process.argv.slice(2);
  let target = "bun-linux-x64-modern";
  let outDir = resolve(ROOT, "build");

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--target" && i + 1 < args.length) {
      target = args[++i]!;
    } else if (arg === "--out" && i + 1 < args.length) {
      outDir = resolve(ROOT, args[++i]!);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: bun run scripts/build.ts [options]

Options:
  --target <triple>    Bun compilation target (default: bun-linux-x64-modern)
                       Common values:
                         bun-linux-x64-modern
                         bun-linux-arm64
                         bun-windows-x64-modern
                         bun-darwin-x64-modern
                         bun-darwin-arm64
  --out <dir>          Output directory (default: build/)
  --help, -h           Show this help
`);
      process.exit(0);
    }
  }

  return { target, outDir };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFileSize(p: string): number {
  try {
    return readFileSync(p).length;
  } catch {
    return 0;
  }
}

function readDirRecursive(dir: string): string[] {
  const result: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    try {
      const entries = Array.from(readdirSync(current, { withFileTypes: true }));
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else {
          result.push(full);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return result;
}

function getDirSize(dir: string): number {
  let total = 0;
  try {
    const entries = readDirRecursive(dir);
    for (const entry of entries) {
      total += getFileSize(entry);
    }
  } catch {
    /* ignore */
  }
  return total;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function copyDir(src: string, dest: string, description: string) {
  if (!existsSync(src)) {
    console.warn(`  ⚠  ${description}: source not found at ${src}`);
    return;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
  const size = getDirSize(dest);
  console.log(`  ✓  ${description} (${formatSize(size)})`);
}

// ---------------------------------------------------------------------------
// Main build
// ---------------------------------------------------------------------------

async function main() {
  const { target, outDir } = parseArgs();

  const isWin = target.includes("windows");
  const binaryName = isWin ? "srcode.exe" : "srcode";
  const binaryPath = join(outDir, binaryName);
  const entrypoint = resolve(ROOT, "bin", "srcode.ts");

  console.log(`\n  Building srcode binary\n`);
  console.log(`  Target:    ${target}`);
  console.log(`  Output:    ${outDir}`);
  console.log(`  Entry:     ${entrypoint}`);
  console.log("");

  // ---- Phase 1: compile binary ----
  console.log(`  ── Compiling binary ──`);

  mkdirSync(outDir, { recursive: true });

  const buildArgs = [
    "build",
    "--compile",
    "--target",
    target,
    "--outfile",
    binaryPath,
    entrypoint,
  ];

  console.log(`  $ bun ${buildArgs.join(" ")}`);

  const result = Bun.spawnSync(["bun", ...buildArgs], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });

  if (result.exitCode !== 0) {
    console.error(`\n  ✗ Compilation failed (exit code ${result.exitCode})`);
    process.exit(1);
  }

  const binarySize = getFileSize(binaryPath);
  console.log(`  ✓  Binary: ${binaryName} (${formatSize(binarySize)})`);

  // ---- Phase 2: copy pi runtime assets ----
  console.log(`\n  ── Copying runtime assets ──`);

  if (existsSync(PI_PKG)) {
    // Generate a custom package.json so pi's config.js reads APP_NAME="srcode"
    // instead of the upstream default "pi". This makes process.title, share URL
    // and internal references all use "srcode" in the compiled binary.
    const piPkg = JSON.parse(readFileSync(PI_PKG, "utf-8"));
    const customPkg = {
      name: "srcode",
      version: piPkg.version,
      piConfig: { name: "srcode", configDir: ".srcode" },
    };
    writeFileSync(join(outDir, "package.json"), JSON.stringify(customPkg, null, 2) + "\n");
    console.log(`  ✓  custom package.json (${formatSize(getFileSize(join(outDir, "package.json")))})`);
  }

  copyDir(
    join(PI_DIST, "modes", "interactive", "theme"),
    join(outDir, "theme"),
    "theme files",
  );

  copyDir(
    join(PI_DIST, "core", "export-html"),
    join(outDir, "export-html"),
    "export-html templates",
  );

  copyDir(
    join(PI_DIST, "modes", "interactive", "assets"),
    join(outDir, "assets"),
    "interactive assets",
  );

  // ---- Phase 3: copy srcode's bundled prompts ----
  console.log(`\n  ── Copying bundled prompts ──`);

  copyDir(
    resolve(ROOT, "src", "extensions", "subagent", "prompts"),
    join(outDir, "prompts"),
    "subagent workflow prompts",
  );

  // ---- Phase 4: copy srcode's bundled skills ----
  console.log(`\n  ── Copying bundled skills ──`);

  copyDir(
    resolve(ROOT, "src", "skills"),
    join(outDir, "skills"),
    "bundled skills",
  );

  // ---- Phase 5: summary ----
  const totalSize = getDirSize(outDir);

  console.log(`\n  ── Build complete ──`);
  console.log(`  Output:  ${outDir}`);
  console.log(`  Binary:  ${binaryPath}`);
  console.log(`  Total:   ${formatSize(totalSize)}`);
  console.log("");

  // Quick smoke test
  console.log(`  Verifying binary...`);
  const verify = Bun.spawnSync([binaryPath, "--help"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (verify.exitCode === 0) {
    const firstLine = verify.stdout.toString().split("\n")[0] || "";
    console.log(`  ✓  ${firstLine}`);
  } else {
    console.error(`  ✗  Binary exited with code ${verify.exitCode}`);
    process.exit(1);
  }

  console.log(`\n  Done. Run with:\n`);
  console.log(`    cd ${outDir} && ./${binaryName}\n`);
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
