import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	commitDeviceRebind,
	DEVICE_REBIND_DAILY_LIMIT,
	readDeviceRebindReceipt,
} from "./coordinator-device-rebind-commit.js";
import { COORDINATOR_DEVICE_REBIND_SCHEMA_SQL } from "./coordinator-device-rebind-schema.js";
import {
	COORDINATOR,
	CURRENT,
	GROUPS,
	NOW,
	type RebindFixture,
	rebindFixture,
	TARGET,
} from "./coordinator-device-rebind-test-fixtures.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";

let f: RebindFixture;
afterEach(async () => {
	await f?.close();
});

const identities = () =>
	f.db
		.prepare(
			"SELECT group_id, identity_id FROM enrolled_devices WHERE device_id = 'device-work' ORDER BY group_id",
		)
		.all();

type Backend = "SQLite" | "D1";

function registerCommit(kind: Backend) {
	it("binds the device, moves every enrollment of its key, and records one audit event", async () => {
		// Arrange
		f = await rebindFixture(kind);
		const grants = f.db.prepare("SELECT * FROM coordinator_identity_group_grants").all();
		// Act
		const result = await commitDeviceRebind(f.input());
		// Assert
		expect(result).toMatchObject({
			kind: "committed",
			receipt: {
				deviceId: "device-work",
				previousIdentityId: CURRENT,
				targetIdentityId: TARGET,
				enrollmentCount: GROUPS.length,
				finalizedAtMs: NOW,
			},
		});
		expect(identities()).toEqual(GROUPS.map((group) => ({ group_id: group, identity_id: TARGET })));
		expect(
			f.db
				.prepare(
					"SELECT identity_id, provenance, source_ref FROM coordinator_device_ownership_bindings",
				)
				.all(),
		).toEqual([
			{
				identity_id: TARGET,
				provenance: "owner_enrollment",
				source_ref: "rebind:rebind-attempt-a",
			},
		]);
		expect(
			f.db
				.prepare(
					"SELECT action, previous_identity_id, target_identity_id FROM coordinator_device_rebind_audit_log",
				)
				.all(),
		).toEqual([
			{ action: "owner_device_rebound", previous_identity_id: CURRENT, target_identity_id: TARGET },
		]);
		// Grants (and therefore Team access) never move.
		expect(f.db.prepare("SELECT * FROM coordinator_identity_group_grants").all()).toEqual(grants);
	});
}

function registerRetry(kind: Backend) {
	it("returns the same receipt for an exact retry and writes nothing more", async () => {
		// Arrange
		f = await rebindFixture(kind);
		const input = f.input();
		const first = await commitDeviceRebind(input);
		const after = f.effects();
		// Act
		const retry = await commitDeviceRebind({ ...input, now: NOW + 1000 });
		const status = await readDeviceRebindReceipt(f.backend, COORDINATOR, f.attempt.attempt_id);
		// Assert
		if (first.kind !== "committed") throw new Error("expected a commit");
		expect(retry).toEqual({ kind: "prior_commit", receipt: first.receipt });
		expect(status).toEqual(first.receipt);
		expect(f.effects()).toEqual(after);
	});
}

function registerProofRefusals(kind: Backend) {
	it.each([
		["a forged signature", () => ({ signature: f.sign("wrong message") })],
		[
			"a different completion secret",
			() => ({ completionSecret: Buffer.alloc(32, 8).toString("base64url") }),
		],
		["an expired attempt", () => ({ now: f.attempt.expires_at_ms })],
	])("writes nothing with %s", async (_name, patch) => {
		// Arrange
		f = await rebindFixture(kind);
		const before = f.effects();
		// Act
		const result = await commitDeviceRebind(f.input(patch()));
		// Assert
		expect(result).toEqual({ kind: "refused" });
		expect(f.effects()).toEqual(before);
	});
}

