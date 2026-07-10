export interface ForkableSessionManager {
	getLeafId?: () => unknown;
	createBranchedSession?: (leafId: string) => unknown;
}

/**
 * Attempt to fork the current session into a branched session file so a
 * subagent can inherit the parent's conversation history.
 */
export function tryForkSession(sessionManager: unknown): string | undefined {
	if (!sessionManager || typeof sessionManager !== "object") return undefined;
	const manager = sessionManager as ForkableSessionManager;
	try {
		const leafId = typeof manager.getLeafId === "function" ? manager.getLeafId() : undefined;
		if (typeof leafId !== "string" || leafId.length === 0) return undefined;
		if (typeof manager.createBranchedSession !== "function") return undefined;
		const forkedPath = manager.createBranchedSession(leafId);
		return typeof forkedPath === "string" && forkedPath.length > 0 ? forkedPath : undefined;
	} catch {
		return undefined;
	}
}

