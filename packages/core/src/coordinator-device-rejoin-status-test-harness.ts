import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	type DeviceRejoinStatusScope,
	readVerifiedDeviceRejoinStatus,
} from "./coordinator-device-rejoin-status.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { buildCanonicalRequest } from "./sync-auth.js";

type Fixture = Pick<AuthLinkBackend, "first"> & {
	run(sql: string, ...values: (string | number | null)[]): Promise<unknown>;
};
type WithFixture = (use: (db: Fixture) => Promise<void>) => Promise<void>;
const NOW = 1_791_028_800_000;
const scope: DeviceRejoinStatusScope = {
	coordinatorId: "coordinator",
	attemptId: "attempt",
	origin: "https://coordinator.example.test",
	issuer: "https://issuer.example.test",
	authConfigRevision: "revision",
	now: NOW,
};

async function seed(
	db: Fixture,
	options: { keyId?: string; pinnedGroup?: string; omitTombstone?: true } = {},
) {
	const keys = generateKeyPairSync("ed25519");
	const raw = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
	const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const keyId = options.keyId ?? (await ed25519KeyId(publicKey));
	if (!keyId) throw new Error("Invalid fixture key");
	if (!options.omitTombstone)
		await db.run(
			`INSERT INTO coordinator_device_removals
		(removal_id, group_id, device_id, public_key, fingerprint, key_id, removed_at)
		VALUES ('removal', 'group', 'device', ?, 'fingerprint', ?, 'then')`,
			publicKey,
			keyId,
		);
	await db.run(
		`INSERT INTO coordinator_device_rejoin_attempts
		(coordinator_id,attempt_id,origin,device_id,public_key,key_id,fingerprint,identity_id,binding_id,
		issuer,auth_config_revision,removal_digest,own_tombstones_json,alias_removal_seqs_json,
		browser_start_hash,loopback_redirect,created_at_ms,expires_at_ms)
		VALUES (?,?,?,'device',?,?,'fingerprint','identity','binding',?,?,'digest',?,'[]',?,
		'http://127.0.0.1:1234/complete',?,?)`,
		scope.coordinatorId,
		scope.attemptId,
		scope.origin,
		`${publicKey} attempt-comment`,
		keyId,
		scope.issuer,
		scope.authConfigRevision,
		JSON.stringify([[1, options.pinnedGroup ?? "group", publicKey, "fingerprint"]]),
		"a".repeat(64),
		NOW,
		NOW + 600_000,
	);
	const signMessage = (message: string) =>
		sign(null, Buffer.from(message), keys.privateKey).toString("base64url");
	const poll = (timestampMs = NOW, changes: { origin?: string; attemptId?: string } = {}) => ({
		deviceId: "device",
		timestampMs,
		signature: signMessage(
			JSON.stringify([
				"codemem-device-rejoin-status-v1",
				changes.origin ?? scope.origin,
				changes.attemptId ?? scope.attemptId,
				"device",
				keyId,
				timestampMs,
			]),
		),
	});
	return { poll, signMessage, keyId, publicKey };
}

async function snapshot(db: Fixture) {
	const tables = [
		"coordinator_device_rejoin_attempts",
		"coordinator_device_rejoin_audit_log",
		"coordinator_device_removals",
		"enrolled_devices",
		"coordinator_device_revocations",
	];
	return Promise.all(
		tables.map((table) =>
			Promise.all([
				db.first({ sql: `SELECT * FROM ${table} ORDER BY rowid LIMIT 1`, values: [] }),
				db.first({ sql: `SELECT count(*) AS n FROM ${table}`, values: [] }),
			]),
		),
	);
}

