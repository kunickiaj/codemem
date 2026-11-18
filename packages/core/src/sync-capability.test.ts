import { describe, expect, it } from "vitest";
import {
	LOCAL_SYNC_CAPABILITY,
	LOCAL_SYNC_FEATURES,
	negotiateSyncCapability,
	normalizeSyncFeatures,
	setLocalSyncFeature,
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

describe("peer_removal_check feature", () => {
	it("is advertised locally and stays advertised, in sorted order, when another feature is toggled", () => {
		expect(LOCAL_SYNC_FEATURES).toContain("peer_removal_check");
		expect(LOCAL_SYNC_FEATURES).toEqual([...LOCAL_SYNC_FEATURES].sort());

		setLocalSyncFeature("relay", true);
		try {
			expect(LOCAL_SYNC_FEATURES).toEqual([
				"peer_removal_check",
				"reassign_scope",
				"relay",
				"relay_aware",
			]);
		} finally {
			setLocalSyncFeature("relay", false);
		}
		expect(LOCAL_SYNC_FEATURES).toEqual(["peer_removal_check", "reassign_scope", "relay_aware"]);
	});

	it("is recognized from a peer, while a feature from a newer peer is dropped without affecting the rest", () => {
		const advertised = "relay_aware, feature_from_a_newer_build ,peer_removal_check,reassign_scope";

		expect(normalizeSyncFeatures(advertised)).toEqual([
			"peer_removal_check",
			"reassign_scope",
			"relay_aware",
		]);
		expect(supportsSyncFeature(advertised, "reassign_scope")).toBe(true);
		expect(supportsSyncFeature(advertised, "relay")).toBe(false);
	});

	it("is absent for an older peer, which changes nothing else that peer advertises", () => {
		const olderPeer = ["reassign_scope", "relay_aware"];

		expect(supportsSyncFeature(olderPeer, "peer_removal_check")).toBe(false);
		expect(normalizeSyncFeatures(olderPeer)).toEqual(olderPeer);
	});
});
