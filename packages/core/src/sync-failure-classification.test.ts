import { describe, expect, it } from "vitest";
import { classifyRecordedSyncFailure } from "./sync-failure-classification.js";

describe("classifyRecordedSyncFailure", () => {
	it.each([
		["no dialable peer addresses", "connectivity"],
		["peer status failed (503)", "connectivity"],
		[
			"all addresses failed | http://a.test:7337: The operation was aborted due to timeout",
			"connectivity",
		],
		["peer status failed (401: unauthorized)", "trust"],
		["peer fingerprint mismatch", "trust"],
		["peer protocol mismatch (expected 2, got 1)", "compatibility"],
		["scoped sync incomplete: oss=scope_rejected:stale_epoch", "scope"],
		["opaque failure", "other"],
		[null, "other"],
	])("classifies %s as %s", (error, category) => {
		expect(classifyRecordedSyncFailure(error)).toBe(category);
	});

	it("ignores words inside peer addresses and Space IDs", () => {
		expect(
			classifyRecordedSyncFailure(
				"all addresses failed | http://unauthorized-network.local:7337: bootstrap apply failed",
			),
		).toBe("other");
		expect(
			classifyRecordedSyncFailure("scoped sync incomplete: auth-network=bootstrap apply failed"),
		).toBe("other");
	});

	it("uses one category only when every failed Space agrees", () => {
		expect(
			classifyRecordedSyncFailure(
				"scoped sync incomplete: one=scoped incremental failed: timeout; two=peer ops fetch failed (503)",
			),
		).toBe("connectivity");
		expect(
			classifyRecordedSyncFailure(
				"scoped sync incomplete: one=bootstrap apply failed; two=scoped incremental failed: timeout",
			),
		).toBe("other");
	});

	it("treats incomplete inbound apply as other, like the runtime category", () => {
		expect(
			classifyRecordedSyncFailure(
				"inbound apply incomplete: 2 op(s) failed; cursor held for retry; scoped sync incomplete: oss=timeout",
			),
		).toBe("other");
	});
});
