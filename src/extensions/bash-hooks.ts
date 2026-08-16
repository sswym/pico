/**
 * Cross-extension coordination for the single "bash" tool.
 *
 * Upstream treats duplicate tool names ACROSS extensions as a fatal startup
 * error (resource-loader.detectExtensionConflicts → main.js exits 1), so
 * only one extension may register "bash". The rtk extension owns that
 * registration (composing every hook registered here into its tool);
 * extensions that augment bash contribute spawn hooks here rather than
 * registering their own tool. Extensions never import each other; this
 * module is the coordination channel (same pattern as events.ts /
 * settings.ts).
 *
 * Ordering is safe: factories run at startup in registration order, and rtk
 * registers its bash tool in its factory after registering its own hook, so
 * the composed chain always includes every hook.
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
