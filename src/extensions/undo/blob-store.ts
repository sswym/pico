/**
 * 内容寻址 blob 存储:文件内容以 sha256 命名落盘。
 *
 * 布局:${PICO_HOME}/agent/cache/undo/<sessionId>/blobs/<hash>
 *
 * 设计:与 Claude Code 的 file-history 磁盘备份同思路(内容全量落盘、内存只存
 * 元数据),但用内容寻址去重:同一内容多处/多版本共享一个 blob,避免重复拷贝。
 */
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { picoAgentHome } from "../paths.ts";

export function undoCacheRoot(sessionId: string): string {
  return join(picoAgentHome(), "cache", "undo", sessionId);
}

function blobsDir(sessionId: string): string {
  return join(undoCacheRoot(sessionId), "blobs");
}

/** 计算内容 sha256(hex) */
export function hashContent(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 读取 blob 内容;不存在返回 null(磁盘被清/会话切换的防御) */
export async function readBlob(sessionId: string, hash: string): Promise<Buffer | null> {
  try {
    return await readFile(join(blobsDir(sessionId), hash));
  } catch {
    return null;
  }
}

/** 写入 blob(内容寻址,已存在则跳过)。目录先建后写,避免竞态 ENOENT。 */
export async function writeBlob(sessionId: string, hash: string, content: Buffer | string): Promise<void> {
  const dir = blobsDir(sessionId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, hash);
  try {
    await writeFile(file, content, { flag: "wx" });
  } catch (err) {
    // EEXIST = 已存在,内容寻址保证内容相同,无需重写
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/** 读取文件内容并计算 hash;文件不存在返回 { hash: null } */
export async function snapshotFile(absPath: string): Promise<{ hash: string | null; size?: number }> {
  try {
    const buffer = await readFile(absPath);
    return { hash: hashContent(buffer), size: buffer.byteLength };
  } catch {
    return { hash: null };
  }
}

/** 清理整个会话的 undo 缓存(session_shutdown 或 /undo-clear) */
export async function clearSessionCache(sessionId: string): Promise<void> {
  await rm(undoCacheRoot(sessionId), { recursive: true, force: true });
}
