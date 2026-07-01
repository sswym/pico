/**
 * Runtime accessor for embedded assets.
 *
 * In source mode (`bun run bin/srcode.ts`) this module returns null for every
 * key — the code falls back to reading from disk as before.
 *
 * In compiled-binary mode, `build.ts` generates `src/generated/embedded-assets.ts`
 * before compilation, and this module re-exports its map. The generated file is
 * only present in the build tree; the import is guarded by a try/catch so
 * source-mode never breaks.
 */

let _embedded: Record<string, string> | null = null;

try {
  // @ts-ignore — generated file only exists during/after build
  const mod = await import("../generated/embedded-assets.ts");
  _embedded = mod.EMBEDDED ?? null;
} catch {
  _embedded = null;
}

/**
 * Return the content of an embedded resource, or null if not available
 * (source mode, or key not found).
 *
 * Binary assets (e.g. PNG) are returned as base64 strings.
 */
export function getEmbeddedContent(key: string): string | null {
  return _embedded?.[key] ?? null;
}

/**
 * Return all embedded keys matching a given prefix.
 * Useful for enumerating e.g. all "agents/" or "skills/" entries.
 */
export function getEmbeddedKeys(prefix: string): string[] {
  if (!_embedded) return [];
  return Object.keys(_embedded).filter((k) => k.startsWith(prefix));
}

/** True when running inside a compiled binary with embedded assets. */
export const isEmbedded = () => _embedded !== null;