function registerGuardRefusals(kind: Backend) {
	it.each([
		[
			"the current Identity has its own active link",
			`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id,
			 attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
			 VALUES ('${COORDINATOR}', 'link-current', 'https://accounts.example.test', 'subject-current',
			 '${CURRENT}', 'link-attempt-current', '${"a".repeat(64)}', 1, 'device_claim', 'claim-current')`,
		],
		["the target link was revoked", "UPDATE coordinator_auth_account_links SET revoked_at_ms = 1"],
		[
			"the device is already bound",
			`INSERT INTO coordinator_device_ownership_bindings
			 (device_id, key_id, identity_id, coordinator_id, binding_id, provenance, source_ref, bound_at)
			 SELECT device_id, key_id, '${TARGET}', coordinator_id, 'binding-old', 'owner_enrollment', 'old', 'bound'
			 FROM coordinator_device_rebind_attempts`,
		],
		[
			"an enrollment names a third Identity",
			"UPDATE enrolled_devices SET identity_id = 'identity-third' WHERE group_id = 'group-a'",
		],
		[
			"an enrollment appeared after confirmation",
			`INSERT INTO groups (group_id, created_at) VALUES ('group-c', 'created');
			 INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, enabled, created_at)
			 SELECT 'group-c', device_id, public_key, fingerprint, 1, 'created' FROM enrolled_devices LIMIT 1`,
		],
		[
			"an operator attested the device for another Identity",
			`INSERT INTO coordinator_auth_controller_attestations
			 (attestation_id, coordinator_id, identity_id, group_id, device_id, public_key, fingerprint,
			 review_receipt_id, evidence_digest, created_at)
			 SELECT 'att-other', '${COORDINATOR}', 'identity-third', group_id, device_id, public_key, fingerprint,
			 'receipt-other', '${"f".repeat(64)}', 'created' FROM enrolled_devices LIMIT 1`,
		],
		[
			"the target already reached its daily limit",
			Array.from(
				{ length: DEVICE_REBIND_DAILY_LIMIT },
				(_, index) => `INSERT INTO coordinator_device_rebind_audit_log
				 (coordinator_id, event_id, attempt_id, action, binding_id, device_id, previous_identity_id,
				 target_identity_id, enrollment_count, created_at_ms)
				 VALUES ('${COORDINATOR}', 'event-${index}', 'attempt-${index}', 'owner_device_rebound',
				 'binding-${index}', 'device-${index}', 'old-${index}', '${TARGET}', 1, ${NOW - 1000})`,
			).join(";"),
		],
	])("refuses and writes nothing when %s", async (_name, sql) => {
		// Arrange
		f = await rebindFixture(kind);
		f.db.exec(sql);
		const before = f.effects();
		// Act
		const result = await commitDeviceRebind(f.input());
		// Assert
		expect(result).toEqual({ kind: "refused" });
		expect(f.effects()).toEqual(before);
		expect(await readDeviceRebindReceipt(f.backend, COORDINATOR, f.attempt.attempt_id)).toBeNull();
	});
}

function registerUnlinkedCurrent(kind: Backend) {
	it("allows a current Identity whose own link was unlinked", async () => {
		// Arrange: the person unlinked that account first, as the ADR requires.
		f = await rebindFixture(kind);
		f.db.exec(`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject,
		 identity_id, attempt_id, auth_config_revision, created_at_ms, revoked_at_ms, authority_kind, device_claim_id)
		 VALUES ('${COORDINATOR}', 'link-current', 'https://accounts.example.test', 'subject-current',
		 '${CURRENT}', 'link-attempt-current', '${"a".repeat(64)}', 1, 2, 'device_claim', 'claim-current')`);
		// Act
		const result = await commitDeviceRebind(f.input());
		// Assert
		expect(result.kind).toBe("committed");
	});
}

function registerAtomicity(kind: Backend) {
	it("leaves everything unchanged when a later statement in the commit fails", async () => {
		// Arrange: the audit insert fails after the binding and enrollments were written.
		f = await rebindFixture(kind);
		f.db.exec(`CREATE TRIGGER fail_rebind_audit BEFORE INSERT ON coordinator_device_rebind_audit_log
		 BEGIN SELECT RAISE(ABORT, 'injected_failure'); END`);
		const before = f.effects();
		// Act
		const pending = commitDeviceRebind(f.input());
		// Assert: the error surfaces (unknown outcome is not a refusal) and nothing persisted.
		await expect(pending).rejects.toThrow();
		expect(f.effects()).toEqual(before);
		expect(await readDeviceRebindReceipt(f.backend, COORDINATOR, f.attempt.attempt_id)).toBeNull();
	});
}

