import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type Database from "better-sqlite3";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL,
	type commitOwnerEnrollment,
	type OwnerAttempt,
} from "./coordinator-owner-enrollment-commit.js";
import { finalizedOwner, pendingOwner } from "./coordinator-owner-enrollment-test-harness.js";

const EFFECT_TABLES = [
	"coordinator_owner_enrollment_attempts",
	"coordinator_device_ownership_bindings",
	"enrolled_devices",
	"coordinator_owner_enrollment_audit_log",
];
export function commitPendingKey() {
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const wire = Buffer.alloc(51);
	wire.writeUInt32BE(11, 0);
	wire.write("ssh-ed25519", 4);
	wire.writeUInt32BE(32, 15);
	raw.copy(wire, 19);
	return {
		publicKey: `ssh-ed25519 ${wire.toString("base64")}`,
		sign: (message: string) =>
			sign(null, Buffer.from(message), keys.privateKey).toString("base64url"),
	};
}
export function commitProofMessage(a: OwnerAttempt, secret: string) {
	const fields =
		"coordinator_id origin auth_config_revision attempt_id device_id public_key key_id fingerprint issuer account_subject identity_id link_id confirmation_hash".split(
			" ",
		) as (keyof OwnerAttempt)[];
	return JSON.stringify([
		"codemem-owner-enrollment-finalize-v1",
		"owner_enroll",
		...fields.map((field) => a[field]),
		secret,
	]);
}
function nativeBackend(db: Database.Database): AuthLinkBackend {
	const run = (s: AuthLinkStatement) => db.prepare(s.sql).run(...s.values).changes;
	return {
		first: async <T>(s: AuthLinkStatement) =>
			(db.prepare(s.sql).get(...s.values) as T | undefined) ?? null,
		run: async (s) => db.transaction(() => run(s)).immediate(),
		batch: async (statements) => {
			db.transaction(() => {
				for (const s of statements) run(s);
			}).immediate();
		},
	};
}
async function confirmedMetadata(key: ReturnType<typeof commitPendingKey>): Promise<OwnerAttempt> {
	return {
		...finalizedOwner,
		purpose: "owner_enroll",
		public_key: key.publicKey,
		key_id: (await ed25519KeyIdForRevocation(key.publicKey)) as string,
		fingerprint: createHash("sha256").update(key.publicKey).digest("hex"),
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
}
type Exec = (sql: string, ...values: AuthLinkStatement["values"]) => Promise<number>;
async function seedCommitAuthority(exec: Exec) {
	await exec(
		"INSERT INTO coordinator_auth_account_links (coordinator_id,link_id,issuer,subject,identity_id,attempt_id,controller_attestation_id,auth_config_revision,created_at_ms) SELECT coordinator_id,link_id,issuer,account_subject,identity_id,link_attempt_id,link_controller_attestation_id,link_auth_config_revision,created_at_ms FROM coordinator_owner_enrollment_attempts",
	);
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
}
async function seedCommitAttempt(exec: Exec, row: OwnerAttempt) {
	const birth = {
		...pendingOwner,
		public_key: row.public_key,
		key_id: row.key_id,
		fingerprint: row.fingerprint,
	};
	const entries = Object.entries(birth);
	await exec(
		`INSERT INTO coordinator_owner_enrollment_attempts (${entries.map(([k]) => k).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
		...entries.map(([, v]) => v),
	);
	// Storage transitions only: these fixture claims are not browser/OIDC verification.
	const stages = [
		["browser_claimed", "browser_transaction_hash browser_binder_hash"],
		[
			"oidc_verified",
			"account_subject identity_id link_id link_attempt_id link_controller_attestation_id link_auth_config_revision grant_revisions_json",
		],
		["confirmed", "confirmation_hash completion_secret_hash"],
	] as const;
	for (const [state, names] of stages) {
		const fields = names.split(" ") as (keyof OwnerAttempt)[];
		await exec(
			`UPDATE coordinator_owner_enrollment_attempts SET state = ?, ${fields.map((k) => `${k} = ?`).join(",")}`,
			state,
			...fields.map((k) => row[k]),
		);
	}
}
// Test-only composition installs audit DDL; no production schema hook, route, provider or SDK.
export async function commitWriterFixture(): Promise<CommitWriterFixture> {
	const { db } = setupStore("SQLite", { authClock: () => NOW });
	db.exec(COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL);
	const backend = nativeBackend(db);
	const exec: Exec = (sql, ...values) => backend.run({ sql, values });
	const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
	const key = commitPendingKey();
	const secret = Buffer.alloc(32, 9).toString("base64url");
	const row = await confirmedMetadata(key);
	await seedCommitAttempt(exec, row);
	await seedCommitAuthority(exec);
	return {
		db,
		backend,
		exec,
		rows,
		row,
		key,
		secret,
		input: (patch: Partial<OwnerAttempt> = {}, completionSecret = secret) => {
			const captured = { ...row, ...patch };
			return {
				backend,
				row: captured,
				revision: row.auth_config_revision,
				now: NOW,
				completionSecret,
				signature: key.sign(commitProofMessage(captured, completionSecret)),
			};
		},
		effects: () => EFFECT_TABLES.map(rows),
		finalRow: () =>
			db.prepare("SELECT * FROM coordinator_owner_enrollment_attempts").get() as OwnerAttempt,
	};
}
export interface CommitWriterFixture {
	db: Database.Database;
	backend: AuthLinkBackend;
	exec: Exec;
	rows(table: string): unknown[];
	row: OwnerAttempt;
	key: ReturnType<typeof commitPendingKey>;
	secret: string;
	input(
		patch?: Partial<OwnerAttempt>,
		completionSecret?: string,
	): Parameters<typeof commitOwnerEnrollment>[0];
	effects(): unknown[][];
	finalRow(): OwnerAttempt;
}
export async function commitFixtureEnrollment(
	f: CommitWriterFixture,
	publicKey: string,
	deviceId = "other-device",
) {
	await f.exec(
		"INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at) VALUES ('group-a',?,?,?,'identity-a',1,?)",
		deviceId,
		publicKey,
		"7".repeat(64),
		new Date(NOW).toISOString(),
	);
}
