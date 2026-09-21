import { expect, it } from "vitest";
import { reconcileCoordinatorEnrollmentSnapshot } from "../../core/src/coordinator-enrollment-reconciler";
import { connect } from "../../core/src/db";
import { listDeviceIdentityInventory } from "../../core/src/device-identity-inventory";
import { listRecipientPolicyIntent } from "../../core/src/recipient-policy-intent";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint";
import { projectDevices } from "./tabs/devices";

function restoreHistoricalLabel(db, kind) {
	const labels = {
		historical: ["Enrolled device", "coordinator_enrollment"],
		"historical-peer": ["Peer device", "managed_exact_project"],
		"user-named": ["Enrolled device", "user"],
	};
	const label = labels[kind];
	if (label)
		db.prepare(
			"UPDATE identity_devices SET display_name = ?, provenance = ? WHERE device_id = 'device-a'",
		).run(...label);
}

it.each(["new", "historical", "explicit", "historical-peer", "user-named"])(
	"projects reconciled %s enrollment names through intent and inventory",
	async (kind) => {
		const db = connect(":memory:");
		const now = "2026-09-20T00:00:00.000Z";
		try {
			db.prepare(
				"INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at) VALUES ('identity-a', 'Example', 0, 'active', ?, ?)",
			).run(now, now);
			const enrollment = {
				group_id: "group-a",
				device_id: "device-a",
				public_key: "key-a",
				fingerprint: fingerprintPublicKey("key-a"),
				identity_id: "identity-a",
				display_name: kind === "explicit" ? "Enrolled device" : null,
				enabled: 1,
				created_at: now,
			};
			await reconcileCoordinatorEnrollmentSnapshot(db, {
				coordinatorId: "https://coord.example.test",
				groupId: "group-a",
				now,
				consumedTeamInvites: [],
				enrollments: [enrollment],
			});
			restoreHistoricalLabel(db, kind);
			const intent = listRecipientPolicyIntent(db);
			const persistedNames = {
				new: "Unnamed device",
				historical: "Enrolled device",
				explicit: "Enrolled device",
				"historical-peer": "Peer device",
				"user-named": "Enrolled device",
			};
			expect(intent.identityDevices[0]?.displayName).toBe(persistedNames[kind]);
			const inventory = listDeviceIdentityInventory(db, {
				localDeviceId: "other",
				coordinator: {
					availability: "available",
					safeErrorCode: null,
					enrollments: [
						{
							...enrollment,
							display_name: kind === "explicit" ? "Enrolled device" : "Studio laptop",
						},
					],
				},
			});
			const projection = projectDevices(intent, { version: 1, items: [] }, [], [], [], inventory);
			expect(projection.devices[0]?.displayName).toBe(
				["explicit", "user-named"].includes(kind) ? "Enrolled device" : "Studio laptop",
			);
			expect(listRecipientPolicyIntent(db)).toEqual(intent);
		} finally {
			db.close();
		}
	},
);