/** The device key in another text form: same canonical key, different public_key and fingerprint. */
const alias = (publicKey: string) => `${publicKey} other-comment`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function registerKeyAliasRefusals(kind: Backend) {
	it.each([
		["the same key text is enrolled on another device", (key: string) => [key, "device-other"]],
		[
			"another text form of the key is enrolled on another device",
			(key: string) => [alias(key), "device-other"],
		],
		[
			"another text form of the key is enrolled on this device",
			(key: string) => [alias(key), "device-work"],
		],
	] as const)("refuses and writes nothing when %s", async (_name, row) => {
		// Arrange
		f = await rebindFixture(kind);
		const [publicKey, deviceId] = row(f.attempt.public_key);
		f.db.exec("INSERT INTO groups (group_id, created_at) VALUES ('group-c', 'created')");
		f.db
			.prepare(
				`INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, identity_id, enabled, created_at)
				 VALUES ('group-c', ?, ?, ?, 'identity-third', 1, 'created')`,
			)
			.run(deviceId, publicKey, sha(publicKey));
		const before = f.effects();
		// Act
		const result = await commitDeviceRebind(f.input());
		// Assert
		expect(result).toEqual({ kind: "refused" });
		expect(f.effects()).toEqual(before);
	});

	it("refuses when another text form of the key is attested for a third Identity", async () => {
		// Arrange
		f = await rebindFixture(kind);
		const publicKey = alias(f.attempt.public_key);
		f.db
			.prepare(
				`INSERT INTO coordinator_auth_controller_attestations
				 (attestation_id, coordinator_id, identity_id, group_id, device_id, public_key, fingerprint,
				 review_receipt_id, evidence_digest, created_at)
				 VALUES ('att-alias', ?, 'identity-third', 'group-a', 'device-other', ?, ?, 'receipt-alias', ?, 'created')`,
			)
			.run(COORDINATOR, publicKey, sha(publicKey), "f".repeat(64));
		const before = f.effects();
		// Act
		const result = await commitDeviceRebind(f.input());
		// Assert
		expect(result).toEqual({ kind: "refused" });
		expect(f.effects()).toEqual(before);
	});
}

function registerGuardEdges(kind: Backend) {
	it.each([
		["the device is revoked", "device_id", (a: RebindFixture["attempt"]) => a.device_id],
		["the key is revoked", "ed25519_key", (a: RebindFixture["attempt"]) => a.key_id],
	] as const)("refuses when %s", async (_name, subjectKind, subject) => {
		// Arrange
		f = await rebindFixture(kind);
		f.db
			.prepare(
				`INSERT INTO coordinator_device_revocations (subject_kind, subject_value, revocation_id,
				 evidence_group_id, evidence_device_id, evidence_public_key, evidence_fingerprint, created_at)
				 VALUES (?, ?, 'revocation-a', 'group-a', ?, ?, ?, 'created')`,
			)
			.run(
				subjectKind,
				subject(f.attempt),
				f.attempt.device_id,
				f.attempt.public_key,
				f.attempt.fingerprint,
			);
		const before = f.effects();
		// Act
		const result = await commitDeviceRebind(f.input());
		// Assert
		expect(result).toEqual({ kind: "refused" });
		expect(f.effects()).toEqual(before);
	});

	it.each([
		[
			"the link's issuer changed",
			"UPDATE coordinator_auth_account_links SET issuer = 'https://other.example.test'",
		],
		[
			"the link's subject changed",
			"UPDATE coordinator_auth_account_links SET subject = 'subject-other'",
		],
		[
			"an enrollment's fingerprint changed",
			"UPDATE enrolled_devices SET fingerprint = '0000000000000000000000000000000000000000000000000000000000000000' WHERE group_id = 'group-a'",
		],
	])("refuses when %s", async (_name, sql) => {
		// Arrange
		f = await rebindFixture(kind);
		f.db.exec(sql);
		const before = f.effects();
		// Act
		const result = await commitDeviceRebind(f.input());
		// Assert
		expect(result).toEqual({ kind: "refused" });
		expect(f.effects()).toEqual(before);
	});

	it("moves an enrollment that already names the target", async () => {
		// Arrange: a partly migrated device already lists the target in one group.
		f = await rebindFixture(kind);
		f.db
			.prepare("UPDATE enrolled_devices SET identity_id = ? WHERE group_id = 'group-a'")
			.run(TARGET);
		// Act
		const result = await commitDeviceRebind(f.input());
		// Assert
		expect(result.kind).toBe("committed");
		expect(identities()).toEqual(GROUPS.map((group) => ({ group_id: group, identity_id: TARGET })));
	});
}

