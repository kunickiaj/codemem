import { readdirSync, readFileSync } from "node:fs";
import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import {
	AUTH_LIFECYCLE_CURRENT_READINESS_SQL,
	AUTH_LIFECYCLE_CURRENT_READY_COUNT,
} from "./coordinator-auth-lifecycle-current-readiness.js";
import { authLifecycleFirstLinkStatements } from "./coordinator-auth-lifecycle-first-link.js";
import { AUTH_LIFECYCLE_FRESH_SCHEMA_STATEMENTS as AUTH_LIFECYCLE_CURRENT_SCHEMA_STATEMENTS } from "./coordinator-auth-lifecycle-fresh-schema.js";
import { AUTH_SCHEMA_V2_READINESS_SQL } from "./coordinator-auth-lifecycle-predecessor.js";
import { upgradeAuthLifecycleSchema } from "./coordinator-auth-lifecycle-upgrade-sqlite.js";
import { AUTH_LINK_AUTHORITY_CUTOVER_SQL } from "./coordinator-auth-link-authority-upgrade.js";

const links = "coordinator_auth_account_links";
const associations = "coordinator_auth_account_associations";
const attempts = "coordinator_auth_link_attempts";
const claims = "coordinator_auth_device_claims";
const browser = "coordinator_auth_browser_transactions";
const revision = "a".repeat(64);
const config = {
	coordinatorId: "synthetic-coordinator",
	issuer: "https://issuer.example.test",
	revision,
	enabled: true,
};
const winning = {
	coordinator_id: config.coordinatorId,
	attempt_id: "attempt",
	identity_id: "actor",
	group_id: "group",
	device_id: "device",
	public_key: "synthetic-key\r\n",
	fingerprint: revision,
	controller_attestation_id: "attestation",
	controller_review_receipt_id: "review",
	controller_revision: 1,
	issuer: config.issuer,
	auth_config_revision: revision,
	runtime_verifier_hash: revision,
	loopback_redirect: "http://127.0.0.1:1234/callback",
	state: "finalized",
	browser_transaction_hash: revision,
	account_subject: "subject-a",
	completion_secret_hash: revision,
	link_id: "new-link",
	created_at_ms: 0,
	expires_at_ms: 600000,
	claimed_at_ms: 1,
	oidc_verified_at_ms: 2,
	confirmed_at_ms: 3,
	finalized_at_ms: 10,
	authority_kind: "controller_attestation",
	browser_start_hash: revision,
	prior_link_id: null,
	prior_generation: null,
};
const databases: SqliteDatabase[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function memory() {
	const db = new Database(":memory:");
	databases.push(db);
	return db;
}
function fresh() {
	const db = memory();
	for (const sql of AUTH_LIFECYCLE_CURRENT_SCHEMA_STATEMENTS) db.exec(sql);
	return db;
}
function old(source: "inline" | "migrations") {
	if (source === "inline") {
		const db = connectCoordinator(":memory:");
		databases.push(db);
		return db;
	}
	const db = memory();
	const directory = new URL("../../cloudflare-coordinator-worker/migrations/", import.meta.url);
	for (const name of readdirSync(directory)
		.filter((name) => /^00(?:[0-2]\d|3[0-3])_.*\.sql$/u.test(name))
		.sort())
		db.exec(readFileSync(new URL(name, directory), "utf8"));
	db.exec(AUTH_LINK_AUTHORITY_CUTOVER_SQL);
	return db;
}
function insert(db: SqliteDatabase, table: string, row: Record<string, unknown>) {
	const columns = Object.keys(row);
	db.prepare(
		`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
	).run(...columns.map((key) => row[key]));
}
function rows(db: SqliteDatabase, table: string) {
	return db.prepare(`SELECT * FROM ${table}`).all();
}
function firstLink(db: SqliteDatabase) {
	for (const statement of authLifecycleFirstLinkStatements({
		attemptId: "attempt",
		coordinatorId: config.coordinatorId,
		issuer: config.issuer,
		authConfigRevision: config.revision,
		now: 10,
		linkId: "new-link",
	}))
		db.prepare(statement.sql).run(...statement.values);
}
function ready(db: SqliteDatabase) {
	return db.prepare(AUTH_LIFECYCLE_CURRENT_READINESS_SQL).get();
}
function reserve(db: SqliteDatabase, changes: Record<string, unknown> = {}) {
	insert(db, associations, {
		coordinator_id: config.coordinatorId,
		issuer: config.issuer,
		subject: "subject-a",
		identity_id: "actor",
		first_link_id: "new-link",
		created_at_ms: 10,
		...changes,
	});
}
function seedBrowser(
	db: SqliteDatabase,
	coordinator_id = config.coordinatorId,
	browser_sequence = 31,
) {
	insert(db, browser, {
		browser_sequence,
		coordinator_id,
		browser_transaction_hash: revision,
		purpose: "signin",
		state_hash: revision,
		binder_hash: revision,
		issuer: config.issuer,
		auth_config_revision: revision,
		redirect_uri: "http://127.0.0.1:1234/callback",
		state: "pending",
		nonce: "n".repeat(43),
		pkce_verifier: "p".repeat(43),
		created_at_ms: 0,
		expires_at_ms: 600000,
	});
}

describe("unused V3 schema and readiness leaves", () => {
	it("initializes V3 auth from nothing without invoking an existing-store upgrader", () => {
		// Arrange
		const db = memory();
		// Act: execute only the fresh schema's complete statements, not an upgrader.
		for (const sql of AUTH_LIFECYCLE_CURRENT_SCHEMA_STATEMENTS) db.exec(sql);
		// Assert
		expect(ready(db)).toEqual({ ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT });
		expect(db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).get()).toEqual({ ready: 9 });
		expect(
			db
				.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
				.get(claims),
		).toEqual({ n: 4 });
		expect(rows(db, associations)).toEqual([]);
	});
	it.each(["inline", "migrations"] as const)(
		"accepts the actual empty upgraded %s family and rejects its unupgraded predecessor",
		(source) => {
			// Arrange
			const db = old(source);
			expect(ready(db)).not.toEqual({ ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT });
			// Act
			upgradeAuthLifecycleSchema(db);
			// Assert
			expect(ready(db)).toEqual(ready(fresh()));
			expect(db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).get()).toEqual({ ready: 9 });
		},
	);
	it.each([
		"DROP TRIGGER coordinator_auth_device_claims_first_generation",
		"DROP TRIGGER auth_sessions_insert_admission",
		"DROP TRIGGER auth_account_links_insert_collision",
		"DROP TRIGGER auth_sessions_insert_admission; CREATE TRIGGER auth_sessions_insert_admission BEFORE INSERT ON coordinator_auth_sessions BEGIN SELECT 1; END;",
		"DROP INDEX idx_auth_account_links_open_identity",
		"ALTER TABLE coordinator_auth_link_profile_refreshes ADD COLUMN unexpected TEXT",
		"CREATE TRIGGER coordinator_auth_account_links AFTER INSERT ON coordinator_auth_account_links BEGIN SELECT 1; END;",
	])("rejects an incomplete or unexpected V3 definition: %s", (damage) => {
		// Arrange
		const db = fresh();
		db.exec(damage);
		// Act
		const actual = ready(db);
		// Assert
		expect(actual).not.toEqual({ ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT });
	});
	it.each(["layout", "merged type", "changed CHECK"])(
		"matches reviewed V3 layout without merging type or CHECK tokens: %s",
		(damage) => {
			// Arrange
			const db = fresh();
			const definition = db
				.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
				.pluck()
				.get(browser) as string;
			const attached = db
				.prepare(
					"SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('trigger','index') AND sql IS NOT NULL",
				)
				.all(browser) as { sql: string }[];
			db.exec(`DROP TABLE ${browser}`);
			let changed = definition.replaceAll("\n", "\n\t");
			if (damage === "merged type")
				changed = definition.replace("coordinator_id TEXT NOT NULL", "coordinator_id TEXTNOTNULL");
			if (damage === "changed CHECK") changed = definition.replaceAll("'pending'", "'pen ding'");
			db.exec(changed);
			for (const { sql } of attached) db.exec(sql);
			// Act
			const actual = ready(db);
			// Assert
			if (damage === "layout")
				expect(actual).toEqual({ ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT });
			else expect(actual).not.toEqual({ ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT });
		},
	);
});

describe("readiness closed inventories", () => {
	it.each([
		{
			check: "external dependency",
			sql: "CREATE TRIGGER caller_auth_writer AFTER INSERT ON caller_events BEGIN DELETE FROM coordinator_auth_sessions; END;",
		},
		{ check: "reserved name", sql: "CREATE TABLE coordinator_auth_lifecycle_x(a)" },
	])(
		"rejects only the $check inventory without treating caller-owned objects as auth attachments",
		({ sql }) => {
			// Arrange: unrelated caller-owned tables, indexes, views and triggers remain allowed.
			const db = fresh();
			db.exec(
				"CREATE TABLE caller_events(a); INSERT INTO caller_events VALUES ('retained'); CREATE INDEX caller_event_index ON caller_events(a); CREATE VIEW caller_event_view AS SELECT a FROM caller_events; CREATE TRIGGER caller_event_trigger AFTER INSERT ON caller_events BEGIN SELECT NEW.a; END;",
			);
			expect(ready(db)).toEqual({ ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT });
			// Act: neither object attaches to an auth table, so exactly one other inventory fails.
			db.exec(sql);
			const actual = ready(db);
			// Assert
			expect(actual).toEqual({ ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT - 1 });
			expect(rows(db, "caller_events")).toEqual([{ a: "retained" }]);
		},
	);
});

describe("first-generation association and link SQL", () => {
	it.each(["controller_attestation", "device_claim"])(
		"derives %s authority only from a matching winning attempt",
		(authority_kind) => {
			// Arrange: these synthetic proof rows test SQL pins, not provider or device authorization.
			const db = fresh();
			seedBrowser(db);
			seedBrowser(db, "other-coordinator", 99);
			const attempt = { ...winning, authority_kind };
			if (authority_kind === "device_claim")
				Object.assign(attempt, {
					controller_attestation_id: null,
					controller_review_receipt_id: null,
					controller_revision: null,
				});
			insert(db, attempts, attempt);
			if (authority_kind === "device_claim")
				insert(db, claims, {
					claim_id: "new-link",
					coordinator_id: config.coordinatorId,
					identity_id: "actor",
					group_id: "group",
					device_id: "device",
					public_key: winning.public_key,
					fingerprint: revision,
					key_id: "b".repeat(64),
					attempt_id: "attempt",
					issuer: config.issuer,
					auth_config_revision: revision,
					created_at_ms: 10,
				});
			// Act
			firstLink(db);
			// Assert
			expect(rows(db, links)).toMatchObject([
				{
					coordinator_id: config.coordinatorId,
					link_id: "new-link",
					identity_id: "actor",
					issuer: config.issuer,
					subject: "subject-a",
					authority_kind,
					controller_attestation_id: attempt.controller_attestation_id,
					device_claim_id: authority_kind === "device_claim" ? "new-link" : null,
					generation: 1,
					signin_sequence_floor: 31,
				},
			]);
			expect(rows(db, associations)).toMatchObject([
				{ identity_id: "actor", first_link_id: "new-link", created_at_ms: 10 },
			]);
			expect(rows(db, "coordinator_auth_link_profiles")).toEqual([]);
			expect(rows(db, "coordinator_auth_link_audit_log")).toEqual([]);
		},
	);
	it("uses floor zero when no browser transaction has been allocated for this coordinator", () => {
		// Arrange
		const db = fresh();
		insert(db, attempts, winning);
		seedBrowser(db, "other-coordinator", 99);
		// Act
		firstLink(db);
		// Assert
		expect(rows(db, links)).toMatchObject([{ signin_sequence_floor: 0 }]);
	});
});

describe("first-generation denial and rollback", () => {
	it("does not replay insertion for a retained first-generation result", () => {
		// Arrange
		const db = fresh();
		insert(db, attempts, winning);
		firstLink(db);
		const before = [rows(db, associations), rows(db, links)];
		// Act: result reconciliation remains the future caller's job.
		firstLink(db);
		// Assert
		expect([rows(db, associations), rows(db, links)]).toEqual(before);
	});
	it("does not treat the same link ID with a different birth subject as an exact retry", () => {
		// Arrange
		const db = fresh();
		insert(db, attempts, winning);
		firstLink(db);
		const snapshot = () => [attempts, associations, links].map((table) => rows(db, table));
		const before = snapshot();
		// Act
		const mismatchedRetry = db.transaction(() => {
			db.prepare(`UPDATE ${attempts} SET account_subject = ? WHERE attempt_id = ?`).run(
				"different-subject",
				"attempt",
			);
			firstLink(db);
		});
		// Assert
		expect(() => mismatchedRetry.immediate()).toThrow(/auth_account_link_collision/);
		expect(snapshot()).toEqual(before);
	});
	it.each(["open", "ended", "revoked"])(
		"rolls back a winning first-link transition when the Identity has %s history",
		(history) => {
			// Arrange
			const db = fresh();
			reserve(db, { subject: "old-subject", first_link_id: "old-link" });
			insert(db, links, {
				coordinator_id: config.coordinatorId,
				link_id: "old-link",
				issuer: config.issuer,
				subject: "old-subject",
				identity_id: "actor",
				attempt_id: "old-attempt",
				controller_attestation_id: "attestation",
				auth_config_revision: revision,
				created_at_ms: 0,
				authority_kind: "controller_attestation",
				generation: 1,
				signin_sequence_floor: 0,
				ended_at_ms: history === "ended" ? 5 : null,
				end_reason: history === "ended" ? "user_disconnected" : null,
				end_attempt_id: history === "ended" ? "old-disconnect" : null,
				revoked_at_ms: history === "revoked" ? 5 : null,
			});
			insert(db, attempts, {
				...winning,
				state: "confirmed",
				link_id: null,
				finalized_at_ms: null,
			});
			const snapshot = () =>
				[attempts, associations, links, "coordinator_auth_link_audit_log"].map((table) =>
					rows(db, table),
				);
			const before = snapshot();
			// Act: exercise a real winning UPDATE, not a pre-finalized orphan fixture.
			const finalize = db.transaction(() => {
				const result = db
					.prepare(
						`UPDATE ${attempts} SET state = 'finalized', link_id = ?, finalized_at_ms = ? WHERE attempt_id = ? AND state = 'confirmed'`,
					)
					.run("new-link", 10, "attempt");
				expect(result.changes).toBe(1);
				firstLink(db);
			});
			// Assert
			expect(() => finalize.immediate()).toThrow();
			expect(snapshot()).toEqual(before);
			expect(rows(db, attempts)).toMatchObject([
				{ state: "confirmed", link_id: null, finalized_at_ms: null },
			]);
		},
	);
});

describe("first-generation proof pins", () => {
	it("rolls back a device-claim winner if its genesis proof was not inserted first", () => {
		// Arrange
		const db = fresh();
		insert(db, attempts, {
			...winning,
			state: "confirmed",
			link_id: null,
			finalized_at_ms: null,
			authority_kind: "device_claim",
			controller_attestation_id: null,
			controller_review_receipt_id: null,
			controller_revision: null,
		});
		const before = rows(db, attempts);
		// Act
		const finalize = db.transaction(() => {
			const result = db
				.prepare(
					`UPDATE ${attempts} SET state = 'finalized', link_id = ?, finalized_at_ms = ? WHERE attempt_id = ? AND state = 'confirmed'`,
				)
				.run("new-link", 10, "attempt");
			expect(result.changes).toBe(1);
			firstLink(db);
		});
		// Assert
		expect(() => finalize.immediate()).toThrow(/NOT NULL/);
		expect(rows(db, attempts)).toEqual(before);
		for (const table of [claims, associations, links]) expect(rows(db, table)).toEqual([]);
	});
	it.each([
		{ coordinator_id: "other-coordinator" },
		{ issuer: "https://other.example.test" },
		{ auth_config_revision: "b".repeat(64) },
		{ link_id: "old-link" },
		{ finalized_at_ms: 11 },
		{ prior_link_id: "old-link", prior_generation: 1 },
		{ state: "confirmed", link_id: null, finalized_at_ms: null },
		{ state: "session_redeemed" },
	])("does not insert from a non-winning attempt %j", (changes) => {
		// Arrange
		const db = fresh();
		insert(db, attempts, { ...winning, ...changes });
		// Act
		firstLink(db);
		// Assert
		expect(rows(db, associations)).toEqual([]);
		expect(rows(db, links)).toEqual([]);
	});
	it("does not manufacture an association or link when the attempt is missing", () => {
		// Arrange
		const db = fresh();
		// Act
		firstLink(db);
		// Assert
		expect(rows(db, associations)).toEqual([]);
		expect(rows(db, links)).toEqual([]);
	});
	it("does not rewrite an existing same-Actor permanent reservation", () => {
		// Arrange
		const db = fresh();
		insert(db, attempts, winning);
		reserve(db, { first_link_id: "original-link", created_at_ms: 1 });
		const before = rows(db, associations);
		// Act
		firstLink(db);
		// Assert
		expect(rows(db, associations)).toEqual(before);
		expect(rows(db, links)).toHaveLength(1);
	});
	it("rolls back the winning transition and new root claim if another Actor reserved the account", () => {
		// Arrange
		const db = fresh();
		reserve(db, { identity_id: "other-actor", first_link_id: "other-link" });
		insert(db, attempts, {
			...winning,
			state: "confirmed",
			link_id: null,
			finalized_at_ms: null,
			authority_kind: "device_claim",
			controller_attestation_id: null,
			controller_review_receipt_id: null,
			controller_revision: null,
		});
		const before = rows(db, attempts);
		// Act: the future writer owns this atomic batch; the leaf does not authenticate callers.
		const finalize = db.transaction(() => {
			db.prepare(
				`UPDATE ${attempts} SET state = 'finalized', link_id = ?, finalized_at_ms = ?`,
			).run("new-link", 10);
			insert(db, claims, {
				claim_id: "new-link",
				coordinator_id: config.coordinatorId,
				identity_id: "actor",
				group_id: "group",
				device_id: "device",
				public_key: winning.public_key,
				fingerprint: revision,
				key_id: "b".repeat(64),
				attempt_id: "attempt",
				issuer: config.issuer,
				auth_config_revision: revision,
				created_at_ms: 10,
			});
			firstLink(db);
		});
		// Assert
		expect(() => finalize.immediate()).toThrow(/auth_account_link_unavailable/);
		expect(rows(db, attempts)).toEqual(before);
		expect(rows(db, claims)).toEqual([]);
		expect(rows(db, links)).toEqual([]);
		expect(rows(db, associations)).toMatchObject([
			{ identity_id: "other-actor", first_link_id: "other-link" },
		]);
	});
});
