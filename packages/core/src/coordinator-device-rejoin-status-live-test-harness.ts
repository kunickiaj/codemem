import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { readLiveDeviceRejoinStatus } from "./coordinator-device-rejoin-status-projection.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";

export type StatusLiveFixture = Pick<AuthLinkBackend, "first"> & {
	run(sql: string, ...values: (string | number | null)[]): Promise<unknown>;
};
type WithFixture = (use: (db: StatusLiveFixture) => Promise<void>) => Promise<void>;
export const statusLiveScope = {
	coordinatorId: "coordinator",
	attemptId: "attempt",
	origin: "https://coordinator.example.test",
	issuer: "https://issuer.example.test",
	authConfigRevision: "revision",
	now: 1_791_028_800_000,
};
const scope = statusLiveScope;
export const liveReceipt = {
	attempt_id: "attempt",
	device_id: "device",
	identity_id: "identity",
	binding_id: "binding",
	group_ids: ["group"],
	lifted_removal_seqs: [1, 2],
	finalized_at_ms: scope.now,
};
const view = {
	destinations: [["group", null]],
	non_destinations: [["other", "excluded"]],
};

export async function seedStatusLive(db: StatusLiveFixture) {
	const keys = generateKeyPairSync("ed25519");
	const raw = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
	const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const keyId = await ed25519KeyId(publicKey);
	if (!keyId) throw new Error("Invalid synthetic key");
	await db.run(
		`INSERT INTO coordinator_device_removals
 (removal_seq,removal_id,group_id,device_id,public_key,fingerprint,key_id,removed_at)
 VALUES (1,'removal','group','device',?,'fingerprint',?,'then')`,
		publicKey,
		keyId,
	);
	await db.run(
		`INSERT INTO coordinator_device_rejoin_attempts
 (coordinator_id,attempt_id,origin,device_id,public_key,key_id,fingerprint,identity_id,binding_id,
 issuer,auth_config_revision,removal_digest,own_tombstones_json,alias_removal_seqs_json,
 browser_start_hash,loopback_redirect,created_at_ms,expires_at_ms)
 VALUES (?,?,?,'device',?,?,'fingerprint','identity','binding',?,?,'digest',?,'[2]',?,
 'http://127.0.0.1:1234/complete',?,?)`,
		scope.coordinatorId,
		scope.attemptId,
		scope.origin,
		`${publicKey} unused-attempt-comment`,
		keyId,
		scope.issuer,
		scope.authConfigRevision,
		JSON.stringify([[1, "group", publicKey, "fingerprint"]]),
		"a".repeat(64),
		scope.now,
		scope.now + 600_000,
	);
	return (now = scope.now) => ({
		deviceId: "device",
		timestampMs: now,
		signature: sign(
			null,
			Buffer.from(
				JSON.stringify([
					"codemem-device-rejoin-status-v1",
					scope.origin,
					scope.attemptId,
					"device",
					keyId,
					now,
				]),
			),
			keys.privateKey,
		).toString("base64url"),
	});
}

export async function confirmStatusLive(db: StatusLiveFixture) {
	await db.run(
		`UPDATE coordinator_device_rejoin_attempts SET state='browser_claimed',
 browser_transaction_hash='transaction', browser_binder_hash=?`,
		"b".repeat(64),
	);
	await db.run(
		`UPDATE coordinator_device_rejoin_attempts SET state='oidc_verified',
 link_id='link', link_authority_kind='device_claim', link_generation=1`,
	);
	await db.run(
		`UPDATE coordinator_device_rejoin_attempts SET state='confirmed',
 destinations_json='[["group",null]]',non_destinations_json='[["other","excluded"]]',
 confirmation_hash='confirmation',completion_secret_hash=?`,
		"c".repeat(64),
	);
}

export async function finalizeStatusLive(db: StatusLiveFixture) {
	await confirmStatusLive(db);
	await db.run(
		`UPDATE coordinator_device_rejoin_attempts SET state='finalized',
 finalized_at_ms=?,final_receipt_json=?`,
		scope.now,
		JSON.stringify(liveReceipt),
	);
	await db.run(
		`UPDATE coordinator_device_removals SET lifted_at='later',lifted_by_attempt_id='attempt'`,
	);
}

