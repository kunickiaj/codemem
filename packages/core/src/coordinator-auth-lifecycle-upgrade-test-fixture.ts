import { readdirSync, readFileSync } from "node:fs";
import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import { AUTH_LINK_AUTHORITY_CUTOVER_SQL } from "./coordinator-auth-link-authority-upgrade.js";

export const LEGACY_AUTH_TABLES = [
	"coordinator_auth_account_links",
	"coordinator_auth_link_attempts",
	"coordinator_auth_link_audit_log",
	"coordinator_auth_browser_transactions",
	"coordinator_auth_sessions",
	"coordinator_auth_session_receipts",
	"coordinator_auth_account_profiles",
	"coordinator_auth_link_profiles",
	"coordinator_auth_device_claims",
] as const;
export const hash = (index: number) => (index + 1).toString(16).repeat(64);
export function insert(db: SqliteDatabase, table: string, row: Record<string, unknown>) {
	const names = Object.keys(row);
	db.prepare(
		`INSERT INTO main."${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
	).run(...Object.values(row));
}
export function columns(db: SqliteDatabase, table: string) {
	return (db.prepare(`PRAGMA main.table_info("${table}")`).all() as { name: string }[]).map(
		({ name }) => name,
	);
}
const defaults = {
	coordinator_id: "synthetic-coordinator",
	issuer: "https://issuer.example.test",
	auth_config_revision: hash(0),
	created_at_ms: 1000,
	public_key: "synthetic-public-key\r\nexact-Ω-bytes\r\n",
	loopback_redirect: "http://127.0.0.1:1234/callback",
	state: "finalized",
	failure_reason: null,
	expires_at_ms: 600000,
	claimed_at_ms: 10,
	oidc_verified_at_ms: 30,
	confirmed_at_ms: 40,
	finalized_at_ms: 1000,
	failed_at_ms: null,
	action: "link_created",
	purpose: "link",
	redirect_uri: "https://coordinator.example.test/auth/callback?exact=%2f",
	nonce: null,
	pkce_verifier: null,
	consumed_at_ms: 20,
	source: "link_redeem",
	purge_eligible: 0,
	display_name: "Display Ω 'quote'\r\n",
	email: "fixture@example.test",
	email_verified: 0,
	picture_url: "https://example.test/picture?raw=%2f",
	source_signed_in_at_ms: 2000,
	verified_at_ms: 30,
};
function indexedValues(index: number): Record<string, unknown> {
	const deviceClaim = index === 1 || index === 2 || index === 3;
	return {
		...defaults,
		link_id: `link-${index}`,
		attempt_id: `attempt-${index}`,
		subject: `subject-${index}`,
		identity_id: `identity-${index}`,
		controller_attestation_id: deviceClaim ? null : `attestation-${index}`,
		controller_review_receipt_id: deviceClaim ? null : `review-${index}`,
		controller_revision: deviceClaim ? null : 1,
		revoked_at_ms: index === 1 ? 2000 : null,
		authority_kind: deviceClaim ? "device_claim" : "controller_attestation",
		device_claim_id: deviceClaim ? `link-${index}` : null,
		claim_id: `link-${index}`,
		group_id: `group-${index}`,
		device_id: `device-${index}`,
		fingerprint: hash(index),
		key_id: hash(index),
		runtime_verifier_hash: hash(index),
		browser_transaction_hash: hash(index),
		account_subject: `subject-${index}`,
		completion_secret_hash: hash(index),
		browser_start_hash: hash(index),
		state_hash: hash(index),
		binder_hash: hash(index),
		claim_token: `claim-${index}`,
		session_id: `session-${index}`,
		credential_hash: hash(index),
		source_session_id: `session-${index}`,
	};
}
function attemptValues(index: number, values: Record<string, unknown>) {
	values.created_at_ms = 0;
	if (index >= 3)
		Object.assign(values, {
			state: "pending",
			browser_transaction_hash: null,
			account_subject: null,
			completion_secret_hash: null,
			link_id: null,
			claimed_at_ms: null,
			oidc_verified_at_ms: null,
			confirmed_at_ms: null,
			finalized_at_ms: null,
		});
	if (index === 4)
		Object.assign(values, {
			state: "oidc_verified",
			browser_transaction_hash: hash(index),
			account_subject: `subject-${index}`,
			claimed_at_ms: 10,
			oidc_verified_at_ms: 30,
		});
}
function browserValues(index: number, values: Record<string, unknown>) {
	Object.assign(values, { state: "consumed", created_at_ms: 1, expires_at_ms: 600001 });
	if (index >= 5) Object.assign(values, { purpose: "signin", attempt_id: null });
	if (index === 3 || index === 5)
		Object.assign(values, {
			state: index === 3 ? "pending" : "expired",
			claim_token: null,
			consumed_at_ms: null,
		});
	if (index === 3) Object.assign(values, { nonce: "n".repeat(43), pkce_verifier: "p".repeat(43) });
}
function legacyRow(db: SqliteDatabase, table: string, index: number) {
	const values = indexedValues(index);
	if (table.endsWith("link_attempts")) attemptValues(index, values);
	if (table.endsWith("browser_transactions")) browserValues(index, values);
	if (table.endsWith("sessions") || table.endsWith("session_receipts")) {
		Object.assign(values, { created_at_ms: 2000, expires_at_ms: 28802000 });
		if (index === 1)
			Object.assign(values, {
				browser_transaction_hash: hash(6),
				source: "signin",
				attempt_id: null,
				purge_eligible: 1,
			});
	}
	if (table.endsWith("link_profiles") && index === 4) values.link_id = null;
	if (index === 2)
		for (const field of ["display_name", "email", "email_verified", "picture_url"])
			values[field] = null;
	const row = Object.fromEntries(columns(db, table).map((name) => [name, values[name]]));
	if (!table.endsWith("device_claims")) row.rowid = [7, 103, 1009, 3007, 4013, 5003, 7001][index];
	return row;
}
export function populatedPredecessor(source: "inline" | "migrations"): SqliteDatabase {
	let db: SqliteDatabase;
	if (source === "inline") db = connectCoordinator(":memory:");
	else {
		db = new Database(":memory:");
		const directory = new URL("../../cloudflare-coordinator-worker/migrations/", import.meta.url);
		for (const name of readdirSync(directory)
			.filter((name) => /^00(?:[0-2]\d|3[0-3])_.*\.sql$/u.test(name))
			.sort())
			db.exec(readFileSync(new URL(name, directory), "utf8"));
		db.exec(AUTH_LINK_AUTHORITY_CUTOVER_SQL);
	}
	for (const table of LEGACY_AUTH_TABLES) {
		let indexes = [0, 1, 2];
		if (table.endsWith("device_claims")) indexes = [1, 2];
		if (table.endsWith("link_attempts")) indexes = [0, 1, 2, 3, 4];
		if (table.endsWith("browser_transactions")) indexes = [0, 1, 2, 3, 4, 5, 6];
		if (table.endsWith("link_profiles")) indexes = [0, 1, 2, 4];
		for (const index of indexes) insert(db, table, legacyRow(db, table, index));
	}
	db.exec(
		"CREATE TABLE unrelated_sequence (id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO unrelated_sequence VALUES (500); DELETE FROM unrelated_sequence; CREATE TABLE unrelated_notes (body BLOB); INSERT INTO unrelated_notes VALUES (X'0000FF')",
	);
	insert(db, "groups", { group_id: "preserved-group", created_at: "2026-10-01T00:00:00.000Z" });
	insert(db, "coordinator_identity_group_grants", {
		coordinator_id: "synthetic-coordinator",
		identity_id: "identity-0",
		group_id: "preserved-group",
		status: "active",
		revision: 1,
		source_kind: "controller_attestation",
		source_receipt_id: "review-0",
		created_at: "2026-10-01T00:00:00.000Z",
		revoked_at: null,
	});
	return db;
}

/** Independent oracle: read live predecessor columns, not the production copy inventory/builders. */
export function rawAuthSnapshot(
	db: SqliteDatabase,
	inventory: readonly {
		table: string;
		columns: readonly string[];
		rowid?: boolean;
	}[] = LEGACY_AUTH_TABLES.map((table) => ({ table, columns: columns(db, table) })),
) {
	return inventory.map(({ table, columns: names, rowid }) => {
		const projections = names.flatMap((name) => [
			`typeof(s."${name}") AS "${name}:type"`,
			`hex(CAST(s."${name}" AS BLOB)) AS "${name}:bytes"`,
			`CASE WHEN typeof(s."${name}") IN ('integer','real') THEN s."${name}" ELSE NULL END AS "${name}:number"`,
		]);
		const withRowid = rowid ?? !table.endsWith("device_claims");
		if (withRowid) projections.unshift("s.rowid AS original_rowid");
		return {
			table,
			columns: names,
			rows: db
				.prepare(
					`SELECT ${projections.join(",")} FROM main."${table}" s ORDER BY ${withRowid ? "s.rowid" : names.map((name) => `s."${name}"`).join(",")}`,
				)
				.all(),
		};
	});
}

/** Rollback preserves logical storage, not unspecified bytes in SQLite's free pages. */
export function databaseState(db: SqliteDatabase) {
	const schema = db
		.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name")
		.all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
	const inventory = schema
		.filter(({ type }) => type === "table")
		.map(({ name, sql }) => ({
			table: name,
			columns: columns(db, name),
			rowid: !/\bWITHOUT ROWID\b/iu.test(sql ?? ""),
		}));
	return { schema, data: rawAuthSnapshot(db, inventory) };
}
