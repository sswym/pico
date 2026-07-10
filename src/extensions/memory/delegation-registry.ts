import { publishExtensionEvent, subscribeExtensionEvent } from "../events.ts";

type DelegationCallback = (task: string, result: string, childSessionId?: string) => void;

export function registerDelegationCallback(cb: DelegationCallback): void {
  subscribeExtensionEvent("subagent_completed", (event) => {
    cb(event.task, event.result, event.childSessionId);
  });
}

export function fireDelegationCallback(task: string, result: string, childSessionId?: string): void {
  publishExtensionEvent("subagent_completed", { task, result, childSessionId });
}
