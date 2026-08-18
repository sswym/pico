import { log } from "./logging.ts";

export interface SubagentCompletedEvent {
  task: string;
  result: string;
  childSessionId?: string;
}

export interface PlanModeChangedEvent {
  active: boolean;
}

export interface LspStatusEvent {
  failures: Array<{ server: string; at: number; message: string }>;
}

export interface ExtensionEvents {
  subagent_completed: SubagentCompletedEvent;
  plan_mode_changed: PlanModeChangedEvent;
  lsp_status: LspStatusEvent;
}

type Handler<K extends keyof ExtensionEvents> = (event: ExtensionEvents[K]) => void;

const handlers: Partial<Record<keyof ExtensionEvents, Set<(event: unknown) => void>>> = {};
/** Handlers registered as session-scoped; dropped when the session teardown
 *  is a reload (the only path where the upstream resource loader re-runs the
 *  extension factories, which would otherwise stack duplicate subscriptions
 *  onto the module-level sets forever). */
const sessionScopedHandlers = new Set<(event: unknown) => void>();

export function subscribeExtensionEvent<K extends keyof ExtensionEvents>(
  eventName: K,
  handler: Handler<K>,
): () => void {
  const set = (handlers[eventName] ??= new Set());
  set.add(handler as (event: unknown) => void);
  return () => {
    set.delete(handler as (event: unknown) => void);
  };
}

/**
 * Like subscribeExtensionEvent, but the subscription is dropped on the next
 * `/reload` teardown via clearSessionExtensionSubscriptions().
 */
export function subscribeSessionExtensionEvent<K extends keyof ExtensionEvents>(
  eventName: K,
  handler: Handler<K>,
): () => void {
  const unsubscribe = subscribeExtensionEvent(eventName, handler);
  sessionScopedHandlers.add(handler as (event: unknown) => void);
  return () => {
    unsubscribe();
    sessionScopedHandlers.delete(handler as (event: unknown) => void);
  };
}

/**
 * Drop every session-scoped subscription. Extension factories re-run on
 * `/reload` (resource-loader.reload() → clearExtensionCache() → loadExtensions
 * → factory(api)); without this, each reload doubles the subscriber set and
 * stale closures (dead session ctx, duplicate memory writes) pile up.
 */
export function clearSessionExtensionSubscriptions(): void {
  for (const handler of sessionScopedHandlers) {
    for (const set of Object.values(handlers)) {
      set?.delete(handler);
    }
  }
  sessionScopedHandlers.clear();
}

export function publishExtensionEvent<K extends keyof ExtensionEvents>(
  eventName: K,
  event: ExtensionEvents[K],
): void {
  const set = handlers[eventName];
  if (!set) return;
  for (const handler of Array.from(set)) {
    try {
      handler(event);
    } catch (err) {
      // One misbehaving subscriber must not break the rest of the chain
      // (e.g. subagent completion events feeding memory delegation).
      log.warn("events", `handler for '${eventName}' threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function __resetExtensionEventsForTests(): void {
  for (const key of Object.keys(handlers) as Array<keyof ExtensionEvents>) {
    handlers[key]?.clear();
  }
}
