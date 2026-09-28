import { describe, expect, it } from "vitest";
import {
	planRawEventRecoveryWindows,
	type RawEventRecoveryRange,
} from "./raw-event-recovery-windows.js";

function range(
	source: string,
	streamId: string,
	startEventSeq: number,
	endEventSeq: number,
): RawEventRecoveryRange {
	return { source, streamId, startEventSeq, endEventSeq };
}

describe("raw-event auth gap planning", () => {
	it("coalesces overlapping failed and exhausted batches before slicing", () => {
		expect(
			planRawEventRecoveryWindows(
				[range("opencode", "one", 4, 9), range("opencode", "one", 1, 6)],
				[],
				4,
			),
		).toEqual([
			range("opencode", "one", 1, 4),
			range("opencode", "one", 5, 8),
			range("opencode", "one", 9, 9),
		]);
	});

	it("subtracts completed ranges without merging different streams or sources", () => {
		expect(
			planRawEventRecoveryWindows(
				[
					range("opencode", "one", 1, 10),
					range("opencode", "two", 1, 3),
					range("codex", "one", 1, 2),
				],
				[
					range("opencode", "one", 3, 4),
					range("opencode", "one", 7, 8),
					range("opencode", "two", 1, 3),
				],
				20,
			),
		).toEqual([
			range("codex", "one", 1, 2),
			range("opencode", "one", 1, 2),
			range("opencode", "one", 5, 6),
			range("opencode", "one", 9, 10),
		]);
	});

	it("rejects unsafe budgets and leaves inputs untouched", () => {
		const input = [range("opencode", "one", 1, 3)];
		expect(() => planRawEventRecoveryWindows(input, [], 0)).toThrow("invalid recovery limit");
		expect(planRawEventRecoveryWindows(input, [], 2)).toEqual([
			range("opencode", "one", 1, 2),
			range("opencode", "one", 3, 3),
		]);
		expect(input).toEqual([range("opencode", "one", 1, 3)]);
	});
});
