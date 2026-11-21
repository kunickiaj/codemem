import { expect } from "vitest";
import { DEVICE_REJOIN_STORAGE_PRESENT_SQL } from "./coordinator-device-rejoin-schema.js";

export type RejoinSchemaFixture = {
	run(sql: string, ...values: (string | number)[]): Promise<unknown>;
	rows(sql: string): Promise<unknown[]>;
};

const attempts = "coordinator_device_rejoin_attempts";
const audit = "coordinator_device_rejoin_audit_log";
const now = 1_791_028_800_000;
const hash = "1".repeat(64);
const receipt = JSON.stringify({
	attempt_id: "attempt",
	device_id: "device",
	identity_id: "identity",
	binding_id: "binding",
	group_ids: ["group"],
	lifted_removal_seqs: [1],
	finalized_at_ms: now + 1,
});

async function insertAttempt(db: RejoinSchemaFixture, verb = "INSERT", attemptId = "attempt") {
	await db.run(
		`${verb} INTO ${attempts} (coordinator_id, attempt_id, origin, device_id, public_key,
		  key_id, fingerprint, identity_id, binding_id, issuer, auth_config_revision, removal_digest,
		  own_tombstones_json, alias_removal_seqs_json, browser_start_hash, loopback_redirect,
		  created_at_ms, expires_at_ms)
		 VALUES ('coordinator', ?, 'https://coordinator.example.test', 'device', 'fixture-public-key',
		  ?, ?, 'identity', 'binding', 'issuer', ?, ?,
		  '[[1,"group","fixture-public-key","fingerprint"]]', '[]', ?,
		  'http://127.0.0.1:12345/codemem/auth/complete', ?, ?)`,
		attemptId,
		hash,
		hash,
		hash,
		hash,
		hash,
		now,
		now + 600_000,
	);
}

export async function checkRejoinAttemptStorage(db: RejoinSchemaFixture) {
	expect(await db.rows(DEVICE_REJOIN_STORAGE_PRESENT_SQL)).toEqual([{ present: 1 }]);
	expect(await db.rows(`SELECT state FROM ${attempts}`)).toEqual([]);
	expect(await db.rows(`SELECT event_id FROM ${audit}`)).toEqual([]);
	await insertAttempt(db);
	expect(await db.rows(`SELECT attempt_id FROM ${attempts} ORDER BY rowid`)).toEqual([
		{ attempt_id: "attempt" },
	]);
	const before = await db.rows(`SELECT * FROM ${attempts}`);
	await expect(insertAttempt(db, "INSERT OR REPLACE")).rejects.toThrow(
		/device_rejoin_attempt_collision/u,
	);
	await expect(db.run(`UPDATE ${attempts} SET origin = 'changed'`)).rejects.toThrow(
		/device_rejoin_attempt_immutable/u,
	);
	for (const field of ["browser_start_hash", "browser_binder_hash", "completion_secret_hash"]) {
		const column = (await db.rows(`SELECT ${field} FROM ${attempts}`))[0];
		expect(column).toHaveProperty(field, field === "browser_start_hash" ? hash : null);
	}
	await expect(db.run(`UPDATE ${attempts} SET browser_binder_hash = 'raw-binder'`)).rejects.toThrow(
		/constraint/u,
	);
	await expect(
		db.run(`UPDATE ${attempts} SET completion_secret_hash = 'raw-completion'`),
	).rejects.toThrow(/constraint/u);
	expect(await db.rows(`SELECT * FROM ${attempts}`)).toEqual(before);
	await insertAttempt(db, "INSERT", "second-attempt");
	expect(await db.rows(`SELECT count(*) AS count FROM ${attempts}`)).toEqual([{ count: 2 }]);
	await expect(
		db.run(`UPDATE OR REPLACE ${attempts} SET rowid = (
		 SELECT rowid FROM ${attempts} WHERE attempt_id = 'attempt'
		) WHERE attempt_id = 'second-attempt'`),
	).rejects.toThrow(/device_rejoin_attempt_immutable/u);
	await expect(db.run(`UPDATE ${attempts} SET state = 'oidc_verified'`)).rejects.toThrow(
		/device_rejoin_attempt_immutable/u,
	);
	for (const [id, state] of [
		["attempt", "failed"],
		["second-attempt", "expired"],
	] as const) {
		await db.run(`UPDATE ${attempts} SET state = ? WHERE attempt_id = ?`, state, id);
		await expect(
			db.run(`UPDATE ${attempts} SET state = 'pending' WHERE attempt_id = ?`, id),
		).rejects.toThrow(/device_rejoin_attempt_immutable/u);
	}
	await db.run(`DELETE FROM ${attempts} WHERE state IN ('failed', 'expired')`);
	expect(await db.rows(`SELECT attempt_id FROM ${attempts}`)).toEqual([]);
}

