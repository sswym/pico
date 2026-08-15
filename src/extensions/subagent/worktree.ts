/**
 * Git worktree isolation for parallel subagent tasks.
 *
 * Each parallel task gets its own worktree branched from HEAD,
 * preventing file conflicts between concurrent writers.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isFailedResult, type SingleResult } from "./results.ts";

export interface WorktreeHandle {
	worktreeDir: string;
	branchName: string;
	/** Set when the branch must survive cleanup (e.g. merge failed and needs manual resolution). */
	keepBranch?: boolean;
	cleanup: () => void | Promise<void>;
}

/** Timeout for individual git worktree commands (add/merge can be slow on big repos). */
const GIT_TIMEOUT_MS = 60_000;

/** Error carrying the captured stdout/stderr, mirroring execSync's throw payload. */
interface GitError extends Error {
	stdout: string;
	stderr: string;
}

/**
 * Run a git command asynchronously in its own process group, so a timeout can
 * kill the shell AND its grandchildren. Rejects on non-zero exit with
 * stdout/stderr attached — the async counterpart of the old execSync calls
 * (which froze the whole agent loop — UI, MCP in-flight requests — for the
 * duration of every git operation).
 */
function execGit(
	command: string,
	cwd: string,
	env?: Record<string, string>,
	timeoutMs = GIT_TIMEOUT_MS,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("sh", ["-c", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
			env: { ...process.env, ...env },
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (err: Error | null, out?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err) reject(err);
			else resolve(out ?? "");
		};
		const timer = setTimeout(() => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				try { child.kill("SIGKILL"); } catch { /* already gone */ }
			}
			const err = new Error(`git command timed out after ${timeoutMs}ms: ${command}`) as GitError;
			err.stdout = stdout;
			err.stderr = stderr;
			finish(err);
		}, timeoutMs);
		timer.unref?.();
		child.stdout.on("data", (d) => { stdout += String(d); });
		child.stderr.on("data", (d) => { stderr += String(d); });
		child.on("error", (e) => finish(e instanceof Error ? e : new Error(String(e))));
		child.on("close", (code) => {
			if (code === 0) {
				finish(null, stdout);
			} else {
				const err = new Error(`git exited with code ${code}: ${command}`) as GitError;
				err.stdout = stdout;
				err.stderr = stderr;
				finish(err);
			}
		});
	});
}

/**
 * The agent name is LLM-supplied and is embedded into shell commands below
 * (git worktree add/remove, git checkout -b) — restrict it to a safe
 * character set so shell metacharacters can never escape the quoted
 * argument. Unknown agent names are not validated before worktrees are
 * created, so this is the only line of defense.
 */
export function sanitizeAgentNameForWorktree(agentName: string): string {
	return agentName.replace(/[^\w.-]+/g, "_");
}

export interface WorktreeTask {
	agent: string;
}

export interface PreparedWorktrees {
	handles: Array<WorktreeHandle | null>;
	errorText?: string;
}

/**
 * Create a detached git worktree from HEAD.
 *
 * Returns a handle with the worktree directory, branch name,
 * and a cleanup function that removes the worktree and branch.
 */
export async function createWorktree(
	cwd: string,
	agentName: string,
	index: number,
): Promise<WorktreeHandle> {
	const safeAgentName = sanitizeAgentNameForWorktree(agentName);
	// One unique token for both the branch and the worktree directory. Using
	// the same token (incl. timestamp) keeps them consistent and prevents a
	// stale directory from a prior batch — whose cleanup may have silently
	// failed — from colliding with `git worktree add` on reuse.
	const unique = `${index}-${process.pid}-${Date.now()}`;
	const branchName = `subagent/${safeAgentName}-${unique}`;
	const worktreeDir = path.join(os.tmpdir(), `pico-worktree-${safeAgentName}-${unique}`);

	await execGit(`git worktree add --detach "${worktreeDir}" HEAD`, cwd);

	// Create a named branch in the worktree for easy identification
	try {
		await execGit(`git checkout -b "${branchName}"`, worktreeDir);
	} catch (err) {
		// Partial failure: `worktree add` registered the worktree, but the
		// branch check failed. The handle is never returned, so
		// prepareParallelWorktrees' cleanup pass cannot reach it — remove the
		// worktree here (rmSync fallback) before rethrowing, or the git
		// registration and /tmp dir leak.
		try {
			await execGit(`git worktree remove "${worktreeDir}" --force`, cwd);
		} catch {
			try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch {}
		}
		throw err;
	}

	const handle: WorktreeHandle = {
		worktreeDir,
		branchName,
		cleanup: async () => {
			try {
				await execGit(`git worktree remove "${worktreeDir}" --force`, cwd);
			} catch {
				try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch {}
			}
			// Merged branches are deleted; branches kept for manual resolution
			// (merge failure) survive so the task's output is not destroyed.
			if (!handle.keepBranch) {
				try { await execGit(`git branch -D "${branchName}"`, cwd); } catch {}
			}
		},
	};
	return handle;
}

export async function prepareParallelWorktrees(
	cwd: string | ((task: WorktreeTask, index: number) => string),
	tasks: WorktreeTask[],
	create: (cwd: string, agentName: string, index: number) => Promise<WorktreeHandle> | WorktreeHandle = createWorktree,
): Promise<PreparedWorktrees> {
	const handles: Array<WorktreeHandle | null> = new Array(tasks.length).fill(null);
	const errors: string[] = [];

	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i];
		if (!task) continue;
		const taskCwd = typeof cwd === "function" ? cwd(task, i) : cwd;
		try {
			handles[i] = await create(taskCwd, task.agent, i);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`task ${i} (${task.agent}): ${message}`);
		}
	}

	if (errors.length > 0) {
		await cleanupWorktrees(handles);
		return {
			handles,
			errorText: `Failed to set up git worktrees:\n${errors.join("\n")}`,
		};
	}

	return { handles };
}

