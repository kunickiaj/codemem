import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	completeDeviceClaimBinding,
	deviceClaimBindingStatements,
	prepareDeviceClaimBinding,
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
const now = Date.parse(LEGACY_SETUP.now);
const input = () => ({ signer: f.account.signer, currentIdentityId: LEGACY_SETUP.identityId });
const effects = () =>
	[
		"coordinator_device_ownership_bindings",
		"enrolled_devices",
		"coordinator_device_rebind_audit_log",
		"coordinator_identity_group_grants",
	].map((table) => f.coordinator.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());

const DENIAL_SQL = [
	[
		"a forged genesis",
		`DROP TRIGGER IF EXISTS coordinator_auth_link_attempts_immutable; UPDATE coordinator_auth_link_attempts SET browser_start_hash=NULL`,
	],
	["missing genesis audit", `DELETE FROM coordinator_auth_link_audit_log`],
	[
		"wrong fingerprint",
		`UPDATE enrolled_devices SET fingerprint='${"f".repeat(64)}' WHERE device_id='device-a'`,
	],
	[
		"another enrollment key",
		`UPDATE enrolled_devices SET public_key=public_key||' alias' WHERE device_id='device-a'`,
	],
	[
		"a canonical key alias on another device",
		`INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at) SELECT group_id,'alias-device',public_key,fingerprint,NULL,1,created_at FROM enrolled_devices WHERE device_id='device-a'`,
	],
	[
		"a competing same-Identity binding with different provenance",
		`INSERT INTO coordinator_device_ownership_bindings (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at) SELECT device_id,key_id,identity_id,coordinator_id,'other-binding','owner_enrollment','other-attempt','2026-01-01' FROM coordinator_auth_device_claims`,
	],
	[
		"an active conflicting attestation",
		`INSERT INTO coordinator_auth_controller_attestations (coordinator_id,attestation_id,identity_id,group_id,device_id,public_key,fingerprint,review_receipt_id,evidence_digest,enrollment_identity_id,revision,created_at) SELECT coordinator_id,'other-attestation','other-identity',group_id,device_id,public_key,fingerprint,'review-a','${"c".repeat(64)}',NULL,1,'2026-01-01' FROM coordinator_auth_device_claims`,
	],
	[
		"a consumed invitation naming another Identity",
		`INSERT INTO coordinator_invites (invite_id,group_id,token,policy,expires_at,created_at,consumed_at,bound_device_id,bound_public_key,bound_fingerprint,assigned_identity_id) SELECT 'conflict-invite',group_id,'fixture-token','open','2027-01-01','2026-01-01','2026-01-02',device_id,public_key,fingerprint,'other-identity' FROM coordinator_auth_device_claims`,
	],
	[
		"a deliberate legacy exclusion",
		`INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) SELECT group_id,'excluded-candidate',1,json_object('coordinator_id',coordinator_id,'device_decisions',json_array(json_object('device_id',device_id,'key_fingerprint',fingerprint,'identity_id',identity_id,'decision','excluded','enabled',0))),'2026-01-01','2026-01-01' FROM coordinator_auth_device_claims`,
	],
	[
		"a legacy own-device assignment to another Identity",
		`INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) SELECT group_id,'contradictory-candidate',1,json_object('coordinator_id',coordinator_id,'device_decisions',json_array(json_object('device_id',device_id,'key_fingerprint',fingerprint,'identity_id','other-identity','decision','included','enabled',1,'identity_evidence','self'))),'2026-01-01','2026-01-01' FROM coordinator_auth_device_claims`,
	],
	[
		"a key revocation",
		`INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) SELECT 'ed25519_key',key_id,'key-revoke',group_id,device_id,public_key,fingerprint,'2026-01-01' FROM coordinator_auth_device_claims`,
	],
	[
		"a live competing owner ceremony",
		`INSERT INTO coordinator_owner_enrollment_attempts (coordinator_id,attempt_id,purpose,origin,device_id,public_key,key_id,fingerprint,issuer,auth_config_revision,loopback_redirect,browser_start_hash,state,created_at_ms,expires_at_ms) SELECT coordinator_id,'competing-owner','owner_enroll','https://coordinator.example.test',device_id,public_key,key_id,fingerprint,issuer,auth_config_revision,'http://127.0.0.1:4567/complete','${"d".repeat(64)}','pending',created_at_ms,created_at_ms+600000 FROM coordinator_auth_device_claims`,
	],
	[
		"a live competing rebind ceremony",
		`INSERT INTO coordinator_device_rebind_attempts (coordinator_id,attempt_id,origin,device_id,public_key,key_id,fingerprint,current_identity_id,issuer,auth_config_revision,browser_start_hash,state,created_at_ms,expires_at_ms,review_digest) SELECT coordinator_id,'competing-rebind','https://coordinator.example.test',device_id,public_key,key_id,fingerprint,identity_id,issuer,auth_config_revision,'${"d".repeat(64)}','pending',created_at_ms,created_at_ms+600000,'${"e".repeat(64)}' FROM coordinator_auth_device_claims`,
	],
	[
		"a retained other-Identity link footprint",
		`INSERT INTO coordinator_auth_account_links (coordinator_id,link_id,issuer,subject,identity_id,attempt_id,controller_attestation_id,auth_config_revision,created_at_ms,authority_kind) SELECT coordinator_id,'other-link',issuer,'other-subject','other-identity','other-attempt','other-attestation',auth_config_revision,created_at_ms,'controller_attestation' FROM coordinator_auth_device_claims;
 INSERT INTO coordinator_auth_link_audit_log (coordinator_id,link_id,action,attempt_id,identity_id,group_id,device_id,fingerprint,controller_attestation_id,auth_config_revision,created_at_ms,authority_kind) SELECT coordinator_id,'other-link','link_created','other-attempt','other-identity',group_id,device_id,fingerprint,'other-attestation',auth_config_revision,created_at_ms,'controller_attestation' FROM coordinator_auth_device_claims`,
	],
] as const;

