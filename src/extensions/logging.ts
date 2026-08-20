/**
 * pico leveled logger — 统一的 `[pico]` 前缀 + 级别日志通道（2026-08 使用者
 * 视角优化落地，§6.5）。
 *
 * 背景：此前各扩展的 console.warn/error 前缀不一（`[pico]`/`[pico events]`/
 * `[lsp]`/`[memory]`…），无级别、无落盘——线上问题排查靠人肉 grep stderr。
 * 本模块提供单一入口：
 *   - 级别过滤：`PICO_LOG_LEVEL`（debug|info|warn|error，默认 warn，与既往
 *     可见噪音一致）；
 *   - 可选落盘：`PICO_LOG_FILE` 设置后把 warn/error（含 info）追加写入
 *     `$PICO_HOME/logs/<name>.log`（0o600，超 5MB 截断保留末尾 1000 行，
 *     与 observability 的 events.jsonl 同风格）；未设置则保持纯 stderr 输出，
 *     行为零变化；
 *   - `PICO_LOG_DIR`（可选）覆盖日志目录（默认 `$PICO_HOME/logs`）。
 *
 * 容错：fs 失败一律静默——日志绝不能拖垮会话。仅记录非用户内容。
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { picoHome } from "./paths.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveLevel(): LogLevel {
  const raw = process.env.PICO_LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "warn";
}

function resolveLogFilePath(): string | undefined {
  const file = process.env.PICO_LOG_FILE;
  if (!file) return undefined;
  // 相对路径落 $PICO_HOME/logs；绝对路径原样使用。
  return file.startsWith("/") ? file : join(picoHome(), "logs", file);
}

function resolveLogDir(): string {
  return process.env.PICO_LOG_DIR ?? join(picoHome(), "logs");
}

let filePath: string | undefined;
let currentLevel: LogLevel = resolveLevel();
let maxBytes = 5 * 1024 * 1024;
let maxKeptLines = 1000;

function ensureFilePath(): string | undefined {
  const resolved = filePath ?? resolveLogFilePath();
  if (!resolved) return undefined;
  if (filePath !== resolved) {
    filePath = resolved;
    try {
      mkdirSync(dirname(resolved), { recursive: true });
    } catch {
      // 只读目录等——落盘失败只影响文件通道，stderr 照常。
    }
  }
  return resolved;
}

/** 追加+超限截断。模式仿 input-history / observability：0o600 + 锁保护的读改写 trim。 */
function appendLine(line: string): void {
  const path = ensureFilePath();
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      const mode = statSync(path).mode & 0o777;
      if ((mode & 0o077) !== 0) chmodSync(path, 0o600);
    } catch {
      // 文件尚不存在——appendFileSync 会以 0o600 创建。
    }
    appendFileSync(path, `${line}\n`, { encoding: "utf-8", mode: 0o600 });
    try {
      if (statSync(path).size > maxBytes) {
        const release = tryAcquireTrimLock(path);
        if (!release) return;
        try {
          const raw = readFileSync(path, "utf-8");
          const lines = raw.split("\n").filter((l) => l.trim().length > 0);
          if (lines.length > maxKeptLines) {
            const kept = lines.slice(-maxKeptLines);
            const tmp = `${path}.${process.pid}.tmp`;
            writeFileSync(tmp, `${kept.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
            renameSync(tmp, path);
          }
        } finally {
          release();
        }
      }
    } catch {
      // best-effort trim。
    }
  } catch {
    // 只读目录/磁盘满——日志失败绝不影响主流程。
  }
}

const TRIM_LOCK_STALE_MS = 30_000;

/** 跨实例串行化截断的读-改-写（mkdir 原子锁，模式借自 input-history）。 */
function tryAcquireTrimLock(path: string): (() => void) | null {
  const lockDir = `${path}.trim-lock`;
  try {
    mkdirSync(lockDir);
    return () => {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
    };
  } catch {
    // 锁被崩溃实例残留——超过 30s 视为过期，打破后重试。
    try {
      const st = statSync(lockDir);
      if (Date.now() - st.mtimeMs > TRIM_LOCK_STALE_MS) {
        rmSync(lockDir, { recursive: true, force: true });
        try {
          mkdirSync(lockDir);
          return () => {
            try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
          };
        } catch {
          return null;
        }
      }
    } catch {
      // 锁目录不存在了（并发释放）——返回 null 跳过本次截断。
    }
    return null;
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack ? a.stack : a.message;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function write(level: LogLevel, tag: string, ...args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const message = formatArgs(args);
  const line = tag ? `[pico ${tag}] ${message}` : `[pico] ${message}`;
  if (level === "error") {
    try { console.error(line); } catch { /* stderr 关闭等 */ }
  } else {
    try { console.warn(line); } catch { /* 同上 */ }
  }
  if (level !== "debug") appendLine(line);
}

/** 统一日志入口：`log.warn("events", \`msg: ${err}\`)` 或 `log.warn("events", "msg", err)`。 */
export const log = {
  warn(tag: string, ...args: unknown[]): void { write("warn", tag, ...args); },
  error(tag: string, ...args: unknown[]): void { write("error", tag, ...args); },
};

/** 测试钩子：重置模块级状态。 */
export function __resetLoggingForTests(): void {
  filePath = undefined;
  currentLevel = resolveLevel();
}

/** 测试钩子：覆盖日志文件路径（注入临时目录）。 */
export function __setLogFilePathForTests(path: string | undefined): void {
  filePath = path;
}

/** 测试钩子：覆盖级别阈值。 */
export function __setLogLevelForTests(level: LogLevel): void {
  currentLevel = level;
}

/** 测试钩子：覆盖文件大小/保留行数预算（验证截断逻辑用）。 */
export function __setLogBudgetForTests(bytes: number, keptLines: number): void {
  maxBytes = bytes;
  maxKeptLines = keptLines;
}

/** 供 /doctor 展示当前日志通道状态。 */
export function loggingStatus(): { level: LogLevel; file: string | undefined; dir: string } {
  return { level: currentLevel, file: resolveLogFilePath(), dir: resolveLogDir() };
}
