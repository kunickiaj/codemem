import { expect, it, vi } from "vitest";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	commitOwnerEnrollment,
	type OwnerAttempt,
	readOwnerEnrollmentReceipt,
	verifyOwnerEnrollmentSignature,
} from "./coordinator-owner-enrollment-commit.js";
import {
	type CommitWriterFixture,
	commitFixtureEnrollment,
	commitPendingKey,
	commitProofMessage,
	commitWriterFixture,
} from "./coordinator-owner-enrollment-commit-test-fixtures.js";

const test = it.extend<{ writer: CommitWriterFixture }>({
	writer: async ({ task: _task }, use) => {
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		const f = await commitWriterFixture();
		try {
			await use(f);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			f.db.close();
		}
	},
});

test("private confirmed writer commits ownership, every pinned group, audit and exact retained receipt", async ({
	writer: f,
}) => {
	// Arrange: two eligible pinned groups exercise the real dependent SQL changes() count.
	const input = f.input();
	// Act
	const committed = await commitOwnerEnrollment(input);
	const receipt = f.finalRow();
	// Assert: a private writer receipt is not an SDK/browser verification claim.
	expect(committed).toBe(true);
	expect(f.rows("coordinator_device_ownership_bindings")).toEqual([
		expect.objectContaining({
			device_id: f.row.device_id,
			key_id: f.row.key_id,
			identity_id: f.row.identity_id,
			binding_id: receipt.binding_id,
			source_ref: f.row.attempt_id,
			provenance: "owner_enrollment",
		}),
	]);
	expect(f.rows("enrolled_devices")).toEqual(
		["group-a", "group-b"].map((group_id) =>
			expect.objectContaining({
				group_id,
				device_id: f.row.device_id,
				public_key: f.key.publicKey,
				enabled: 1,
			}),
		),
	);
	expect(f.rows("coordinator_owner_enrollment_audit_log")).toEqual([
		expect.objectContaining({
			event_id: receipt.audit_event_id,
			binding_id: receipt.binding_id,
			attempt_id: receipt.attempt_id,
			action: "owner_device_enrolled",
		}),
	]);
	expect(receipt).toMatchObject({
		state: "finalized",
		loopback_redirect: null,
		finalized_at_ms: NOW,
	});
	expect(JSON.parse(receipt.final_outcome_json as string)).toEqual({
		kind: "finalized",
		bindingId: receipt.binding_id,
		groups: ["group-a", "group-b"],
	});
	expect(JSON.stringify(f.effects())).not.toContain(f.secret);
	expect(await readOwnerEnrollmentReceipt(f.backend, receipt)).toBe(true);
});

test.for(["signature", "other-key", "secret", "malformed-secret", "early", "deadline", "revision"])(
	"private final proof denies %s with no durable changes",
	async (fault, { writer: f }) => {
		// Arrange
		const input = f.input(
			{},
			fault === "secret" ? Buffer.alloc(32, 4).toString("base64url") : f.secret,
		);
		if (fault === "signature") input.signature = "not-a-signature";
		if (fault === "other-key")
			input.signature = commitPendingKey().sign(commitProofMessage(f.row, f.secret));
		if (fault === "malformed-secret") input.completionSecret = "bad";
		if (fault === "early") input.now = NOW - 1;
		if (fault === "deadline") input.now = f.row.expires_at_ms;
		if (fault === "revision") input.revision = "9".repeat(64);
		const before = f.effects();
		// Act
		const result = await commitOwnerEnrollment(input);
		// Assert
		expect(result).toBe(false);
		expect(f.effects()).toEqual(before);
	},
);

