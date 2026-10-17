import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS } from "../../core/src/coordinator-auth-device-claim-schema.js";
import { AUTH_LIFECYCLE_PREDECESSOR_TABLES } from "../../core/src/coordinator-auth-lifecycle-predecessor-shapes.js";
import { AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL } from "../../core/src/coordinator-auth-lifecycle-schema.js";
import { authLifecycleCopyStatement, authLifecyclePreservationCheck, authLifecycleSnapshotStatements, type AuthLifecycleCopyTable } from "../../core/src/coordinator-auth-lifecycle-upgrade-copy.js";

const db = env.COORDINATOR_DB;
const links = "coordinator_auth_account_links";
const claims = "coordinator_auth_device_claims";
const hash = "a".repeat(64);
const linkDdl = AUTH_LIFECYCLE_PREDECESSOR_TABLES.find(({ name }) => name === links)?.variants[0];
if (!linkDdl) throw new Error("Missing frozen link definition");
function check(table: AuthLifecycleCopyTable) {
	return db.prepare(`SELECT ${authLifecyclePreservationCheck({ table })} AS ok`).first();
}
async function sourceRows() {
	const { results } = await db.prepare(`SELECT rowid, hex(CAST(issuer AS BLOB)) AS issuer_bytes, typeof(identity_id) AS identity_type, hex(identity_id) AS identity_bytes, revoked_at_ms FROM ${links} ORDER BY rowid`).all();
	return results;
}
beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	// Reset only this isolated Miniflare database, never an operator store.
	for (const table of [links, claims]) {
		const suffix = table.slice("coordinator_auth_".length);
		for (const name of [table, `${table}_lifecycle_upgrade`, `coordinator_auth_lifecycle_snapshot_${suffix}`]) await db.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
	}
	await db.prepare(linkDdl).run();
	await db.prepare(AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL.replace(`${links} (`, `${links}_lifecycle_upgrade (`)).run();
	for (const rowid of [3, 42]) await db.prepare(`INSERT INTO ${links} (rowid, coordinator_id, link_id, issuer, subject, identity_id, attempt_id, controller_attestation_id, auth_config_revision, created_at_ms, revoked_at_ms, authority_kind, device_claim_id) VALUES (?, 'synthetic', ?, ?, ?, ?, ?, 'attestation', ?, 1000, ?, 'controller_attestation', NULL)`).bind(rowid, `link-${rowid}`, "Ω'issuer\0tail", `subject-${rowid}`, new Uint8Array([rowid, 0, 255, 0]), `attempt-${rowid}`, hash, rowid === 42 ? 2000 : null).run();
});
afterEach(() => {
	try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
	finally { vi.restoreAllMocks(); }
});
async function copyLinks() {
	const statements = [...authLifecycleSnapshotStatements({ table: links }), authLifecycleCopyStatement({ table: links, extraColumns: { generation: 1, signin_sequence_floor: 0 } })];
	await db.batch(statements.map((sql) => db.prepare(sql)));
}

it("executes snapshot and named-column copy on native D1 with sparse identities and raw bytes", async () => {
	// Arrange
	const before = await sourceRows();
	// Act
	await copyLinks();
	const copied = await db.prepare(`SELECT rowid, generation, signin_sequence_floor, hex(CAST(issuer AS BLOB)) AS issuer_bytes, hex(identity_id) AS identity_bytes FROM ${links}_lifecycle_upgrade ORDER BY rowid`).all();
	// Assert
	expect(await check(links)).toEqual({ ok: 1 });
	expect(copied.results).toEqual([3, 42].map((rowid) => ({ rowid, generation: 1, signin_sequence_floor: 0, issuer_bytes: "CEA927697373756572007461696C", identity_bytes: rowid === 3 ? "0300FF00" : "2A00FF00" })));
	expect(await sourceRows()).toEqual(before);
});

it.each([
	"UPDATE coordinator_auth_account_links_lifecycle_upgrade SET issuer = 'Ω''issuer' || char(0) || 'changed' WHERE rowid = 3",
	"UPDATE coordinator_auth_account_links_lifecycle_upgrade SET identity_id = X'0300FF01' WHERE rowid = 3",
	"UPDATE coordinator_auth_account_links_lifecycle_upgrade SET created_at_ms = X'31303030' WHERE rowid = 3",
	"UPDATE coordinator_auth_account_links_lifecycle_upgrade SET rowid = 43 WHERE rowid = 42",
	"DELETE FROM coordinator_auth_account_links_lifecycle_upgrade WHERE rowid = 3",
	"INSERT INTO coordinator_auth_account_links_lifecycle_upgrade (rowid, coordinator_id, link_id, issuer, subject, identity_id, attempt_id, controller_attestation_id, auth_config_revision, created_at_ms, authority_kind, generation, signin_sequence_floor) VALUES (99, 'synthetic', 'extra', 'issuer', 'extra', 'extra', 'extra', 'attestation', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1000, 'controller_attestation', 1, 0)",
])("rejects native D1 destination damage %# without changing the source", async (damage) => {
	// Arrange
	await copyLinks();
	const before = await sourceRows();
	// Act
	await db.prepare(damage).run();
	// Assert
	expect(await check(links)).toEqual({ ok: 0 });
	expect(await sourceRows()).toEqual(before);
});

it("refuses a native D1 snapshot collision without reusing or overwriting scratch", async () => {
	// Arrange
	await copyLinks();
	const before = await sourceRows();
	// Act
	const repeat = () => db.batch(authLifecycleSnapshotStatements({ table: links }).map((sql) => db.prepare(sql)));
	// Assert
	await expect(repeat()).rejects.toThrow(/already exists/);
	expect(await check(links)).toEqual({ ok: 1 });
	expect(await sourceRows()).toEqual(before);
});

it("copies native WITHOUT ROWID proofs and detects a changed logical claim identity", async () => {
	// Arrange: frozen proof DDL without future lifecycle guards; no cryptographic enrollment occurs.
	const ddl = COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS[0];
	await db.prepare(ddl).run();
	await db.prepare(ddl.replace(`${claims} (`, `${claims}_lifecycle_upgrade (`)).run();
	await db.prepare(`INSERT INTO ${claims} (claim_id, coordinator_id, identity_id, group_id, device_id, public_key, fingerprint, key_id, attempt_id, issuer, auth_config_revision, created_at_ms) VALUES ('claim', 'synthetic', 'identity', 'group', 'device', 'synthetic-key', ?, ?, 'attempt', 'https://issuer.example.test', ?, 1000)`).bind(hash, hash, hash).run();
	// Act
	await db.batch([...authLifecycleSnapshotStatements({ table: claims }), authLifecycleCopyStatement({ table: claims })].map((sql) => db.prepare(sql)));
	const copied = await check(claims);
	await db.prepare(`UPDATE ${claims}_lifecycle_upgrade SET claim_id = 'changed'`).run();
	// Assert
	expect(copied).toEqual({ ok: 1 });
	expect(await check(claims)).toEqual({ ok: 0 });
	expect(await db.prepare(`SELECT claim_id FROM ${claims}`).first()).toEqual({ claim_id: "claim" });
});
