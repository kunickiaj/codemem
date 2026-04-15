import { describe, expect, it } from "vitest";

import { syncAttemptsHistoryNote } from "./diagnostics";

describe("syncAttemptsHistoryNote", () => {
	it("explains that offline-peer attempts may be historical", () => {
		expect(syncAttemptsHistoryNote("offline-peers", true)).toContain(
			"before all peers went offline",
		);
	});

	it("stays empty when there are no visible failures to explain", () => {
		expect(syncAttemptsHistoryNote("offline-peers", false)).toBe("");
	});

	it("stays empty for other daemon states", () => {
		expect(syncAttemptsHistoryNote("ok", true)).toBe("");
		expect(syncAttemptsHistoryNote("stale", true)).toBe("");
	});
});
