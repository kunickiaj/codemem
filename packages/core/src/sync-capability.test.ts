import { describe, expect, it } from "vitest";
import {
	LOCAL_SYNC_CAPABILITY,
	negotiateSyncCapability,
	normalizeSyncFeatures,
	supportsSyncFeature,
} from "./sync-capability.js";

describe("additive sync features", () => {
	it("keeps the existing capability rank while negotiating reassign_scope independently", () => {
		expect(LOCAL_SYNC_CAPABILITY).toBe("scoped");
		expect(negotiateSyncCapability(LOCAL_SYNC_CAPABILITY, "aware")).toBe("aware");
		expect(normalizeSyncFeatures(undefined)).toEqual([]);
		expect(normalizeSyncFeatures(["reassign_scope", "unknown"])).toEqual(["reassign_scope"]);
		expect(supportsSyncFeature("reassign_scope", "reassign_scope")).toBe(true);
	});
});
