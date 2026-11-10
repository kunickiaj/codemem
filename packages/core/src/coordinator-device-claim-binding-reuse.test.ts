import { afterEach, describe, expect, it } from "vitest";
import {
	deviceClaimBindingStatements,
	prepareFirstLinkDeviceClaimBinding,
	readDeviceClaimBindingReceipt,
	readFirstLinkDeviceClaimOwnershipComplete,
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
const now = Date.parse(LEGACY_SETUP.now);
const input = () => ({ signer: f.account.signer, currentIdentityId: LEGACY_SETUP.identityId });
const effects = () =>
	[
		"coordinator_device_ownership_bindings",
		"coordinator_device_rebind_audit_log",
		"enrolled_devices",
	].map((table) => f.coordinator.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());
function existingBinding() {
	f.coordinator.db.exec(`INSERT INTO coordinator_device_ownership_bindings
 (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
 SELECT device_id,key_id,identity_id,coordinator_id,'prior-owned-binding','reviewed_legacy_migration','prior-reviewed-source','2026-01-01T00:00:00.000Z' FROM coordinator_auth_device_claims`);
}
for (const kind of ["SQLite", "D1"] as const) {
	async function backend() {
		const db = await f.coordinator.store.readDeviceRebindBackend();
		if (!db) throw new Error("backend missing");
		return kind === "SQLite" ? nativeBackend(f.coordinator.db) : db;
	}
	describe(`${kind} first-link prior ownership`, () => {
		it.each(["NULL", "complete"])("preserves prior binding with %s enrollment", async (state) => {
			// Arrange
			f = await linkedLegacySetupFixture(kind);
			existingBinding();
			if (state === "complete")
				f.coordinator.db
					.prepare("UPDATE enrolled_devices SET identity_id=? WHERE device_id=?")
					.run(LEGACY_SETUP.identityId, f.keyA.deviceId);
			const db = await backend();
			const binding = f.coordinator.db
				.prepare("SELECT * FROM coordinator_device_ownership_bindings")
				.all();
			const audit = f.coordinator.db
				.prepare("SELECT * FROM coordinator_device_rebind_audit_log")
				.all();
			const plan = await prepareFirstLinkDeviceClaimBinding(db, input(), f.account.config, now);
			if (!plan) throw new Error("expected first-link plan");
			// Act
			await db.batch(
				deviceClaimBindingStatements(plan, "unused-binding", "unused-audit", {
					winning: { sql: "1", values: [] },
				}),
			);
			const complete = await readFirstLinkDeviceClaimOwnershipComplete(
				db,
				input(),
				f.account.config,
				now,
			);
			const receipt = await readDeviceClaimBindingReceipt(db, input(), f.account.config);
			// Assert
			expect(complete).toBe(true);
			expect(receipt).toBeNull();
			expect(
				f.coordinator.db.prepare("SELECT * FROM coordinator_device_ownership_bindings").all(),
			).toEqual(binding);
			expect(
				f.coordinator.db.prepare("SELECT * FROM coordinator_device_rebind_audit_log").all(),
			).toEqual(audit);
		});
		it("recovers a lost reply by reading completed ownership without another write", async () => {
			// Arrange
			f = await linkedLegacySetupFixture(kind);
			existingBinding();
			const db = await backend();
			const plan = await prepareFirstLinkDeviceClaimBinding(db, input(), f.account.config, now);
			if (!plan) throw new Error("expected first-link plan");
			// Act
			const reply = db
				.batch(deviceClaimBindingStatements(plan, "unused-binding", "unused-audit"))
				.then(() => {
					throw new Error("reply_lost");
				});
			const error = await reply.catch((error) => error);
			const before = effects();
			const complete = await readFirstLinkDeviceClaimOwnershipComplete(
				db,
				input(),
				f.account.config,
				now,
			);
			// Assert
			expect(error).toMatchObject({ message: "reply_lost" });
			expect(complete).toBe(true);
			expect(effects()).toEqual(before);
		});
		it("does not treat prior binding alone as a committed account claim", async () => {
			// Arrange
			f = await linkedLegacySetupFixture(kind);
			existingBinding();
			f.coordinator.db.exec("DELETE FROM coordinator_auth_link_audit_log");
			const db = await backend();
			const before = effects();
			// Act
			const complete = await readFirstLinkDeviceClaimOwnershipComplete(
				db,
				input(),
				f.account.config,
				now,
			);
			// Assert
			expect(complete).toBe(false);
			expect(effects()).toEqual(before);
		});
	});
	describe(`${kind} first-link reuse atomicity`, () => {
		it.each([
			[
				"zero NULL updates",
				`CREATE TRIGGER ignore_reuse_update BEFORE UPDATE ON enrolled_devices BEGIN SELECT RAISE(IGNORE); END`,
			],
			[
				"enrollment drift",
				`UPDATE enrolled_devices SET identity_id='other-identity' WHERE device_id='device-a'`,
			],
			[
				"a key alias introduced during NULL updates",
				`CREATE TRIGGER add_reuse_alias AFTER UPDATE ON enrolled_devices WHEN NEW.device_id='device-a' BEGIN INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at) VALUES (NEW.group_id,'racing-alias',NEW.public_key,NEW.fingerprint,NULL,1,NEW.created_at); END`,
			],
			[
				"binding provenance drift",
				`DROP TRIGGER coordinator_device_ownership_immutable_update; UPDATE coordinator_device_ownership_bindings SET source_ref='changed-source' WHERE device_id='device-a'`,
			],
		])("rolls back after %s", async (_name, sql) => {
			// Arrange
			f = await linkedLegacySetupFixture(kind);
			existingBinding();
			const db = await backend();
			const plan = await prepareFirstLinkDeviceClaimBinding(db, input(), f.account.config, now);
			if (!plan) throw new Error("expected first-link plan");
			f.coordinator.db.exec(sql);
			const before = effects();
			// Act
			const write = db.batch(
				deviceClaimBindingStatements(plan, "unused-binding", "unused-audit", {
					winning: { sql: "1", values: [] },
				}),
			);
			// Assert
			await expect(write).rejects.toThrow();
			expect(effects()).toEqual(before);
		});
	});
}
