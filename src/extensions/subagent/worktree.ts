/**
 * Git worktree isolation for parallel subagent tasks.
 *
 * Each parallel task gets its own worktree branched from HEAD,
 * preventing file conflicts between concurrent writers.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isFailedResult, type SingleResult } from "./results.ts";

export interface WorktreeHandle {
	worktreeDir: string;
	branchName: string;
	cleanup: () => void;
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
export function createWorktree(
	cwd: string,
	agentName: string,
	index: number,
): WorktreeHandle {
	// One unique token for both the branch and the worktree directory. Using
	// the same token (incl. timestamp) keeps them consistent and prevents a
	// stale directory from a prior batch — whose cleanup may have silently
	// failed — from colliding with `git worktree add` on reuse.
	const unique = `${index}-${process.pid}-${Date.now()}`;
	const branchName = `subagent/${agentName}-${unique}`;
	const worktreeDir = path.join(os.tmpdir(), `srcode-worktree-${agentName}-${unique}`);

	execSync(
		`git worktree add --detach "${worktreeDir}" HEAD`,
		{ cwd, stdio: "pipe" },
	);

	// Create a named branch in the worktree for easy identification
	execSync(`git checkout -b "${branchName}"`, { cwd: worktreeDir, stdio: "pipe" });

	return {
		worktreeDir,
		branchName,
		cleanup: () => {
			try {
				execSync(`git worktree remove "${worktreeDir}" --force`, { cwd, stdio: "pipe" });
			} catch {
				try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch {}
			}
			try {
				execSync(`git branch -D "${branchName}"`, { cwd, stdio: "pipe" });
			} catch {}
		},
	};
}

export function prepareParallelWorktrees(
	cwd: string,
	tasks: WorktreeTask[],
	create: (cwd: string, agentName: string, index: number) => WorktreeHandle = createWorktree,
): PreparedWorktrees {
	const handles: Array<WorktreeHandle | null> = new Array(tasks.length).fill(null);
	const errors: string[] = [];

	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i];
		if (!task) continue;
		try {
			handles[i] = create(cwd, task.agent, i);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`task ${i} (${task.agent}): ${message}`);
		}
	}

	if (errors.length > 0) {
		cleanupWorktrees(handles);
		return {
			handles,
			errorText: `Failed to set up git worktrees:\n${errors.join("\n")}`,
		};
	}

	return { handles };
}

export function cleanupWorktrees(handles: Array<WorktreeHandle | null>): void {
	for (const handle of handles) {
		if (!handle) continue;
		try {
			handle.cleanup();
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
export function mergeWorktree(cwd: string, branchName: string): { success: boolean; conflict?: string } {
	try {
		execSync(`git merge "${branchName}" --no-edit`, { cwd, stdio: "pipe" });
		return { success: true };
	} catch (err: any) {
		const stderr = err.stderr ? err.stderr.toString() : "";
		if (/CONFLICT/.test(stderr)) {
			// Abort the merge to leave the working tree clean
			try { execSync("git merge --abort", { cwd, stdio: "pipe" }); } catch {}
			return { success: false, conflict: `Merge conflict on branch ${branchName}. Resolve manually.` };
		}
		return { success: false, conflict: `Merge failed: ${stderr.slice(0, 200)}` };
	}
}

/**
 * Commit any uncommitted changes inside a worktree so the follow-up merge has
 * something to merge. Subagents edit files but do not necessarily commit;
 * without this, their work would be dropped when the worktree is removed.
 * Returns false when the commit fails (e.g. missing git identity).
 */
export function commitWorktreeChanges(
	cwd: string,
	worktreeDir: string,
): boolean {
	try {
		const status = execSync(`git -C "${worktreeDir}" status --porcelain`, { cwd, encoding: "utf-8", stdio: "pipe" });
		if (!status.trim()) return true;
		execSync(`git -C "${worktreeDir}" add -A`, { cwd, stdio: "pipe" });
		execSync(`git -C "${worktreeDir}" commit -m "subagent worktree changes" --no-verify`, {
			cwd,
			stdio: "pipe",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "srcode-subagent",
				GIT_AUTHOR_EMAIL: "subagent@srcode.local",
				GIT_COMMITTER_NAME: "srcode-subagent",
				GIT_COMMITTER_EMAIL: "subagent@srcode.local",
			},
		});
		return true;
	} catch {
		return false;
	}
}

export function mergeParallelWorktrees(
	cwd: string,
	results: SingleResult[],
	handles: Array<WorktreeHandle | null>,
	getDiff: (cwd: string, branchName: string) => string = getWorktreeDiff,
	merge: (cwd: string, branchName: string) => { success: boolean; conflict?: string } = mergeWorktree,
	commitChanges: (cwd: string, worktreeDir: string) => boolean = (cwd, dir) => commitWorktreeChanges(cwd, dir),
): string[] {
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
		// Commit uncommitted edits before diffing — a branch that only has
		// working-tree changes merges as "no changes" and then gets deleted
		// with the worktree, silently dropping the task's output.
		const committed = commitChanges(cwd, handle.worktreeDir);
		if (!committed) {
			mergeNotes.push(
				`task ${i} (${result.agent}): could not commit worktree changes (git identity missing?); ` +
					`uncommitted edits may be lost after cleanup`,
			);
			continue;
		}
		const diff = getDiff(cwd, handle.branchName);
		if (!diff.trim()) {
			mergeNotes.push(`task ${i} (${result.agent}): no changes to merge`);
			continue;
		}
		const mergeResult = merge(cwd, handle.branchName);
		if (mergeResult.success) {
			mergeNotes.push(`task ${i} (${result.agent}): merged\n${diff.trimEnd()}`);
		} else {
			mergeNotes.push(`task ${i} (${result.agent}): ${mergeResult.conflict}`);
		}
	}
	return mergeNotes;
}

/**
 * Get a diff summary of changes in a worktree branch vs HEAD.
 */
export function getWorktreeDiff(cwd: string, branchName: string): string {
	try {
		return execSync(`git diff --stat HEAD.."${branchName}"`, { cwd, encoding: "utf-8", stdio: "pipe" });
	} catch {
		return "(unable to get diff)";
	}
}
