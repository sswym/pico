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
	const branchName = `subagent/${agentName}-${index}-${Date.now()}`;
	const worktreeDir = path.join(os.tmpdir(), `srcode-worktree-${agentName}-${index}-${process.pid}`);

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

export function mergeParallelWorktrees(
	cwd: string,
	results: SingleResult[],
	handles: Array<WorktreeHandle | null>,
	getDiff: (cwd: string, branchName: string) => string = getWorktreeDiff,
	merge: (cwd: string, branchName: string) => { success: boolean; conflict?: string } = mergeWorktree,
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