function registerDurableReceipt(kind: Backend) {
	it("keeps the receipt after an admin later changes the device's enrollments", async () => {
		// Arrange
		f = await rebindFixture(kind);
		const committed = await commitDeviceRebind(f.input());
		if (committed.kind !== "committed") throw new Error("expected a commit");
		// Act: an admin removes the device from one group after the commit.
		f.db.exec("DELETE FROM enrolled_devices WHERE group_id = 'group-a'");
		const status = await readDeviceRebindReceipt(f.backend, COORDINATOR, f.attempt.attempt_id);
		const retry = await commitDeviceRebind(f.input());
		// Assert
		expect(status).toEqual(committed.receipt);
		expect(retry).toEqual({ kind: "prior_commit", receipt: committed.receipt });
	});

	it("rejects replacing a finalized attempt or an audit event", async () => {
		// Arrange
		f = await rebindFixture(kind);
		await commitDeviceRebind(f.input());
		// Act / Assert
		expect(() =>
			f.db.exec(
				"INSERT OR REPLACE INTO coordinator_device_rebind_attempts SELECT * FROM coordinator_device_rebind_attempts",
			),
		).toThrow(/device_rebind_attempt_collision/);
		expect(() =>
			f.db.exec(
				"INSERT OR REPLACE INTO coordinator_device_rebind_audit_log SELECT * FROM coordinator_device_rebind_audit_log",
			),
		).toThrow(/device_rebind_audit_collision/);
	});
}

describe.each(["SQLite", "D1"] as const)("%s device rebind commit", (kind) => {
	registerCommit(kind);
	registerRetry(kind);
	registerProofRefusals(kind);
	registerGuardRefusals(kind);
	registerUnlinkedCurrent(kind);
	registerAtomicity(kind);
	registerKeyAliasRefusals(kind);
	registerGuardEdges(kind);
	registerDurableReceipt(kind);
});

describe("device rebind schema", () => {
	it("matches the D1 migration and the Worker schema", () => {
		const worker = join(import.meta.dirname, "../../cloudflare-coordinator-worker");
		const migration = readFileSync(join(worker, "migrations/0038_add_device_rebind.sql"), "utf8");
		const schema = readFileSync(join(worker, "schema.sql"), "utf8");
		const sql = COORDINATOR_DEVICE_REBIND_SCHEMA_SQL.trim();
		expect(migration).toContain(sql);
		expect(schema).toContain(sql);
	});
});

describe("D1 device rebind commit with legacy owner reviews", () => {
	it("refuses when a legacy owner review named another Identity for the device", async () => {
		// Arrange: only coordinators with migration 0037 keep these reviews.
		f = await rebindFixture("D1");
		f.db.pragma("ignore_check_constraints = ON");
		f.db
			.prepare(
				`INSERT INTO coordinator_legacy_owner_resolutions (coordinator_id, resolution_id, resolution_version,
				 device_id, key_id, owner_identity_id, purpose, scope, source_attestation_id, source_group_id,
				 source_controller_revision, source_public_key, source_fingerprint, source_created_at,
				 source_review_receipt_id, source_evidence_digest, resolution_evidence_digest,
				 reviewed_weak_labels_json, created_at)
				 VALUES (?, 'resolution-a', 1, 'device-work', ?, 'identity-third', 'existing_account_owner',
				 'historical_included_owner_labels_only', 'att', 'group-a', 1, 'key', 'fp', 'created', 'receipt',
				 'digest', 'digest', '[]', 'created')`,
			)
			.run(COORDINATOR, f.attempt.key_id);
		f.db.pragma("ignore_check_constraints = OFF");
		const before = f.effects();
		// Act
		const result = await commitDeviceRebind(f.input());
		// Assert
		expect(result).toEqual({ kind: "refused" });
		expect(f.effects()).toEqual(before);
	});
});

describe("SQLite device rebind commit pins the scanned attestations", () => {
	it("refuses when an attestation is swapped between the scan and the commit", async () => {
		// Arrange: an unrelated attestation exists when the commit scans.
		f = await rebindFixture("SQLite");
		const insertAttestation = f.db.prepare(
			`INSERT INTO coordinator_auth_controller_attestations
			 (attestation_id, coordinator_id, identity_id, group_id, device_id, public_key, fingerprint,
			 review_receipt_id, evidence_digest, created_at)
			 VALUES (?, ?, ?, 'group-a', ?, ?, ?, ?, ?, 'created')`,
		);
		const unrelated =
			"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";
		insertAttestation.run(
			"att-unrelated",
			COORDINATOR,
			"identity-other",
			"device-other",
			unrelated,
			sha(unrelated),
			"receipt-1",
			"f".repeat(64),
		);
		// Before the batch, one revocation and one alias attestation keep the count equal.
		const swap = () => {
			f.db.exec(
				"UPDATE coordinator_auth_controller_attestations SET revoked_at = 'revoked' WHERE attestation_id = 'att-unrelated'",
			);
			const publicKey = alias(f.attempt.public_key);
			insertAttestation.run(
				"att-alias",
				COORDINATOR,
				"identity-third",
				"device-alias",
				publicKey,
				sha(publicKey),
				"receipt-2",
				"f".repeat(64),
			);
		};
		const backend = nativeBackend(f.db, swap);
		// Act
		const result = await commitDeviceRebind({ ...f.input(), backend });
		// Assert
		expect(result).toEqual({ kind: "refused" });
		expect(
			f.db.prepare("SELECT count(*) AS n FROM coordinator_device_ownership_bindings").get(),
		).toEqual({ n: 0 });
	});
});