export async function statusLiveSnapshot(db: StatusLiveFixture) {
	return Promise.all(
		[
			"coordinator_device_rejoin_attempts",
			"coordinator_device_removals",
			"enrolled_devices",
			"request_nonces",
			"coordinator_device_rejoin_audit_log",
			"coordinator_device_ownership_bindings",
			"coordinator_identity_group_grants",
		].map((table) =>
			Promise.all([
				db.first({ sql: `SELECT * FROM ${table} ORDER BY rowid LIMIT 1`, values: [] }),
				db.first({ sql: `SELECT count(*) AS n FROM ${table}`, values: [] }),
			]),
		),
	);
}

export function registerStatusLiveTests(withFixture: WithFixture) {
	registerLiveStateTests(withFixture);
	registerBoundaryTests(withFixture);
	registerMalformedProjectionTests(withFixture);
}

async function advanceState(db: StatusLiveFixture, state: string) {
	if (state === "finalized") return finalizeStatusLive(db);
	if (state === "confirmed") return confirmStatusLive(db);
	if (state === "pending") return;
	await db.run("UPDATE coordinator_device_rejoin_attempts SET state='browser_claimed'");
	if (state === "oidc_verified")
		await db.run("UPDATE coordinator_device_rejoin_attempts SET state='oidc_verified'");
}

function registerLiveStateTests(withFixture: WithFixture) {
	it.each(["pending", "browser_claimed", "oidc_verified", "confirmed", "finalized"] as const)(
		"projects only the live %s fields without writes",
		(state) =>
			withFixture(async (db) => {
				const poll = await seedStatusLive(db);
				await advanceState(db, state);
				const before = await statusLiveSnapshot(db);
				expect(await readLiveDeviceRejoinStatus(db, scope, poll())).toEqual({
					kind: "live",
					body: {
						state,
						expires_at_ms: scope.now + 600_000,
						...(state === "confirmed" || state === "finalized" ? { confirmation_view: view } : {}),
						...(state === "finalized" ? { receipt: liveReceipt } : {}),
					},
				});
				expect(await statusLiveSnapshot(db)).toEqual(before);
			}),
	);
	it("preserves SQLite BINARY group order for non-ASCII identifiers", () =>
		withFixture(async (db) => {
			const poll = await seedStatusLive(db);
			await confirmStatusLive(db);
			const first: AuthLinkBackend["first"] = async <T>(
				statement: Parameters<AuthLinkBackend["first"]>[0],
			) => {
				const row = await db.first<Record<string, unknown>>(statement);
				if (!row) return null;
				if (statement.sql.includes("final_receipt_json"))
					return { ...row, destinations_json: '[["\uE000",1],["😀",2]]' } as T;
				return row as T;
			};
			const result = await readLiveDeviceRejoinStatus({ first }, scope, poll());
			expect(result).toMatchObject({
				kind: "live",
				body: {
					confirmation_view: {
						destinations: [
							["\uE000", 1],
							["😀", 2],
						],
					},
				},
			});
		}));
}

