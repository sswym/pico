/**
 * Global cap on in-flight subagent children across the whole session (unlike
 * mapWithConcurrencyLimit, which scopes to one call). Release exactly once.
 */
let activeChildSlots = 0;
const slotWaiters: Array<() => void> = [];

export function acquireChildSlot(limit: number | undefined): Promise<() => void> {
	if (!limit || limit <= 0) return Promise.resolve(() => {});
	return new Promise((resolve) => {
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			activeChildSlots--;
			const next = slotWaiters.shift();
			if (next) {
				activeChildSlots++;
				next();
			}
		};
		if (activeChildSlots < limit) {
			activeChildSlots++;
			resolve(release);
		} else {
			slotWaiters.push(() => resolve(release));
		}
	});
}

/** Test-only: reset global slot accounting. */
export function __resetChildSlotsForTests(): void {
	activeChildSlots = 0;
	slotWaiters.length = 0;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	onFailure?: (err: unknown) => void,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	let failed = false;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			if (failed) return;
			const current = nextIndex++;
			if (current >= items.length) return;
			try {
				results[current] = await fn(items[current]!, current);
			} catch (err) {
				failed = true;
				onFailure?.(err);
				throw err;
			}
		}
	});
	// Wait for ALL workers (aborted siblings included) before propagating the
	// first failure — otherwise callers that clean up shared resources (e.g.
	// worktrees) would tear them down while sibling tasks still run.
	const settled = await Promise.allSettled(workers);
	for (const r of settled) {
		if (r.status === "rejected") throw r.reason;
	}
	return results;
}
