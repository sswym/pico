/**
 * Managed codegraph installation（方案 B：pico 托管安装到 $PICO_HOME/bin）。
 *
 * 与 rtk 同链路（通用托管核心 managed-install.ts）：setup 向导把 GitHub
 * release 的预编译二进制解包到 $PICO_HOME/bin/codegraph，不污染系统
 * PATH。下载源与资产命名以 codegraph 官方 release 为准（2026-08-18
 * 实测 v1.5.0，MIT）。
 */
import { installManagedTool, managedBinPath, type InstallManagedToolOptions, type ManagedToolInstallResult } from "../managed-install.ts";

export type ManagedCodegraphInstallResult = ManagedToolInstallResult;

/** 托管二进制落点：$PICO_HOME/bin/codegraph。 */
export function codegraphManagedBinPath(): string {
  return managedBinPath("codegraph");
}

/** 平台 → release 资产名。与 codegraph 官方 release 资产命名一一对应。 */
export function codegraphAssetName(platform: string = process.platform, arch: string = process.arch): string | undefined {
  if (platform === "linux" && arch === "x64") return "codegraph-linux-x64.tar.gz";
  if (platform === "linux" && arch === "arm64") return "codegraph-linux-arm64.tar.gz";
  if (platform === "darwin" && arch === "x64") return "codegraph-darwin-x64.tar.gz";
  if (platform === "darwin" && arch === "arm64") return "codegraph-darwin-arm64.tar.gz";
  // win32 资产是 zip；托管安装暂只支持 tar.gz，不映射（走"请手动安装"）。
  return undefined;
}

export interface InstallManagedCodegraphOptions extends InstallManagedToolOptions {}

export function installManagedCodegraph(opts: InstallManagedCodegraphOptions = {}): Promise<ManagedCodegraphInstallResult> {
  return installManagedTool(
    {
      name: "codegraph",
      repo: "colbymchenry/codegraph",
      assetName: (platform, arch) => codegraphAssetName(platform, arch),
      verifyArgs: ["--version"],
    },
    opts,
  );
}