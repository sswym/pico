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
 *   └── package.json            # generated package.json (sets APP_NAME=srcode)
 *
 * All runtime assets (agents, prompts, skills, themes, export-html templates,
 * images) are embedded directly into the binary via src/generated/embedded-assets.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_DIST = resolve(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
const PI_PKG = resolve(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
const GENERATED_DIR = resolve(ROOT, "src", "generated");

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Embedded asset generation
// ---------------------------------------------------------------------------

/** Escape a string for embedding inside a JS template literal. */
function escapeTemplateLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** Recursively collect all files under dir, returning absolute paths. */
function collectFiles(dir: string): string[] {
  const result: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) result.push(full);
      }
    } catch { /* ignore */ }
  }
  return result;
}

/**
 * Generate src/generated/embedded-assets.ts — a module that bundles every
 * runtime resource into a single Record<string, string> so the compiled
 * binary is fully self-contained.
 */
function generateEmbeddedAssets() {
  console.log(`  ── Generating embedded assets ──`);
  mkdirSync(GENERATED_DIR, { recursive: true });

  const entries: Array<{ key: string; value: string; binary?: boolean }> = [];

  // 1. srcode agents
  const agentsDir = resolve(ROOT, "src", "extensions", "subagent", "agents");
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir, { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith(".md")) {
        const content = readFileSync(join(agentsDir, f.name), "utf-8");
        entries.push({ key: `agents/${f.name}`, value: content });
      }
    }
  }

  // 2. srcode prompts (all .md files in src/prompts/)
  const promptsDir = resolve(ROOT, "src", "prompts");
  if (existsSync(promptsDir)) {
    for (const f of readdirSync(promptsDir, { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith(".md")) {
        const content = readFileSync(join(promptsDir, f.name), "utf-8");
        entries.push({ key: `prompts/${f.name}`, value: content });
      }
    }
  }

  // 3. srcode skills (recursive — preserves subdirectory structure)
  const skillsDir = resolve(ROOT, "src", "skills");
  if (existsSync(skillsDir)) {
    for (const abs of collectFiles(skillsDir)) {
      const rel = relative(skillsDir, abs);
      const content = readFileSync(abs, "utf-8");
      entries.push({ key: `skills/${rel}`, value: content });
    }
  }

  // 4. pi theme JSONs
  const themeSrc = join(PI_DIST, "modes", "interactive", "theme");
  for (const name of ["dark.json", "light.json"]) {
    const p = join(themeSrc, name);
    if (existsSync(p)) {
      entries.push({ key: `theme/${name}`, value: readFileSync(p, "utf-8") });
    }
  }

  // 5. pi export-html templates + vendor JS
  const exportHtmlSrc = join(PI_DIST, "core", "export-html");
  for (const name of ["template.html", "template.css", "template.js"]) {
    const p = join(exportHtmlSrc, name);
    if (existsSync(p)) {
      entries.push({ key: `export-html/${name}`, value: readFileSync(p, "utf-8") });
    }
  }
  const vendorSrc = join(exportHtmlSrc, "vendor");
  if (existsSync(vendorSrc)) {
    for (const f of readdirSync(vendorSrc, { withFileTypes: true })) {
      if (f.isFile()) {
        const p = join(vendorSrc, f.name);
        entries.push({ key: `export-html/vendor/${f.name}`, value: readFileSync(p, "utf-8") });
      }
    }
  }

  // 6. pi assets (binary — base64)
  const assetsSrc = join(PI_DIST, "modes", "interactive", "assets");
  if (existsSync(assetsSrc)) {
    for (const f of readdirSync(assetsSrc, { withFileTypes: true })) {
      if (f.isFile()) {
        const buf = readFileSync(join(assetsSrc, f.name));
        entries.push({ key: `assets/${f.name}`, value: buf.toString("base64"), binary: true });
      }
    }
  }

  // Generate the TypeScript module
  const lines: string[] = [
    "// AUTO-GENERATED by scripts/build.ts — do not edit manually.",
    "",
    "/** Map of resource path → content. Binary assets are base64-encoded. */",
    "export const EMBEDDED: Record<string, string> = {",
  ];

  for (const { key, value, binary } of entries) {
    if (binary) {
      // base64 — safe to embed directly (no escaping needed)
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: \`${escapeTemplateLiteral(value)}\`,`);
    }
  }

  lines.push("};", "");

  const outPath = join(GENERATED_DIR, "embedded-assets.ts");
  writeFileSync(outPath, lines.join("\n"));
  const totalSize = entries.reduce((sum, e) => sum + e.value.length, 0);
  console.log(`  ✓  embedded-assets.ts (${entries.length} entries, ${formatSize(totalSize)})`);
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

  // ---- Phase 0: generate embedded assets module ----
  generateEmbeddedAssets();

  // ---- Phase 1: compile binary ----
  console.log(`\n  ── Compiling binary ──`);

  mkdirSync(outDir, { recursive: true });

  // Clean old asset directories from previous builds (they are now embedded)
  for (const oldDir of ["agents", "assets", "export-html", "prompts", "skills", "theme"]) {
    const p = join(outDir, oldDir);
    if (existsSync(p)) {
      const { rmSync } = await import("node:fs");
      rmSync(p, { recursive: true, force: true });
    }
  }

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

  // ---- Phase 2: generate pi package.json ----
  console.log(`\n  ── Generating pi package.json ──`);

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

  // ---- Phase 3: summary ----
  const totalSize = binarySize + getFileSize(join(outDir, "package.json"));

  console.log(`\n  ── Build complete ──`);
  console.log(`  Output:  ${outDir}`);
  console.log(`  Binary:  ${binaryPath}`);
  console.log(`  Total:   ${formatSize(totalSize)} (single-file binary + package.json)`);
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