export async function storeFinalizedRejoinFixture(db: RejoinSchemaFixture) {
	await insertAttempt(db);
	await db.run(
		`UPDATE ${attempts} SET state = 'browser_claimed', browser_transaction_hash = ?, browser_binder_hash = ?`,
		hash,
		hash,
	);
	await db.run(
		`UPDATE ${attempts} SET state = 'oidc_verified', link_id = 'link', link_authority_kind = 'device_claim',
		  link_generation = 1`,
	);
	await db.run(
		`UPDATE ${attempts} SET state = 'confirmed',
		  destinations_json = '[["group",null]]', non_destinations_json = '[]',
		  confirmation_hash = ?, completion_secret_hash = ?`,
		hash,
		hash,
	);
	for (const change of [
		"browser_transaction_hash = NULL",
		"browser_binder_hash = NULL",
		"link_id = 'another-link'",
		"link_authority_kind = 'controller_attestation'",
		"link_generation = 2",
		"destinations_json = '[]'",
		"non_destinations_json = '[\"different\"]'",
		"confirmation_hash = 'new-hash'",
		"completion_secret_hash = NULL",
	]) {
		await expect(db.run(`UPDATE ${attempts} SET ${change}`)).rejects.toThrow(
			/device_rejoin_attempt_immutable/u,
		);
	}
	await db.run(
		`UPDATE ${attempts} SET state = 'finalized', finalized_at_ms = ?, final_receipt_json = ?`,
		now + 1,
		receipt,
	);
	await db.run(
		`INSERT INTO ${audit} (coordinator_id, event_id, attempt_id, identity_id, device_id,
		  binding_id, group_count, finalized_at_ms)
		 VALUES ('coordinator', 'event', 'attempt', 'identity', 'device', 'binding', 1, ?)`,
		now + 1,
	);
}

export async function checkFinalizedRejoinStorage(db: RejoinSchemaFixture) {
	for (const [table, idColumn] of [
		[attempts, "attempt_id"],
		[audit, "event_id"],
	] as const) {
		const columns = await db.rows(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`);
		const names = columns.map((column) => (column as { name: string }).name);
		const projection = names.map((name) =>
			name === idColumn || (table === audit && name === "attempt_id") ? "'new-id'" : name,
		);
		await expect(
			db.run(`INSERT OR REPLACE INTO ${table} (rowid, ${names.join(", ")})
			 SELECT rowid, ${projection.join(", ")} FROM ${table}`),
		).rejects.toThrow(/device_rejoin_(attempt|audit)_collision/u);
		await expect(
			db.run(`INSERT INTO ${table} (rowid, ${names.join(", ")})
			 SELECT -1, ${projection.join(", ")} FROM ${table}`),
		).rejects.toThrow(/device_rejoin_(attempt|audit)_rowid/u);
	}
	await expect(db.run(`UPDATE ${attempts} SET final_receipt_json = '{}'`)).rejects.toThrow(
		/device_rejoin_attempt_immutable/u,
	);
	await expect(db.run(`DELETE FROM ${attempts}`)).rejects.toThrow(
		/device_rejoin_attempt_immutable/u,
	);
	await expect(insertAttempt(db, "INSERT OR REPLACE")).rejects.toThrow(
		/device_rejoin_attempt_collision/u,
	);
	await expect(db.run(`UPDATE ${audit} SET group_count = 2`)).rejects.toThrow(
		/device_rejoin_audit_immutable/u,
	);
	await expect(db.run(`DELETE FROM ${audit}`)).rejects.toThrow(/device_rejoin_audit_immutable/u);
	await expect(
		db.run(`INSERT OR REPLACE INTO ${audit} SELECT coordinator_id, 'replacement-event', attempt_id,
		 identity_id, device_id, binding_id, group_count, finalized_at_ms FROM ${audit}`),
	).rejects.toThrow(/device_rejoin_audit_collision/u);
	await expect(
		db.run(`INSERT OR REPLACE INTO ${audit} SELECT coordinator_id, event_id, 'another-attempt',
		 identity_id, device_id, binding_id, group_count, finalized_at_ms FROM ${audit}`),
	).rejects.toThrow(/device_rejoin_audit_collision/u);
	expect(await db.rows(`SELECT state, final_receipt_json FROM ${attempts}`)).toEqual([
		{ state: "finalized", final_receipt_json: receipt },
	]);
	expect(await db.rows(`SELECT event_id, group_count FROM ${audit}`)).toEqual([
		{ event_id: "event", group_count: 1 },
	]);
}
