/**
 * Async subagent job registry.
 *
 * Async single-mode runs (`subagent(async: true)`) are spawned and return a
 * job id immediately; the child keeps running in the background of the same
 * process. Jobs are keyed by session id so `subagent_wait` can find them and
 * session_shutdown can cancel anything still running. Module-level state
 * mirrors the session-scoped pattern used by todo/plan.
 */
import type { SingleResult } from "./results.ts";

export type AsyncJobStatus = "running" | "settled";

export interface AsyncJob {
	id: string;
	agent: string;
	task: string;
	status: AsyncJobStatus;
	/** Settled with a normal (possibly failed/aborted) run result. */
	result?: SingleResult;
	/** Settled without a result (canceled at shutdown, launch error). */
	errorMessage?: string;
	createdAt: number;
	/** Supervisor channel dir + run id (set at async launch) — lets the
	 *  parent deliver steering instructions mid-run. */
	channelDir?: string;
	runId?: string;
}

export interface WaitOutcome {
	/** Jobs that were settled when the wait resolved. */
	settled: AsyncJob[];
	/** Job ids still running when the wait gave up (timeout/abort). */
	pending: string[];
	/** Job ids that were never registered in this session. */
	unknown: string[];
	timedOut: boolean;
	aborted: boolean;
}

interface InternalJob extends AsyncJob {
	/** Resolved when the job settles — wakes every registered waiter. */
	waiters: Array<() => void>;
	/** Aborts the child (AbortController.abort → runJsonProcess kills the
	 *  process group). */
	cancel: () => void;
}

const jobsBySession = new Map<string, Map<string, InternalJob>>();
let nextJobId = 1;

/** Test-only: drop every job and reset the id counter. */
export function __resetJobsForTests(): void {
	jobsBySession.clear();
	nextJobId = 1;
}

export function createJobId(): string {
	return `subagent-job-${nextJobId++}`;
}

export function registerJob(
	sessionKey: string,
	id: string,
	agent: string,
	task: string,
	cancel: () => void,
	meta?: { channelDir?: string; runId?: string },
): AsyncJob {
	const job: InternalJob = {
		id,
		agent,
		task,
		status: "running",
		createdAt: Date.now(),
		waiters: [],
		cancel,
		...meta,
	};
	const sessionJobs = jobsBySession.get(sessionKey) ?? new Map<string, InternalJob>();
	sessionJobs.set(id, job);
	jobsBySession.set(sessionKey, sessionJobs);
	return job;
}

export function getJob(sessionKey: string, jobId: string): AsyncJob | undefined {
	return jobsBySession.get(sessionKey)?.get(jobId);
}

export function listJobs(sessionKey: string): AsyncJob[] {
	return Array.from(jobsBySession.get(sessionKey)?.values() ?? []);
}

function getInternal(sessionKey: string, jobId: string): InternalJob | undefined {
	return jobsBySession.get(sessionKey)?.get(jobId);
}

/** Settle a job with a run result; wakes every waiter. Idempotent. */
export function settleJob(sessionKey: string, jobId: string, result: SingleResult): void {
	const job = getInternal(sessionKey, jobId);
	if (!job || job.status === "settled") return;
	job.status = "settled";
	job.result = result;
	for (const waiter of job.waiters.splice(0)) waiter();
}

/** Settle a job without a result (canceled, launch error). Idempotent. */
export function failJob(sessionKey: string, jobId: string, message: string): void {
	const job = getInternal(sessionKey, jobId);
	if (!job || job.status === "settled") return;
	job.status = "settled";
	job.errorMessage = message;
	for (const waiter of job.waiters.splice(0)) waiter();
}

/**
 * Wait until every listed job is settled, or until the timeout fires / the
 * signal aborts. Settled-early jobs are returned immediately. Unknown ids
 * are reported, never awaited.
 */
export async function waitForJobs(
	sessionKey: string,
	jobIds: string[],
	opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<WaitOutcome> {
	const known = jobIds.filter((id) => getInternal(sessionKey, id) !== undefined);
	const unknown = jobIds.filter((id) => getInternal(sessionKey, id) === undefined);

	const pendingIds = () => known.filter((id) => getInternal(sessionKey, id)?.status !== "settled");
	if (pendingIds().length === 0) {
		const settled = known
			.map((id) => getInternal(sessionKey, id))
			.filter((job): job is InternalJob => job !== undefined && job.status === "settled");
		return { settled, pending: [], unknown, timedOut: false, aborted: false };
	}

	return new Promise<WaitOutcome>((resolve) => {
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const detach = () => {
			if (timer) clearTimeout(timer);
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			for (const id of known) {
				const job = getInternal(sessionKey, id);
				if (job) job.waiters = job.waiters.filter((w) => w !== onSettled);
			}
		};
		const finish = (timedOut: boolean, aborted: boolean) => {
			if (done) return;
			done = true;
			detach();
			const settled = known
				.map((id) => getInternal(sessionKey, id))
				.filter((job): job is InternalJob => job !== undefined && job.status === "settled");
			resolve({ settled, pending: pendingIds(), unknown, timedOut, aborted });
		};
		const onSettled = () => {
			if (pendingIds().length === 0) finish(false, false);
		};
		const onAbort = () => finish(false, true);

		for (const id of known) {
			const job = getInternal(sessionKey, id);
			if (job && job.status !== "settled") job.waiters.push(onSettled);
		}
		if (opts.timeoutMs && opts.timeoutMs > 0) {
			timer = setTimeout(() => finish(true, false), opts.timeoutMs);
		}
		if (opts.signal?.aborted) onAbort();
		else if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Cancel every running job of a session (session_shutdown). Each child is
 * aborted (process-group SIGTERM → SIGKILL escalation inside runJsonProcess)
 * and the job settles without a result. Returns the canceled ids.
 */
export function cancelRunningJobs(sessionKey?: string): string[] {
	const canceled: string[] = [];
	for (const [key, jobs] of jobsBySession) {
		if (sessionKey !== undefined && key !== sessionKey) continue;
		for (const job of Array.from(jobs.values())) {
			if (job.status !== "running") continue;
			job.cancel();
			failJob(key, job.id, "Subagent job canceled at session shutdown");
			canceled.push(job.id);
		}
	}
	return canceled;
}
