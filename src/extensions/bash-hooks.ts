/**
 * Cross-extension coordination for the single "bash" tool.
 *
 * Upstream treats duplicate tool names ACROSS extensions as a fatal startup
 * error (resource-loader.detectExtensionConflicts → main.js exits 1), so
 * only one extension may register "bash". undo-redo owns that registration
 * (sandboxed buffered bash); other extensions that augment bash — rtk output
 * compression — contribute spawn hooks here that undo-redo composes into its
 * tool. Extensions never import each other; this module is the coordination
 * channel (same pattern as events.ts / settings.ts).
 *
 * Ordering is safe: factories run at startup in registration order, and
 * undo-redo creates its toolset lazily on session_start — after every
 * factory has run — so all hooks are registered before they are composed.
 */
import type { BashSpawnContext, BashSpawnHook } from "@earendil-works/pi-coding-agent";

const spawnHooks: BashSpawnHook[] = [];

/** Register a bash spawn hook. Called from extension factories (rtk). */
export function registerBashSpawnHook(hook: BashSpawnHook): void {
  spawnHooks.push(hook);
}

/** Compose every registered hook in registration order, or undefined when none. */
export function composeBashSpawnHooks(): BashSpawnHook | undefined {
  if (spawnHooks.length === 0) return undefined;
  return (context: BashSpawnContext) =>
    spawnHooks.reduce<BashSpawnContext>((acc, hook) => hook(acc), context);
}

/** Test hook: clear the registry between test cases. */
export function __resetBashSpawnHooksForTests(): void {
  spawnHooks.length = 0;
}
