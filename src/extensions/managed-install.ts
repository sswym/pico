/**
 * 通用托管安装核心（方案 B：pico 托管下载 CLI 到 $PICO_HOME/bin）。
 *
 * rtk / codegraph 共用同一链路：GitHub release 预编译二进制（tar.gz / zip）
 * → 临时目录解包 → chmod +x → 原子 move 到 $PICO_HOME/bin/<name> → 自检
 * 命令验证。不污染系统 PATH；卸载/重装只删一个文件；失败不留半成品。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { picoHome } from "./paths.ts";

export interface ManagedToolSpec {
  /** 二进制名，也是 $PICO_HOME/bin/<name> 落点与解包内可执行文件名。 */
  name: string;
  /** GitHub 仓库路径（owner/repo），用于构造 release 下载 URL。 */
  repo: string;
  /** 平台 → release 资产名（与官方 release 命名一一对应）。 */
  assetName: (platform: string, arch: string) => string | undefined;
  /** 安装后自检命令参数（默认 --version）。 */
  verifyArgs?: string[];
}

export interface ManagedToolInstallResult {
  ok: boolean;
  output: string;
}

export interface InstallManagedToolOptions {
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

/** 托管二进制落点：$PICO_HOME/bin/<name>。 */
export function managedBinPath(name: string): string {
  return join(picoHome(), "bin", name);
}

/**
 * 下载 release 资产到临时目录、解包、chmod +x 后原子 move 到
 * $PICO_HOME/bin/<name>，最后跑自检命令验证可执行。
 */
export async function installManagedTool(
  spec: ManagedToolSpec,
  opts: InstallManagedToolOptions = {},
): Promise<ManagedToolInstallResult> {
  const name = spec.name;
  const asset = opts.assetName ?? spec.assetName(opts.platform ?? process.platform, opts.arch ?? process.arch);
  if (!asset) {
    return {
      ok: false,
      output: `当前平台 ${opts.platform ?? process.platform}/${opts.arch ?? process.arch} 没有 ${name} 预编译产物，请手动安装`,
    };
  }

  const url = `${opts.baseUrl ?? `https://github.com/${spec.repo}/releases/latest/download`}/${asset}`;
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
  const work = mkdtempSync(join(tmpdir(), `pico-${name}-`));
  try {
    const archive = join(work, asset);
    writeFileSync(archive, bytes);

    // 系统解包（Linux/macOS 自带 tar/unzip；不引入解压依赖）。
    const unpack =
      asset.endsWith(".zip")
        ? spawnSync("unzip", ["-q", "-o", archive, "-d", work], { stdio: ["ignore", "pipe", "pipe"] })
        : spawnSync("tar", ["-xzf", archive, "-C", work], { stdio: ["ignore", "pipe", "pipe"] });
    if (unpack.status !== 0) {
      const label = asset.endsWith(".zip") ? "unzip" : "tar";
      return { ok: false, output: `解压失败：${unpack.stderr?.toString() || unpack.stdout?.toString() || `${label} 退出码 ${unpack.status}`}` };
    }

    const extracted = locateBinary(work, name);
    if (!extracted) {
      return { ok: false, output: `解压产物中找不到 ${name} 可执行文件` };
    }
    chmodSync(extracted, 0o755);

    const binDir = join(picoHome(), "bin");
    mkdirSync(binDir, { recursive: true });
    const target = managedBinPath(name);
    renameSync(extracted, target);

    const verifyArgs = spec.verifyArgs ?? ["--version"];
    const probe = spawnSync(target, verifyArgs, { stdio: ["ignore", "pipe", "pipe"] });
    if (probe.status !== 0) {
      rmSync(target, { force: true });
      return {
        ok: false,
        output: `安装到 ${target} 后自检失败：${probe.stderr?.toString() || probe.stdout?.toString() || `退出码 ${probe.status}`}`,
      };
    }
    return { ok: true, output: `已安装 ${name}（${probe.stdout?.toString().trim() || "版本未知"}）到 ${target}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** 在解包目录中定位名为 name 的可执行文件（顶层或单层子目录）。 */
function locateBinary(dir: string, name: string): string | undefined {
  if (existsSync(join(dir, name))) return join(dir, name);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = join(dir, entry.name, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}