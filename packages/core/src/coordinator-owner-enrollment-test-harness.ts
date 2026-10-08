import { expect, it } from "vitest";
import type { SchemaFixture } from "./coordinator-auth-browser-migration-test-harness.js";
import { browserConfig } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";

export const OWNER_TABLE = "coordinator_owner_enrollment_attempts";
export const ownerDefinitions = `SELECT type,name,sql FROM sqlite_master WHERE tbl_name = '${OWNER_TABLE}' AND sql IS NOT NULL ORDER BY type,name`;
export const pendingOwner = {
	coordinator_id: "coordinator-a",
	attempt_id: "owner-attempt-a",
	purpose: "owner_enroll",
	origin: "https://coordinator.example.test",
	device_id: "owner-device",
	public_key: CANONICAL_PUBLIC_KEY,
	key_id: EXPECTED_KEY_ID,
	fingerprint: "a".repeat(64),
	issuer: browserConfig.issuer,
	auth_config_revision: browserConfig.revision,
	loopback_redirect: "http://127.0.0.1:4567/complete",
	browser_start_hash: "b".repeat(64),
	browser_binder_hash: null,
	state: "pending",
	created_at_ms: NOW,
	expires_at_ms: NOW + 600000,
};
const provenance = {
	account_subject: "dummy-subject",
	identity_id: "identity-a",
	link_id: "link-a",
	link_attempt_id: "legacy-attempt-a",
	link_controller_attestation_id: "controller-a",
	link_auth_config_revision: "c".repeat(64),
	grant_revisions_json: '[{"groupId":"group-a","revision":7}]',
};
export const finalizedOwner = {
	...pendingOwner,
	...provenance,
	state: "finalized",
	browser_transaction_hash: "d".repeat(64),
	browser_binder_hash: "8".repeat(64),
	confirmation_hash: "e".repeat(64),
	completion_secret_hash: "f".repeat(64),
	final_key_proof_hash: "1".repeat(64),
	loopback_redirect: null,
	finalized_at_ms: NOW + 1,
	binding_id: "binding-a",
	audit_event_id: "audit-a",
	final_outcome_json: '{ "kind": "finalized", "bindingId": "binding-a", "groups": ["group-a"] }',
};
type Value = string | number | null;
type InsertMode = "INSERT" | "INSERT OR REPLACE" | "INSERT OR IGNORE";
export function insertOwner(
	f: SchemaFixture,
	row: Record<string, Value> = pendingOwner,
	{ mode = "INSERT" }: { mode?: InsertMode } = {},
) {
	const entries = Object.entries(row);
	return f.exec(
		`${mode} INTO ${OWNER_TABLE} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
		...entries.map(([, value]) => value),
	);
}
export function ownerRows(f: SchemaFixture) {
	return f.query(`SELECT * FROM ${OWNER_TABLE} ORDER BY attempt_id`);
}
export type OwnerFixture = SchemaFixture & { store: Store };
export function ownerHarness(fixture: (use: (f: OwnerFixture) => Promise<void>) => Promise<void>) {
	return it.extend<{ fixture: OwnerFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}

// Raw INSERT fixtures test storage shape only; they neither authorize nor create ownership bindings.
export function registerOwnerSchemaTests(test: ReturnType<typeof ownerHarness>) {
	registerOwnerStates(test);
	registerOwnerPins(test);
	registerOwnerRecordedPins(test);
	registerOwnerLoopbackPurge(test);
	registerOwnerInvalid(test);
	registerOwnerRetention(test);
	registerOwnerReplacement(test);
	registerOwnerPendingReplacement(test);
	registerOwnerRetryAndRowid(test);
	registerOwnerCommitmentCollisions(test);
	registerOwnerMixedCollision(test);
}
type OwnerTest = ReturnType<typeof ownerHarness>;
function registerOwnerPins(test: OwnerTest) {
	test.for(
		Object.entries(pendingOwner).filter(([key, value]) => key !== "state" && value !== null),
	)(
		"birth fact %j permits identical retry but rejects replacement before finalization",
		async ([column, value], { fixture: f }) => {
			// Contract lines 262–274 pin the original pending key and deadline.
			await insertOwner(f);
			const before = await ownerRows(f);
			await f.exec(`UPDATE ${OWNER_TABLE} SET ${column} = ?`, value);
			expect(await ownerRows(f)).toEqual(before);
			// Update both timestamps so CHECK constraints cannot mask a mutable deadline.
			let replacement: Value = `${value}-changed`;
			if (
				column.endsWith("hash") ||
				["key_id", "fingerprint", "auth_config_revision"].includes(column)
			)
				replacement = "9".repeat(64);
			const mutation =
				typeof value === "number"
					? f.exec(
							`UPDATE ${OWNER_TABLE} SET created_at_ms = created_at_ms + 1, expires_at_ms = expires_at_ms + 1`,
						)
					: f.exec(`UPDATE ${OWNER_TABLE} SET ${column} = ?`, replacement);
			// Require the pin error rather than a coincidental CHECK failure.
			await expect(mutation).rejects.toThrow(/owner_enrollment_pins_immutable/);
			expect(await ownerRows(f)).toEqual(before);
			// Clearing a birth pin must not open a later refill path.
			const clear = f.exec(`UPDATE ${OWNER_TABLE} SET ${column} = NULL`);
			await expect(clear).rejects.toThrow(/owner_enrollment_pins_immutable/);
			expect(await ownerRows(f)).toEqual(before);
		},
	);
}
function registerOwnerRecordedPins(test: OwnerTest) {
	test("normal ceremony populates commitments once and retains original binder evidence", async ({
		fixture: f,
	}) => {
		// Raw storage transitions do not issue proof or enroll a device.
		await insertOwner(f);
		const stages = [
			{
				state: "browser_claimed",
				browser_transaction_hash: finalizedOwner.browser_transaction_hash,
				browser_binder_hash: finalizedOwner.browser_binder_hash,
			},
			{ state: "oidc_verified", ...provenance },
			{
				state: "confirmed",
				confirmation_hash: finalizedOwner.confirmation_hash,
				completion_secret_hash: finalizedOwner.completion_secret_hash,
			},
			finalizedOwner,
		];
		for (const stage of stages) {
			const entries = Object.entries(stage);
			await f.exec(
				`UPDATE ${OWNER_TABLE} SET ${entries.map(([key]) => `${key} = ?`).join(",")}`,
				...entries.map(([, value]) => value),
			);
			expect(await ownerRows(f)).toEqual([expect.objectContaining(stage)]);
		}
	});
	test.for(["confirmed", "expired", "retired"])(
		"recorded commitments cannot change, clear or refill in %s",
		async (state, { fixture: f }) => {
			// Terminal nonfinal states must preserve facts recorded earlier.
			await insertOwner(f, { ...otherConfirmed, state });
			const before = await ownerRows(f);
			const pins = {
				...provenance,
				browser_transaction_hash: otherConfirmed.browser_transaction_hash,
				browser_binder_hash: otherConfirmed.browser_binder_hash,
				confirmation_hash: otherConfirmed.confirmation_hash,
				completion_secret_hash: otherConfirmed.completion_secret_hash,
			};
			for (const [column, original] of Object.entries(pins)) {
				// Same-value retries remain legal before finalization.
				await f.exec(`UPDATE ${OWNER_TABLE} SET ${column} = ?`, original);
				expect(await ownerRows(f)).toEqual(before);
				for (const replacement of [
					null,
					column.endsWith("hash") || column.endsWith("revision") ? "9".repeat(64) : "changed",
				]) {
					const mutation = f.exec(`UPDATE ${OWNER_TABLE} SET ${column} = ?`, replacement);
					// Denial leaves the original value available, not a refillable NULL.
					await expect(mutation).rejects.toThrow(/owner_enrollment_pins_immutable/);
					expect(await ownerRows(f)).toEqual(before);
				}
			}
		},
	);
}
function registerOwnerLoopbackPurge(test: OwnerTest) {
	test.for(["expired", "failed", "retired"])(
		"%s can purge loopback but cannot restore or replace its destination",
		async (state, { fixture: f }) => {
			await insertOwner(f);
			await f.exec(`UPDATE ${OWNER_TABLE} SET state = ?, loopback_redirect = NULL`, state);
			const before = await ownerRows(f);
			expect(before).toEqual([expect.objectContaining({ state, loopback_redirect: null })]);
			for (const destination of [
				pendingOwner.loopback_redirect,
				"http://127.0.0.1:9876/complete",
			]) {
				const restore = f.exec(`UPDATE ${OWNER_TABLE} SET loopback_redirect = ?`, destination);
				await expect(restore).rejects.toThrow(/owner_enrollment_pins_immutable/);
				expect(await ownerRows(f)).toEqual(before);
			}
		},
	);
}
function registerOwnerStates(test: OwnerTest) {
	test.for([
		"pending",
		"browser_claimed",
		"oidc_verified",
		"confirmed",
		"finalized",
		"expired",
		"failed",
		"retired",
	])(
		"accepts state %s with the required pins and provisional nullability",
		async (state, { fixture: f }) => {
			const row: Record<string, Value> = { ...pendingOwner, state };
			if (["browser_claimed", "oidc_verified", "confirmed"].includes(state))
				Object.assign(row, {
					browser_transaction_hash: "d".repeat(64),
					browser_binder_hash: "8".repeat(64),
				});
			if (["oidc_verified", "confirmed"].includes(state)) Object.assign(row, provenance);
			if (state === "confirmed")
				Object.assign(row, {
					confirmation_hash: "e".repeat(64),
					completion_secret_hash: "f".repeat(64),
				});
			if (state === "finalized") Object.assign(row, finalizedOwner);
			await insertOwner(f, row);
			expect(await ownerRows(f)).toEqual([expect.objectContaining(row)]);
			expect(await f.query(`PRAGMA foreign_key_list(${OWNER_TABLE})`)).toEqual([]);
			expect(await f.query("SELECT * FROM coordinator_device_ownership_bindings")).toEqual([]);
		},
	);
}
function registerOwnerInvalid(test: OwnerTest) {
	const invalidProvisional: Record<string, Value>[] = [
		{ state: "unknown" },
		{ purpose: "signin" },
		{ key_id: "A".repeat(64) },
		{ key_id: "g".repeat(64) },
		{ key_id: `${"a".repeat(63)}\0` },
		{ device_id: " " },
		{ attempt_id: "a\0b" },
		{ public_key: null },
		{ auth_config_revision: "bad" },
		{ account_subject: "dummy-subject" },
		{ state: "browser_claimed" },
		{ browser_binder_hash: "8".repeat(64) },
		{ state: "browser_claimed", browser_transaction_hash: "d".repeat(64) },
		{
			state: "browser_claimed",
			browser_transaction_hash: "d".repeat(64),
			browser_binder_hash: "bad",
		},
		{ state: "oidc_verified", browser_transaction_hash: "d".repeat(64) },
		{ state: "confirmed", ...provenance, browser_transaction_hash: "d".repeat(64) },
		{ final_outcome_json: "{}" },
		{ expires_at_ms: NOW + 600001 },
	];
	test.for(invalidProvisional)(
		"rejects invalid provisional combination %j",
		async (patch, { fixture: f }) => {
			const insertion = insertOwner(f, { ...pendingOwner, ...patch });
			await expect(insertion).rejects.toThrow();
			expect(await ownerRows(f)).toEqual([]);
		},
	);
	test.for([
		{ loopback_redirect: pendingOwner.loopback_redirect },
		{ final_outcome_json: "[]" },
		{ final_outcome_json: "not-json" },
		{ grant_revisions_json: "{}" },
		{ link_id: null },
		{ account_subject: null },
		{ binding_id: null },
		{ audit_event_id: null },
		{ final_key_proof_hash: null },
		{ finalized_at_ms: NOW + 600000 },
		{ browser_transaction_hash: null },
		{ browser_binder_hash: null },
	])("rejects malformed finalized commitment/outcome %j", async (patch, { fixture: f }) => {
		const insertion = insertOwner(f, { ...finalizedOwner, ...patch });
		await expect(insertion).rejects.toThrow();
		expect(await ownerRows(f)).toEqual([]);
	});
}
const otherFinalized = {
	...finalizedOwner,
	attempt_id: "owner-attempt-b",
	browser_start_hash: "2".repeat(64),
	browser_transaction_hash: "3".repeat(64),
	completion_secret_hash: "4".repeat(64),
};
const otherConfirmed = {
	...otherFinalized,
	state: "confirmed",
	loopback_redirect: pendingOwner.loopback_redirect,
	finalized_at_ms: null,
	binding_id: null,
	audit_event_id: null,
	final_outcome_json: null,
	final_key_proof_hash: null,
};
function registerOwnerPendingReplacement(test: OwnerTest) {
	test("INSERT OR REPLACE cannot overwrite original pending birth pins via attempt identity", async ({
		fixture: f,
	}) => {
		// The replacement has valid storage shape; no owner proof is issued.
		await insertOwner(f);
		const replacement = {
			...pendingOwner,
			device_id: "replacement-device",
			public_key: UNRELATED_PUBLIC_KEY,
			key_id: "9".repeat(64),
			browser_start_hash: "7".repeat(64),
			created_at_ms: NOW + 1,
			expires_at_ms: NOW + 600001,
		};
		// The same facts are accepted for a genuinely new attempt.
		await insertOwner(f, {
			...replacement,
			attempt_id: "replacement-attempt",
			browser_start_hash: "6".repeat(64),
		});
		const before = await ownerRows(f);
		expect(before).toHaveLength(2);
		// A primary-key collision must not erase the original birth facts.
		const overwrite = insertOwner(f, replacement, { mode: "INSERT OR REPLACE" });
		await expect(overwrite).rejects.toThrow(/owner_enrollment_pins_immutable/);
		expect(await ownerRows(f)).toEqual(before);
	});
}
function registerOwnerRetryAndRowid(test: OwnerTest) {
	test.for(["INSERT OR REPLACE", "INSERT OR IGNORE"] as const)(
		"%s permits identical pending facts but rejects changed facts",
		async (mode, { fixture: f }) => {
			await insertOwner(f);
			const before = await ownerRows(f);
			// Retry all stored columns, including nullable commitments.
			await f.exec(`${mode} INTO ${OWNER_TABLE} SELECT * FROM ${OWNER_TABLE}`);
			expect(await ownerRows(f)).toEqual(before);
			const changed = insertOwner(f, { ...pendingOwner, device_id: "changed-device" }, { mode });
			await expect(changed).rejects.toThrow(/owner_enrollment_pins_immutable/);
			expect(await ownerRows(f)).toEqual(before);
		},
	);
	test.for(["INSERT OR REPLACE", "UPDATE OR REPLACE"])(
		"%s cannot erase a different coordinator's pending row via rowid",
		async (mode, { fixture: f }) => {
			// Per-coordinator identities do not prevent a physical rowid collision.
			await insertOwner(f, { ...pendingOwner, rowid: 11 });
			const other = { ...pendingOwner, coordinator_id: "coordinator-b", rowid: 22 };
			await insertOwner(f, other);
			const allRows = () => f.query(`SELECT rowid,* FROM ${OWNER_TABLE} ORDER BY rowid`);
			const before = await allRows();
			// The UPDATE changes no birth pin on its source row.
			const collision =
				mode === "INSERT OR REPLACE"
					? insertOwner(f, { ...other, rowid: 11 }, { mode })
					: f.exec(`${mode} ${OWNER_TABLE} SET rowid = 11 WHERE rowid = 22`);
			await expect(collision).rejects.toThrow(/owner_enrollment_pins_immutable/);
			expect(await allRows()).toEqual(before);
		},
	);
}
function registerOwnerCommitmentCollisions(test: OwnerTest) {
	test.for(["browser_transaction_hash", "completion_secret_hash"])(
		"one-time %s population cannot replace another nonfinal attempt",
		async (column, { fixture: f }) => {
			// Both rows satisfy their existing state constraints.
			let source: Record<string, Value> = pendingOwner;
			let target: Record<string, Value> = {
				...pendingOwner,
				attempt_id: "owner-attempt-b",
				browser_start_hash: "2".repeat(64),
				state: "browser_claimed",
				browser_transaction_hash: "3".repeat(64),
				browser_binder_hash: "8".repeat(64),
			};
			let transition: Record<string, Value> = {
				state: "browser_claimed",
				browser_transaction_hash: "3".repeat(64),
				browser_binder_hash: "8".repeat(64),
			};
			if (column === "completion_secret_hash") {
				source = {
					...pendingOwner,
					...provenance,
					state: "oidc_verified",
					browser_transaction_hash: "d".repeat(64),
					browser_binder_hash: "8".repeat(64),
				};
				target = otherConfirmed;
				transition = {
					state: "confirmed",
					confirmation_hash: otherConfirmed.confirmation_hash,
					completion_secret_hash: otherConfirmed.completion_secret_hash,
				};
			}
			await insertOwner(f, source);
			await insertOwner(f, target);
			const before = await ownerRows(f);
			const entries = Object.entries(transition);
			// Own NULL-to-value pins are legal; erasing the competing row is not.
			const collision = f.exec(
				`UPDATE OR REPLACE ${OWNER_TABLE} SET ${entries.map(([key]) => `${key} = ?`).join(",")} WHERE attempt_id = ?`,
				...entries.map(([, value]) => value),
				pendingOwner.attempt_id,
			);
			await expect(collision).rejects.toThrow(/owner_enrollment_pins_immutable/);
			expect(await ownerRows(f)).toEqual(before);
		},
	);
}
function registerOwnerMixedCollision(test: OwnerTest) {
	test("mixed finalized and pending INSERT OR REPLACE collisions preserve receipt error and both rows", async ({
		fixture: f,
	}) => {
		// Each independent row is valid before the two-collision replacement.
		await insertOwner(f, finalizedOwner);
		const pending = {
			...pendingOwner,
			attempt_id: "pending-c",
			browser_start_hash: "5".repeat(64),
		};
		await insertOwner(f, pending);
		const before = await ownerRows(f);
		// The attempt PK hits pending; the browser commitment hits finalized.
		const collision = insertOwner(
			f,
			{
				...pending,
				state: "browser_claimed",
				browser_transaction_hash: finalizedOwner.browser_transaction_hash,
				browser_binder_hash: finalizedOwner.browser_binder_hash,
			},
			{ mode: "INSERT OR REPLACE" },
		);
		// The existing receipt protection retains its diagnostic.
		await expect(collision).rejects.toThrow(/owner_enrollment_receipt_immutable/);
		expect(await ownerRows(f)).toEqual(before);
	});
}
function registerOwnerReplacement(test: OwnerTest) {
	for (const mode of ["UPDATE OR REPLACE", "INSERT OR REPLACE"] as const) {
		test.for([
			"attempt_id",
			"browser_start_hash",
			"browser_transaction_hash",
			"completion_secret_hash",
			"rowid",
		])(
			`${mode} cannot erase a different finalized receipt via %s`,
			async (column, { fixture: f }) => {
				// Both raw storage fixtures satisfy their state checks before the collision.
				await insertOwner(f, finalizedOwner);
				await insertOwner(f, otherConfirmed);
				const allRows = () => f.query(`SELECT rowid,* FROM ${OWNER_TABLE} ORDER BY rowid`);
				const before = await allRows();
				const receipt = before[0];
				if (!receipt) throw new Error("Missing finalized receipt fixture");
				const collision = receipt[column] as Value;
				const replacement =
					mode === "UPDATE OR REPLACE"
						? f.exec(
								`${mode} ${OWNER_TABLE} SET ${column} = ? WHERE attempt_id = ?`,
								collision,
								otherConfirmed.attempt_id,
							)
						: insertOwner(f, { ...otherConfirmed, [column]: collision }, { mode });
				// A generic UNIQUE/CHECK failure is not receipt protection.
				await expect(replacement).rejects.toThrow(/owner_enrollment_receipt_immutable/);
				expect(await allRows()).toEqual(before);
			},
		);
	}
	test("a noncolliding confirmed row can finalize without changing an existing receipt", async ({
		fixture: f,
	}) => {
		await insertOwner(f, finalizedOwner);
		await insertOwner(f, otherConfirmed);
		const before = await ownerRows(f);
		const entries = Object.entries(otherFinalized);
		await f.exec(
			`UPDATE ${OWNER_TABLE} SET ${entries.map(([key]) => `${key} = ?`).join(",")} WHERE attempt_id = ?`,
			...entries.map(([, value]) => value),
			otherConfirmed.attempt_id,
		);
		expect(await ownerRows(f)).toEqual([before[0], expect.objectContaining(otherFinalized)]);
	});
}
function registerOwnerRetention(test: OwnerTest) {
	test("finalized receipts reject deletion, mutation and replacement without losing the outcome", async ({
		fixture: f,
	}) => {
		await insertOwner(f, finalizedOwner);
		const before = await ownerRows(f);
		for (const sql of [
			`DELETE FROM ${OWNER_TABLE}`,
			`UPDATE ${OWNER_TABLE} SET browser_binder_hash = browser_binder_hash`,
			`UPDATE ${OWNER_TABLE} SET final_outcome_json = '{}'`,
			`INSERT OR REPLACE INTO ${OWNER_TABLE} SELECT * FROM ${OWNER_TABLE}`,
		]) {
			await expect(f.exec(sql)).rejects.toThrow(/owner_enrollment_receipt_immutable/);
			expect(await ownerRows(f)).toEqual(before);
		}
	});
	test("retains the exact finalized outcome and pins through unrelated cleanup", async ({
		fixture: f,
	}) => {
		// No ownership record is created by this fixture.
		await f.store.createGroup("group-a");
		await insertOwner(f, finalizedOwner);
		const before = await ownerRows(f);
		for (const table of [
			"groups",
			"coordinator_auth_link_attempts",
			"coordinator_auth_sessions",
			"coordinator_auth_browser_transactions",
			"coordinator_auth_link_audit_log",
		])
			await f.exec(`DELETE FROM ${table}`);
		expect(await ownerRows(f)).toEqual(before);
		expect(before[0]).toMatchObject(finalizedOwner);
		expect(before[0]).not.toHaveProperty("completion_secret");
	});
}
