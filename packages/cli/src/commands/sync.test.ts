import { describe, expect, it } from "vitest";
import { formatSyncAttempt } from "./sync.js";

describe("formatSyncAttempt", () => {
	it("matches the compact Python-era output shape", () => {
		expect(
			formatSyncAttempt({
				peer_device_id: "peer-1",
				ok: 1,
				ops_in: 3,
				ops_out: 5,
				error: null,
				finished_at: "2026-03-18T20:00:00Z",
			}),
		).toBe("peer-1|ok|in=3|out=5|2026-03-18T20:00:00Z");
	});

	it("includes the error suffix when present", () => {
		expect(
			formatSyncAttempt({
				peer_device_id: "peer-2",
				ok: 0,
				ops_in: 0,
				ops_out: 1,
				error: "timeout",
				finished_at: "2026-03-18T21:00:00Z",
			}),
		).toBe("peer-2|error|in=0|out=1|2026-03-18T21:00:00Z | timeout");
	});
});
