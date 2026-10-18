import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { AuthLinkBackend, AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { ed25519KeyIdForRevocation } from "../../core/src/coordinator-ed25519-key-id-compat.js";
import { UNRELATED_PUBLIC_KEY } from "../../core/src/coordinator-enrollment-revocation-test-harness.js";
import {
	COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL,
	commitOwnerEnrollment,
	type OwnerAttempt,
	readOwnerEnrollmentReceipt,
} from "../../core/src/coordinator-owner-enrollment-commit.js";
import {
	ownerEnrollmentConfirmationHash,
	ownerEnrollmentFinalMessage,
} from "../../core/src/coordinator-owner-enrollment-proof.js";
import {
	finalizedOwner,
	pendingOwner,
} from "../../core/src/coordinator-owner-enrollment-test-harness.js";
import { NOW, resetCeremony, seedNativeOwnerAuthority } from "./owner-ceremony-test-fixtures.js";

const tables = [
	"coordinator_owner_enrollment_attempts",
	"coordinator_device_ownership_bindings",
	"enrolled_devices",
	"coordinator_owner_enrollment_audit_log",
];
const prepare = (s: AuthLinkStatement) => env.COORDINATOR_DB.prepare(s.sql).bind(...s.values);
const backend: AuthLinkBackend = {
	first: <T>(s: AuthLinkStatement) => prepare(s).first<T>(),
	run: async (s) => (await prepare(s).run()).meta.changes,
	batch: async (statements) => {
		await env.COORDINATOR_DB.batch(statements.map(prepare));
	},
};
const exec = (sql: string, ...values: AuthLinkStatement["values"]) => backend.run({ sql, values });
const rows = async (table: string) =>
	(await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
const effects = () => Promise.all(tables.map(rows));
async function finalRow() {
	const row = await env.COORDINATOR_DB.prepare(
		"SELECT * FROM coordinator_owner_enrollment_attempts",
	).first<OwnerAttempt>();
	if (!row) throw new Error("Missing native attempt");
	return row;
}

async function resetFixture() {
	await exec("DROP TRIGGER IF EXISTS commit_test_skip");
	await resetCeremony();
}

async function writerFixture() {
	// Self-contained fixture: no better-sqlite3 runtime or provider enters the worker.
	await exec(COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL);
	const keys = (await crypto.subtle.generateKey("Ed25519", true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const raw = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey));
	const wire = Buffer.alloc(51);
	wire.writeUInt32BE(11, 0);
	wire.write("ssh-ed25519", 4);
	wire.writeUInt32BE(32, 15);
	raw.copy(wire, 19);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const secret = Buffer.alloc(32, 9).toString("base64url");
	const row: OwnerAttempt = {
		...finalizedOwner,
		purpose: "owner_enroll",
		public_key: publicKey,
		key_id: (await ed25519KeyIdForRevocation(publicKey)) as string,
		fingerprint: createHash("sha256").update(publicKey).digest("hex"),
		grant_revisions_json: '[{"groupId":"group-a","revision":1},{"groupId":"group-b","revision":1}]',
		completion_secret_hash: createHash("sha256").update(Buffer.alloc(32, 9)).digest("hex"),
		state: "confirmed",
		loopback_redirect: pendingOwner.loopback_redirect,
		final_key_proof_hash: null,
		finalized_at_ms: null,
		binding_id: null,
		audit_event_id: null,
		final_outcome_json: null,
	};
	row.confirmation_hash = await ownerEnrollmentConfirmationHash(row);
	const birth = Object.entries({
		...pendingOwner,
		public_key: publicKey,
		key_id: row.key_id,
		fingerprint: row.fingerprint,
	});
	await exec(
		`INSERT INTO coordinator_owner_enrollment_attempts (${birth.map(([k]) => k).join(",")}) VALUES (${birth.map(() => "?").join(",")})`,
		...birth.map(([, v]) => v),
	);
	// Storage transitions only; these claims do not simulate browser/OIDC verification.
	for (const [state, names] of [
		["browser_claimed", "browser_transaction_hash browser_binder_hash"],
		[
			"oidc_verified",
			"account_subject identity_id link_id link_attempt_id link_controller_attestation_id link_auth_config_revision grant_revisions_json",
		],
		["confirmed", "confirmation_hash completion_secret_hash"],
	]) {
		const fields = (names as string).split(" ") as (keyof OwnerAttempt)[];
		await exec(
			`UPDATE coordinator_owner_enrollment_attempts SET state = ?, ${fields.map((k) => `${k} = ?`).join(",")}`,
			state as string,
			...fields.map((k) => row[k]),
		);
	}
	if (!row.link_id || !row.identity_id || !row.account_subject || !row.link_attempt_id ||
		!row.link_controller_attestation_id || !row.link_auth_config_revision)
		throw new Error("Missing native owner authority pins");
	await seedNativeOwnerAuthority({
		coordinatorId: row.coordinator_id, issuer: row.issuer, revision: row.link_auth_config_revision,
		linkId: row.link_id, subject: row.account_subject, identityId: row.identity_id,
		attemptId: row.link_attempt_id, controllerAttestationId: row.link_controller_attestation_id,
		controllerReviewReceiptId: "historical-receipt", redirectUri: "https://coordinator.example.test/auth/callback",
		groupId: "historical-group", deviceId: "historical-controller-device",
		publicKey: "fixture-historical-controller-key", fingerprint: createHash("sha256").update("fixture-historical-controller-key").digest("hex"),
		createdAtMs: row.created_at_ms,
	});
	for (const group of ["group-a", "group-b"]) {
		await exec(
			"INSERT INTO groups (group_id,created_at) VALUES (?,?)",
			group,
			new Date(NOW).toISOString(),
		);
		await exec(
			"INSERT INTO coordinator_identity_group_grants (coordinator_id,identity_id,group_id,status,revision,source_kind,source_receipt_id,created_at) SELECT coordinator_id,identity_id,?,'active',1,'controller_attestation','historical-receipt',? FROM coordinator_owner_enrollment_attempts",
			group,
			new Date(NOW).toISOString(),
		);
	}
	const signature = Buffer.from(
		await crypto.subtle.sign(
			"Ed25519",
			keys.privateKey,
			new TextEncoder().encode(ownerEnrollmentFinalMessage(row, secret)),
		),
	).toString("base64url");
	return {
		row,
		secret,
		input: {
			backend: { ...backend },
			row,
			revision: row.auth_config_revision,
			now: NOW,
			completionSecret: secret,
			signature,
		},
	};
}
const test = it.extend<{ writer: Awaited<ReturnType<typeof writerFixture>> }>({
	writer: async ({ task: _task }, use) => {
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await resetFixture();
			await use(await writerFixture());
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await resetFixture();
		}
	},
});

test("native D1 commits all pinned groups, binding, audit and receipt atomically", async ({
	writer: f,
}) => {
	// Arrange
	const input = f.input;
	const genesis = await rows("coordinator_auth_link_attempts");
	const browsers = await rows("coordinator_auth_browser_transactions");
	const births = await rows("coordinator_auth_link_audit_log");
	// Act
	const committed = await commitOwnerEnrollment(input);
	const receipt = await finalRow();
	// Assert: actual D1 changes() counts drive the dependent writes.
	expect(committed).toBe(true);
	expect(genesis).toEqual([expect.objectContaining({
		attempt_id: f.row.link_attempt_id, state: "finalized", link_id: f.row.link_id,
		account_subject: f.row.account_subject, controller_attestation_id: f.row.link_controller_attestation_id,
		finalized_at_ms: f.row.created_at_ms,
	})]);
	expect(browsers).toEqual([expect.objectContaining({
		attempt_id: f.row.link_attempt_id, purpose: "link", state: "consumed", nonce: null, pkce_verifier: null,
		browser_transaction_hash: genesis[0]?.browser_transaction_hash,
	})]);
	expect(births).toEqual([expect.objectContaining({
		attempt_id: f.row.link_attempt_id, link_id: f.row.link_id, action: "link_created",
		identity_id: f.row.identity_id, authority_kind: "controller_attestation", created_at_ms: f.row.created_at_ms,
	})]);
	expect(await rows("coordinator_auth_link_audit_log")).toEqual(births);
	expect(receipt).toMatchObject({
		state: "finalized",
		loopback_redirect: null,
		finalized_at_ms: NOW,
	});
	expect(await rows(tables[1] as string)).toEqual([
		expect.objectContaining({
			device_id: f.row.device_id,
			key_id: f.row.key_id,
			identity_id: f.row.identity_id,
			binding_id: receipt.binding_id,
			source_ref: f.row.attempt_id,
			provenance: "owner_enrollment",
		}),
	]);
	expect(await rows("enrolled_devices")).toEqual(
		["group-a", "group-b"].map((group_id) =>
			expect.objectContaining({
				group_id,
				device_id: f.row.device_id,
				public_key: f.row.public_key,
				enabled: 1,
			}),
		),
	);
	expect(await rows("coordinator_owner_enrollment_audit_log")).toEqual([
		expect.objectContaining({
			event_id: receipt.audit_event_id,
			binding_id: receipt.binding_id,
			attempt_id: receipt.attempt_id,
			action: "owner_device_enrolled",
		}),
	]);
	expect(JSON.parse(receipt.final_outcome_json as string)).toEqual({
		kind: "finalized",
		bindingId: receipt.binding_id,
		groups: ["group-a", "group-b"],
	});
	expect(JSON.stringify(await effects())).not.toContain(f.secret);
});

test.for([0, 1, 3, 5])(
	"native D1 rolls back SQL failure after statement %i",
	async (index, { writer: f }) => {
		// Arrange: inject failure into the real D1 batch, not a SQLite adapter.
		f.input.backend.batch = async (statements) => {
			const broken = [...statements];
			broken.splice(index + 1, 0, {
				sql: "INSERT INTO groups (group_id,created_at) VALUES ('group-a','duplicate')",
				values: [],
			});
			await backend.batch(broken);
		};
		const before = await effects();
		// Act
		const result = commitOwnerEnrollment(f.input);
		// Assert
		await expect(result).rejects.toThrow(/UNIQUE constraint failed/);
		expect(await effects()).toEqual(before);
	},
);

test.for(tables.slice(1))(
	"native D1 rolls back a zero-row dependent insert into %s",
	async (table, { writer: f }) => {
		// Arrange: native trigger skips the insert, exercising the writer's own abort assertion.
		await exec(
			`CREATE TRIGGER commit_test_skip BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
		);
		const before = await effects();
		// Act
		const result = commitOwnerEnrollment(f.input);
		// Assert
		await expect(result).rejects.toThrow();
		expect(await effects()).toEqual(before);
	},
);

test.for([
	"link-revoked",
	"grant-revoked",
	"device-revoked",
	"key-revoked",
	"device-collision",
	"key-collision",
	"binding-collision",
])("native D1 denies %s without effects", async (fault, { writer: f }) => {
	// Arrange
	if (fault === "link-revoked")
		await exec("UPDATE coordinator_auth_account_links SET revoked_at_ms = ? WHERE coordinator_id = ? AND link_id = ?", NOW, f.row.coordinator_id, f.row.link_id);
	if (fault === "grant-revoked")
		await exec(
			"UPDATE coordinator_identity_group_grants SET status = 'revoked', revoked_at = 'revoked'",
		);
	if (["device-revoked", "key-revoked"].includes(fault))
		await exec(
			"INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES (?,?,'revocation-a','group-a',?,?,?,?)",
			fault === "device-revoked" ? "device_id" : "ed25519_key",
			fault === "device-revoked" ? f.row.device_id : f.row.key_id,
			f.row.device_id,
			f.row.public_key,
			f.row.fingerprint,
			new Date(NOW).toISOString(),
		);
	if (["device-collision", "key-collision"].includes(fault)) {
		const publicKey =
			fault === "device-collision" ? UNRELATED_PUBLIC_KEY : `${f.row.public_key} changed-comment`;
		const fingerprint = createHash("sha256").update(publicKey).digest("hex");
		expect(fingerprint).not.toBe(f.row.fingerprint);
		await exec(
			"INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at) VALUES ('group-a',?,?,?,'identity-a',1,?)",
			fault === "device-collision" ? f.row.device_id : "other-device",
			publicKey,
			fingerprint,
			new Date(NOW).toISOString(),
		);
	}
	if (fault === "binding-collision")
		await exec(
			"INSERT INTO coordinator_device_ownership_bindings VALUES (?,?,'other-identity','coordinator-a','other-binding','reviewed_legacy_migration','receipt',?)",
			f.row.device_id,
			"9".repeat(64),
			new Date(NOW).toISOString(),
		);
	const before = await effects();
	// Act
	const result = await commitOwnerEnrollment(f.input);
	// Assert
	expect(result).toBe(false);
	expect(await effects()).toEqual(before);
});

test.for(["retained", "removed", "forged"])(
	"native D1 reads %s receipt without restoring authority on retry",
	async (mode, { writer: f }) => {
		// Arrange
		expect(await commitOwnerEnrollment(f.input)).toBe(true);
		const receipt = await finalRow();
		if (mode === "removed") {
			await exec("DELETE FROM enrolled_devices");
			await exec("DELETE FROM coordinator_owner_enrollment_audit_log");
		}
		if (mode === "forged") receipt.confirmation_hash = "9".repeat(64);
		const before = await effects();
		const batch = vi.spyOn(f.input.backend, "batch");
		const run = vi.spyOn(f.input.backend, "run");
		// Act
		const read = await readOwnerEnrollmentReceipt(f.input.backend, receipt);
		// Assert: receipt reading never writes, including after device removal.
		expect(read).toBe(mode !== "forged");
		expect(batch).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		// Act: a stale confirmed writer cannot recreate enrollment.
		const duplicate = await commitOwnerEnrollment(f.input);
		// Assert
		expect(duplicate).toBe(false);
		expect(await effects()).toEqual(before);
	},
);
