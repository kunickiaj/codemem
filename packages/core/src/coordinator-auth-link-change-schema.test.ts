import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL } from "./coordinator-auth-device-claim-schema.js";
import {
	AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS,
	AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL,
	AUTH_ACCOUNT_LINK_GENERATION_GUARD_STATEMENTS,
	AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS,
	AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL,
} from "./coordinator-auth-lifecycle-schema.js";
import {
	AUTH_LINK_CHANGE_ATTEMPT_GUARD_STATEMENTS,
	AUTH_LINK_CHANGE_ATTEMPT_INDEX_STATEMENTS,
	AUTH_LINK_CHANGE_ATTEMPT_TABLE_SQL,
	AUTH_LINK_CHANGE_END_RECEIPT_GUARD_SQL,
} from "./coordinator-auth-link-change-schema.js";

const attempts = "coordinator_auth_link_change_attempts";
const links = "coordinator_auth_account_links";
const associations = "coordinator_auth_account_associations";
const hash = "a".repeat(64);
const birth = {
	coordinator_id: "coordinator",
	link_id: "link",
	issuer: "https://accounts.google.com",
	subject: "subject",
	identity_id: "actor",
	attempt_id: "genesis",
	controller_attestation_id: null,
	device_claim_id: "claim",
	authority_kind: "device_claim",
	auth_config_revision: hash,
	created_at_ms: 0,
	revoked_at_ms: null,
	generation: 1,
	ended_at_ms: null,
	end_reason: null,
	end_attempt_id: null,
	signin_sequence_floor: 0,
};
const pending = {
	coordinator_id: birth.coordinator_id,
	attempt_id: "change",
	identity_id: birth.identity_id,
	target_link_id: birth.link_id,
	target_generation: 1,
	target_subject: birth.subject,
	origin: "http://127.0.0.1:43123",
	intent: "disconnect",
	purpose: "coordinator-account-link-change-v1",
	group_id: "group",
	device_id: "device",
	public_key: "fixture public key\r\n",
	fingerprint: hash,
	key_id: "b".repeat(64),
	authority_kind: "device_claim",
	device_claim_id: "claim",
	controller_attestation_id: null,
	controller_review_receipt_id: null,
	controller_revision: null,
	issuer: birth.issuer,
	auth_config_revision: hash,
	runtime_verifier_hash: "c".repeat(64),
	browser_start_hash: "d".repeat(64),
	loopback_redirect: "http://127.0.0.1:43123/callback",
	state: "pending",
	browser_transaction_hash: null,
	browser_binder_hash: null,
	browser_sequence: null,
	account_subject: null,
	completion_secret_hash: null,
	created_at_ms: 10,
	expires_at_ms: 600010,
	claimed_at_ms: null,
	oidc_verified_at_ms: null,
	confirmed_at_ms: null,
	completed_at_ms: null,
	failed_at_ms: null,
	failure_reason: null,
};
type Row = Record<string, unknown>;
const stages: Row[] = [
	{
		state: "browser_claimed",
		browser_transaction_hash: "e".repeat(64),
		browser_binder_hash: "7".repeat(64),
		browser_sequence: 1,
		claimed_at_ms: 20,
	},
	{ state: "oidc_verified", account_subject: birth.subject, oidc_verified_at_ms: 30 },
	{ state: "confirmed", completion_secret_hash: "f".repeat(64), confirmed_at_ms: 40 },
	{ state: "completed", completed_at_ms: 50 },
];
const databases: SqliteDatabase[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function insert(db: SqliteDatabase, table: string, row: Row, mode = "INSERT") {
	const columns = Object.keys(row);
	db.prepare(
		`${mode} INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
	).run(...Object.values(row));
}
function update(db: SqliteDatabase, changes: Row, attemptId = pending.attempt_id) {
	db.prepare(
		`UPDATE ${attempts} SET ${Object.keys(changes)
			.map((key) => `${key} = ?`)
			.join(",")} WHERE attempt_id = ?`,
	).run(...Object.values(changes), attemptId);
}
function rows(db: SqliteDatabase, table = attempts) {
	return db.prepare(`SELECT * FROM ${table}`).all();
}
function setup(controller = false) {
	const db = new Database(":memory:");
	databases.push(db);
	db.pragma("recursive_triggers = OFF");
	for (const sql of [
		COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL,
		AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL,
		AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL,
		...AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS,
		...AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS,
		...AUTH_ACCOUNT_LINK_GENERATION_GUARD_STATEMENTS,
		AUTH_LINK_CHANGE_ATTEMPT_TABLE_SQL,
		...AUTH_LINK_CHANGE_ATTEMPT_INDEX_STATEMENTS,
		...AUTH_LINK_CHANGE_ATTEMPT_GUARD_STATEMENTS,
		AUTH_LINK_CHANGE_END_RECEIPT_GUARD_SQL,
	])
		db.exec(sql);
	insert(db, associations, {
		coordinator_id: birth.coordinator_id,
		issuer: birth.issuer,
		subject: birth.subject,
		identity_id: birth.identity_id,
		first_link_id: birth.link_id,
		created_at_ms: 0,
	});
	insert(
		db,
		links,
		controller
			? {
					...birth,
					authority_kind: "controller_attestation",
					controller_attestation_id: "origin-attestation",
					device_claim_id: null,
				}
			: birth,
	);
	insert(db, "coordinator_auth_device_claims", {
		coordinator_id: birth.coordinator_id,
		claim_id: "claim",
		identity_id: birth.identity_id,
		group_id: "original-group",
		device_id: pending.device_id,
		public_key: pending.public_key,
		fingerprint: pending.fingerprint,
		key_id: pending.key_id,
		attempt_id: "genesis",
		issuer: birth.issuer,
		auth_config_revision: hash,
		created_at_ms: 0,
	});
	return db;
}
function advance(db: SqliteDatabase, count = stages.length) {
	for (const stage of stages.slice(0, count)) update(db, stage);
}
function end(db: SqliteDatabase, attemptId = pending.attempt_id, at = 50) {
	db.prepare(
		`UPDATE ${links} SET ended_at_ms = ?, end_reason = 'user_disconnected', end_attempt_id = ?`,
	).run(at, attemptId);
}

// These fixtures assert storage metadata, not fresh Google/device cryptographic proof,
// current controller eligibility, canonical key derivation, or grant/owner authority.
describe("inert link-change storage", () => {
	it.each(["disconnect", "refresh"])(
		"retains a complete %s receipt without ending a link itself",
		(intent) => {
			// Arrange
			const db = setup();
			insert(db, attempts, { ...pending, intent });
			// Act
			advance(db);
			// Assert
			expect(rows(db)).toEqual([{ ...pending, intent, ...Object.assign({}, ...stages) }]);
			expect(rows(db, links)).toEqual([birth]);
			expect(db.pragma(`foreign_key_list(${attempts})`)).toEqual([]);
		},
	);
	it.each([
		{ intent: "switch" },
		{ purpose: "coordinator-account-link-v1" },
		{ target_generation: 0 },
		{ target_generation: Number.MAX_SAFE_INTEGER + 1 },
		{ created_at_ms: -1 },
		{ expires_at_ms: 600011 },
		{ created_at_ms: 1.5 },
		{ runtime_verifier_hash: "A".repeat(64) },
		{ key_id: "not-a-hash" },
		{ browser_start_hash: "x" },
		{ state: "completed" },
		{ authority_kind: "device_claim", controller_attestation_id: "attestation" },
		{ authority_kind: "controller_attestation", device_claim_id: null },
		{ target_subject: "" },
		{ origin: "" },
		{ public_key: "\r\n " },
		{ device_id: "device\0hidden" },
	])("rejects invalid birth/state shape %j", (changes) => {
		// Arrange
		const db = setup();
		// Act
		const write = () => insert(db, attempts, { ...pending, ...changes });
		// Assert
		expect(write).toThrow(/CHECK|NOT NULL|auth_link_change_(birth_invalid|target_unavailable)/);
		expect(rows(db)).toEqual([]);
	});
	it.each(
		Object.keys(pending).filter(
			(field) =>
				![
					"state",
					"browser_transaction_hash",
					"browser_binder_hash",
					"browser_sequence",
					"account_subject",
					"completion_secret_hash",
					"claimed_at_ms",
					"oidc_verified_at_ms",
					"confirmed_at_ms",
					"completed_at_ms",
					"failed_at_ms",
					"failure_reason",
				].includes(field),
		),
	)("pins birth field %s before completion", (field) => {
		// Arrange
		const db = setup();
		insert(db, attempts, pending);
		const original = (pending as Row)[field];
		// Act
		const write = () =>
			update(db, { [field]: typeof original === "number" ? original + 1 : "changed" });
		// Assert
		expect(write).toThrow(/auth_link_change_.*immutable/);
		expect(rows(db)).toEqual([pending]);
	});
});

describe("link-change proof and receipt pins", () => {
	it("accepts safe integer boundaries and equal ceremony timestamps before expiry", () => {
		// Arrange
		const db = setup();
		const created_at_ms = Number.MAX_SAFE_INTEGER - 600000;
		insert(db, attempts, {
			...pending,
			created_at_ms,
			expires_at_ms: Number.MAX_SAFE_INTEGER,
		});
		// Act
		for (const stage of stages) {
			const changes = { ...stage };
			for (const key of Object.keys(changes))
				if (key.endsWith("_at_ms")) changes[key] = created_at_ms;
			if (changes.browser_sequence) changes.browser_sequence = Number.MAX_SAFE_INTEGER - 1;
			update(db, changes);
		}
		// Assert
		expect(rows(db)).toMatchObject([
			{
				state: "completed",
				completed_at_ms: created_at_ms,
				browser_sequence: Number.MAX_SAFE_INTEGER - 1,
			},
		]);
	});
	it.each([1, 2, 3])("rejects missing proof or out-of-order timestamp in phase %s", (phase) => {
		// Arrange
		const db = setup();
		insert(db, attempts, pending);
		advance(db, phase);
		const before = rows(db);
		const next = stages[phase] as Row;
		const timestamp = Object.keys(next).find((key) => key.endsWith("_at_ms")) as string;
		// Act
		const missing = () => update(db, { ...next, [timestamp]: null });
		const early = () => update(db, { ...next, [timestamp]: 19 });
		const expired = () => update(db, { ...next, [timestamp]: pending.expires_at_ms });
		// Assert
		expect(missing).toThrow();
		expect(early).toThrow();
		expect(expired).toThrow();
		expect(rows(db)).toEqual(before);
	});
	it.each([
		{ state: "confirmed", ...stages[0], ...stages[1], ...stages[2] },
		{ ...stages[0], claimed_at_ms: 9 },
		{ ...stages[0], browser_sequence: 0 },
		{ ...stages[0], browser_sequence: Number.MAX_SAFE_INTEGER },
	])("rejects skipped states or invalid proof chronology %j", (changes) => {
		// Arrange
		const db = setup();
		insert(db, attempts, pending);
		// Act
		const write = () => update(db, changes);
		// Assert
		expect(write).toThrow();
		expect(rows(db)).toEqual([pending]);
	});
	it.each([
		"browser_transaction_hash",
		"browser_binder_hash",
		"browser_sequence",
		"account_subject",
		"completion_secret_hash",
		"claimed_at_ms",
		"oidc_verified_at_ms",
		"confirmed_at_ms",
	])("never clears or substitutes recorded %s", (field) => {
		// Arrange
		const db = setup();
		insert(db, attempts, pending);
		advance(db, 3);
		const before = rows(db);
		// Act
		const clear = () => update(db, { [field]: null });
		const replace = () =>
			update(db, { [field]: typeof (before[0] as Row)[field] === "number" ? 99 : "9".repeat(64) });
		// Assert
		expect(clear).toThrow();
		expect(replace).toThrow();
		expect(rows(db)).toEqual(before);
	});
	it.each(Object.keys(pending))("completed receipts reject updates to %s", (field) => {
		// Arrange
		const db = setup();
		insert(db, attempts, pending);
		advance(db);
		const before = rows(db);
		// Act
		const write = () => update(db, { [field]: (before[0] as Row)[field] });
		// Assert
		expect(write).toThrow(/auth_link_change_.*immutable/);
		expect(rows(db)).toEqual(before);
	});
});

describe("link-change terminal states", () => {
	it.each(["completed", "failed", "expired"])(
		"%s releases the active Actor slot without an automatic link effect",
		(state) => {
			// Arrange
			const db = setup();
			insert(db, attempts, pending);
			// Act
			if (state === "completed") advance(db);
			else
				update(
					db,
					state === "failed"
						? { state, failure_reason: "device_cancelled", failed_at_ms: 20 }
						: { state },
				);
			insert(db, attempts, {
				...pending,
				attempt_id: "next",
				runtime_verifier_hash: "1".repeat(64),
				browser_start_hash: "2".repeat(64),
			});
			// Assert
			if (state !== "completed") expect(() => end(db)).toThrow(/auth_.*receipt/);
			expect(rows(db)).toHaveLength(2);
			expect(rows(db, links)).toEqual([birth]);
		},
	);
	it.each(["failed", "expired"])("cannot resurrect %s proof state", (state) => {
		// Arrange
		const db = setup();
		insert(db, attempts, pending);
		update(
			db,
			state === "failed"
				? { state, failure_reason: "browser_cancelled", failed_at_ms: 20 }
				: { state },
		);
		const before = rows(db);
		// Act
		const write = () => update(db, stages[0] as Row);
		// Assert
		expect(write).toThrow(/auth_link_change_transition_invalid/);
		expect(rows(db)).toEqual(before);
	});
});

describe("link-change collision retention", () => {
	it.each(["pending", "browser_claimed", "oidc_verified", "confirmed"])(
		"allows only one active attempt per Actor in %s",
		(state) => {
			// Arrange
			const db = setup();
			insert(db, attempts, pending);
			advance(db, ["pending", "browser_claimed", "oidc_verified", "confirmed"].indexOf(state));
			const before = rows(db);
			// Act
			const write = () =>
				insert(
					db,
					attempts,
					{
						...pending,
						attempt_id: "next",
						runtime_verifier_hash: "1".repeat(64),
						browser_start_hash: "2".repeat(64),
					},
					"INSERT OR REPLACE",
				);
			// Assert
			expect(write).toThrow(/auth_link_change_.*collision/);
			expect(rows(db)).toEqual(before);
		},
	);
	it.each([
		"attempt_id",
		"runtime_verifier_hash",
		"browser_start_hash",
		"browser_transaction_hash",
		"completion_secret_hash",
		"rowid",
	])("REPLACE cannot evict completed history through %s", (field) => {
		// Arrange
		const db = setup();
		insert(db, attempts, pending);
		advance(db);
		const before = rows(db);
		const candidate: Row = {
			...pending,
			attempt_id: "next",
			identity_id: "other",
			runtime_verifier_hash: "1".repeat(64),
			browser_start_hash: "2".repeat(64),
		};
		candidate[field] = field === "rowid" ? 1 : (before[0] as Row)[field];
		// Act
		const write = () => insert(db, attempts, candidate, "INSERT OR REPLACE");
		// Assert
		expect(db.pragma("recursive_triggers", { simple: true })).toBe(0);
		expect(write).toThrow(/auth_link_change_.*collision/);
		expect(rows(db)).toEqual(before);
	});
	it("retains completed receipts against deletion and exposes no raw secret or display columns", () => {
		// Arrange
		const db = setup();
		insert(db, attempts, pending);
		advance(db);
		const before = rows(db);
		// Act
		const remove = () => db.exec(`DELETE FROM ${attempts}`);
		const columns = (db.pragma(`table_info(${attempts})`) as { name: string }[]).map(
			(column) => column.name,
		);
		// Assert
		expect(remove).toThrow(/auth_link_change_.*immutable/);
		expect(rows(db)).toEqual(before);
		expect(columns.join(" ")).not.toMatch(
			/\b(?:id_token|access_token|refresh_token|nonce|pkce_verifier|display_name|email|picture_url)\b/,
		);
	});
});

function seedEarlierDisconnect(db: SqliteDatabase, record: Row) {
	insert(db, attempts, {
		...record,
		attempt_id: "earlier",
		runtime_verifier_hash: "1".repeat(64),
		browser_start_hash: "2".repeat(64),
		intent: "disconnect",
	});
	for (const stage of stages) {
		const proof = { ...stage };
		if (proof.browser_transaction_hash) proof.browser_transaction_hash = "3".repeat(64);
		if (proof.completion_secret_hash) proof.completion_secret_hash = "4".repeat(64);
		update(db, proof, "earlier");
	}
}
function invalidateTarget(db: SqliteDatabase, context: string) {
	if (context === "missing")
		db.exec(`DROP TRIGGER auth_account_links_immutable_delete; DELETE FROM ${links}`);
	if (context === "ended") end(db, "earlier");
	if (context === "revoked") db.exec(`UPDATE ${links} SET revoked_at_ms = 45`);
	if (context === "historical-revoked")
		insert(db, links, {
			...birth,
			link_id: "history",
			attempt_id: "history",
			generation: 2,
			revoked_at_ms: 1,
		});
}

describe.each(["disconnect", "refresh"])("%s target fences", (intent) => {
	it.each(
		["insert", "complete"].flatMap((phase) =>
			[
				"missing",
				"ended",
				"revoked",
				"historical-revoked",
				"generation",
				"actor",
				"issuer",
				"subject",
				"claim-id",
				"controller-on-device",
				"device-on-controller",
			].map((context) => ({ phase, context })),
		),
	)("rejects $context at $phase without a false receipt", ({ phase, context }) => {
		// Arrange: only completion metadata-mismatch cases bypass the birth-target guard,
		// to isolate completion's independent fence; all completion guards remain installed.
		const controller = context === "device-on-controller";
		const db = setup(controller);
		const authority = {
			authority_kind: "controller_attestation",
			device_claim_id: null,
			controller_attestation_id: "current",
			controller_review_receipt_id: "review",
			controller_revision: 1,
		};
		const record: Row = { ...pending, intent, ...(controller ? authority : {}) };
		if (context === "ended") seedEarlierDisconnect(db, record);
		const mismatches: Record<string, Row> = {
			generation: { target_generation: 2 },
			actor: { identity_id: "other" },
			issuer: { issuer: "https://other.invalid" },
			subject: { target_subject: "other" },
			"claim-id": { device_claim_id: "other" },
			"controller-on-device": authority,
			"device-on-controller": {
				authority_kind: "device_claim",
				device_claim_id: "claim",
				controller_attestation_id: null,
				controller_review_receipt_id: null,
				controller_revision: null,
			},
		};
		const mismatch = mismatches[context];
		if (mismatch) Object.assign(record, mismatch);
		if (phase === "complete") {
			if (mismatch) db.exec("DROP TRIGGER auth_link_change_insert_live_target");
			insert(db, attempts, record);
			update(db, stages[0] as Row);
			update(db, { ...stages[1], account_subject: record.target_subject });
			update(db, stages[2] as Row);
		}
		invalidateTarget(db, context);
		const before = rows(db),
			beforeLinks = rows(db, links);
		// Act
		const write = () =>
			phase === "insert" ? insert(db, attempts, record) : update(db, stages[3] as Row);
		// Assert
		expect(write).toThrow(/auth_link_change_target_unavailable/);
		expect(rows(db)).toEqual(before);
		expect(rows(db, links)).toEqual(beforeLinks);
		if (phase === "complete")
			expect(rows(db).find((row) => (row as Row).attempt_id === "change")).toMatchObject({
				state: "confirmed",
				completed_at_ms: null,
			});
	});
});

describe("logical disconnect end receipt", () => {
	it.each([false, true])(
		"independently rejects opposite receipt authority on controller target %s",
		(controller) => {
			// Arrange: end-binding defense only, not accepted proof; bypass just new target fences.
			const db = setup(controller);
			db.exec(
				"DROP TRIGGER auth_link_change_insert_live_target; DROP TRIGGER auth_link_change_complete_live_target",
			);
			insert(db, attempts, {
				...pending,
				...(!controller
					? {
							authority_kind: "controller_attestation",
							device_claim_id: null,
							controller_attestation_id: "current",
							controller_review_receipt_id: "review",
							controller_revision: 1,
						}
					: {}),
			});
			advance(db);
			const before = rows(db, links);
			// Act
			const write = () => end(db);
			// Assert
			expect(write).toThrow(/auth_link_change_end_receipt_invalid/);
			expect(rows(db, links)).toEqual(before);
		},
	);
	it.each(["device_claim", "controller_attestation"])(
		"permits an exact completed disconnect retaining %s birth authority",
		(authority_kind) => {
			// Arrange
			const controller = authority_kind === "controller_attestation";
			const db = setup(controller);
			insert(db, attempts, {
				...pending,
				authority_kind,
				...(controller
					? {
							device_claim_id: null,
							controller_attestation_id: "current-attestation",
							controller_review_receipt_id: "current-review",
							controller_revision: 1,
						}
					: {}),
			});
			advance(db);
			const before = rows(db, links)[0] as Row;
			// Act
			end(db);
			// Assert
			expect(rows(db, links)).toEqual([
				{ ...before, ended_at_ms: 50, end_reason: "user_disconnected", end_attempt_id: "change" },
			]);
		},
	);
	it.each([
		{ intent: "refresh" },
		{ target_generation: 2 },
		{ target_link_id: "other" },
		{ identity_id: "other" },
		{ issuer: "https://other.invalid" },
		{ target_subject: "other" },
		{ device_claim_id: "other" },
		{ device_id: "other" },
		{ public_key: "different key" },
		{ fingerprint: "9".repeat(64) },
		{ key_id: "9".repeat(64) },
		{ completed_at_ms: 51 },
	])("denies nonmatching completed receipt %j", (changes) => {
		// Arrange: isolate end binding, not accepted runtime proof; retain every other guard.
		const db = setup();
		db.exec(
			"DROP TRIGGER auth_link_change_insert_live_target; DROP TRIGGER auth_link_change_complete_live_target",
		);
		insert(db, attempts, { ...pending, ...changes, completed_at_ms: null });
		advance(db, 1);
		update(db, { ...stages[1], account_subject: changes.target_subject ?? birth.subject });
		update(db, stages[2] as Row);
		update(db, { ...stages[3], completed_at_ms: changes.completed_at_ms ?? 50 });
		// Act
		const write = () => end(db);
		// Assert
		expect(write).toThrow(/auth_.*receipt/);
		expect(rows(db, links)).toEqual([birth]);
	});
	it.each([
		"missing",
		"pending",
		"confirmed",
		"revoked",
		"other-revoked",
		"missing-association",
		"wrong-attempt",
	])("denies end with %s receipt/target context", (context) => {
		// Arrange
		const db = setup();
		if (context !== "missing") insert(db, attempts, pending);
		if (context === "confirmed") advance(db, 3);
		if (context === "revoked") {
			advance(db);
			db.exec(`UPDATE ${links} SET revoked_at_ms = 49`);
		}
		if (["other-revoked", "missing-association", "wrong-attempt"].includes(context)) advance(db);
		if (context === "other-revoked")
			insert(db, links, {
				...birth,
				link_id: "historical",
				attempt_id: "historical-attempt",
				generation: 2,
				revoked_at_ms: 1,
			});
		if (context === "missing-association") {
			// Simulate a missing logical dependency; production association deletion remains forbidden.
			db.exec(
				`DROP TRIGGER auth_account_associations_immutable_delete; DELETE FROM ${associations}`,
			);
		}
		const before = rows(db, links);
		// Act
		const write = () => end(db, context === "wrong-attempt" ? "unrelated" : pending.attempt_id);
		// Assert
		expect(write).toThrow(/auth_.*receipt|auth_account_link_immutable/);
		expect(rows(db, links)).toEqual(before);
	});
});
