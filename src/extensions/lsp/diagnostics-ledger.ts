/**
 * Diagnostics deduplication ledger.
 * Tracks diagnostics already sent to the agent, returns only new ones.
 */
const DIAGNOSTIC_LOCATION_PREFIX_RE = /^.*?:\d+:\d+\s+/;

function diagnosticIdentity(message: string): string {
  return message.replace(DIAGNOSTIC_LOCATION_PREFIX_RE, "");
}

export class DiagnosticsLedger {
  readonly #seen = new Map<string, Set<string>>();

  reduce(absPath: string, messages: string[]): string[] {
    const previous = this.#seen.get(absPath);
    const currentIdentities = new Set<string>();
    const fresh: string[] = [];
    for (const message of messages) {
      const identity = diagnosticIdentity(message);
      currentIdentities.add(identity);
      if (!previous?.has(identity)) {
        fresh.push(message);
      }
    }
    if (currentIdentities.size === 0) {
      this.#seen.delete(absPath);
    } else {
      this.#seen.set(absPath, currentIdentities);
    }
    return fresh;
  }

  clear(): void {
    this.#seen.clear();
  }
}
