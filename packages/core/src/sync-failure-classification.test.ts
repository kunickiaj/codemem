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
		["opaque failure", "other"],
		[null, "other"],
	])("classifies %s as %s", (error, category) => {
		expect(classifyRecordedSyncFailure(error)).toBe(category);
	});

	it("ignores words inside peer addresses", () => {
		expect(
			classifyRecordedSyncFailure(
				"all addresses failed | http://unauthorized-network.local:7337: bootstrap apply failed",
			),
		).toBe("other");
	});

	it.each([
		"scoped sync incomplete: oss=scoped incremental failed: timeout",
		"scoped sync incomplete: oss=vector catch-up failed: network; fallback failed: timeout",
		"scoped sync incomplete: auth-network=bootstrap apply failed",
		"inbound apply incomplete: 2 op(s) failed; cursor held for retry",
	])("does not guess a category for aggregated failures: %s", (error) => {
		expect(classifyRecordedSyncFailure(error)).toBe("other");
	});

	it("stays fast on long adversarial input", () => {
		const started = performance.now();
		classifyRecordedSyncFailure(`a://${"a://".repeat(50_000)}`);
		classifyRecordedSyncFailure("a".repeat(200_000));
		expect(performance.now() - started).toBeLessThan(500);
	});
});