for (const kind of ["SQLite", "D1"] as const) {
	const backend = async (): Promise<AuthLinkBackend> => {
		if (kind === "SQLite") return nativeBackend(f.coordinator.db);
		const db = await f.coordinator.store.readDeviceRebindBackend();
		if (!db) throw new Error("D1 backend missing");
		return db;
	};
	describe(`${kind} completion safety`, () => {
		it.each(DENIAL_SQL)("denies %s with no completion effects", async (_name, sql) => {
			// Arrange
			f = await linkedLegacySetupFixture(kind);
			f.coordinator.db.exec(sql);
			const db = await backend();
			const before = effects();
			// Act
			const result = await completeDeviceClaimBinding(db, input(), f.account.config, now);
			// Assert
			expect(result).toEqual({ kind: "requires_review" });
			expect(effects()).toEqual(before);
		});

		it("does not use a requested different Identity as authority", async () => {
			// Arrange
			f = await linkedLegacySetupFixture(kind);
			const db = await backend();
			const before = effects();
			// Act
			const result = await completeDeviceClaimBinding(
				db,
				{ ...input(), currentIdentityId: "arbitrary-identity" },
				f.account.config,
				now,
			);
			// Assert
			expect(result).toEqual({ kind: "requires_review" });
			expect(effects()).toEqual(before);
		});

		it("fills only NULL enrollments across the exact group set", async () => {
			// Arrange
			f = await linkedLegacySetupFixture(kind);
			await f.coordinator.store.createGroup("group-b");
			await f.coordinator.store.enrollDevice("group-b", {
				...f.keyA,
				identityId: LEGACY_SETUP.identityId,
			});
			f.coordinator.db.exec(
				`CREATE TRIGGER forbid_nonnull_update BEFORE UPDATE ON enrolled_devices WHEN OLD.identity_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'nonnull_changed'); END`,
			);
			const db = await backend();
			// Act
			const result = await completeDeviceClaimBinding(db, input(), f.account.config, now);
			// Assert
			expect(result).toMatchObject({ kind: "completed", receipt: { enrollmentCount: 2 } });
		});

		it.each([
			[
				"zero-row binding",
				`CREATE TRIGGER inject_zero BEFORE INSERT ON coordinator_device_ownership_bindings BEGIN SELECT RAISE(IGNORE); END`,
			],
			[
				"zero-row update",
				`CREATE TRIGGER inject_zero BEFORE UPDATE ON enrolled_devices WHEN OLD.device_id='device-a' BEGIN SELECT RAISE(IGNORE); END`,
			],
			[
				"zero-row audit",
				`CREATE TRIGGER inject_zero BEFORE INSERT ON coordinator_device_rebind_audit_log BEGIN SELECT RAISE(IGNORE); END`,
			],
			[
				"audit error",
				`CREATE TRIGGER inject_error BEFORE INSERT ON coordinator_device_rebind_audit_log BEGIN SELECT RAISE(ABORT,'audit_failure'); END`,
			],
			[
				"update-count drift",
				`CREATE TRIGGER inject_drift AFTER INSERT ON coordinator_device_ownership_bindings WHEN NEW.device_id='device-a' BEGIN UPDATE enrolled_devices SET identity_id=NEW.identity_id WHERE device_id=NEW.device_id; END`,
			],
		])("rolls back the whole batch after %s", async (_name, sql) => {
			// Arrange: inject only after captures, so readiness is valid.
			f = await linkedLegacySetupFixture(kind);
			const db = await backend();
			const plan = await prepareDeviceClaimBinding(db, input(), f.account.config, now);
			if (!plan) throw new Error("expected plan");
			f.coordinator.db.exec(sql);
			const before = effects();
			// Act
			const write = db.batch(deviceClaimBindingStatements(plan, "binding-test", "event-test"));
			// Assert
			await expect(write).rejects.toThrow();
			expect(effects()).toEqual(before);
		});

		it("pins the exact enrollment set against concurrent additions", async () => {
			// Arrange
			f = await linkedLegacySetupFixture(kind);
			const db = await backend();
			const plan = await prepareDeviceClaimBinding(db, input(), f.account.config, now);
			if (!plan) throw new Error("expected plan");
			await f.coordinator.store.createGroup("new-group");
			await f.coordinator.store.enrollDevice("new-group", f.keyA);
			const before = effects();
			// Act
			const write = db.batch(deviceClaimBindingStatements(plan, "binding-test", "event-test"));
			// Assert
			await expect(write).rejects.toThrow();
			expect(effects()).toEqual(before);
		});
	});
	describe(`${kind} producer composition`, () => {
		it("leaves a losing producer batch with zero new effects", async () => {
			// Arrange: a prior committed claim must not be reused by a losing new attempt.
			f = await linkedLegacySetupFixture(kind);
			const db = await backend();
			const plan = await prepareDeviceClaimBinding(db, input(), f.account.config, now);
			if (!plan) throw new Error("expected plan");
			const before = effects();
			// Act
			await db.batch(
				deviceClaimBindingStatements(plan, "losing-binding", "losing-event", {
					winning: { sql: "? = 1", values: [0] },
				}),
			);
			// Assert
			expect(effects()).toEqual(before);
		});
		it("retains strict assertions when the exact producer winner matches", async () => {
			// Arrange
			f = await linkedLegacySetupFixture(kind);
			const db = await backend();
			const plan = await prepareDeviceClaimBinding(db, input(), f.account.config, now);
			if (!plan) throw new Error("expected plan");
			f.coordinator.db.exec(
				`CREATE TRIGGER inject_error BEFORE INSERT ON coordinator_device_rebind_audit_log BEGIN SELECT RAISE(IGNORE); END`,
			);
			const before = effects();
			const original = f.coordinator.db
				.prepare(
					"SELECT attempt_id,link_id,finalized_at_ms FROM coordinator_auth_link_attempts WHERE authority_kind='device_claim'",
				)
				.get() as { attempt_id: string; link_id: string; finalized_at_ms: number };
			const winning = {
				sql: `EXISTS (SELECT 1 FROM coordinator_auth_link_attempts WHERE coordinator_id=? AND attempt_id=? AND authority_kind='device_claim' AND state='finalized' AND link_id=? AND finalized_at_ms=?)`,
				values: [
					f.account.config.coordinatorId,
					original.attempt_id,
					original.link_id,
					original.finalized_at_ms,
				],
			};
			// Act
			const write = db.batch(
				deviceClaimBindingStatements(plan, "winning-binding", "winning-event", { winning }),
			);
			// Assert
			await expect(write).rejects.toThrow();
			expect(effects()).toEqual(before);
		});
	});
	describe(`${kind} receipt recovery`, () => {
		it.each(["empty Identity", "wrong key", "wrong group"])(
			"rejects %s without mutation",
			async (caseName) => {
				// Arrange
				f = await linkedLegacySetupFixture(kind);
				const db = await backend();
				const value = input();
				if (caseName === "empty Identity") value.currentIdentityId = "";
				if (caseName === "wrong key")
					value.signer = { ...value.signer, publicKey: f.keyB.publicKey };
				if (caseName === "wrong group") value.signer = { ...value.signer, groupId: "other-group" };
				const before = effects();
				// Act
				const result = await completeDeviceClaimBinding(db, value, f.account.config, now);
				// Assert
				expect(result).toEqual({ kind: "requires_review" });
				expect(effects()).toEqual(before);
			},
		);
		it("reads readiness and missing receipts without issuing any writes", async () => {
			// Arrange
			f = await linkedLegacySetupFixture(kind);
			const db = await backend();
			const run = vi.spyOn(db, "run");
			const batch = vi.spyOn(db, "batch");
			const before = effects();
			// Act
			const ready = await readDeviceClaimBindingReadiness(db, input(), f.account.config, now);
			const receipt = await readDeviceClaimBindingReceipt(db, input(), f.account.config);
			// Assert
			expect(ready).toEqual({ kind: "ready" });
			expect(receipt).toBeNull();
			expect(run).not.toHaveBeenCalled();
			expect(batch).not.toHaveBeenCalled();
			expect(effects()).toEqual(before);
		});

		it("recovers an unknown committed outcome before another write attempt", async () => {
			// Arrange
			f = await linkedLegacySetupFixture(kind);
			const db = await backend();
			const batch = db.batch.bind(db);
			const writes = vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
				await batch(statements);
				throw new Error("reply_lost");
			});
			// Act
			await expect(completeDeviceClaimBinding(db, input(), f.account.config, now)).rejects.toThrow(
				"reply_lost",
			);
			const receipt = await readDeviceClaimBindingReceipt(db, input(), f.account.config);
			const retry = await completeDeviceClaimBinding(db, input(), f.account.config, now + 1);
			// Assert
			expect(receipt).not.toBeNull();
			expect(retry).toEqual({ kind: "complete", receipt });
			expect(writes).toHaveBeenCalledTimes(1);
		});
	});
}
