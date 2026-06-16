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

export interface WorktreeHandle {
	worktreeDir: string;
	branchName: string;
	cleanup: () => void;
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
 * Get a diff summary of changes in a worktree branch vs HEAD.
 */
export function getWorktreeDiff(cwd: string, branchName: string): string {
	try {
		return execSync(`git diff --stat HEAD.."${branchName}"`, { cwd, encoding: "utf-8", stdio: "pipe" });
	} catch {
		return "(unable to get diff)";
	}
}
