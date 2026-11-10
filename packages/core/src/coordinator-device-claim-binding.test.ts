import { afterEach, describe, expect, it } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	completeDeviceClaimBinding,
	readDeviceClaimBindingReadiness,
	readDeviceClaimBindingReceipt,
} from "./coordinator-device-claim-binding.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";
import {
	LEGACY_SETUP,
	type LinkedLegacySetupFixture,
	linkedLegacySetupFixture,
} from "./linked-legacy-setup-test-fixtures.js";

let f: LinkedLegacySetupFixture;
afterEach(async () => {
	await f?.close();
});

async function fixtureBackend(kind: "SQLite" | "D1"): Promise<AuthLinkBackend> {
	if (kind === "SQLite") return nativeBackend(f.coordinator.db);
	const result = await f.coordinator.store.readDeviceRebindBackend();
	if (!result) throw new Error("expected ready D1 backend");
	return result;
}

for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} claim-backed binding`, () => {
		it("allows independently bound peers recorded under this Identity in retained legacy history", async () => {
			// Arrange
			f = await linkedLegacySetupFixture(backend);
			f.coordinator.db
				.prepare(`INSERT INTO coordinator_legacy_team_completions
 (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES (?, 'peer-history',1,?,'2026-01-01','2026-01-01')`)
				.run(
					LEGACY_SETUP.groupId,
					JSON.stringify({
						coordinator_id: LEGACY_SETUP.coordinatorId,
						device_decisions: [
							{
								device_id: f.keyB.deviceId,
								key_fingerprint: f.keyB.fingerprint,
								identity_id: LEGACY_SETUP.identityId,
								decision: "included",
								enabled: true,
								identity_evidence: "self",
							},
						],
					}),
				);
			const db = await fixtureBackend(backend);
			// Act
			const result = await completeDeviceClaimBinding(
				db,
				{ signer: f.account.signer, currentIdentityId: LEGACY_SETUP.identityId },
				f.account.config,
				Date.parse(LEGACY_SETUP.now),
			);
			// Assert
			expect(result.kind).toBe("completed");
		});
		it("completes only this device and preserves the existing other-device binding", async () => {
			// Arrange: real committed own claim, independently owned peer, and NULL own enrollment.
			f = await linkedLegacySetupFixture(backend);
			const db = await fixtureBackend(backend);
			const input = { signer: f.account.signer, currentIdentityId: LEGACY_SETUP.identityId };
			const peer = f.coordinator.db
				.prepare("SELECT * FROM coordinator_device_ownership_bindings")
				.all();
			const grants = f.coordinator.db
				.prepare("SELECT * FROM coordinator_identity_group_grants")
				.all();
			// Act
			const ready = await readDeviceClaimBindingReadiness(
				db,
				input,
				f.account.config,
				Date.parse(LEGACY_SETUP.now),
			);
			const result = await completeDeviceClaimBinding(
				db,
				input,
				f.account.config,
				Date.parse(LEGACY_SETUP.now),
			);
			// Assert
			expect(ready.kind).toBe("ready");
			expect(result.kind).toBe("completed");
			expect(
				f.coordinator.db
					.prepare("SELECT identity_id FROM enrolled_devices WHERE device_id = ?")
					.get(f.keyA.deviceId),
			).toEqual({ identity_id: LEGACY_SETUP.identityId });
			expect(
				f.coordinator.db
					.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id = ?")
					.all(f.keyB.deviceId),
			).toEqual(peer);
			expect(
				f.coordinator.db.prepare("SELECT * FROM coordinator_identity_group_grants").all(),
			).toEqual(grants);
		});

		it("replays an immutable receipt without updating enrollment or audit", async () => {
			// Arrange
			f = await linkedLegacySetupFixture(backend);
			const db = await fixtureBackend(backend);
			const input = { signer: f.account.signer, currentIdentityId: LEGACY_SETUP.identityId };
			const first = await completeDeviceClaimBinding(
				db,
				input,
				f.account.config,
				Date.parse(LEGACY_SETUP.now),
			);
			const before = f.coordinator.db
				.prepare("SELECT * FROM coordinator_device_rebind_audit_log")
				.all();
			// Act
			const retry = await completeDeviceClaimBinding(
				db,
				input,
				f.account.config,
				Date.parse(LEGACY_SETUP.now) + 1,
			);
			const receipt = await readDeviceClaimBindingReceipt(db, input, f.account.config);
			// Assert
			expect(first.kind).toBe("completed");
			expect(retry).toMatchObject({ kind: "complete", receipt });
			expect(
				f.coordinator.db.prepare("SELECT * FROM coordinator_device_rebind_audit_log").all(),
			).toEqual(before);
		});
	});
	describe(`${backend} enrollment denials`, () => {
		it.each([
			[
				"wrong Identity",
				"UPDATE enrolled_devices SET identity_id = 'other' WHERE device_id = 'device-a'",
			],
			["disabled signer", "UPDATE enrolled_devices SET enabled = 0 WHERE device_id = 'device-a'"],
			["archived group", "UPDATE groups SET archived_at = '2026-01-01'"],
			["revoked link", "UPDATE coordinator_auth_account_links SET revoked_at_ms = 1"],
			[
				"device revocation",
				"INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) SELECT 'device_id',device_id,'revoke-a',group_id,device_id,public_key,fingerprint,created_at FROM enrolled_devices WHERE device_id='device-a'",
			],
		])("denies %s without writes", async (_name, sql) => {
			// Arrange
			f = await linkedLegacySetupFixture(backend);
			f.coordinator.db.exec(sql);
			const db = await fixtureBackend(backend);
			const input = { signer: f.account.signer, currentIdentityId: LEGACY_SETUP.identityId };
			const before = f.coordinator.db
				.prepare("SELECT * FROM coordinator_device_ownership_bindings")
				.all();
			// Act
			const result = await completeDeviceClaimBinding(
				db,
				input,
				f.account.config,
				Date.parse(LEGACY_SETUP.now),
			);
			// Assert
			expect(result).toEqual({ kind: "requires_review" });
			expect(
				f.coordinator.db.prepare("SELECT * FROM coordinator_device_ownership_bindings").all(),
			).toEqual(before);
		});
	});
}
