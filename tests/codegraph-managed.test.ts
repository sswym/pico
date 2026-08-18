import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codegraphAssetName, codegraphManagedBinPath, installManagedCodegraph } from "../src/extensions/codegraph/managed.ts";

const ORIG_PICO_HOME = process.env.PICO_HOME;
let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "pico-codegraph-home-"));
  process.env.PICO_HOME = testHome;
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  if (ORIG_PICO_HOME === undefined) delete process.env.PICO_HOME;
  else process.env.PICO_HOME = ORIG_PICO_HOME;
});

test("codegraphAssetName maps official release assets by platform", () => {
  expect(codegraphAssetName("linux", "x64")).toBe("codegraph-linux-x64.tar.gz");
  expect(codegraphAssetName("linux", "arm64")).toBe("codegraph-linux-arm64.tar.gz");
  expect(codegraphAssetName("darwin", "x64")).toBe("codegraph-darwin-x64.tar.gz");
  expect(codegraphAssetName("darwin", "arm64")).toBe("codegraph-darwin-arm64.tar.gz");
  expect(codegraphAssetName("win32", "x64")).toBe("codegraph-win32-x64.zip");
  expect(codegraphAssetName("win32", "arm64")).toBe("codegraph-win32-arm64.zip");
});

test("installManagedCodegraph rejects win32 zip assets explicitly", async () => {
  const result = await installManagedCodegraph({
    platform: "linux",
    arch: "x64",
    assetName: "codegraph-win32-x64.zip",
    fetcher: async () => {
      throw new Error("must not fetch a rejected asset");
    },
  });
  expect(result.ok).toBe(false);
  expect(result.output).toContain("zip");
});

test("installManagedCodegraph unpacks a real zip release asset into $PICO_HOME/bin", async () => {
  // Windows 资产为 zip；托管安装用系统 unzip 解包（rtk 同链路扩展）。
  const pkg = mkdtempSync(join(tmpdir(), "pico-codegraph-zip-"));
  try {
    writeFileSync(join(pkg, "codegraph"), "#!/bin/sh\necho codegraph 1.5.0-win\n");
    const zip = Bun.spawnSync(
      ["zip", "-q", "-j", join(pkg, "codegraph-win32-x64.zip"), join(pkg, "codegraph")],
      {},
    );
    if (zip.exitCode === 0) {
      const archive = new Uint8Array(await Bun.file(join(pkg, "codegraph-win32-x64.zip")).arrayBuffer());
      const result = await installManagedCodegraph({
        assetName: "codegraph-win32-x64.zip",
        fetcher: async () => new Response(archive),
      });
      expect(result.ok).toBe(true);
      expect(result.output).toContain(codegraphManagedBinPath());
    }
    // 无 zip 命令的环境跳过，不伪造产物。
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

test("installManagedCodegraph reports an unsupported platform", async () => {
  const result = await installManagedCodegraph({ platform: "linux", arch: "ia32" });
  expect(result.ok).toBe(false);
  expect(result.output).toContain("没有 codegraph 预编译产物");
});

async function fakeCodegraphArchive(): Promise<Uint8Array> {
  const pkg = mkdtempSync(join(tmpdir(), "pico-codegraph-pkg-"));
  try {
    writeFileSync(join(pkg, "codegraph"), "#!/bin/sh\necho codegraph 1.5.0\n");
    const tar = Bun.spawnSync(["tar", "-czf", join(pkg, "codegraph-linux-x64.tar.gz"), "-C", pkg, "codegraph"], {});
    expect(tar.exitCode).toBe(0);
    return new Uint8Array(await Bun.file(join(pkg, "codegraph-linux-x64.tar.gz")).arrayBuffer());
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
}

test("installManagedCodegraph unpacks a real release asset into $PICO_HOME/bin", async () => {
  const archive = await fakeCodegraphArchive();
  const result = await installManagedCodegraph({
    assetName: "codegraph-linux-x64.tar.gz",
    fetcher: async () => new Response(archive),
  });
  expect(result.ok).toBe(true);
  expect(result.output).toContain(codegraphManagedBinPath());
  expect(result.output).toContain("codegraph 1.5.0");

  const probe = Bun.spawnSync([codegraphManagedBinPath(), "--version"], {});
  expect(probe.exitCode).toBe(0);
  expect(probe.stdout.toString()).toContain("codegraph 1.5.0");
});

test("installManagedCodegraph reports a fetch failure without leaving artifacts", async () => {
  const result = await installManagedCodegraph({
    assetName: "codegraph-linux-x64.tar.gz",
    fetcher: async () => new Response(null, { status: 500 }),
  });
  expect(result.ok).toBe(false);
  expect(result.output).toContain("HTTP 500");
  expect(existsSync(codegraphManagedBinPath())).toBe(false);
});