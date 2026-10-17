import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUTH_LIFECYCLE_CONTINUATION_COLUMN_STATEMENTS,
	AUTH_LIFECYCLE_CONTINUATION_GUARD_STATEMENTS,
	AUTH_LIFECYCLE_SESSION_ADMISSION_GUARD_STATEMENTS,
} from "./coordinator-auth-lifecycle-admission-schema.js";
import { AUTH_LIFECYCLE_BROWSER_TRANSACTION_TABLE_SQL } from "./coordinator-auth-lifecycle-browser-schema.js";
import {
	AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS,
	AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL,
	AUTH_ACCOUNT_LINK_GENERATION_GUARD_STATEMENTS,
	AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS,
	AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL,
} from "./coordinator-auth-lifecycle-schema.js";
import { AUTH_LINK_SCHEMA_SQL } from "./coordinator-auth-link-contract.js";
import { AUTH_SESSION_SCHEMA_SQL } from "./coordinator-auth-session-contract.js";

const links = "coordinator_auth_account_links";
const associations = "coordinator_auth_account_associations";
const attempts = "coordinator_auth_link_attempts";
const browser = "coordinator_auth_browser_transactions";
const receipts = "coordinator_auth_session_receipts";
const sessions = "coordinator_auth_sessions";
const birthRevision = "a".repeat(64);
const currentRevision = "b".repeat(64);
const browserHash = "c".repeat(64);
const linked = {
	coordinator_id: "coordinator",
	link_id: "link-b",
	issuer: "https://accounts.google.com",
	subject: "google-a",
	identity_id: "actor",
	attempt_id: "attempt-b",
	controller_attestation_id: "attestation",
	auth_config_revision: birthRevision,
	created_at_ms: 10,
	revoked_at_ms: null,
	authority_kind: "controller_attestation",
	device_claim_id: null,
	generation: 2,
	ended_at_ms: null,
	end_reason: null,
	end_attempt_id: null,
	signin_sequence_floor: 10,
};
const transaction = {
	coordinator_id: linked.coordinator_id,
	browser_transaction_hash: browserHash,
	purpose: "signin",
	attempt_id: null,
	state_hash: browserHash,
	binder_hash: browserHash,
	issuer: linked.issuer,
	auth_config_revision: currentRevision,
	redirect_uri: "http://127.0.0.1:1234/callback",
	state: "consumed",
	nonce: null,
	pkce_verifier: null,
	claim_token: "claim",
	created_at_ms: 0,
	expires_at_ms: 600000,
	consumed_at_ms: 20,
	browser_sequence: 11,
};
const receipt = {
	coordinator_id: linked.coordinator_id,
	browser_transaction_hash: browserHash,
	source: "signin",
	attempt_id: null,
	link_id: linked.link_id,
	session_id: "session",
	auth_config_revision: currentRevision,
	created_at_ms: 20,
};
const session = {
	coordinator_id: linked.coordinator_id,
	session_id: receipt.session_id,
	credential_hash: "d".repeat(64),
	browser_transaction_hash: browserHash,
	link_id: linked.link_id,
	identity_id: linked.identity_id,
	issuer: linked.issuer,
	subject: linked.subject,
	auth_config_revision: currentRevision,
	created_at_ms: 20,
	expires_at_ms: 28800020,
	revoked_at_ms: null,
};
const finalized = {
	coordinator_id: linked.coordinator_id,
	attempt_id: linked.attempt_id,
	identity_id: linked.identity_id,
	group_id: "group",
	device_id: "device",
	public_key: "exact-key\r\n",
	fingerprint: birthRevision,
	controller_attestation_id: "attestation",
	controller_review_receipt_id: "review",
	controller_revision: 1,
	issuer: linked.issuer,
	auth_config_revision: birthRevision,
	runtime_verifier_hash: birthRevision,
	loopback_redirect: transaction.redirect_uri,
	state: "finalized",
	browser_transaction_hash: browserHash,
	account_subject: linked.subject,
	completion_secret_hash: birthRevision,
	link_id: linked.link_id,
	created_at_ms: 0,
	expires_at_ms: 600000,
	claimed_at_ms: 1,
	oidc_verified_at_ms: 2,
	confirmed_at_ms: 3,
	finalized_at_ms: 10,
	authority_kind: "controller_attestation",
	browser_start_hash: birthRevision,
	prior_link_id: "link-a",
	prior_generation: 1,
};
const pending = {
	coordinator_id: linked.coordinator_id,
	attempt_id: "pending",
	identity_id: linked.identity_id,
	group_id: "group",
	device_id: "device",
	public_key: "exact-key\r\n",
	fingerprint: birthRevision,
	controller_attestation_id: null,
	controller_review_receipt_id: null,
	controller_revision: null,
	issuer: linked.issuer,
	auth_config_revision: currentRevision,
	runtime_verifier_hash: birthRevision,
	loopback_redirect: transaction.redirect_uri,
	state: "pending",
	created_at_ms: 0,
	expires_at_ms: 600000,
	authority_kind: "device_claim",
	prior_link_id: null,
	prior_generation: null,
};
const databases: SqliteDatabase[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function insert(db: SqliteDatabase, table: string, row: Record<string, unknown>) {
	const columns = Object.keys(row);
	db.prepare(
		`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
	).run(...columns.map((key) => row[key]));
}
function rows(db: SqliteDatabase, table: string) {
	return db.prepare(`SELECT * FROM ${table}`).all();
}
function installAdmission(db: SqliteDatabase) {
	for (const sql of AUTH_LIFECYCLE_SESSION_ADMISSION_GUARD_STATEMENTS) db.exec(sql);
}
function setup(options: { association?: boolean; admission?: boolean } = {}) {
	const db = new Database(":memory:");
	databases.push(db);
	db.exec(AUTH_LINK_SCHEMA_SQL);
	db.exec(AUTH_SESSION_SCHEMA_SQL);
	db.exec(`DROP TABLE ${links}`);
	for (const sql of [
		AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL,
		AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL,
		...AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS,
		AUTH_LIFECYCLE_BROWSER_TRANSACTION_TABLE_SQL,
		...AUTH_LIFECYCLE_CONTINUATION_COLUMN_STATEMENTS,
		...AUTH_LIFECYCLE_CONTINUATION_GUARD_STATEMENTS,
	])
		db.exec(sql);
	// Historical copies precede guard installation; malformed-history fixtures test each defense directly.
	if (options.association !== false)
		insert(db, associations, {
			coordinator_id: linked.coordinator_id,
			issuer: linked.issuer,
			subject: linked.subject,
			identity_id: linked.identity_id,
			first_link_id: "link-a",
			created_at_ms: 0,
		});
	insert(db, links, {
		...linked,
		link_id: "link-a",
		attempt_id: "attempt-a",
		generation: 1,
		created_at_ms: 0,
		ended_at_ms: 5,
		end_reason: "user_disconnected",
		end_attempt_id: "disconnect-a",
		signin_sequence_floor: 0,
	});
	insert(db, links, linked);
	for (const sql of [
		...AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS,
		...AUTH_ACCOUNT_LINK_GENERATION_GUARD_STATEMENTS,
	])
		db.exec(sql);
	if (options.admission !== false) installAdmission(db);
	return db;
}
function ownRedeem(db: SqliteDatabase, changes: Record<string, unknown> = {}) {
	insert(db, browser, {
		...transaction,
		purpose: "link",
		attempt_id: linked.attempt_id,
		auth_config_revision: birthRevision,
		browser_sequence: 1,
	});
	insert(db, attempts, { ...finalized, ...changes });
	return {
		...receipt,
		source: "link_redeem",
		attempt_id: linked.attempt_id,
		auth_config_revision: birthRevision,
	};
}

describe("continuation pins", () => {
	it("adds null continuation pins to retained first attempts without rewriting their values", () => {
		// Arrange
		const db = new Database(":memory:");
		databases.push(db);
		db.exec(AUTH_LINK_SCHEMA_SQL);
		const legacy = { ...pending } as Record<string, unknown>;
		delete legacy.prior_link_id;
		delete legacy.prior_generation;
		insert(db, attempts, legacy);
		const before = rows(db, attempts)[0] as Record<string, unknown>;
		// Act
		for (const sql of [
			...AUTH_LIFECYCLE_CONTINUATION_COLUMN_STATEMENTS,
			...AUTH_LIFECYCLE_CONTINUATION_GUARD_STATEMENTS,
		])
			db.exec(sql);
		const retrofit = () =>
			db.prepare(`UPDATE ${attempts} SET prior_link_id = ?, prior_generation = ?`).run("link-a", 1);
		// Assert
		expect(rows(db, attempts)).toEqual([
			{ ...before, prior_link_id: null, prior_generation: null },
		]);
		expect(retrofit).toThrow(/auth_link_continuation_immutable/);
	});
	it.each([
		{ prior_link_id: null, prior_generation: null },
		{ prior_link_id: "link-a", prior_generation: 1 },
	])("stores valid first/continuation pins %j without changing authority", (pins) => {
		// Arrange
		const db = setup();
		// Act
		insert(db, attempts, { ...pending, ...pins });
		// Assert
		expect(rows(db, attempts)).toMatchObject([{ ...pins, authority_kind: "device_claim" }]);
	});
	it.each([
		{ prior_link_id: "link-a" },
		{ prior_generation: 1 },
		{ prior_link_id: "", prior_generation: 1 },
		...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((prior_generation) => ({
			prior_link_id: "link-a",
			prior_generation,
		})),
	])("rejects malformed continuation pair %j", (pins) => {
		// Arrange
		const db = setup();
		// Act
		const write = () => insert(db, attempts, { ...pending, ...pins });
		// Assert
		expect(write).toThrow(/auth_link_continuation_invalid|CHECK/);
		expect(rows(db, attempts)).toEqual([]);
	});
	it.each([
		{ prior_link_id: "other" },
		{ prior_generation: 2 },
		{ prior_link_id: null, prior_generation: null },
	])("keeps continuation pins immutable on update %j", (pins) => {
		// Arrange
		const db = setup();
		insert(db, attempts, { ...pending, prior_link_id: "link-a", prior_generation: 1 });
		const columns = Object.keys(pins);
		const before = rows(db, attempts);
		// Act
		const write = () =>
			db
				.prepare(`UPDATE ${attempts} SET ${columns.map((key) => `${key} = ?`).join(",")}`)
				.run(...Object.values(pins));
		// Assert
		expect(write).toThrow(/auth_link_continuation_immutable/);
		expect(rows(db, attempts)).toEqual(before);
	});
});

describe("generation-aware receipt admission", () => {
	it("admits fresh same-issuer sign-in above the floor with a current revision different from birth", () => {
		// Arrange
		const db = setup();
		insert(db, browser, transaction);
		// Act: the receipt precedes the session, matching the established writer order.
		insert(db, receipts, receipt);
		insert(db, sessions, session);
		// Assert
		expect(rows(db, receipts)).toEqual([{ ...receipt, purge_eligible: 0 }]);
		expect(rows(db, sessions)).toEqual([session]);
	});
	it.each([1, 9, 10])(
		"rejects old sign-in sequence %s at identical clock timestamps",
		(browser_sequence) => {
			// Arrange
			const db = setup();
			insert(db, browser, { ...transaction, browser_sequence });
			// Act
			const write = () => insert(db, receipts, receipt);
			// Assert
			expect(write).toThrow(/auth_session_admission_unavailable/);
			expect(rows(db, receipts)).toEqual([]);
		},
	);
	it.each([
		{ coordinator_id: "other" },
		{ browser_transaction_hash: "e".repeat(64) },
		{ issuer: "https://other.example.test" },
		{ auth_config_revision: birthRevision },
		{ state: "expired", claim_token: null, consumed_at_ms: null },
		{ consumed_at_ms: 21 },
		{ purpose: "owner_enroll", attempt_id: "owner" },
		{
			state: "pending",
			nonce: "n".repeat(43),
			pkce_verifier: "p".repeat(43),
			claim_token: null,
			consumed_at_ms: null,
		},
	])("rejects mismatched or unconsumed sign-in browser proof %j", (changes) => {
		// Arrange
		const db = setup();
		insert(db, browser, { ...transaction, ...changes });
		// Act
		const write = () => insert(db, receipts, receipt);
		// Assert
		expect(write).toThrow(/auth_session_admission_unavailable/);
		expect(rows(db, receipts)).toEqual([]);
	});
	it.each(["finalized", "session_redeemed"])(
		"admits the current generation's own %s attempt below its floor",
		(state) => {
			// Arrange
			const db = setup();
			const own = ownRedeem(db, { state });
			// Act
			insert(db, receipts, own);
			insert(db, sessions, { ...session, auth_config_revision: birthRevision });
			// Assert
			expect(rows(db, receipts)).toEqual([{ ...own, purge_eligible: 0 }]);
			expect(rows(db, sessions)).toHaveLength(1);
		},
	);
	it.each([
		{ identity_id: "other" },
		{ issuer: "https://other.example.test" },
		{ account_subject: "google-other" },
		{ link_id: "link-a" },
		{ auth_config_revision: currentRevision },
		{
			authority_kind: "device_claim",
			controller_attestation_id: null,
			controller_review_receipt_id: null,
			controller_revision: null,
		},
	])("rejects mismatched own-attempt metadata %j", (changes) => {
		// Arrange
		const db = setup();
		const own = ownRedeem(db, changes);
		// Act
		const write = () => insert(db, receipts, own);
		// Assert
		expect(write).toThrow(/auth_session_admission_unavailable/);
		expect(rows(db, receipts)).toEqual([]);
	});
	it("cannot resume old A's own redemption against a new live generation of the same account", () => {
		// Arrange
		const db = setup();
		const own = ownRedeem(db, {
			attempt_id: "attempt-a",
			link_id: "link-a",
			prior_link_id: null,
			prior_generation: null,
		});
		// Act
		const write = () => insert(db, receipts, { ...own, attempt_id: "attempt-a" });
		// Assert
		expect(write).toThrow(/auth_session_admission_unavailable/);
		expect(rows(db, receipts)).toEqual([]);
	});
});

describe("session admission and historical barriers", () => {
	it("requires an exact browser row before receipt admission", () => {
		// Arrange
		const db = setup();
		// Act
		const write = () => insert(db, receipts, receipt);
		// Assert
		expect(write).toThrow(/auth_session_admission_unavailable/);
		expect(rows(db, receipts)).toEqual([]);
	});
	it.each([
		{ identity_id: "other" },
		{ subject: "google-other" },
		{ issuer: "https://other.example.test" },
		{ auth_config_revision: birthRevision },
		{ session_id: "other" },
		{ link_id: "link-a" },
		{ browser_transaction_hash: "e".repeat(64) },
		{ created_at_ms: 21, expires_at_ms: 28800021 },
		{ revoked_at_ms: 20 },
	])("rejects session/receipt metadata mismatch %j", (changes) => {
		// Arrange
		const db = setup();
		insert(db, browser, transaction);
		insert(db, receipts, receipt);
		// Act
		const write = () => insert(db, sessions, { ...session, ...changes });
		// Assert
		expect(write).toThrow(/auth_session_admission_unavailable/);
		expect(rows(db, sessions)).toEqual([]);
	});
	it("requires a matching receipt before inserting a session", () => {
		// Arrange
		const db = setup();
		insert(db, browser, transaction);
		// Act
		const write = () => insert(db, sessions, session);
		// Assert
		expect(write).toThrow(/auth_session_admission_unavailable/);
		expect(rows(db, sessions)).toEqual([]);
	});
	it.each(["historical revocation", "missing association", "ended target"])(
		"blocks both receipt and session admission after %s",
		(barrier) => {
			// Arrange: retain a previously valid receipt to test the session's independent recheck.
			const db = setup({ association: barrier !== "missing association", admission: false });
			insert(db, browser, transaction);
			insert(db, receipts, receipt);
			installAdmission(db);
			if (barrier === "historical revocation")
				db.prepare(`UPDATE ${links} SET revoked_at_ms = ? WHERE link_id = ?`).run(30, "link-a");
			if (barrier === "ended target")
				db.prepare(
					`UPDATE ${links} SET ended_at_ms = ?, end_reason = ?, end_attempt_id = ? WHERE link_id = ?`,
				).run(30, "user_disconnected", "disconnect-b", "link-b");
			// Act
			const writeReceipt = () => insert(db, receipts, { ...receipt, session_id: "other" });
			const writeSession = () => insert(db, sessions, session);
			// Assert
			expect(writeReceipt).toThrow(/auth_session_admission_unavailable/);
			expect(writeSession).toThrow(/auth_session_admission_unavailable/);
			expect(rows(db, sessions)).toEqual([]);
		},
	);
	it("installing guards does not rewrite existing receipt or session history", () => {
		// Arrange
		const db = setup({ admission: false });
		insert(db, receipts, receipt);
		insert(db, sessions, session);
		const before = [rows(db, receipts), rows(db, sessions)];
		// Act
		installAdmission(db);
		// Assert
		expect([rows(db, receipts), rows(db, sessions)]).toEqual(before);
	});
});
