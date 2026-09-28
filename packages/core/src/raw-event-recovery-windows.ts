/** Exact raw-event ranges missed during an observer authentication outage. */
export interface RawEventRecoveryRange {
	source: string;
	streamId: string;
	startEventSeq: number;
	endEventSeq: number;
}

function sameStream(left: RawEventRecoveryRange, right: RawEventRecoveryRange): boolean {
	return left.source === right.source && left.streamId === right.streamId;
}

function compareRanges(left: RawEventRecoveryRange, right: RawEventRecoveryRange): number {
	return (
		left.source.localeCompare(right.source) ||
		left.streamId.localeCompare(right.streamId) ||
		left.startEventSeq - right.startEventSeq ||
		left.endEventSeq - right.endEventSeq
	);
}

function mergeRanges(ranges: RawEventRecoveryRange[]): RawEventRecoveryRange[] {
	const merged: RawEventRecoveryRange[] = [];
	for (const range of [...ranges].sort(compareRanges)) {
		if (
			!range.source ||
			!range.streamId ||
			!Number.isSafeInteger(range.startEventSeq) ||
			range.startEventSeq < 0 ||
			!Number.isSafeInteger(range.endEventSeq) ||
			range.endEventSeq < range.startEventSeq
		)
			throw new Error("invalid recovery range");
		const last = merged[merged.length - 1];
		if (last && sameStream(last, range) && range.startEventSeq <= last.endEventSeq + 1) {
			last.endEventSeq = Math.max(last.endEventSeq, range.endEventSeq);
			continue;
		}
		merged.push({ ...range });
	}
	return merged;
}

function subtractCompleted(
	range: RawEventRecoveryRange,
	completed: RawEventRecoveryRange[],
): RawEventRecoveryRange[] {
	let cursor = range.startEventSeq;
	const remaining: RawEventRecoveryRange[] = [];
	for (const covered of completed) {
		if (!sameStream(range, covered) || covered.endEventSeq < cursor) continue;
		if (covered.startEventSeq > range.endEventSeq) break;
		if (covered.startEventSeq > cursor) {
			remaining.push({ ...range, startEventSeq: cursor, endEventSeq: covered.startEventSeq - 1 });
		}
		cursor = Math.max(cursor, covered.endEventSeq + 1);
		if (cursor > range.endEventSeq) break;
	}
	if (cursor <= range.endEventSeq) remaining.push({ ...range, startEventSeq: cursor });
	return remaining;
}

/** Reconcile overlapping failed batches without reprocessing completed event ranges. */
export function planRawEventRecoveryWindows(
	missingAuth: RawEventRecoveryRange[],
	completed: RawEventRecoveryRange[],
	maxEvents: number,
): RawEventRecoveryRange[] {
	if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 100)
		throw new Error("invalid recovery limit");
	const windows: RawEventRecoveryRange[] = [];
	const covered = mergeRanges(completed);
	for (const range of mergeRanges(missingAuth)) {
		for (const gap of subtractCompleted(range, covered)) {
			for (let start = gap.startEventSeq; start <= gap.endEventSeq; start += maxEvents) {
				windows.push({
					...gap,
					startEventSeq: start,
					endEventSeq: Math.min(gap.endEventSeq, start + maxEvents - 1),
				});
			}
		}
	}
	return windows;
}