export async function cleanupWorktrees(handles: Array<WorktreeHandle | null>): Promise<void> {
	for (const handle of handles) {
		if (!handle) continue;
		try {
			await handle.cleanup();
		} catch {
			/* ignore cleanup failures */
		}
	}
}

/**
 * Attempt to merge a worktree branch back into the current branch.
 *
 * Returns true on success, false on merge conflict (leaves the branch for manual resolution).
 */
function errorStreamText(err: unknown, key: "stdout" | "stderr"): string {
  if (err && typeof err === "object") {
    const value = (err as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
    if (Buffer.isBuffer(value)) return value.toString();
  }
  return "";
}

export async function mergeWorktree(
	cwd: string,
	branchName: string,
): Promise<{ success: boolean; conflict?: string }> {
	try {
		// LC_ALL=C keeps git's conflict/merge messages in English so the
		// CONFLICT probe below is locale-independent.
		await execGit(`git merge "${branchName}" --no-edit`, cwd, { LC_ALL: "C" });
		return { success: true };
	} catch (err: unknown) {
		// git prints conflict notifications ("CONFLICT (content): ...") to
		// stdout; only the final "Automatic merge failed" summary goes to
		// stderr. Checking stderr alone almost never fires, so the merge was
		// left half-applied in the main tree (MERGE_HEAD + conflict markers).
		const stderr = errorStreamText(err, "stderr");
		const stdout = errorStreamText(err, "stdout");
		const detail = (stdout || stderr).slice(0, 200);
		if (/CONFLICT/.test(stderr) || /CONFLICT/.test(stdout)) {
			// Abort the merge to leave the working tree clean
			try { await execGit("git merge --abort", cwd); } catch {}
			return { success: false, conflict: `Merge conflict on branch ${branchName}. Resolve manually. ${detail}`.trim() };
		}
		return { success: false, conflict: `Merge failed: ${detail}` };
	}
}

/**
 * Commit any uncommitted changes inside a worktree so the follow-up merge has
 * something to merge. Subagents edit files but do not necessarily commit;
 * without this, their work would be dropped when the worktree is removed.
 * Returns false when the commit fails (e.g. missing git identity).
 */
export async function commitWorktreeChanges(
	cwd: string,
	worktreeDir: string,
): Promise<boolean> {
	try {
		const status = await execGit(`git -C "${worktreeDir}" status --porcelain`, cwd);
		if (!status.trim()) return true;
		await execGit(`git -C "${worktreeDir}" add -A`, cwd);
		await execGit(`git -C "${worktreeDir}" commit -m "subagent worktree changes" --no-verify`, cwd, {
			GIT_AUTHOR_NAME: "pico-subagent",
			GIT_AUTHOR_EMAIL: "subagent@pico.local",
			GIT_COMMITTER_NAME: "pico-subagent",
			GIT_COMMITTER_EMAIL: "subagent@pico.local",
		});
		return true;
	} catch {
		return false;
	}
}

export async function mergeParallelWorktrees(
	cwd: string | ((index: number) => string),
	results: SingleResult[],
	handles: Array<WorktreeHandle | null>,
	getDiff: (cwd: string, branchName: string) => string | Promise<string> = getWorktreeDiff,
	merge: (cwd: string, branchName: string) => { success: boolean; conflict?: string } | Promise<{ success: boolean; conflict?: string }> = mergeWorktree,
	commitChanges: (cwd: string, worktreeDir: string) => boolean | Promise<boolean> = (cwd, dir) => commitWorktreeChanges(cwd, dir),
): Promise<string[]> {
	const mergeNotes: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const handle = handles[i];
		if (!handle) continue;
		const result = results[i];
		if (!result) continue;
		if (isFailedResult(result)) {
			mergeNotes.push(`task ${i} (${result.agent}): skipped merge (task failed)`);
			continue;
		}
		// The worktree's repo — the branch must be merged back into the repo
		// it was checked out from, which may differ from the main session cwd.
		const repoCwd = typeof cwd === "function" ? cwd(i) : cwd;
		// Commit uncommitted edits before diffing — a branch that only has
		// working-tree changes merges as "no changes" and then gets deleted
		// with the worktree, silently dropping the task's output.
		const committed = await commitChanges(repoCwd, handle.worktreeDir);
		if (!committed) {
			mergeNotes.push(
				`task ${i} (${result.agent}): could not commit worktree changes (git identity missing?); ` +
					`uncommitted edits may be lost after cleanup`,
			);
			continue;
		}
		const diff = await getDiff(repoCwd, handle.branchName);
		if (!diff.trim()) {
			mergeNotes.push(`task ${i} (${result.agent}): no changes to merge`);
			continue;
		}
		const mergeResult = await merge(repoCwd, handle.branchName);
		if (mergeResult.success) {
			mergeNotes.push(`task ${i} (${result.agent}): merged\n${diff.trimEnd()}`);
		} else {
			// Keep the branch: the merge failed (conflict / dirty main tree) and
			// cleanup must not `git branch -D` the task's only remaining copy.
			handle.keepBranch = true;
			mergeNotes.push(`task ${i} (${result.agent}): ${mergeResult.conflict}`);
		}
	}
	return mergeNotes;
}

/**
 * Get a diff summary of changes in a worktree branch vs HEAD.
 */
export async function getWorktreeDiff(cwd: string, branchName: string): Promise<string> {
	try {
		return await execGit(`git diff --stat HEAD.."${branchName}"`, cwd);
	} catch {
		return "(unable to get diff)";
	}
}