describe("SQLite device rebind commit pins attestation contents", () => {
	it("refuses when an attestation is edited into a key alias between the scan and the commit", async () => {
		// Arrange: an unrelated attestation exists when the commit scans.
		f = await rebindFixture("SQLite");
		const unrelated =
			"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";
		f.db
			.prepare(
				`INSERT INTO coordinator_auth_controller_attestations
				 (attestation_id, coordinator_id, identity_id, group_id, device_id, public_key, fingerprint,
				 review_receipt_id, evidence_digest, created_at)
				 VALUES ('att-unrelated', ?, 'identity-other', 'group-a', 'device-other', ?, ?, 'receipt-1', ?, 'created')`,
			)
			.run(COORDINATOR, unrelated, sha(unrelated), "f".repeat(64));
		// Before the batch, the same row is rewritten to attest the device key for a third Identity.
		const edit = () => {
			const publicKey = alias(f.attempt.public_key);
			f.db
				.prepare(
					"UPDATE coordinator_auth_controller_attestations SET public_key = ?, fingerprint = ?, identity_id = 'identity-third' WHERE attestation_id = 'att-unrelated'",
				)
				.run(publicKey, sha(publicKey));
		};
		// Act
		const result = await commitDeviceRebind({ ...f.input(), backend: nativeBackend(f.db, edit) });
		// Assert
		expect(result).toEqual({ kind: "refused" });
		expect(
			f.db.prepare("SELECT count(*) AS n FROM coordinator_device_ownership_bindings").get(),
		).toEqual({ n: 0 });
	});
});

describe("SQLite device rebind records survive rowid replacement", () => {
	it.each([
		[
			"a finalized attempt",
			"coordinator_device_rebind_attempts",
			/device_rebind_attempt_collision/,
			`INSERT OR REPLACE INTO coordinator_device_rebind_attempts
			 (rowid, coordinator_id, attempt_id, origin, device_id, public_key, key_id, fingerprint,
			 current_identity_id, issuer, auth_config_revision, browser_start_hash, state, created_at_ms, expires_at_ms)
			 SELECT rowid, coordinator_id, 'fresh-attempt', origin, device_id, public_key, key_id, fingerprint,
			 current_identity_id, issuer, auth_config_revision, 'fresh-start', 'pending', created_at_ms, expires_at_ms
			 FROM coordinator_device_rebind_attempts`,
		],
		[
			"an audit event",
			"coordinator_device_rebind_audit_log",
			/device_rebind_audit_collision/,
			`INSERT OR REPLACE INTO coordinator_device_rebind_audit_log
			 (rowid, coordinator_id, event_id, attempt_id, action, binding_id, device_id, previous_identity_id,
			 target_identity_id, enrollment_count, created_at_ms)
			 SELECT rowid, coordinator_id, 'fresh-event', 'fresh-attempt', action, binding_id, device_id,
			 previous_identity_id, target_identity_id, enrollment_count, created_at_ms
			 FROM coordinator_device_rebind_audit_log`,
		],
	])("rejects replacing %s through its rowid with fresh keys", async (_name, table, error, sql) => {
		// Arrange
		f = await rebindFixture("SQLite");
		await commitDeviceRebind(f.input());
		const before = f.db.prepare(`SELECT * FROM ${table}`).all();
		// Act / Assert
		expect(() => f.db.exec(sql)).toThrow(error);
		expect(f.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
	});

	it("rejects a nonpositive explicit rowid that an automatic rowid could match", async () => {
		f = await rebindFixture("SQLite");
		expect(() =>
			f.db.exec(`INSERT INTO coordinator_device_rebind_audit_log (rowid, coordinator_id, event_id, attempt_id,
			 action, binding_id, device_id, previous_identity_id, target_identity_id, enrollment_count, created_at_ms)
			 VALUES (-1, 'c', 'e', 'a', 'owner_device_rebound', 'b', 'd', 'p', 't', 1, 1)`),
		).toThrow(/device_rebind_audit_rowid/);
	});
});
