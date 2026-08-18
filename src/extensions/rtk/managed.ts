/**
 * Managed rtk installation (方案 B：pico 托管安装到 $PICO_HOME）。
 *
 * 与 codegraph 的 `curl | sh` 不同，rtk 走托管下载：setup 向导或需要时把
 * GitHub release 的预编译二进制解包到 $PICO_HOME/bin/rtk，不污染系统 PATH，
 * 卸载/重装只删一个文件。下载源与资产命名以 rtk 官方 release 为准
 * （2026-08-18 实测 v0.45.0）。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { picoHome } from "../paths.ts";

/** 托管二进制落点：$PICO_HOME/bin/rtk。 */
export function rtkManagedBinPath(): string {
  return join(picoHome(), "bin", "rtk");
}

/** 平台 → release 资产名。与 rtk 官方 release 资产命名一一对应。 */
export function rtkAssetName(platform: string = process.platform, arch: string = process.arch): string | undefined {
  if (platform === "linux" && arch === "x64") return "rtk-x86_64-unknown-linux-musl.tar.gz";
  if (platform === "linux" && arch === "arm64") return "rtk-aarch64-unknown-linux-gnu.tar.gz";
  if (platform === "darwin" && arch === "x64") return "rtk-x86_64-apple-darwin.tar.gz";
  if (platform === "darwin" && arch === "arm64") return "rtk-aarch64-apple-darwin.tar.gz";
  if (platform === "win32" && arch === "x64") return "rtk-x86_64-pc-windows-msvc.zip";
  return undefined;
}

export interface ManagedRtkInstallResult {
  ok: boolean;
  output: string;
}

export interface InstallManagedRtkOptions {
  /** 覆盖 fetch；主要供测试注入。 */
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /** 覆盖平台（如测试模拟 darwin）。 */
  platform?: string;
  arch?: string;
  /** 发布资产（test 注入小文件用）。 */
  assetName?: string;
  /** 下载 URL 前缀（默认 GitHub latest）。 */
  baseUrl?: string;
}

/**
 * 下载 rtk release 资产到临时目录、解包、chmod +x 后原子 move 到
 * $PICO_HOME/bin/rtk，最后跑一遍 `--version` 验证可执行。
 */
export async function installManagedRtk(opts: InstallManagedRtkOptions = {}): Promise<ManagedRtkInstallResult> {
  const asset = opts.assetName ?? rtkAssetName(opts.platform, opts.arch);
  if (!asset) {
    return {
      ok: false,
      output: `当前平台 ${opts.platform ?? process.platform}/${opts.arch ?? process.arch} 没有 rtk 预编译产物，请手动安装`,
    };
  }

  const url = `${opts.baseUrl ?? "https://github.com/rtk-ai/rtk/releases/latest/download"}/${asset}`;
  const fetcher = opts.fetcher ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (error) {
    return { ok: false, output: `下载失败（${url}）：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) {
    return { ok: false, output: `下载失败 HTTP ${response.status}（${url}）` };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const work = mkdtempSync(join(tmpdir(), "pico-rtk-"));
  try {
    const archive = join(work, asset);
    writeFileSync(archive, bytes);

    // 系统 tar 解包（Linux/macOS 均自带；不引入解压依赖）。
    const untar = spawnSync("tar", ["-xzf", archive, "-C", work], { stdio: ["ignore", "pipe", "pipe"] });
    if (untar.status !== 0) {
      return { ok: false, output: `解压失败：${untar.stderr?.toString() || untar.stdout?.toString() || `tar 退出码 ${untar.status}`}` };
    }

    const extracted = locateRtkBinary(work);
    if (!extracted) {
      return { ok: false, output: "解压产物中找不到 rtk 可执行文件" };
    }
    chmodSync(extracted, 0o755);

    const binDir = join(picoHome(), "bin");
    mkdirSync(binDir, { recursive: true });
    const target = rtkManagedBinPath();
    renameSync(extracted, target);

    const probe = spawnSync(target, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    if (probe.status !== 0) {
      rmSync(target, { force: true });
      return {
        ok: false,
        output: `安装到 ${target} 后自检失败：${probe.stderr?.toString() || probe.stdout?.toString() || `退出码 ${probe.status}`}`,
      };
    }
    return { ok: true, output: `已安装 rtk（${probe.stdout?.toString().trim() || "版本未知"}）到 ${target}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** 在解包目录中定位名为 rtk 的可执行文件（顶层或单层子目录）。 */
function locateRtkBinary(dir: string): string | undefined {
  if (existsSync(join(dir, "rtk"))) return join(dir, "rtk");
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = join(dir, entry.name, "rtk");
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}