/**
 * Managed rtk installation（方案 B：pico 托管安装到 $PICO_HOME/bin）。
 *
 * rtk 走托管下载：setup 向导把 GitHub release 的预编译二进制解包到
 * $PICO_HOME/bin/rtk，不污染系统 PATH，卸载/重装只删一个文件。实现委托
 * 通用托管核心 managed-install.ts；下载源与资产命名以 rtk 官方 release
 * 为准（2026-08-18 实测 v0.45.0）。
 */
import { installManagedTool, managedBinPath, type InstallManagedToolOptions, type ManagedToolInstallResult } from "../managed-install.ts";

export type ManagedRtkInstallResult = ManagedToolInstallResult;

/** 托管二进制落点：$PICO_HOME/bin/rtk。 */
export function rtkManagedBinPath(): string {
  return managedBinPath("rtk");
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

export interface InstallManagedRtkOptions extends InstallManagedToolOptions {}

export function installManagedRtk(opts: InstallManagedRtkOptions = {}): Promise<ManagedRtkInstallResult> {
  return installManagedTool(
    {
      name: "rtk",
      repo: "rtk-ai/rtk",
      assetName: (platform, arch) => rtkAssetName(platform, arch),
      verifyArgs: ["--version"],
    },
    opts,
  );
}