export function registerRejoinStatusTests(withFixture: WithFixture) {
	it("authenticates each poll against the original tombstone without writing", () =>
		withFixture(async (db) => {
			const { poll } = await seed(db);
			const before = await snapshot(db);
			const readOnly = { first: db.first };
			expect(await readVerifiedDeviceRejoinStatus(readOnly, scope, poll())).toEqual({
				state: "pending",
				expiresAtMs: NOW + 600_000,
				deadlineElapsed: false,
			});
			expect(
				await readVerifiedDeviceRejoinStatus(readOnly, { ...scope, now: NOW + 300_001 }, poll()),
			).toBeNull();
			expect(
				await readVerifiedDeviceRejoinStatus(
					readOnly,
					{ ...scope, now: NOW + 300_001 },
					poll(NOW + 300_001),
				),
			).not.toBeNull();
			expect(await snapshot(db)).toEqual(before);
		}));

	it("reports expiry only to its trusted caller without expiring the attempt", () =>
		withFixture(async (db) => {
			const { poll } = await seed(db);
			const before = await snapshot(db);
			for (const now of [NOW + 599_999, NOW + 600_000, NOW + 900_000]) {
				expect(await readVerifiedDeviceRejoinStatus(db, { ...scope, now }, poll(now))).toEqual({
					state: "pending",
					expiresAtMs: NOW + 600_000,
					deadlineElapsed: now >= NOW + 600_000,
				});
			}
			expect(await snapshot(db)).toEqual(before);
		}));

	it("still uses the original key after lifting, without enrollment or receipt reads", () =>
		withFixture(async (db) => {
			const { poll } = await seed(db);
			await db.run(
				`UPDATE coordinator_device_removals SET lifted_at='later', lifted_by_invite_id='fixture'`,
			);
			const before = await snapshot(db);
			expect(await readVerifiedDeviceRejoinStatus(db, scope, poll())).toEqual({
				state: "pending",
				expiresAtMs: NOW + 600_000,
				deadlineElapsed: false,
			});
			expect(await snapshot(db)).toEqual(before);
		}));

	registerRefusals(withFixture);
	registerProofRefusals(withFixture);
	registerStateReads(withFixture);
	registerPrivateMaterialTest(withFixture);
}

function registerPrivateMaterialTest(withFixture: WithFixture) {
	it("never reads or returns stored completion material or a finalized receipt", () =>
		withFixture(async (db) => {
			const { poll } = await seed(db);
			await db.run(
				"UPDATE coordinator_device_rejoin_attempts SET state='browser_claimed', browser_transaction_hash='transaction', browser_binder_hash=?",
				"b".repeat(64),
			);
			await db.run(
				"UPDATE coordinator_device_rejoin_attempts SET state='oidc_verified', link_id='link', link_authority_kind='device_claim', link_generation=1",
			);
			await db.run(
				`UPDATE coordinator_device_rejoin_attempts SET state='confirmed',
				destinations_json='[["group",null]]', non_destinations_json='[]',
				confirmation_hash='confirmation', completion_secret_hash=?`,
				"c".repeat(64),
			);
			for (const state of ["confirmed", "finalized"]) {
				if (state === "finalized")
					await db.run(
						`UPDATE coordinator_device_rejoin_attempts SET state='finalized',
						finalized_at_ms=?, final_receipt_json='{"receipt":"fixture-only"}'`,
						NOW,
					);
				const before = await snapshot(db);
				const first: AuthLinkBackend["first"] = (statement) => {
					expect(statement.sql).not.toMatch(/completion|browser_|receipt|SELECT a\.\*/u);
					return db.first(statement);
				};
				expect(await readVerifiedDeviceRejoinStatus({ first }, scope, poll())).toEqual({
					state,
					expiresAtMs: NOW + 600_000,
					deadlineElapsed: false,
				});
				expect(await snapshot(db)).toEqual(before);
			}
		}));
}

function registerStateReads(withFixture: WithFixture) {
	it.each(["expired", "failed"] as const)("reads stored %s facts without altering them", (state) =>
		withFixture(async (db) => {
			const { poll } = await seed(db);
			await db.run("UPDATE coordinator_device_rejoin_attempts SET state = ?", state);
			const before = await snapshot(db);
			expect(await readVerifiedDeviceRejoinStatus(db, scope, poll())).toEqual({
				state,
				expiresAtMs: NOW + 600_000,
				deadlineElapsed: false,
			});
			expect(await snapshot(db)).toEqual(before);
		}),
	);
	it("refuses a valid status signature made by a different key", () =>
		withFixture(async (db) => {
			const { poll, keyId } = await seed(db);
			const input = poll();
			const other = generateKeyPairSync("ed25519");
			input.signature = sign(
				null,
				Buffer.from(
					JSON.stringify([
						"codemem-device-rejoin-status-v1",
						scope.origin,
						scope.attemptId,
						"device",
						keyId,
						NOW,
					]),
				),
				other.privateKey,
			).toString("base64url");
			const before = await snapshot(db);
			expect(await readVerifiedDeviceRejoinStatus(db, scope, input)).toBeNull();
			expect(await snapshot(db)).toEqual(before);
		}));
}