const pinChanges: Partial<OwnerAttempt>[] = [
	{ origin: "https://other.example.test" },
	{ issuer: "https://other.example.test" },
	{ device_id: "other-device" },
	{ public_key: "same-key-different-comment" },
	{ key_id: "9".repeat(64) },
	{ fingerprint: "9".repeat(64) },
	{ browser_start_hash: "9".repeat(64) },
	{ browser_transaction_hash: "9".repeat(64) },
	{ browser_binder_hash: "9".repeat(64) },
	{ account_subject: "other-account" },
	{ identity_id: "other-identity" },
	{ link_id: "other-link" },
	{ link_attempt_id: "other-attempt" },
	{ link_controller_attestation_id: "other-controller" },
	{ link_auth_config_revision: "9".repeat(64) },
	{ grant_revisions_json: "[]" },
	{ confirmation_hash: "9".repeat(64) },
	{ loopback_redirect: "http://127.0.0.1:9876/complete" },
	{ created_at_ms: NOW - 1 },
	{ expires_at_ms: NOW + 1 },
];
test.for(pinChanges)("private writer rejects stale caller pin %j", async (patch, { writer: f }) => {
	// Arrange: even a fresh real signature on a changed caller row cannot replace stored facts.
	const before = f.effects();
	const caller = { ...patch };
	if (caller.public_key) caller.public_key = `${f.key.publicKey} changed-comment`;
	const input = f.input(caller);
	// Act
	const result = await commitOwnerEnrollment(input);
	// Assert
	expect(result).toBe(false);
	expect(f.effects()).toEqual(before);
});

const authorityChanges = {
	"revoked link": "UPDATE coordinator_auth_account_links SET revoked_at_ms = 1",
	"link issuer tuple":
		"UPDATE coordinator_auth_account_links SET issuer = 'https://other.example.test'",
	"link subject tuple": "UPDATE coordinator_auth_account_links SET subject = 'other-subject'",
	"link identity tuple": "UPDATE coordinator_auth_account_links SET identity_id = 'other-identity'",
	"link attempt provenance": "UPDATE coordinator_auth_account_links SET attempt_id = 'changed'",
	"link controller provenance":
		"UPDATE coordinator_auth_account_links SET controller_attestation_id = 'changed'",
	"link revision provenance": `UPDATE coordinator_auth_account_links SET auth_config_revision = '${"9".repeat(64)}'`,
	"grant revision": "UPDATE coordinator_identity_group_grants SET revision = 2",
	"grant revoked":
		"UPDATE coordinator_identity_group_grants SET status = 'revoked', revoked_at = 'revoked'",
	"archived group": "UPDATE groups SET archived_at = 'archived'",
	"missing link": "DELETE FROM coordinator_auth_account_links",
	"missing grant": "DELETE FROM coordinator_identity_group_grants",
	"nonconfirmed attempt": "UPDATE coordinator_owner_enrollment_attempts SET state = 'expired'",
};
test.for(Object.entries(authorityChanges))(
	"private SQL winner denies changed %s",
	async ([, sql], { writer: f }) => {
		// Arrange
		await f.exec(sql);
		const before = f.effects();
		// Act
		const result = await commitOwnerEnrollment(f.input());
		// Assert
		expect(result).toBe(false);
		expect(f.effects()).toEqual(before);
	},
);

test("private SQL winner denies a device-claim link with otherwise current grants", async ({
	writer: f,
}) => {
	// Arrange: retain the confirmed historical pins, but replace the current link authority.
	await f.exec(`UPDATE coordinator_auth_account_links SET authority_kind='device_claim',
 controller_attestation_id=NULL, device_claim_id='claim-a'`);
	const before = f.effects();
	// Act
	const result = await commitOwnerEnrollment(f.input());
	// Assert: a valid pending-key proof cannot turn a claim into owner enrollment.
	expect(result).toBe(false);
	expect(f.effects()).toEqual(before);
});

test.for(["device_id", "ed25519_key"] as const)(
	"private writer denies durable %s revocation",
	async (kind, { writer: f }) => {
		// Arrange
		await f.exec(
			"INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES (?,?,'revocation-a','group-a',?,?,?,?)",
			kind,
			kind === "device_id" ? f.row.device_id : f.row.key_id,
			f.row.device_id,
			f.row.public_key,
			f.row.fingerprint,
			new Date(NOW).toISOString(),
		);
		const before = f.effects();
		// Act
		const result = await commitOwnerEnrollment(f.input());
		// Assert
		expect(result).toBe(false);
		expect(f.effects()).toEqual(before);
	},
);

