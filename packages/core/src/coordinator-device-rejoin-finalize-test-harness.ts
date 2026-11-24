import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	encodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import {
	confirmDeviceRejoinAttempt,
	readDeviceRejoinConfirmation,
} from "./coordinator-device-rejoin-confirmation.js";
import {
	prepareConfirmation,
	type RejoinConfirmationFixture,
	confirmationScope as scope,
} from "./coordinator-device-rejoin-confirmation-test-harness.js";
import { finalizeDeviceRejoin } from "./coordinator-device-rejoin-finalize.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";

type Fixture = RejoinConfirmationFixture & { batch: AuthLinkBackend["batch"] };

export async function signedFinalize(db: RejoinConfirmationFixture) {
	const key = generateKeyPairSync("ed25519");
	const raw = key.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
	const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const keyId = await ed25519KeyId(publicKey);
	if (!keyId) throw new Error("Fixture key could not be parsed");
	await prepareConfirmation(db, { key: { publicKey, keyId }, alias: true });
	const review = await readDeviceRejoinConfirmation(db, scope);
	if (!review) throw new Error("Fixture could not be reviewed");
	const token = new Uint8Array(32).fill(7);
	const completion = encodeCoordinatorAuthProof32(token);
	const completionSecretHash = await hashCoordinatorAuthProofBytes32(token);
	expect(
		await confirmDeviceRejoinAttempt(
			{ first: db.first, run: db.changed },
			{ ...scope, confirmation: review.confirmation, completionSecretHash },
		),
	).toBe(true);
	const deviceId = "removed";
	const proof = JSON.stringify([
		"codemem-device-rejoin-finalize-v1",
		scope.coordinatorId,
		scope.origin,
		scope.authConfigRevision,
		scope.attemptId,
		deviceId,
		publicKey,
		keyId,
		"fingerprint",
		scope.issuer,
		"identity-a",
		"binding",
		"digest",
		review.confirmation,
		completion,
	]);
	return {
		attemptId: scope.attemptId,
		deviceId,
		completion,
		signature: sign(null, Buffer.from(proof), key.privateKey).toString("base64url"),
	};
}

function effects(db: Fixture) {
	return db.first({
		sql: `SELECT
		(SELECT state FROM coordinator_device_rejoin_attempts) AS attempt,
		(SELECT count(*) FROM coordinator_device_removals WHERE lifted_at IS NOT NULL) AS lifted,
		(SELECT json_group_array(device_id) FROM enrolled_devices) AS devices,
		(SELECT count(*) FROM coordinator_device_rejoin_audit_log) AS audit`,
		values: [],
	});
}

function backend(db: Fixture): AuthLinkBackend {
	return { first: db.first, run: db.changed, batch: db.batch };
}

export function registerRejoinFinalizeTests(
	withFixture: (use: (db: Fixture) => Promise<void>) => Promise<void>,
) {
	it("lifts exact tombstones and enrolls the signed device once", () =>
		withFixture(async (db) => {
			const input = await signedFinalize(db);
			const wrong = { ...input, signature: input.signature.slice(1) };
			expect(await finalizeDeviceRejoin(backend(db), scope, wrong)).toEqual({
				kind: "unavailable",
			});
			expect(
				await finalizeDeviceRejoin(backend(db), { ...scope, now: scope.now + 600_000 }, input),
			).toEqual({ kind: "unavailable" });
			expect(await effects(db)).toEqual({
				attempt: "confirmed",
				lifted: 0,
				devices: "[]",
				audit: 0,
			});
			const result = await finalizeDeviceRejoin(backend(db), scope, input);
			expect(result).toMatchObject({
				kind: "finalized",
				receipt: {
					device_id: "removed",
					lifted_removal_seqs: [1, 2],
					group_ids: ["group-a"],
				},
			});
			expect(await effects(db)).toEqual({
				attempt: "finalized",
				lifted: 2,
				devices: '["removed"]',
				audit: 1,
			});
			expect(await finalizeDeviceRejoin(backend(db), scope, input)).toMatchObject({
				...result,
				kind: "prior_commit",
			});
		}));

	it("rolls back the finalized attempt and tombstone lifts if enrollment writes no row", () =>
		withFixture(async (db) => {
			const input = await signedFinalize(db);
			await db.run(`CREATE TRIGGER fixture_skip_rejoin BEFORE INSERT ON enrolled_devices
		WHEN NEW.device_id = 'removed' BEGIN SELECT RAISE(IGNORE); END`);
			expect(await finalizeDeviceRejoin(backend(db), scope, input)).toEqual({
				kind: "refused",
				reason: "retry",
			});
			expect(await effects(db)).toEqual({
				attempt: "confirmed",
				lifted: 0,
				devices: "[]",
				audit: 0,
			});
		}));

	registerFinalizeLimitTest(withFixture);
	registerFinalizeRaceTests(withFixture);
	registerFinalizeReceiptTests(withFixture);
}

