import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import * as Diff from "diff";
import type { Cache } from "./cache.ts";
import type { SnapshotTracker } from "./tracker.ts";
import type { ChangeType, DiffItem, FileState, Manifest } from "./types.ts";

interface UiDiffItem {
	label: string;
	leafId: string;
	path: string;
	change: "A" | "M" | "D";
	previousLeafId?: string;
}

function describeChange(
	baseEntry: FileState | undefined,
	leafEntry: FileState | undefined,
): "A" | "M" | "D" | null {
	const baseExists = baseEntry?.exists ?? false;
	const leafExists = leafEntry?.exists ?? false;

	if (!baseExists && leafExists) return "A";
	if (baseExists && !leafExists) return "D";
	if (baseExists && leafExists && baseEntry?.hash !== leafEntry?.hash)
		return "M";
	return null;
}

function toChangeType(change: "A" | "M" | "D"): ChangeType {
	switch (change) {
		case "A":
			return "added";
		case "M":
			return "modified";
		case "D":
			return "deleted";
	}
}

function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index]!;
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum += 1;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum += 1;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextPartIsChange =
			index < parts.length - 1 &&
			((parts[index + 1]!.added) || parts[index + 1]!.removed);

		if (lastWasChange || nextPartIsChange) {
			let linesToShow = raw;
			let skipStart = 0;
			let skipEnd = 0;

			if (!lastWasChange) {
				skipStart = Math.max(0, raw.length - contextLines);
				linesToShow = raw.slice(skipStart);
			}

			if (!nextPartIsChange && linesToShow.length > contextLines) {
				skipEnd = linesToShow.length - contextLines;
				linesToShow = linesToShow.slice(0, contextLines);
			}

			if (skipStart > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipStart;
				newLineNum += skipStart;
			}

			for (const line of linesToShow) {
				const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
				output.push(` ${lineNum} ${line}`);
				oldLineNum += 1;
				newLineNum += 1;
			}

			if (skipEnd > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipEnd;
				newLineNum += skipEnd;
			}
		} else {
			oldLineNum += raw.length;
			newLineNum += raw.length;
		}

		lastWasChange = false;
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export async function formatDiffText(
	cache: Cache,
	baseEntry: FileState | undefined,
	leafEntry: FileState | undefined,
): Promise<string> {
	const baseExists = baseEntry?.exists ?? false;
	const leafExists = leafEntry?.exists ?? false;

	if (!baseExists && !leafExists) {
		return "No changes recorded.";
	}

	if (leafEntry?.binary || baseEntry?.binary) {
		if (!baseExists && leafExists) return "Binary file added.";
		if (baseExists && !leafExists) return "Binary file deleted.";
		return "Binary file modified.";
	}

	const baseText =
		baseExists && baseEntry?.hash
			? (await cache.readBlob(baseEntry.hash)).toString("utf-8")
			: "";
	const leafText =
		leafExists && leafEntry?.hash
			? (await cache.readBlob(leafEntry.hash)).toString("utf-8")
			: "";

	const { diff } = generateDiffString(baseText, leafText);
	return diff || "No changes recorded.";
}

function collectUiDiffItems(
	baseManifest: Manifest,
	leafId: string,
	leafManifest: Manifest,
): UiDiffItem[] {
	const items: UiDiffItem[] = [];
	for (const [filePath, leafEntry] of leafManifest) {
		const baseEntry = baseManifest.get(filePath);
		const change = describeChange(baseEntry, leafEntry);
		if (!change) continue;
		items.push({
			leafId,
			path: filePath,
			change,
			label: `[${leafId}] ${change} ${filePath}`,
		});
	}
	return items;
}

/** Diff items between two adjacent leaves (newer leaf vs its predecessor). */
function collectLeafPairItems(
	prevLeafId: string,
	prevManifest: Manifest,
	nextLeafId: string,
	nextManifest: Manifest,
): UiDiffItem[] {
	const items: UiDiffItem[] = [];
	const filePaths = new Set<string>([
		...prevManifest.keys(),
		...nextManifest.keys(),
	]);
	for (const filePath of filePaths) {
		const change = describeChange(
			prevManifest.get(filePath),
			nextManifest.get(filePath),
		);
		if (!change) continue;
		items.push({
			leafId: nextLeafId,
			previousLeafId: prevLeafId,
			path: filePath,
			change,
			label: `[${nextLeafId}] ${change} ${filePath} (vs ${prevLeafId})`,
		});
	}
	return items;
}

