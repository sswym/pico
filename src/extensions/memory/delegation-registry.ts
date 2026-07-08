/**
 * DelegationRegistry — cross-extension bridge for subagent delegation hooks.
 *
 * The memory extension registers a callback; the subagent extension calls it
 * when a subagent completes. This avoids circular imports between extensions.
 */

type DelegationCallback = (task: string, result: string, childSessionId?: string) => void;

let registeredCallback: DelegationCallback | null = null;

export function registerDelegationCallback(cb: DelegationCallback): void {
  registeredCallback = cb;
}

export function fireDelegationCallback(task: string, result: string, childSessionId?: string): void {
  registeredCallback?.(task, result, childSessionId);
}