function registerRefusals(withFixture: WithFixture) {
	const pinChanges: Partial<DeviceRejoinStatusScope>[] = [
		{ coordinatorId: null },
		{ coordinatorId: "other" },
		{ attemptId: "other" },
		{ origin: "https://other.example.test" },
		{ issuer: "https://other.example.test" },
		{ authConfigRevision: "other" },
		{ now: NOW + 300_001 },
		{ now: NOW - 300_001 },
	];
	it.each(pinChanges)("returns the same internal refusal for changed pin %j", (change) =>
		withFixture(async (db) => {
			const { poll } = await seed(db);
			const before = await snapshot(db);
			expect(await readVerifiedDeviceRejoinStatus(db, { ...scope, ...change }, poll())).toBeNull();
			expect(await snapshot(db)).toEqual(before);
		}),
	);
	it.each([{ keyId: "0".repeat(64) }, { pinnedGroup: "other" }])(
		"requires a matching original key and pinned tombstone %j",
		(options) =>
			withFixture(async (db) => {
				const { poll } = await seed(db, options);
				const before = await snapshot(db);
				expect(await readVerifiedDeviceRejoinStatus(db, scope, poll())).toBeNull();
				expect(await snapshot(db)).toEqual(before);
			}),
	);
	it("requires the pinned tombstone", () =>
		withFixture(async (db) => {
			const { poll } = await seed(db, { omitTombstone: true });
			expect(await readVerifiedDeviceRejoinStatus(db, scope, poll())).toBeNull();
		}));
}

function purposeMessage(
	change: "start" | "finalize" | "ordinary",
	keyId: string,
	publicKey: string,
) {
	if (change === "start")
		return JSON.stringify([
			"codemem-device-rejoin-start-v1",
			scope.origin,
			scope.attemptId,
			"device",
			publicKey,
			keyId,
			"a".repeat(64),
			"http://127.0.0.1:1234/complete",
			NOW,
		]);
	if (change === "finalize")
		return JSON.stringify([
			"codemem-device-rejoin-finalize-v1",
			scope.coordinatorId,
			scope.origin,
			scope.authConfigRevision,
			scope.attemptId,
			"device",
			publicKey,
			keyId,
			"fingerprint",
			scope.issuer,
			"identity",
			"binding",
			"digest",
			"confirmation",
			"completion",
		]);
	return buildCanonicalRequest(
		"POST",
		"/v1/auth/rejoin-attempts/attempt/status",
		String(NOW / 1000),
		"fixture-nonce",
		Buffer.from("body"),
	).toString("utf8");
}

function registerProofRefusals(withFixture: WithFixture) {
	it.each([
		"device",
		"signature",
		"timestamp",
		"origin",
		"attempt",
		"start",
		"finalize",
		"ordinary",
	] as const)("refuses a substituted %s proof without writing", (change) =>
		withFixture(async (db) => {
			const { poll, signMessage, keyId, publicKey } = await seed(db);
			const input = poll();
			switch (change) {
				case "device":
					input.deviceId = "other";
					break;
				case "signature":
					input.signature = "invalid";
					break;
				case "timestamp":
					input.timestampMs++;
					break;
				case "origin":
					input.signature = poll(NOW, { origin: "https://other.example.test" }).signature;
					break;
				case "attempt":
					input.signature = poll(NOW, { attemptId: "other" }).signature;
					break;
				default:
					input.signature = signMessage(purposeMessage(change, keyId, publicKey));
			}
			const before = await snapshot(db);
			expect(await readVerifiedDeviceRejoinStatus(db, scope, input)).toBeNull();
			expect(await snapshot(db)).toEqual(before);
		}),
	);
}
