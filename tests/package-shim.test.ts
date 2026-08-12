/**
 * Package shim tests: brand overlay directory for source-mode runs.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePackageShim } from "../src/runtime/package-shim.ts";

function makeFakeUpstream(dir: string): void {
  mkdirSync(join(dir, "dist"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "examples"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# upstream");
  writeFileSync(join(dir, "CHANGELOG.md"), "# changelog");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.84.0",
      type: "module",
      piConfig: { configDir: ".pi" },
    }),
  );
}

test("ensurePackageShim builds an overlay with pico brand and symlinked assets", () => {
  const root = mkdtempSync(join(tmpdir(), "pico-shim-"));
  try {
    const home = join(root, "home");
    const upstream = join(root, "upstream");
    mkdirSync(home);
    makeFakeUpstream(upstream);

    const shim = ensurePackageShim(home, upstream);
    expect(shim).toBe(join(home, "pkg"));

    const pkg = JSON.parse(readFileSync(join(shim!, "package.json"), "utf8"));
    expect(pkg.piConfig.name).toBe("pico");
    // 源码/编译模式项目配置目录必须一致（否则上游项目配置读 .pi vs .pico 分裂）。
    expect(pkg.piConfig.configDir).toBe(".pico");
    expect(pkg.name).toBe("@earendil-works/pi-coding-agent");
    expect(pkg.version).toBe("0.84.0");
    expect(pkg.type).toBe("module");

    expect(readlinkSync(join(shim!, "dist"))).toBe(join(upstream, "dist"));
    expect(readlinkSync(join(shim!, "docs"))).toBe(join(upstream, "docs"));
    expect(readlinkSync(join(shim!, "README.md"))).toBe(join(upstream, "README.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensurePackageShim is idempotent and tracks upstream version changes", () => {
  const root = mkdtempSync(join(tmpdir(), "pico-shim-"));
  try {
    const home = join(root, "home");
    const upstream = join(root, "upstream");
    mkdirSync(home);
    makeFakeUpstream(upstream);

    const first = ensurePackageShim(home, upstream);
    expect(first).not.toBeNull();
    const firstPkg = JSON.parse(readFileSync(join(first!, "package.json"), "utf8"));
    expect(firstPkg.version).toBe("0.84.0");

    writeFileSync(
      join(upstream, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.0" }),
    );
    const second = ensurePackageShim(home, upstream);
    expect(second).toBe(first);
    const secondPkg = JSON.parse(readFileSync(join(second!, "package.json"), "utf8"));
    expect(secondPkg.version).toBe("0.85.0");
    expect(secondPkg.piConfig.name).toBe("pico");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensurePackageShim returns null when the upstream package is missing or malformed", () => {
  const root = mkdtempSync(join(tmpdir(), "pico-shim-"));
  try {
    const home = join(root, "home");
    mkdirSync(home);

    expect(ensurePackageShim(home, join(root, "no-such-package"))).toBeNull();

    const broken = join(root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "package.json"), "{not json");
    expect(ensurePackageShim(home, broken)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensurePackageShim repairs a file blocking the dist slot", () => {
  const root = mkdtempSync(join(tmpdir(), "pico-shim-"));
  try {
    const home = join(root, "home");
    const upstream = join(root, "upstream");
    mkdirSync(home);
    makeFakeUpstream(upstream);

    // A regular file squatting on the dist slot must be replaced by the link.
    mkdirSync(join(home, "pkg"));
    writeFileSync(join(home, "pkg", "dist"), "not a symlink");

    const shim = ensurePackageShim(home, upstream);
    expect(shim).toBe(join(home, "pkg"));
    expect(readlinkSync(join(shim!, "dist"))).toBe(join(upstream, "dist"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
