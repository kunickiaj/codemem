import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import {
	AUTH_LIFECYCLE_BROWSER_SEQUENCE_GUARD_STATEMENTS,
	AUTH_LIFECYCLE_BROWSER_TRANSACTION_INDEX_STATEMENTS,
	AUTH_LIFECYCLE_BROWSER_TRANSACTION_TABLE_SQL,
} from "./coordinator-auth-lifecycle-browser-schema.js";
import {
	AUTH_SCHEMA_V2_READINESS_SQL,
	AUTH_SCHEMA_V2_READY_COUNT,
} from "./coordinator-auth-lifecycle-predecessor.js";
import {
	AUTH_LIFECYCLE_ACCOUNT_PROFILE_TABLE_SQL,
	AUTH_LIFECYCLE_LINK_PROFILE_TABLE_SQL,
	AUTH_LINK_PROFILE_REFRESH_TABLE_SQL as AUTH_LIFECYCLE_PROFILE_REFRESH_TABLE_SQL,
} from "./coordinator-auth-lifecycle-profile-schema.js";

const browser = "coordinator_auth_browser_transactions";
const signin = "coordinator_auth_account_profiles";
const linkProfile = "coordinator_auth_link_profiles";
const refresh = "coordinator_auth_link_profile_refreshes";
const hash = "a".repeat(64);
const transaction = {
	coordinator_id: "coordinator",
	browser_transaction_hash: hash,
	purpose: "signin",
	attempt_id: null,
	state_hash: hash,
	binder_hash: hash,
	issuer: "https://accounts.google.com",
	auth_config_revision: hash,
	redirect_uri: "http://127.0.0.1:1234/callback",
	state: "pending",
	nonce: "n".repeat(43),
	pkce_verifier: "p".repeat(43),
	claim_token: null,
	created_at_ms: 0,
	expires_at_ms: 600000,
	consumed_at_ms: null,
};
const display = {
	display_name: "Name",
	email: "fixture@example.test",
	email_verified: 1,
	picture_url: "https://example.test/picture",
};
const account = {
	coordinator_id: "coordinator",
	link_id: "link",
	...display,
	source_session_id: "session",
	source_signed_in_at_ms: 10,
};
const staged = {
	coordinator_id: "coordinator",
	attempt_id: "attempt",
	issuer: transaction.issuer,
	subject: "google-a",
	auth_config_revision: hash,
	browser_transaction_hash: hash,
	link_id: null,
	...display,
	verified_at_ms: 10,
};
const snapshot = {
	coordinator_id: "coordinator",
	link_id: "link",
	...display,
	source_attempt_id: "refresh",
	verified_at_ms: 10,
	source_order: 2,
};
const databases: SqliteDatabase[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function setup() {
	const db = new Database(":memory:");
	databases.push(db);
	for (const sql of [
		AUTH_LIFECYCLE_BROWSER_TRANSACTION_TABLE_SQL,
		...AUTH_LIFECYCLE_BROWSER_TRANSACTION_INDEX_STATEMENTS,
		...AUTH_LIFECYCLE_BROWSER_SEQUENCE_GUARD_STATEMENTS,
		AUTH_LIFECYCLE_ACCOUNT_PROFILE_TABLE_SQL,
		AUTH_LIFECYCLE_LINK_PROFILE_TABLE_SQL,
		AUTH_LIFECYCLE_PROFILE_REFRESH_TABLE_SQL,
	])
		db.exec(sql);
	return db;
}
function insert(
	db: SqliteDatabase,
	table: string,
	row: Record<string, unknown>,
	options: { mode?: string; conflict?: string } = {},
) {
	const columns = Object.keys(row);
	return db
		.prepare(
			`${options.mode ?? "INSERT"} INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ${options.conflict ?? ""}`,
		)
		.run(...columns.map((key) => row[key]));
}
function rows(db: SqliteDatabase, table: string) {
	return db.prepare(`SELECT * FROM ${table}`).all();
}
function freshTransaction() {
	return {
		...transaction,
		browser_transaction_hash: "b".repeat(64),
		state_hash: "b".repeat(64),
		binder_hash: "b".repeat(64),
		attempt_id: "other-attempt",
		claim_token: "other-claim",
	};
}

describe("lifecycle browser storage", () => {
	it.each(["signin", "link", "owner_enroll", "link_change"])(
		"stores %s with its exact purpose-specific attempt pin",
		(purpose) => {
			// Arrange
			const db = setup();
			const row = { ...transaction, purpose, attempt_id: purpose === "signin" ? null : "attempt" };
			// Act
			insert(db, browser, row);
			// Assert
			expect(rows(db, browser)).toEqual([{ ...row, browser_sequence: 1 }]);
		},
	);
	it.each(["signin", "link", "owner_enroll", "link_change", "switch"])(
		"rejects invalid attempt/purpose tuple %s",
		(purpose) => {
			// Arrange
			const db = setup();
			const row = { ...transaction, purpose, attempt_id: purpose === "signin" ? "attempt" : null };
			// Act
			const write = () => insert(db, browser, row);
			// Assert
			expect(write).toThrow(/CHECK/);
			expect(rows(db, browser)).toEqual([]);
		},
	);
	it.each(["browser_transaction_hash", "state_hash", "binder_hash", "attempt_id", "claim_token"])(
		"retains the existing %s unique",
		(field) => {
			// Arrange
			const db = setup();
			const first = {
				...transaction,
				purpose: "link",
				attempt_id: "attempt",
				state: "consumed",
				nonce: null,
				pkce_verifier: null,
				claim_token: "claim",
				consumed_at_ms: 10,
			};
			insert(db, browser, first);
			const second = {
				...freshTransaction(),
				purpose: "link",
				state: "consumed",
				nonce: null,
				pkce_verifier: null,
				consumed_at_ms: 10,
				[field]: first[field as keyof typeof first],
			};
			// Act
			const write = () => insert(db, browser, second);
			// Assert
			expect(write).toThrow(/auth_browser_transaction_collision/);
			expect(rows(db, browser)).toHaveLength(1);
		},
	);
	it.each([
		{ nonce: null },
		{ pkce_verifier: null },
		{ nonce: "short" },
		{ pkce_verifier: "bad!" },
		{ state: "consumed" },
		{ state: "expired" },
		{ claim_token: "claim" },
		{ consumed_at_ms: 10 },
		{ state: "consumed", nonce: null, pkce_verifier: null, claim_token: "claim" },
		{
			state: "consumed",
			nonce: null,
			pkce_verifier: null,
			claim_token: "claim",
			consumed_at_ms: 600000,
		},
	])("retains nonce/PKCE and consumption CHECKs %j", (changes) => {
		// Arrange
		const db = setup();
		// Act
		const write = () => insert(db, browser, { ...transaction, ...changes });
		// Assert
		expect(write).toThrow(/CHECK/);
		expect(rows(db, browser)).toEqual([]);
	});
	it.each(["consumed", "expired"])(
		"permits a valid %s transaction with erased secrets",
		(state) => {
			// Arrange
			const db = setup();
			const row = {
				...transaction,
				state,
				nonce: null,
				pkce_verifier: null,
				claim_token: state === "consumed" ? "claim" : null,
				consumed_at_ms: state === "consumed" ? 10 : null,
			};
			// Act
			insert(db, browser, row);
			// Assert
			expect(rows(db, browser)).toEqual([{ ...row, browser_sequence: 1 }]);
		},
	);
	it("never reuses the highest allocated sequence after cleanup", () => {
		// Arrange
		const db = setup();
		insert(db, browser, { ...transaction, browser_sequence: 40 });
		// Act
		db.prepare(`DELETE FROM ${browser}`).run();
		insert(db, browser, transaction);
		// Assert
		expect(rows(db, browser)).toEqual([{ ...transaction, browser_sequence: 41 }]);
	});
	it("keeps its sequence while a valid consume transition erases browser secrets", () => {
		// Arrange
		const db = setup();
		insert(db, browser, transaction);
		// Act
		db.prepare(
			`UPDATE ${browser} SET state = ?, nonce = NULL, pkce_verifier = NULL, claim_token = ?, consumed_at_ms = ?`,
		).run("consumed", "claim", 10);
		// Assert
		expect(rows(db, browser)).toEqual([
			{
				...transaction,
				browser_sequence: 1,
				state: "consumed",
				nonce: null,
				pkce_verifier: null,
				claim_token: "claim",
				consumed_at_ms: 10,
			},
		]);
	});
	it.each(["browser_sequence", "rowid", "_rowid_", "oid"])(
		"rejects changing sequence through %s",
		(alias) => {
			// Arrange
			const db = setup();
			insert(db, browser, transaction);
			// Act
			const write = () => db.prepare(`UPDATE ${browser} SET ${alias} = ?`).run(9);
			// Assert
			expect(write).toThrow();
			expect(rows(db, browser)).toEqual([{ ...transaction, browser_sequence: 1 }]);
		},
	);
});

describe("browser insert collisions cannot resequence retained proofs", () => {
	it.each(
		(
			[
				"browser_sequence",
				"browser_transaction_hash",
				"state_hash",
				"binder_hash",
				"attempt_id",
				"claim_token",
			] as const
		).flatMap((field) =>
			[
				{ mode: "INSERT", conflict: "" },
				{ mode: "INSERT OR REPLACE", conflict: "" },
				{ mode: "INSERT", conflict: "ON CONFLICT DO NOTHING" },
				{
					mode: "INSERT",
					conflict: "ON CONFLICT DO UPDATE SET browser_sequence = excluded.browser_sequence",
				},
			].map((options) => ({ field, ...options })),
		),
	)("rejects only-$field collision with $mode $conflict", ({ field, ...options }) => {
		// Arrange: consumed link rows make both nullable unique keys present and valid.
		const db = setup();
		db.pragma("recursive_triggers = OFF");
		const first = {
			...transaction,
			browser_sequence: 7,
			purpose: "link",
			attempt_id: "attempt",
			state: "consumed",
			nonce: null,
			pkce_verifier: null,
			claim_token: "claim",
			consumed_at_ms: 10,
		};
		const clean = {
			...freshTransaction(),
			purpose: "link",
			state: "consumed",
			nonce: null,
			pkce_verifier: null,
			consumed_at_ms: 10,
		};
		insert(db, browser, first);
		const candidate = { ...clean, browser_sequence: 8, [field]: first[field] };
		if (field === "browser_sequence") candidate.coordinator_id = "other-coordinator";
		const before = rows(db, browser);
		const sequence = rows(db, "sqlite_sequence");
		// Act
		const write = () => insert(db, browser, candidate, options);
		// Assert
		expect(db.pragma("recursive_triggers", { simple: true })).toBe(0);
		expect(write).toThrow(/auth_browser_transaction_collision/);
		expect(rows(db, browser)).toEqual(before);
		expect(rows(db, "sqlite_sequence")).toEqual(sequence);
		insert(db, browser, clean);
		expect(rows(db, browser)).toEqual([first, { ...clean, browser_sequence: 8 }]);
	});
	it("keeps composite uniques coordinator-scoped while allocating a fresh global sequence", () => {
		// Arrange
		const db = setup();
		insert(db, browser, transaction);
		// Act
		insert(db, browser, { ...transaction, coordinator_id: "other-coordinator" });
		// Assert
		expect(rows(db, browser)).toEqual([
			{ ...transaction, browser_sequence: 1 },
			{ ...transaction, coordinator_id: "other-coordinator", browser_sequence: 2 },
		]);
	});
	it("permits multiple sign-in rows with null attempt and claim-token keys", () => {
		// Arrange
		const db = setup();
		insert(db, browser, transaction);
		const second = {
			...transaction,
			browser_transaction_hash: "b".repeat(64),
			state_hash: "b".repeat(64),
			binder_hash: "b".repeat(64),
		};
		// Act
		insert(db, browser, second);
		// Assert
		expect(rows(db, browser)).toEqual([
			{ ...transaction, browser_sequence: 1 },
			{ ...second, browser_sequence: 2 },
		]);
	});
	it("cannot replace an old sign-in to jump a reconnect floor or raise its source order", () => {
		// Arrange
		const db = setup();
		db.pragma("recursive_triggers = OFF");
		insert(db, browser, { ...transaction, browser_sequence: 7 });
		const sequence = rows(db, "sqlite_sequence");
		// Act
		const replace = () =>
			insert(db, browser, { ...transaction, browser_sequence: 50 }, { mode: "INSERT OR REPLACE" });
		// Assert
		expect(replace).toThrow(/auth_browser_transaction_collision/);
		expect(rows(db, browser)).toEqual([{ ...transaction, browser_sequence: 7 }]);
		expect(rows(db, "sqlite_sequence")).toEqual(sequence);
		expect(
			db
				.prepare(
					`SELECT browser_sequence > ? AS above_floor, browser_sequence + 1 AS source_order FROM ${browser}`,
				)
				.get(7),
		).toEqual({ above_floor: 0, source_order: 8 });
	});
});

describe("sequence and source-order limits", () => {
	it("permits the last sequence-plus-one order and rejects allocating beyond it after cleanup", () => {
		// Arrange
		const db = setup();
		insert(db, browser, { ...transaction, browser_sequence: Number.MAX_SAFE_INTEGER - 1 });
		// Act
		db.prepare(
			`INSERT INTO ${refresh} (coordinator_id, link_id, source_attempt_id, verified_at_ms, source_order) SELECT coordinator_id, ?, ?, ?, browser_sequence + 1 FROM ${browser}`,
		).run("link", "refresh", 10);
		db.prepare(`DELETE FROM ${browser}`).run();
		const overflow = () => insert(db, browser, transaction);
		// Assert
		expect(rows(db, refresh)).toEqual([
			{
				...snapshot,
				display_name: null,
				email: null,
				email_verified: null,
				picture_url: null,
				source_order: Number.MAX_SAFE_INTEGER,
			},
		]);
		expect(overflow).toThrow(/CHECK/);
		expect(rows(db, browser)).toEqual([]);
	});
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects unsafe sign-in order %s",
		(source_order) => {
			// Arrange
			const db = setup();
			// Act
			const write = () => insert(db, signin, { ...account, source_order });
			// Assert
			expect(write).toThrow(/CHECK/);
			expect(rows(db, signin)).toEqual([]);
		},
	);
	it.each([1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects unsafe staged-link order %s",
		(source_order) => {
			// Arrange
			const db = setup();
			// Act
			const write = () => insert(db, linkProfile, { ...staged, source_order });
			// Assert
			expect(write).toThrow(/CHECK/);
			expect(rows(db, linkProfile)).toEqual([]);
		},
	);
});

describe("lifecycle display-only storage", () => {
	it("retains raw sign-in and link columns with separate legacy source-order baselines", () => {
		// Arrange
		const db = setup();
		// Act
		insert(db, signin, account);
		insert(db, linkProfile, staged);
		// Assert
		expect(rows(db, signin)).toEqual([{ ...account, source_order: 1 }]);
		expect(rows(db, linkProfile)).toEqual([{ ...staged, source_order: 0, source_purpose: "link" }]);
	});
	it.each(["source_session_id", "source_signed_in_at_ms"])(
		"does not fabricate missing sign-in %s",
		(field) => {
			// Arrange
			const db = setup();
			// Act
			const write = () => insert(db, signin, { ...account, [field]: null });
			// Assert
			expect(write).toThrow(/NOT NULL/);
			expect(rows(db, signin)).toEqual([]);
		},
	);
	it.each([{}, { source_order: 0 }])(
		"rejects link_change staging with legacy order %j",
		(order) => {
			// Arrange
			const db = setup();
			// Act
			const write = () =>
				insert(db, linkProfile, { ...staged, source_purpose: "link_change", ...order });
			// Assert
			expect(write).toThrow(/CHECK/);
			expect(rows(db, linkProfile)).toEqual([]);
		},
	);
	it("stages link_change display data privately and stores an attempt-sourced refresh without session columns", () => {
		// Arrange
		const db = setup();
		const row = { ...staged, source_purpose: "link_change", source_order: 2 };
		// Act
		insert(db, linkProfile, row);
		insert(db, refresh, snapshot);
		// Assert
		expect(rows(db, linkProfile)).toEqual([row]);
		expect(rows(db, refresh)).toEqual([snapshot]);
		expect(
			db
				.prepare(`SELECT name FROM pragma_table_info('${refresh}') WHERE name LIKE '%session%'`)
				.all(),
		).toEqual([]);
	});
	it.each(["signin", "switch", "", null])(
		"rejects unsupported staged source purpose %j",
		(source_purpose) => {
			// Arrange
			const db = setup();
			// Act
			const write = () => insert(db, linkProfile, { ...staged, source_purpose });
			// Assert
			expect(write).toThrow();
			expect(rows(db, linkProfile)).toEqual([]);
		},
	);
	it("does not publish link-change staging as original link metadata", () => {
		// Arrange
		const db = setup();
		// Act
		const write = () =>
			insert(db, linkProfile, {
				...staged,
				source_purpose: "link_change",
				source_order: 2,
				link_id: "link",
			});
		// Assert
		expect(write).toThrow(/CHECK/);
		expect(rows(db, linkProfile)).toEqual([]);
	});
	it.each([signin, linkProfile, refresh])(
		"accepts an empty snapshot and rejects email verification without email in %s",
		(table) => {
			// Arrange
			const db = setup();
			const base = { [signin]: account, [linkProfile]: staged, [refresh]: snapshot }[table];
			const empty = {
				...base,
				display_name: null,
				email: null,
				email_verified: null,
				picture_url: null,
			};
			// Act
			const invalid = () => insert(db, table, { ...empty, email_verified: 1 });
			// Assert
			expect(invalid).toThrow(/CHECK/);
			insert(db, table, empty);
			expect(rows(db, table)).toHaveLength(1);
		},
	);
	it.each([
		{ source_attempt_id: null },
		{ source_attempt_id: "" },
		{ source_order: -1 },
		{ source_order: 1.5 },
		{ source_order: Number.MAX_SAFE_INTEGER + 1 },
		{ verified_at_ms: -1 },
		{ verified_at_ms: 1.5 },
		{ email_verified: 2 },
		{ email_verified: "invalid" },
	])("rejects malformed refresh source metadata %j", (changes) => {
		// Arrange
		const db = setup();
		// Act
		const write = () => insert(db, refresh, { ...snapshot, ...changes });
		// Assert
		expect(write).toThrow();
		expect(rows(db, refresh)).toEqual([]);
	});
	it("retains coordinator/link refresh keys and permits independent namespaces", () => {
		// Arrange
		const db = setup();
		insert(db, refresh, snapshot);
		// Act
		const duplicate = () => insert(db, refresh, { ...snapshot, source_attempt_id: "other" });
		insert(db, refresh, { ...snapshot, coordinator_id: "other" });
		// Assert
		expect(duplicate).toThrow(/UNIQUE/);
		expect(rows(db, refresh)).toHaveLength(2);
	});
});

it("leaves current initialization inert and frozen V2 readiness at ten", () => {
	// Arrange
	const db = connectCoordinator(":memory:");
	databases.push(db);
	// Act
	const ready = db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).get();
	// Assert
	expect(AUTH_SCHEMA_V2_READY_COUNT).toBe(10);
	expect(ready).toEqual({ ready: 10 });
	expect(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").all(refresh)).toEqual([]);
	expect(
		db
			.prepare(`SELECT name FROM pragma_table_info('${browser}') WHERE name = 'browser_sequence'`)
			.all(),
	).toEqual([]);
	for (const table of [signin, linkProfile])
		expect(
			db
				.prepare(
					"SELECT name FROM pragma_table_info(?) WHERE name IN ('source_order','source_purpose')",
				)
				.all(table),
		).toEqual([]);
});