test.for([
	"device",
	"key-comment",
	"key-encoding",
	"unrecognized-ed25519",
	"ownership-device",
	"ownership-key",
])("private writer denies %s collision", async (fault, { writer: f }) => {
	// Arrange: SSH comments and permitted base64 spelling changes do not change key bytes.
	if (fault.startsWith("ownership"))
		await f.exec(
			"INSERT INTO coordinator_device_ownership_bindings VALUES (?,?, 'other-identity','coordinator-a','other-binding','reviewed_legacy_migration','receipt',?)",
			fault === "ownership-device" ? f.row.device_id : "other-device",
			fault === "ownership-key" ? f.row.key_id : "9".repeat(64),
			new Date(NOW).toISOString(),
		);
	else {
		let publicKey = commitPendingKey().publicKey;
		if (fault === "key-comment") publicKey = `${f.key.publicKey} different-comment`;
		if (fault === "key-encoding") {
			const wire = Buffer.from(f.key.publicKey.split(" ")[1] as string, "base64");
			publicKey = `ssh-ed25519 ${Buffer.concat([wire, Buffer.from([0])]).toString("base64")}`;
		}
		if (fault === "unrecognized-ed25519") publicKey = "ssh-ed25519 not-a-valid-key";
		await commitFixtureEnrollment(
			f,
			publicKey,
			fault === "device" ? f.row.device_id : "other-device",
		);
	}
	const before = f.effects();
	// Act
	const result = await commitOwnerEnrollment(f.input());
	// Assert
	expect(result).toBe(false);
	expect(f.effects()).toEqual(before);
});

test.for(["pending-device", "pending-fingerprint", "unresolved", "resolved"])(
	"private legacy exclusion %s uses persisted decisions",
	async (fault, { writer: f }) => {
		// Arrange: a resolved unrelated exclusion is the positive control.
		if (["resolved", "pending-fingerprint"].includes(fault))
			await commitFixtureEnrollment(f, commitPendingKey().publicKey);
		if (fault === "pending-fingerprint") {
			// The unrelated key avoids canonical collision; matching legacy metadata resolves the exclusion.
			// Only its fingerprint match against the pending device must now deny this writer.
			await f.exec(
				"UPDATE enrolled_devices SET fingerprint = ? WHERE device_id = 'other-device'",
				f.row.fingerprint,
			);
		}
		await f.exec(
			"INSERT INTO coordinator_legacy_team_completions VALUES ('group-a','candidate-a',1,?,?,?)",
			JSON.stringify({
				coordinator_id: f.row.coordinator_id,
				device_decisions: [
					{
						decision: "excluded",
						device_id: fault === "pending-device" ? f.row.device_id : "other-device",
						key_fingerprint: ["pending-device", "pending-fingerprint"].includes(fault)
							? f.row.fingerprint
							: "7".repeat(64),
					},
				],
			}),
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
		);
		const before = f.effects();
		// Act
		const result = await commitOwnerEnrollment(f.input());
		// Assert
		expect(result).toBe(fault === "resolved");
		if (fault !== "resolved") expect(f.effects()).toEqual(before);
	},
);

test.for(["inactive", "removed"])(
	"private writer accepts active link with historical controller %s",
	async (state, { writer: f }) => {
		// Arrange: historical provenance remains pinned but is not live controller permission.
		await commitFixtureEnrollment(f, commitPendingKey().publicKey, "historical-device");
		await f.exec(
			"INSERT INTO coordinator_auth_controller_attestations (attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,review_receipt_id,evidence_digest,created_at,revoked_at) SELECT ?,'coordinator-a','identity-a',group_id,device_id,public_key,fingerprint,'historical-receipt',?,?,? FROM enrolled_devices",
			f.row.link_controller_attestation_id,
			"b".repeat(64),
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
		);
		await f.exec("UPDATE enrolled_devices SET enabled = 0");
		if (state === "removed") {
			await f.exec("DELETE FROM coordinator_auth_controller_attestations");
			await f.exec("DELETE FROM enrolled_devices");
		}
		// Act
		const result = await commitOwnerEnrollment(f.input());
		// Assert
		expect(result).toBe(true);
	},
);

test("private atomic update rejects unrelated enrollment scan drift at batch boundary", async ({
	writer: f,
}) => {
	// Arrange: change persisted keys after preflight, before the actual SQL write.
	const original = f.backend.batch;
	let before: ReturnType<typeof f.effects> = [];
	f.backend.batch = async (statements) => {
		await commitFixtureEnrollment(f, commitPendingKey().publicKey);
		before = f.effects();
		await original(statements);
	};
	// Act
	const result = await commitOwnerEnrollment(f.input());
	// Assert: preserves concurrent unrelated state without adding ownership or receipt.
	expect(result).toBe(false);
	expect(f.effects()).toEqual(before);
});

