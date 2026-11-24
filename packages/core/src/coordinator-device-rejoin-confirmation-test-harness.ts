import { expect, it } from "vitest";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	confirmDeviceRejoinAttempt,
	type DeviceRejoinConfirmationScope,
	readDeviceRejoinConfirmation,
} from "./coordinator-device-rejoin-confirmation.js";
import {
	type RejoinEvidenceFixture,
	seedGenesis,
} from "./coordinator-device-rejoin-link-evidence-test-harness.js";

export type RejoinConfirmationFixture = RejoinEvidenceFixture & {
	changed(s: AuthLinkStatement): Promise<number>;
};
type Fixture = RejoinConfirmationFixture;
const now = 1_791_028_800_020;
export const confirmationScope: DeviceRejoinConfirmationScope = {
	coordinatorId: "coordinator-a",
	attemptId: "rejoin-a",
	origin: "https://coordinator.example.test",
	issuer: "https://accounts.example.test",
	authConfigRevision: "a".repeat(64),
	redirectUri: "https://coordinator.example.test/auth/callback",
	transactionHash: "c".repeat(64),
	binderHash: "d".repeat(64),
	now,
};
const pin = confirmationScope;
const keyId = "f".repeat(64);
const completeHash = "b".repeat(64);

export async function prepareConfirmation(
	db: Fixture,
	options: { generation?: number; key?: { publicKey: string; keyId: string }; alias?: true } = {},
) {
	const key = options.key ?? { publicKey: "fixture-key", keyId };
	await seedGenesis(db);
	await db.run(
		`INSERT INTO coordinator_device_ownership_bindings
	(device_id,key_id,coordinator_id,identity_id,binding_id,provenance,source_ref,bound_at)
	VALUES ('removed',?,'coordinator-a','identity-a','binding','owner_enrollment','fixture','then')`,
		key.keyId,
	);
	await db.run("INSERT INTO groups (group_id,created_at) VALUES ('group-a','then')");
	await db.run(
		`INSERT INTO coordinator_device_removals
	(removal_seq,removal_id,group_id,device_id,public_key,fingerprint,key_id,identity_id,removed_at)
	VALUES (1,'removal','group-a','removed',?,'fingerprint',?,'identity-a','then')`,
		key.publicKey,
		key.keyId,
	);
	if (options.alias)
		await db.run(
			`INSERT INTO coordinator_device_removals
		(removal_seq,removal_id,group_id,device_id,public_key,fingerprint,key_id,identity_id,removed_at)
		VALUES (2,'alias-removal','group-a','alias',?,'fingerprint',?,'identity-a','then')`,
			key.publicKey,
			key.keyId,
		);
	await db.run(
		`INSERT INTO coordinator_device_rejoin_attempts
	(coordinator_id,attempt_id,origin,device_id,public_key,key_id,fingerprint,identity_id,binding_id,
	issuer,auth_config_revision,removal_digest,own_tombstones_json,alias_removal_seqs_json,
	browser_start_hash,loopback_redirect,created_at_ms,expires_at_ms)
	VALUES (?,?,?,'removed',?,?,'fingerprint','identity-a','binding',?,?,'digest',
	?,?,?,'http://127.0.0.1:1234/complete',?,?)`,
		pin.coordinatorId,
		pin.attemptId,
		pin.origin,
		key.publicKey,
		key.keyId,
		pin.issuer,
		pin.authConfigRevision,
		JSON.stringify([[1, "group-a", key.publicKey, "fingerprint"]]),
		options.alias ? "[2]" : "[]",
		"e".repeat(64),
		now - 20,
		now - 20 + 600_000,
	);
	await seedConsumedBrowser(db, options.generation ?? 1);
}

async function seedConsumedBrowser(db: Fixture, generation: number) {
	await db.run(
		`INSERT INTO coordinator_auth_browser_transactions
	(coordinator_id,browser_transaction_hash,purpose,attempt_id,state_hash,binder_hash,issuer,
	auth_config_revision,redirect_uri,state,claim_token,created_at_ms,expires_at_ms,consumed_at_ms,start_order)
	VALUES (?,?,'owner_enroll',?,?,?,?,?,?,'consumed','claim-rejoin',?,?,?,1)`,
		pin.coordinatorId,
		pin.transactionHash,
		pin.attemptId,
		"1".repeat(64),
		pin.binderHash,
		pin.issuer,
		pin.authConfigRevision,
		pin.redirectUri,
		now - 19,
		now - 20 + 600_000,
		now - 18,
	);
	await db.run(
		`UPDATE coordinator_device_rejoin_attempts SET state='browser_claimed',
	browser_transaction_hash=?,browser_binder_hash=?`,
		pin.transactionHash,
		pin.binderHash,
	);
	await db.run(
		`UPDATE coordinator_device_rejoin_attempts SET state='oidc_verified',link_id='link-a',
	link_authority_kind='controller_attestation',link_generation=?`,
		generation,
	);
}

function attempt(db: Fixture) {
	return db.first({
		sql: `SELECT state,confirmation_hash,completion_secret_hash,
	destinations_json,non_destinations_json FROM coordinator_device_rejoin_attempts`,
		values: [],
	});
}

function confirm(db: Fixture, confirmation: string, run = db.changed) {
	return confirmDeviceRejoinAttempt(
		{ first: db.first, run },
		{
			...pin,
			confirmation,
			completionSecretHash: completeHash,
		},
	);
}

export function registerRejoinConfirmationTests(
	withFixture: (use: (db: Fixture) => Promise<void>) => Promise<void>,
) {
	it("confirms the exact browser review once", () =>
		withFixture(async (db) => {
			await prepareConfirmation(db);
			const review = await readDeviceRejoinConfirmation(db, pin);
			if (!review) throw new Error("Missing eligible review");
			expect(review.destinationsJson).toBe('[["group-a",null]]');
			expect(
				await readDeviceRejoinConfirmation(db, { ...pin, binderHash: "9".repeat(64) }),
			).toBeNull();
			expect(
				await readDeviceRejoinConfirmation(db, { ...pin, now: now - 20 + 600_000 }),
			).toBeNull();
			expect(await confirm(db, review.confirmation)).toBe(true);
			expect(await attempt(db)).toEqual({
				state: "confirmed",
				confirmation_hash: review.confirmation,
				completion_secret_hash: completeHash,
				destinations_json: review.destinationsJson,
				non_destinations_json: "[]",
			});
			expect(await confirm(db, review.confirmation)).toBe(false);
		}));

	it.each(["link revoked", "group archived"] as const)(
		"refuses when the %s after the read",
		(scenario) =>
			withFixture(async (db) => {
				await prepareConfirmation(db);
				const review = await readDeviceRejoinConfirmation(db, pin);
				if (!review) throw new Error("Missing eligible review");
				const before = await attempt(db);
				expect(
					await confirm(db, review.confirmation, async (statement) => {
						if (scenario === "link revoked")
							await db.run("UPDATE coordinator_auth_account_links SET revoked_at_ms=?", now);
						else await db.run("UPDATE groups SET archived_at='then'");
						return db.changed(statement);
					}),
				).toBe(false);
				expect(await attempt(db)).toEqual(before);
			}),
	);

	it("refuses an incorrect generation", () =>
		withFixture(async (db) => {
			await prepareConfirmation(db, { generation: 2 });
			expect(await readDeviceRejoinConfirmation(db, pin)).toBeNull();
			expect(await confirm(db, "1".repeat(64))).toBe(false);
			expect(await attempt(db)).toMatchObject({ state: "oidc_verified", confirmation_hash: null });
		}));
}
