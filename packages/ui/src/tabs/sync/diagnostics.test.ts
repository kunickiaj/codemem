import { describe, expect, it } from "vitest";

import { syncAttemptsHistoryNote } from "./diagnostics";
import { cleanupDiagnosticLabel } from "./diagnostics/render/sync-status";

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

describe("cleanupDiagnosticLabel", () => {
	it("labels cleanup-specific sync states without raw ids", () => {
		expect(
			cleanupDiagnosticLabel({
				state: "cleanup_pending",
				stale_peer_rows: { would_remove: 3 },
			}),
		).toBe("3 pending removal");
		expect(
			cleanupDiagnosticLabel({ state: "needs_review", stale_peer_rows: { ambiguous: 2 } }),
		).toBe("2 needs review");
		expect(
			cleanupDiagnosticLabel({ state: "cleanup_applied", access_cleanup_ops: { applied: 4 } }),
		).toBe("4 applied");
		expect(cleanupDiagnosticLabel({ state: "clear" })).toBe("Clear");
	});
});
