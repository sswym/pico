export interface SubagentCompletedEvent {
  task: string;
  result: string;
  childSessionId?: string;
}

export interface ExtensionEvents {
  subagent_completed: SubagentCompletedEvent;
}

type Handler<K extends keyof ExtensionEvents> = (event: ExtensionEvents[K]) => void;

const handlers: Partial<Record<keyof ExtensionEvents, Set<(event: unknown) => void>>> = {};

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
      console.warn(`[pico events] handler for '${eventName}' threw:`, err);
    }
  }
}

export function __resetExtensionEventsForTests(): void {
  for (const key of Object.keys(handlers) as Array<keyof ExtensionEvents>) {
    handlers[key]?.clear();
  }
}