function registerFinalizeLimitTest(
	withFixture: (use: (db: Fixture) => Promise<void>) => Promise<void>,
) {
	it("checks the Identity's daily limit inside the commit", () =>
		withFixture(async (db) => {
			const input = await signedFinalize(db);
			const b = backend(db);
			b.batch = async (statements) => {
				await db.run(
					`INSERT INTO coordinator_device_rejoin_audit_log
			(coordinator_id,event_id,attempt_id,identity_id,device_id,binding_id,group_count,finalized_at_ms)
			SELECT 'coordinator-a',value,value,'identity-a','earlier','other-binding',1,?
			FROM json_each('["old-a","old-b","old-c"]')`,
					scope.now - 1,
				);
				return db.batch(statements);
			};
			expect(await finalizeDeviceRejoin(b, scope, input)).toEqual({
				kind: "refused",
				reason: "daily_limit",
			});
			expect(await effects(db)).toEqual({
				attempt: "confirmed",
				lifted: 0,
				devices: "[]",
				audit: 3,
			});
		}));
}

function registerFinalizeReceiptTests(
	withFixture: (use: (db: Fixture) => Promise<void>) => Promise<void>,
) {
	it("replays only a verified receipt without writing, even after a later removal", () =>
		withFixture(async (db) => {
			const input = await signedFinalize(db);
			const b = backend(db);
			const result = await finalizeDeviceRejoin(b, scope, input);
			if (result.kind !== "finalized") throw new Error("Expected verified finalize");
			await db.run(`INSERT INTO coordinator_device_removals
			 (removal_id,group_id,device_id,public_key,fingerprint,key_id,identity_id,removed_at)
			 SELECT 'later',group_id,device_id,public_key,fingerprint,key_id,identity_id,'later'
			 FROM enrolled_devices WHERE device_id='removed'`);
			await db.run("DELETE FROM enrolled_devices WHERE device_id='removed'");
			b.batch = async () => {
				throw new Error("Receipt read attempted a write");
			};
			const late = { ...scope, now: scope.now + 600_000 };
			expect(await finalizeDeviceRejoin(b, late, input)).toEqual({
				kind: "prior_commit",
				receipt: result.receipt,
			});
			expect(
				await finalizeDeviceRejoin(b, late, { ...input, signature: input.signature.slice(1) }),
			).toEqual({ kind: "unavailable" });
			expect(
				await finalizeDeviceRejoin(b, { ...late, authConfigRevision: "f".repeat(64) }, input),
			).toEqual({ kind: "unavailable" });
			expect(await effects(db)).toEqual({
				attempt: "finalized",
				lifted: 2,
				devices: "[]",
				audit: 1,
			});
		}));
}

function registerFinalizeRaceTests(
	withFixture: (use: (db: Fixture) => Promise<void>) => Promise<void>,
) {
	it.each([
		["link revoked", "account_not_linked"],
		["group archived", "no_destination"],
		["grant added", "removal_changed"],
	] as const)("refuses when the %s just before the batch", (scenario, reason) =>
		withFixture(async (db) => {
			const input = await signedFinalize(db);
			const b = backend(db);
			b.batch = async (statements) => {
				if (scenario === "link revoked")
					await db.run("UPDATE coordinator_auth_account_links SET revoked_at_ms=?", scope.now);
				else if (scenario === "group archived")
					await db.run("UPDATE groups SET archived_at='then'");
				else
					await db.run(`INSERT INTO coordinator_identity_group_grants
				(coordinator_id,identity_id,group_id,status,revision,source_kind,source_receipt_id,created_at)
				VALUES ('coordinator-a','identity-a','group-a','active',1,'controller_attestation','grant','then')`);
				return db.batch(statements);
			};
			expect(await finalizeDeviceRejoin(b, scope, input)).toEqual({ kind: "refused", reason });
			expect(await effects(db)).toEqual({
				attempt: "confirmed",
				lifted: 0,
				devices: "[]",
				audit: 0,
			});
		}),
	);
}