/** Session history order, oldest first, deduplicated. */
function orderedLeaves(leafOrder: string[]): string[] {
	const order: string[] = [];
	for (const leafId of leafOrder) {
		if (leafId && !order.includes(leafId)) order.push(leafId);
	}
	return order;
}

export async function listDiffItems(
	tracker: SnapshotTracker,
	cache: Cache,
): Promise<DiffItem[]> {
	const baseManifest = tracker.getBaseManifest();
	const leafIds = await cache.listLeafIds();
	const items: DiffItem[] = [];

	for (const leafId of leafIds) {
		const leafManifest = await cache.readLeaf(leafId);
		if (!leafManifest) continue;
		for (const [filePath, leafEntry] of leafManifest) {
			const baseEntry = baseManifest.get(filePath);
			const change = describeChange(baseEntry, leafEntry);
			if (!change) continue;
			items.push({
				leafId,
				path: filePath,
				change: toChangeType(change),
			});
		}
	}

	return items;
}

export async function showDiffStack(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	tracker: SnapshotTracker,
	cache: Cache,
	leafOrder: string[] = [],
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("No UI available", "error");
		return;
	}

	const baseManifest = tracker.getBaseManifest();
	const leafIds = await cache.listLeafIds();
	const items: UiDiffItem[] = [];
	const manifests = new Map<string, Manifest>();

	for (const leafId of leafIds) {
		const leafManifest = await cache.readLeaf(leafId);
		if (!leafManifest) continue;
		manifests.set(leafId, leafManifest);
		items.push(...collectUiDiffItems(baseManifest, leafId, leafManifest));
	}

	// Leaf-to-leaf diffs between adjacent leaves in session history.
	const ordered = orderedLeaves(leafOrder);
	for (let index = 1; index < ordered.length; index += 1) {
		const prevLeafId = ordered[index - 1]!;
		const nextLeafId = ordered[index]!;
		const prevManifest =
			manifests.get(prevLeafId) ?? (await cache.readLeaf(prevLeafId));
		const nextManifest =
			manifests.get(nextLeafId) ?? (await cache.readLeaf(nextLeafId));
		if (!prevManifest || !nextManifest) continue;
		items.push(
			...collectLeafPairItems(
				prevLeafId,
				prevManifest,
				nextLeafId,
				nextManifest,
			),
		);
	}

	if (items.length === 0) {
		ctx.ui.notify("No buffered diffs available", "info");
		return;
	}

	const labels = items.map((item) => item.label);
	const selection = await ctx.ui.select("Buffered diffs", labels);
	if (!selection) return;
	const item = items.find((candidate) => candidate.label === selection);
	if (!item) return;

	const nextManifest = await cache.readLeaf(item.leafId);
	if (!nextManifest) {
		ctx.ui.notify("Diff no longer available", "warning");
		return;
	}

	let baseEntry: FileState | undefined;
	if (item.previousLeafId) {
		const prevManifest = await cache.readLeaf(item.previousLeafId);
		if (!prevManifest) {
			ctx.ui.notify("Diff no longer available", "warning");
			return;
		}
		baseEntry = prevManifest.get(item.path);
	} else {
		baseEntry = baseManifest.get(item.path);
	}

	const leafEntry = nextManifest.get(item.path);
	const diffText = await formatDiffText(cache, baseEntry, leafEntry);
	const header = item.previousLeafId
		? `Diff for ${item.path} (leaf ${item.previousLeafId} \u2192 ${item.leafId})`
		: `Diff for ${item.path} (leaf ${item.leafId})`;
	pi.sendMessage(
		{
			customType: "undo-redo.diff",
			content: `${header}\n\n${diffText}`,
			display: true,
			details: {
				leafId: item.leafId,
				path: item.path,
				...(item.previousLeafId
					? { previousLeafId: item.previousLeafId }
					: {}),
			},
		},
		{ triggerTurn: false },
	);
}
