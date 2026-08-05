import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { getEmbeddedContent, getEmbeddedKeys } from "../extensions/embedded-assets.ts";

export interface EmbeddedRuntimeDirs {
  promptsDir: string;
  skillsDir: string;
}

/**
 * Bun compiled binaries expose bundled modules through an internal URL scheme.
 * Source-mode runs must not use generated embedded assets left by older builds.
 */
export function isBunBinaryRuntime(metaUrl: string): boolean {
  return metaUrl.includes("$bunfs") || metaUrl.includes("~BUN") || metaUrl.includes("%7EBUN");
}

/**
 * Extract embedded runtime assets to a temporary directory so pi-coding-agent
 * can keep resolving prompts, skills, themes, and export-html assets via files.
 */
export function prepareEmbeddedRuntime(isBunBinary: boolean): EmbeddedRuntimeDirs | null {
  if (!isBunBinary) return null;

  const allKeys = getEmbeddedKeys("");
  if (allKeys.length === 0) return null;

  const tmpDir = resolve(tmpdir(), `pico-${randomBytes(6).toString("hex")}`);
  try {
    mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    // Unwritable tmpdir must not crash the binary at startup — fall back to
    // source-style resolution (embeddedDirs null keeps the existing branch).
    console.warn(`[pico] failed to create embedded runtime dir under ${tmpdir()}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const cleanup = () => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  };
  process.on("exit", cleanup);
  // No SIGINT/SIGTERM handlers here: registering them would run our exit
  // before the host's graceful teardown (session flush, MCP shutdown), and
  // a bare signal already terminates the process — which fires "exit" and
  // runs cleanup anyway. Let the host own signal handling.

  try {
    for (const key of allKeys) {
      const content = getEmbeddedContent(key);
      if (content === null) continue;

      const filePath = resolve(tmpDir, key);
      mkdirSync(dirname(filePath), { recursive: true });

      if (key.startsWith("assets/") && !key.endsWith(".json")) {
        writeFileSync(filePath, Buffer.from(content, "base64"));
      } else {
        writeFileSync(filePath, content, "utf-8");
      }
    }
  } catch (err) {
    // Disk full / permission error mid-extract: clean up and degrade to
    // source-mode resolution instead of exiting on a raw ENOENT.
    console.warn(`[pico] embedded asset extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    cleanup();
    process.removeListener("exit", cleanup);
    return null;
  }

  process.env.PI_PACKAGE_DIR = tmpDir;

  return {
    promptsDir: resolve(tmpDir, "prompts"),
    skillsDir: resolve(tmpDir, "skills"),
  };
}