test.for(["binding", "enrollment", "audit"])(
	"private native batch rolls back silent zero-row %s write",
	async (stage, { writer: f }) => {
		// Arrange: SQL RAISE(IGNORE) reaches the writer's own changes() abort assertion.
		const table = {
			binding: "coordinator_device_ownership_bindings",
			enrollment: "enrolled_devices",
			audit: "coordinator_owner_enrollment_audit_log",
		}[stage];
		f.db.exec(
			`CREATE TRIGGER commit_test_skip BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
		);
		const before = f.effects();
		// Act
		const result = commitOwnerEnrollment(f.input());
		// Assert: real transaction rollback retains original confirmed pins and every effect table.
		await expect(result).rejects.toThrow();
		expect(f.effects()).toEqual(before);
	},
);

test.for([0, 1, 3, 5])(
	"private native batch rolls back SQL failure after statement %i",
	async (index, { writer: f }) => {
		// Arrange
		const original = f.backend.batch;
		f.backend.batch = async (statements) => {
			const broken = [...statements];
			broken.splice(index + 1, 0, {
				sql: "INSERT INTO nonexistent_commit_test_table VALUES (1)",
				values: [],
			});
			await original(broken);
		};
		const before = f.effects();
		// Act
		const result = commitOwnerEnrollment(f.input());
		// Assert: untrusted SQL errors propagate, never become success labels.
		await expect(result).rejects.toThrow(/nonexistent_commit_test_table/);
		expect(f.effects()).toEqual(before);
	},
);

test("private writer rejects unavailable atomic batch without fallback writes", async ({
	writer: f,
}) => {
	// Arrange: exercise a runtime-invalid backend without widening the production type.
	Object.defineProperty(f.backend, "batch", { value: undefined });
	const before = f.effects();
	// Act
	const result = commitOwnerEnrollment(f.input());
	// Assert
	await expect(result).rejects.toThrow();
	expect(f.effects()).toEqual(before);
});

test.for(["unchanged", "disabled", "removed", "cleaned"])(
	"private receipt read after %s never restores authority",
	async (cleanup, { writer: f }) => {
		// Arrange
		expect(await commitOwnerEnrollment(f.input())).toBe(true);
		const receipt = f.finalRow();
		if (cleanup === "disabled") await f.exec("UPDATE enrolled_devices SET enabled = 0");
		if (["removed", "cleaned"].includes(cleanup)) await f.exec("DELETE FROM enrolled_devices");
		if (cleanup === "cleaned") {
			await f.exec("DELETE FROM coordinator_owner_enrollment_audit_log");
			await f.exec("DELETE FROM coordinator_identity_group_grants");
		}
		const before = f.effects();
		// Act
		const read = await readOwnerEnrollmentReceipt(f.backend, receipt);
		const duplicate = await commitOwnerEnrollment(f.input());
		// Assert: retained evidence proves a past commit, not current device permission.
		expect(read).toBe(true);
		expect(duplicate).toBe(false);
		expect(f.effects()).toEqual(before);
	},
);

test.for(["binding", "audit", "enrollment"])(
	"private receipt denies mismatched %s evidence without repair",
	async (fault, { writer: f }) => {
		// Arrange: deliberately corrupt binding only in this disposable test database.
		expect(await commitOwnerEnrollment(f.input())).toBe(true);
		const receipt = f.finalRow();
		if (fault === "binding") {
			f.db.exec("DROP TRIGGER coordinator_device_ownership_immutable_update");
			await f.exec("UPDATE coordinator_device_ownership_bindings SET source_ref = 'replacement'");
		}
		if (fault === "audit")
			await f.exec("UPDATE coordinator_owner_enrollment_audit_log SET device_id = 'replacement'");
		if (fault === "enrollment")
			await f.exec("UPDATE enrolled_devices SET public_key = ?", commitPendingKey().publicKey);
		const before = f.effects();
		// Act
		const read = await readOwnerEnrollmentReceipt(f.backend, receipt);
		// Assert
		expect(read).toBe(false);
		expect(f.effects()).toEqual(before);
	},
);

test.for(["account_subject", "link_id"])(
	"private receipt rejects corrupted stored %s even when its binding still matches",
	async (field, { writer: f }) => {
		expect(await commitOwnerEnrollment(f.input())).toBe(true);
		// A finalized receipt is normally immutable; simulate storage corruption in this fixture only.
		f.db.exec("DROP TRIGGER owner_enrollment_finalized_update");
		await f.exec(`UPDATE coordinator_owner_enrollment_attempts SET ${field} = 'changed'`);
		const receipt = f.finalRow();
		const before = f.effects();
		expect(await readOwnerEnrollmentReceipt(f.backend, receipt)).toBe(false);
		expect(f.effects()).toEqual(before);
	},
);

test.for(["http://127.0.0.1:4567/complete", "http://127.0.0.1:9876/complete"])(
	"private receipt rejects caller-supplied loopback destination %s",
	async (redirect, { writer: f }) => {
		expect(await commitOwnerEnrollment(f.input())).toBe(true);
		const receipt = f.finalRow();
		const before = f.effects();
		expect(receipt.loopback_redirect).toBeNull();
		expect(await readOwnerEnrollmentReceipt(f.backend, receipt)).toBe(true);
		expect(
			await readOwnerEnrollmentReceipt(f.backend, { ...receipt, loopback_redirect: redirect }),
		).toBe(false);
		expect(f.effects()).toEqual(before);
	},
);

test.for([
	"unchanged",
	"purpose",
	"origin",
	"issuer",
	"auth_config_revision",
	"account_subject",
	"link_id",
	"link_attempt_id",
	"link_controller_attestation_id",
	"link_auth_config_revision",
	"browser_start_hash",
	"browser_transaction_hash",
	"browser_binder_hash",
	"confirmation_hash",
	"completion_secret_hash",
	"final_key_proof_hash",
	"attempt-time",
])("private receipt pins retained attempt %s without writes", async (field, { writer: f }) => {
	// Arrange: forge only the caller DTO after a real commit, not the stored receipt.
	expect(await commitOwnerEnrollment(f.input())).toBe(true);
	const receipt = f.finalRow();
	if (field === "purpose") receipt.purpose = "signin" as OwnerAttempt["purpose"];
	else if (field === "attempt-time") {
		receipt.created_at_ms -= 1;
		receipt.expires_at_ms -= 1; // Preserve the valid ten-minute lifetime.
	} else if (field !== "unchanged") {
		Object.assign(receipt, {
			[field]:
				field.endsWith("hash") || field.endsWith("revision")
					? "9".repeat(64)
					: `${receipt[field as keyof OwnerAttempt]}-forged`,
		});
	}
	const before = f.effects();
	const batch = vi.spyOn(f.backend, "batch");
	const run = vi.spyOn(f.backend, "run");
	// Act
	const read = await readOwnerEnrollmentReceipt(f.backend, receipt);
	// Assert: only the exact retained attempt can attest to this past commit.
	expect(read).toBe(field === "unchanged");
	expect(f.effects()).toEqual(before);
	expect(batch).not.toHaveBeenCalled();
	expect(run).not.toHaveBeenCalled();
});

test("private receipt refuses a nonfinalized attempt", async ({ writer: f }) => {
	// Arrange
	const before = f.effects();
	// Act
	const read = await readOwnerEnrollmentReceipt(f.backend, f.row);
	// Assert
	expect(read).toBe(false);
	expect(f.effects()).toEqual(before);
});

test.for(["valid", "wrong-key", "wrong-message", "malformed-key", "malformed-signature"])(
	"private Ed25519 verifier checks actual bytes for %s",
	async (fault, { writer: f }) => {
		// Arrange
		const message = "private-writer-key-proof";
		const key = fault === "wrong-key" ? commitPendingKey().publicKey : f.key.publicKey;
		// Act
		const valid = await verifyOwnerEnrollmentSignature(
			fault === "malformed-key" ? "ssh-ed25519 invalid" : key,
			fault === "wrong-message" ? "changed" : message,
			fault === "malformed-signature" ? "invalid" : f.key.sign(message),
		);
		// Assert
		expect(valid).toBe(fault === "valid");
	},
);
