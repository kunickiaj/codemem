import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import { COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL } from "./coordinator-auth-device-claim-schema.js";
import {
	AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS,
	AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS,
	AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL as AUTH_LIFECYCLE_ASSOCIATIONS_SCHEMA_SQL,
	AUTH_LINK_AUDIT_RECEIPT_GUARD_STATEMENTS as AUTH_LIFECYCLE_AUDIT_GUARD_STATEMENTS,
	AUTH_DEVICE_CLAIM_FIRST_GENERATION_GUARD_SQL as AUTH_LIFECYCLE_GENESIS_GUARD_SQL,
	AUTH_ACCOUNT_LINK_GENERATION_GUARD_STATEMENTS as AUTH_LIFECYCLE_LINK_GUARD_STATEMENTS,
	AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL as AUTH_LIFECYCLE_LINKS_SCHEMA_SQL,
} from "./coordinator-auth-lifecycle-schema.js";
import { AUTH_LINK_SCHEMA_SQL } from "./coordinator-auth-link-contract.js";
import { authLinkLiveGenerationSql } from "./coordinator-auth-link-liveness.js";
import { AUTH_SCHEMA_READINESS_SQL } from "./coordinator-auth-schema.js";

const links = "coordinator_auth_account_links";
const associations = "coordinator_auth_account_associations";
const attempts = "coordinator_auth_link_attempts";
const claims = "coordinator_auth_device_claims";
const audits = "coordinator_auth_link_audit_log";
const hash = "a".repeat(64);
const birth = {
	coordinator_id: "coordinator",
	link_id: "link-a",
	issuer: "https://accounts.google.com",
	subject: "google-a",
	identity_id: "actor-a",
	attempt_id: "attempt-a",
	controller_attestation_id: null,
	device_claim_id: "link-a",
	authority_kind: "device_claim",
	auth_config_revision: hash,
	created_at_ms: 10,
	revoked_at_ms: null,
	generation: 1,
	ended_at_ms: null,
	end_reason: null,
	end_attempt_id: null,
	signin_sequence_floor: 0,
};
const reservation = {
	coordinator_id: birth.coordinator_id,
	issuer: birth.issuer,
	subject: birth.subject,
	identity_id: birth.identity_id,
	first_link_id: birth.link_id,
	created_at_ms: birth.created_at_ms,
};
const claim = {
	claim_id: birth.link_id,
	coordinator_id: birth.coordinator_id,
	identity_id: birth.identity_id,
	group_id: "group",
	device_id: "device",
	public_key: "exact-key\r\n",
	fingerprint: hash,
	key_id: "b".repeat(64),
	attempt_id: birth.attempt_id,
	issuer: birth.issuer,
	auth_config_revision: hash,
	created_at_ms: birth.created_at_ms,
};
const audit = {
	coordinator_id: birth.coordinator_id,
	link_id: birth.link_id,
	action: "link_created",
	attempt_id: birth.attempt_id,
	identity_id: birth.identity_id,
	group_id: claim.group_id,
	device_id: claim.device_id,
	fingerprint: hash,
	controller_attestation_id: null,
	device_claim_id: birth.device_claim_id,
	auth_config_revision: hash,
	created_at_ms: 10,
	authority_kind: "device_claim",
};
const databases: SqliteDatabase[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function insert(
	db: SqliteDatabase,
	table: string,
	row: Record<string, unknown>,
	mode = "INSERT",
	suffix = "",
) {
	const columns = Object.keys(row);
	db.prepare(
		`${mode} INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ${suffix}`,
	).run(...columns.map((column) => row[column]));
}
function setup() {
	const db = new Database(":memory:");
	databases.push(db);
	db.pragma("recursive_triggers = OFF");
	// The pre-V3 constants remain unchanged and supply the exact old attempt/audit CHECKs.
	db.exec(AUTH_LINK_SCHEMA_SQL);
	db.exec(COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL);
	db.exec(`CREATE TABLE coordinator_auth_link_profiles (fixture INTEGER);
	 ALTER TABLE ${attempts} ADD COLUMN prior_link_id TEXT;
	 ALTER TABLE ${attempts} ADD COLUMN prior_generation INTEGER;
	 DROP TABLE ${links};`);
	db.exec(AUTH_LIFECYCLE_ASSOCIATIONS_SCHEMA_SQL);
	db.exec(AUTH_LIFECYCLE_LINKS_SCHEMA_SQL);
	for (const sql of [
		...AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS,
		...AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS,
		...AUTH_LIFECYCLE_LINK_GUARD_STATEMENTS,
		...AUTH_LIFECYCLE_AUDIT_GUARD_STATEMENTS,
	])
		db.exec(sql);
	return db;
}
function seed(db: SqliteDatabase) {
	insert(db, associations, reservation);
	insert(db, links, birth);
}
function rows(db: SqliteDatabase, table = links) {
	return db.prepare(`SELECT * FROM ${table}`).all();
}
function end(db: SqliteDatabase) {
	db.prepare(
		`UPDATE ${links} SET ended_at_ms = ?, end_reason = ?, end_attempt_id = ? WHERE link_id = ?`,
	).run(20, "user_disconnected", "disconnect-a", birth.link_id);
}
function reconnect(db: SqliteDatabase) {
	insert(db, associations, { ...reservation, subject: "google-b", first_link_id: "link-b" });
	insert(db, links, {
		...birth,
		link_id: "link-b",
		attempt_id: "attempt-b",
		subject: "google-b",
		generation: 2,
	});
}

describe("inert lifecycle storage contract", () => {
	it("retains ended A and its reservation while B reuses the original claim", () => {
		// Arrange
		const db = setup();
		seed(db);
		// Act
		end(db);
		reconnect(db);
		// Assert
		expect(rows(db)).toHaveLength(2);
		expect(rows(db).map((row) => (row as typeof birth).device_claim_id)).toEqual([
			"link-a",
			"link-a",
		]);
		expect(rows(db, associations)).toContainEqual(reservation);
	});
	it.each([{}, { identity_id: "other-actor" }])(
		"requires the exact permanent association %j",
		(changes) => {
			// Arrange
			const db = setup();
			if (Object.keys(changes).length) insert(db, associations, { ...reservation, ...changes });
			// Act
			const write = () => insert(db, links, birth);
			// Assert
			expect(write).toThrow(/auth_account_link_unavailable/);
			expect(rows(db)).toEqual([]);
		},
	);
	it.each(["INSERT", "INSERT OR REPLACE", "UPSERT"])(
		"rejects association %s collisions before conflict handling",
		(mode) => {
			// Arrange
			const db = setup();
			seed(db);
			end(db);
			// Act
			const write = () =>
				insert(
					db,
					associations,
					{ ...reservation, identity_id: "other-actor" },
					mode === "UPSERT" ? "INSERT" : mode,
					mode === "UPSERT" ? "ON CONFLICT DO UPDATE SET identity_id = excluded.identity_id" : "",
				);
			// Assert
			expect(write).toThrow();
			expect(rows(db, associations)).toEqual([reservation]);
		},
	);
	it.each(["UPDATE", "DELETE"])("prevents permanent reservation %s", (operation) => {
		// Arrange
		const db = setup();
		seed(db);
		// Act
		const write = () =>
			db.exec(
				operation === "UPDATE"
					? `UPDATE ${associations} SET identity_id = 'other'`
					: `DELETE FROM ${associations}`,
			);
		// Assert
		expect(write).toThrow();
		expect(rows(db, associations)).toEqual([reservation]);
	});
	it.each(["link_id", "attempt_id", "identity_id", "subject"])(
		"denies replacement and UPSERT through %s collision",
		(field) => {
			// Arrange: different logical keys isolate permanent PK/attempt and open-row collisions.
			const db = setup();
			seed(db);
			const candidate = {
				...birth,
				link_id: "link-b",
				attempt_id: "attempt-b",
				identity_id: "actor-b",
				subject: "google-b",
				generation: 2,
			};
			Object.assign(candidate, { [field]: birth[field as keyof typeof birth] });
			// Unit-isolate the account collision clause: different Actors avoid the Identity unique.
			// This deliberately bypasses association authority only in this defense-layer test.
			if (field === "subject") db.exec("DROP TRIGGER auth_account_links_insert_authority");
			if (candidate.subject !== birth.subject)
				insert(db, associations, {
					...reservation,
					subject: candidate.subject,
					identity_id: candidate.identity_id,
					first_link_id: candidate.link_id,
				});
			// Act
			const replace = () => insert(db, links, candidate, "INSERT OR REPLACE");
			const upsert = () =>
				insert(
					db,
					links,
					candidate,
					"INSERT",
					"ON CONFLICT DO UPDATE SET created_at_ms = excluded.created_at_ms",
				);
			// Assert
			expect(replace).toThrow(/auth_account_link_collision/);
			expect(upsert).toThrow(/auth_account_link_collision/);
			expect(rows(db)).toEqual([birth]);
		},
	);
});

describe("link history and liveness", () => {
	it.each(
		Object.keys(birth).filter(
			(key) => !["revoked_at_ms", "ended_at_ms", "end_reason", "end_attempt_id"].includes(key),
		),
	)("keeps birth field %s immutable", (field) => {
		// Arrange
		const db = setup();
		seed(db);
		const value = typeof birth[field as keyof typeof birth] === "number" ? 99 : "changed";
		// Act
		const write = () => db.prepare(`UPDATE ${links} SET ${field} = ?`).run(value);
		// Assert
		expect(write).toThrow();
		expect(rows(db)).toEqual([birth]);
	});
	it.each(["rowid", "_rowid_", "oid"])("does not permit hidden %s replacement", (alias) => {
		// Arrange
		const db = setup();
		seed(db);
		insert(db, associations, {
			...reservation,
			subject: "google-b",
			identity_id: "actor-b",
			first_link_id: "link-b",
		});
		const fresh = {
			...birth,
			link_id: "link-b",
			attempt_id: "attempt-b",
			subject: "google-b",
			identity_id: "actor-b",
		};
		// Act
		const replace = () => insert(db, links, { ...fresh, [alias]: 1 }, "INSERT OR REPLACE");
		const update = () => db.prepare(`UPDATE ${links} SET ${alias} = 99`).run();
		// Assert
		expect(replace).toThrow();
		expect(update).toThrow();
		expect(rows(db)).toEqual([birth]);
	});
	it.each([
		"DELETE FROM coordinator_auth_account_links",
		"UPDATE coordinator_auth_account_links SET ended_at_ms = NULL, end_reason = NULL, end_attempt_id = NULL",
		"UPDATE coordinator_auth_account_links SET ended_at_ms = 21",
		"UPDATE coordinator_auth_account_links SET end_reason = 'other'",
		"UPDATE coordinator_auth_account_links SET end_attempt_id = 'other'",
		"UPDATE coordinator_auth_account_links SET revoked_at_ms = NULL",
		"UPDATE coordinator_auth_account_links SET revoked_at_ms = 31",
	])("denies historical mutation: %s", (sql) => {
		// Arrange
		const db = setup();
		seed(db);
		end(db);
		db.prepare(`UPDATE ${links} SET revoked_at_ms = ?`).run(30);
		const before = rows(db);
		// Act
		const write = () => db.exec(sql);
		// Assert
		expect(write).toThrow();
		expect(rows(db)).toEqual(before);
	});
	it.each([
		{ ended_at_ms: 20 },
		{ end_reason: "user_disconnected" },
		{ end_attempt_id: "disconnect" },
		{ ended_at_ms: 20, end_reason: "invalid", end_attempt_id: "disconnect" },
		{ authority_kind: "controller_attestation" },
		{ controller_attestation_id: "attestation" },
		{ device_claim_id: null },
		{ generation: 0 },
		{ signin_sequence_floor: -1 },
	])("rejects malformed lifecycle/authority tuple %j", (changes) => {
		// Arrange
		const db = setup();
		insert(db, associations, reservation);
		// Act
		const write = () => insert(db, links, { ...birth, ...changes });
		// Assert
		expect(write).toThrow();
		expect(rows(db)).toEqual([]);
	});
});

describe("authority, liveness and audit receipts", () => {
	it("retains controller storage authority without a device claim", () => {
		// Arrange
		const db = setup();
		insert(db, associations, reservation);
		const controller = {
			...birth,
			authority_kind: "controller_attestation",
			controller_attestation_id: "attestation",
			device_claim_id: null,
		};
		// Act
		insert(db, links, controller);
		// Assert
		expect(rows(db)).toEqual([controller]);
	});
	it("blocks current B and future C immediately when historical A is security-revoked", () => {
		// Arrange
		const db = setup();
		seed(db);
		end(db);
		reconnect(db);
		const live = () =>
			db
				.prepare(
					`SELECT l.link_id FROM ${links} l WHERE ${authLinkLiveGenerationSql({ link: "l" })}`,
				)
				.all();
		expect(live()).toEqual([{ link_id: "link-b" }]);
		// Act
		db.prepare(`UPDATE ${links} SET revoked_at_ms = ? WHERE link_id = ?`).run(30, "link-a");
		const future = () =>
			insert(db, links, { ...birth, link_id: "link-c", attempt_id: "attempt-c", generation: 3 });
		// Assert
		expect(live()).toEqual([]);
		expect(future).toThrow();
		expect(rows(db)).toHaveLength(2);
	});
	it.each(["l; DROP TABLE x", "l.x", "", "l--"])("rejects invalid SQL alias %j", (linkAlias) => {
		// Arrange / Act
		// @ts-expect-error Untrusted aliases must also fail at runtime.
		const build = () => authLinkLiveGenerationSql({ link: linkAlias });
		// Assert
		expect(build).toThrow();
	});
	it.each(["replace", "upsert", "update", "delete"])(
		"retains immutable audit on %s",
		(operation) => {
			// Arrange
			const db = setup();
			insert(db, audits, audit);
			// Act
			const write = () => {
				if (operation === "replace") insert(db, audits, audit, "INSERT OR REPLACE");
				else if (operation === "upsert")
					insert(db, audits, audit, "INSERT", "ON CONFLICT DO NOTHING");
				else
					db.exec(
						operation === "update"
							? `UPDATE ${audits} SET created_at_ms = 99`
							: `DELETE FROM ${audits}`,
					);
			};
			// Assert
			expect(write).toThrow();
			expect(rows(db, audits)).toEqual([audit]);
		},
	);
});

describe("historical keys and independent namespaces", () => {
	it("reconnects the same account using its retained reservation without moving the old row", () => {
		// Arrange
		const db = setup();
		seed(db);
		const old = db.prepare(`SELECT rowid FROM ${links} WHERE link_id = ?`).get(birth.link_id);
		// Act
		end(db);
		insert(db, links, { ...birth, link_id: "link-b", attempt_id: "attempt-b", generation: 2 });
		const move = () =>
			db.prepare(`UPDATE ${links} SET rowid = 99 WHERE link_id = ?`).run(birth.link_id);
		// Assert
		expect(rows(db)).toHaveLength(2);
		expect(rows(db, associations)).toEqual([reservation]);
		expect(db.prepare(`SELECT rowid FROM ${links} WHERE link_id = ?`).get(birth.link_id)).toEqual(
			old,
		);
		expect(move).toThrow(/auth_account_link_immutable/);
	});
	it("composes a negated live predicate with OR without losing its end-state checks", () => {
		// Arrange
		const db = setup();
		seed(db);
		end(db);
		reconnect(db);
		// Act
		const inactive = db
			.prepare(
				`SELECT l.link_id FROM ${links} l WHERE NOT ${authLinkLiveGenerationSql({ link: "l" })} OR l.link_id = ?`,
			)
			.all("absent");
		// Assert
		expect(inactive).toEqual([{ link_id: "link-a" }]);
	});
	it.each(["link_id", "attempt_id", "generation"])(
		"retains historical %s uniqueness after ending",
		(field) => {
			// Arrange
			const db = setup();
			seed(db);
			end(db);
			const fresh = { ...birth, link_id: "link-b", attempt_id: "attempt-b", generation: 2 };
			Object.assign(fresh, { [field]: birth[field as keyof typeof birth] });
			const before = rows(db);
			// Act
			const replace = () => insert(db, links, fresh, "INSERT OR REPLACE");
			// Assert
			expect(replace).toThrow();
			expect(rows(db)).toEqual(before);
		},
	);
	it("keeps coordinator namespaces separate and accepts the second supported alias", () => {
		// Arrange
		const db = setup();
		seed(db);
		insert(db, associations, { ...reservation, coordinator_id: "other" });
		insert(db, links, { ...birth, coordinator_id: "other" });
		// Act
		db.prepare(`UPDATE ${links} SET revoked_at_ms = ? WHERE coordinator_id = ?`).run(30, "other");
		const live = db
			.prepare(
				`SELECT cl.coordinator_id FROM ${links} cl WHERE ${authLinkLiveGenerationSql({ link: "cl" })}`,
			)
			.all();
		// Assert
		expect(live).toEqual([{ coordinator_id: birth.coordinator_id }]);
	});
	it.each(["rowid", "_rowid_", "oid"])(
		"protects association and audit hidden %s without logical collisions",
		(alias) => {
			// Arrange
			const db = setup();
			seed(db);
			insert(db, audits, audit);
			const freshAssociation = { ...reservation, subject: "other", identity_id: "other" };
			const freshAudit = { ...audit, link_id: "other" };
			// Act
			const replaceAssociation = () =>
				insert(db, associations, { ...freshAssociation, [alias]: 1 }, "INSERT OR REPLACE");
			const replaceAudit = () =>
				insert(db, audits, { ...freshAudit, [alias]: 1 }, "INSERT OR REPLACE");
			// Assert
			expect(replaceAssociation).toThrow();
			expect(replaceAudit).toThrow();
			expect(rows(db, associations)).toEqual([reservation]);
			expect(rows(db, audits)).toEqual([audit]);
		},
	);
});

function winningAttempt(db: SqliteDatabase, changes: Record<string, unknown> = {}) {
	insert(db, attempts, {
		...Object.fromEntries(
			Object.entries(claim).filter(([key]) => !["claim_id", "key_id"].includes(key)),
		),
		created_at_ms: 0,
		expires_at_ms: 600000,
		runtime_verifier_hash: hash,
		loopback_redirect: "http://127.0.0.1:1234/callback",
		state: "finalized",
		browser_transaction_hash: hash,
		completion_secret_hash: hash,
		browser_start_hash: hash,
		account_subject: birth.subject,
		link_id: birth.link_id,
		authority_kind: "device_claim",
		claimed_at_ms: 1,
		oidc_verified_at_ms: 2,
		confirmed_at_ms: 3,
		finalized_at_ms: 10,
		prior_link_id: null,
		prior_generation: null,
		...changes,
	});
}
describe("first-generation proof and predecessor fence", () => {
	it("rejects a matching genesis claim when this Identity already has controller-link history", () => {
		// Arrange
		const db = setup();
		winningAttempt(db);
		insert(db, associations, reservation);
		insert(db, links, {
			...birth,
			link_id: "controller-link",
			attempt_id: "controller-attempt",
			authority_kind: "controller_attestation",
			controller_attestation_id: "attestation",
			device_claim_id: null,
		});
		db.exec(AUTH_LIFECYCLE_GENESIS_GUARD_SQL);
		// Act
		const write = () => insert(db, claims, claim);
		// Assert
		expect(write).toThrow(/auth_device_claim_genesis_unavailable/);
		expect(rows(db, claims)).toEqual([]);
	});
	it("does not activate lifecycle definitions in the actual fresh initializer", () => {
		// Arrange
		const db = connectCoordinator(":memory:");
		databases.push(db);
		// Act
		const ready = db.prepare(AUTH_SCHEMA_READINESS_SQL).get();
		const installed = db
			.prepare("SELECT name FROM sqlite_master WHERE name = ?")
			.all("coordinator_auth_device_claims_first_generation");
		// Assert
		expect(ready).toEqual({ ready: 10 });
		expect(installed).toEqual([]);
		expect(
			db.prepare("SELECT name FROM pragma_table_info(?) WHERE name = ?").all(links, "generation"),
		).toEqual([]);
	});
	it("accepts only the matching finalized first-link claim", () => {
		// Arrange
		const db = setup();
		winningAttempt(db);
		db.exec(AUTH_LIFECYCLE_GENESIS_GUARD_SQL);
		// Act
		insert(db, claims, claim);
		// Assert
		expect(rows(db, claims)).toEqual([claim]);
	});
	it.each([
		{ prior_link_id: "old", prior_generation: 1 },
		{ prior_link_id: "old" },
		{ prior_generation: 1 },
		{ state: "confirmed", link_id: null, finalized_at_ms: null },
		{
			authority_kind: "controller_attestation",
			controller_attestation_id: "attestation",
			controller_review_receipt_id: "review",
			controller_revision: 1,
		},
		...Object.keys(claim)
			.filter((key) => !["claim_id", "key_id", "created_at_ms"].includes(key))
			.map((key) => ({
				[key]: key.includes("revision") || key === "fingerprint" ? "c".repeat(64) : "different",
			})),
		{ finalized_at_ms: 11 },
		{ link_id: "different" },
		{ claimed_at_ms: null },
		{ browser_start_hash: null },
		{ claimed_at_ms: 4, oidc_verified_at_ms: 2 },
	])("rejects non-genesis or mismatching winning proof %j", (changes) => {
		// Arrange
		const db = setup();
		winningAttempt(db, changes);
		db.exec(AUTH_LIFECYCLE_GENESIS_GUARD_SQL);
		// Act
		const write = () => insert(db, claims, claim);
		// Assert
		expect(write).toThrow();
		expect(rows(db, claims)).toEqual([]);
	});
	it("rejects a claim without any winning attempt", () => {
		// Arrange
		const db = setup();
		db.exec(AUTH_LIFECYCLE_GENESIS_GUARD_SQL);
		// Act
		const write = () => insert(db, claims, claim);
		// Assert
		expect(write).toThrow();
		expect(rows(db, claims)).toEqual([]);
	});
	it("takes unchanged predecessor readiness from ten to nine and old initialization cannot restore it", () => {
		// Arrange: production readiness remains the pre-V3 predicate in this inert C0 slice.
		const db = setup();
		const ready = () => db.prepare(AUTH_SCHEMA_READINESS_SQL).get();
		expect(ready()).toEqual({ ready: 10 });
		// Act
		db.exec(AUTH_LIFECYCLE_GENESIS_GUARD_SQL);
		const fenced = ready();
		db.exec(AUTH_LINK_SCHEMA_SQL);
		db.exec(COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL);
		// Assert
		expect(fenced).toEqual({ ready: 9 });
		expect(ready()).toEqual({ ready: 9 });
		expect(
			db
				.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
				.get(claims),
		).toEqual({ n: 4 });
	});
});
