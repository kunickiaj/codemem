import { expect } from "vitest";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";

export const BROWSER_TABLE = "coordinator_auth_browser_transactions";
export const FLOOR_TABLE = "coordinator_auth_signin_purge_floors";
export type SchemaFixture = {
	exec: (sql: string, ...values: (string | number | null)[]) => Promise<void>;
	query: (sql: string) => Promise<Record<string, unknown>[]>;
};
export const browserDefinitions = `SELECT type, name, sql FROM sqlite_master
 WHERE tbl_name IN ('${BROWSER_TABLE}', '${FLOOR_TABLE}') AND sql IS NOT NULL ORDER BY type, name`;
export function normalizeDefinitions(rows: Record<string, unknown>[]) {
	return rows.map((row) => ({ ...row, sql: String(row.sql).replace(/\s+/g, " ").trim() }));
}
export async function browserSnapshot(f: SchemaFixture) {
	return {
		rows: await f.query(`SELECT * FROM ${BROWSER_TABLE} ORDER BY state_hash`),
		floors: await f.query(`SELECT * FROM ${FLOOR_TABLE} ORDER BY coordinator_id`),
		indexes: await f.query(`SELECT * FROM pragma_index_list('${BROWSER_TABLE}') ORDER BY name`),
	};
}

// Dummy strings exercise byte-for-byte preservation, never provider exchange or owner proof.
export async function seedOldBrowserRows(f: SchemaFixture) {
	let index = 0;
	for (const purpose of ["signin", "link"]) {
		for (const state of ["pending", "consumed", "expired"]) {
			index++;
			await seedBrowserRow(f, { index, purpose, state });
		}
	}
	await f.exec(`INSERT INTO ${FLOOR_TABLE} VALUES (?,?)`, "coordinator-a", NOW - 123);
}
async function seedBrowserRow(
	f: SchemaFixture,
	{ index, purpose, state }: { index: number; purpose: string; state: string },
) {
	const hash = (offset: number) => (index + offset).toString(16).padStart(64, "0");
	await f.exec(
		`INSERT INTO ${BROWSER_TABLE}
 (coordinator_id,browser_transaction_hash,purpose,attempt_id,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,claim_token,created_at_ms,expires_at_ms,consumed_at_ms)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		"coordinator-a",
		hash(0),
		purpose,
		purpose === "link" ? `old-attempt-${index}` : null,
		hash(10),
		hash(20),
		"https://accounts.example.test/exact?fixture=1",
		"a".repeat(64),
		"https://coordinator.example.test/auth/callback?exact=%2f",
		state,
		state === "pending" ? `dummy-nonce-${"n".repeat(43)}` : null,
		state === "pending" ? `dummy-pkce-${"p".repeat(43)}` : null,
		state === "consumed" ? `dummy-claim-${index}` : null,
		NOW + index,
		NOW + index + 600000,
		state === "consumed" ? NOW + index + 1 : null,
	);
}

export async function assertBrowserUniqueness(f: SchemaFixture) {
	for (const column of [
		"browser_transaction_hash",
		"state_hash",
		"binder_hash",
		"attempt_id",
		"claim_token",
	]) {
		const before = await browserSnapshot(f);
		const target =
			column === "claim_token"
				? "purpose = 'signin' AND state = 'consumed'"
				: "purpose = 'link' AND state = 'pending'";
		const collision = f.exec(`UPDATE ${BROWSER_TABLE} SET ${column} =
 (SELECT ${column} FROM ${BROWSER_TABLE} WHERE purpose = 'link' AND state = 'consumed')
 WHERE ${target}`);
		await expect(collision).rejects.toThrow();
		expect(await browserSnapshot(f)).toEqual(before);
	}
}
