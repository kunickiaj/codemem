import { describe, expect, it } from "vitest";
import {
	classifyRecordedSyncFailure,
	storedAddressFailureCategory,
} from "./sync-failure-classification.js";

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
		["peer ops fetch failed (502)", "connectivity"],
		["peer status failed (404)", "other"],
		["peer ops fetch failed (400: bad request)", "other"],
		["snapshot fetch failed (500: internal)", "other"],
		["snapshot fetch failed: status 500", "other"],
		["snapshot fetch failed: status 503", "connectivity"],
		["snapshot fetch failed: sync_auth_store_busy", "connectivity"],
		["snapshot fetch failed: bootstrap_grant_invalid", "other"],
		["peer status failed", "other"],
		["fetch failed", "connectivity"],
		["peer ops push failed (403: scope_rejected:stale_epoch)", "scope"],
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

describe("storedAddressFailureCategory", () => {
	it.each([
		[
			[{ address: "http://gateway.local/missing_scope", error: "peer status failed (500)" }],
			"other",
		],
		[
			[
				{
					address: "http://a.local:7337",
					error: "peer status failed (400: bad || connection refused)",
				},
			],
			"other",
		],
		[
			[
				{ address: "http://a.local:7337", error: "peer status failed (400)" },
				{ address: "http://b.local:7337", error: "connection refused" },
			],
			"connectivity",
		],
		[
			[
				{ address: "http://a.local:7337", error: "fetch failed" },
				{ address: "http://b.local:7337", error: "peer status failed (401: unauthorized)" },
			],
			"trust",
		],
		[[{ address: "http://a.local:7337", error: "peer ops fetch failed (503)" }], "connectivity"],
		[[{ address: "http://a.local:7337", error: "socket hang up" }], "other"],
	] as const)("classifies %j as %s", (addressErrors, category) => {
		expect(storedAddressFailureCategory([...addressErrors], "unused")).toBe(category);
	});

	it("uses the fallback error when no address was attempted", () => {
		expect(storedAddressFailureCategory([], "no dialable peer addresses")).toBe("connectivity");
	});
});