function registerBoundaryTests(withFixture: WithFixture) {
	it("keeps the authenticated scope for projection across the proof read", () =>
		withFixture(async (db) => {
			const poll = await seedStatusLive(db);
			await confirmStatusLive(db);
			const mutableScope = { ...scope };
			const proof = poll();
			const first = async <T>(statement: AuthLinkStatement) => {
				const row = await db.first<T>(statement);
				if (statement.sql.includes("t.public_key")) {
					mutableScope.attemptId = "other-attempt";
					proof.deviceId = "other-device";
				}
				return row;
			};
			expect(await readLiveDeviceRejoinStatus({ first }, mutableScope, proof)).toMatchObject({
				kind: "live",
				body: { state: "confirmed" },
			});
		}));

	it.each([599_999, 600_000, 600_001])(
		"authenticates the deadline boundary at +%i without reading elapsed receipts",
		(offset) =>
			withFixture(async (db) => {
				const poll = await seedStatusLive(db);
				await finalizeStatusLive(db);
				const now = scope.now + offset;
				const first: AuthLinkBackend["first"] = (statement) => {
					if (offset >= 600_000) expect(statement.sql).not.toContain("receipt");
					return db.first(statement);
				};
				const before = await statusLiveSnapshot(db);
				const result = await readLiveDeviceRejoinStatus({ first }, { ...scope, now }, poll(now));
				expect(result.kind).toBe(offset < 600_000 ? "live" : "authenticated_deadline_elapsed");
				expect(await statusLiveSnapshot(db)).toEqual(before);
			}),
	);
	it("does not read projection fields or disclose elapsed state with invalid proof", () =>
		withFixture(async (db) => {
			const poll = await seedStatusLive(db);
			await finalizeStatusLive(db);
			const now = scope.now + 600_000;
			const first: AuthLinkBackend["first"] = (statement) => {
				expect(statement.sql).not.toMatch(/receipt|destinations_json/);
				return db.first(statement);
			};
			expect(
				await readLiveDeviceRejoinStatus(
					{ first },
					{ ...scope, now },
					{ ...poll(now), signature: "invalid" },
				),
			).toEqual({ kind: "unavailable" });
		}));
	it("leaves stored expiry HTTP policy to its caller", () =>
		withFixture(async (db) => {
			const poll = await seedStatusLive(db);
			await db.run("UPDATE coordinator_device_rejoin_attempts SET state='expired'");
			const before = await statusLiveSnapshot(db);
			expect(await readLiveDeviceRejoinStatus(db, scope, poll())).toEqual({
				kind: "authenticated_expired",
			});
			expect(await statusLiveSnapshot(db)).toEqual(before);
		}));
}

function registerMalformedProjectionTests(withFixture: WithFixture) {
	const corruptions: Record<string, unknown>[] = [
		{ destinations_json: "{" },
		{ destinations_json: "{}" },
		{ destinations_json: "[]" },
		{ destinations_json: '[["group"]]' },
		{ destinations_json: '[["group",0]]' },
		{ destinations_json: '[["group","1"]]' },
		{ destinations_json: '[["group",null],["group",1]]' },
		{ non_destinations_json: '[["other","unknown"]]' },
		{ non_destinations_json: '[["other",["excluded"]]]' },
		{ non_destinations_json: '[["group","excluded"]]' },
		{ own_tombstones_json: '[["1","group","key","fingerprint"]]' },
		{ alias_removal_seqs_json: "[1]" },
		{ final_receipt_json: '{"private":"must-not-forward"}' },
		{ final_receipt_json: JSON.stringify({ ...liveReceipt, extra: "private" }) },
		{ final_receipt_json: JSON.stringify({ ...liveReceipt, device_id: "other" }) },
		{ final_receipt_json: JSON.stringify({ ...liveReceipt, group_ids: ["other"] }) },
		{ final_receipt_json: JSON.stringify({ ...liveReceipt, lifted_removal_seqs: [2, 1] }) },
		{ finalized_at_ms: scope.now + 1 },
		{ state: "unknown" },
		{ expires_at_ms: "invalid" },
	];
	it.each(corruptions)("fails closed on a malformed stored projection %j", (corruption) =>
		withFixture(async (db) => {
			const poll = await seedStatusLive(db);
			await finalizeStatusLive(db);
			const first: AuthLinkBackend["first"] = async <T>(
				statement: Parameters<AuthLinkBackend["first"]>[0],
			) => {
				const row = await db.first<Record<string, unknown>>(statement);
				if (!row) return null;
				// Corrupt only the projection read, leaving the actual proof verifier in place.
				return (
					statement.sql.includes("final_receipt_json") ? { ...row, ...corruption } : row
				) as T;
			};
			expect(await readLiveDeviceRejoinStatus({ first }, scope, poll())).toEqual({
				kind: "unavailable",
			});
		}),
	);
}
