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
import { finalizeNewDeviceRejoin } from "./coordinator-device-rejoin-finalize.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";

type Fixture = RejoinConfirmationFixture & { batch: AuthLinkBackend["batch"] };

async function signedFinalize(db: Fixture) {
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
			expect(await finalizeNewDeviceRejoin(backend(db), scope, wrong)).toBeNull();
			expect(await effects(db)).toEqual({
				attempt: "confirmed",
				lifted: 0,
				devices: "[]",
				audit: 0,
			});
			const receipt = await finalizeNewDeviceRejoin(backend(db), scope, input);
			expect(receipt).toMatchObject({
				device_id: "removed",
				lifted_removal_seqs: [1, 2],
				group_ids: ["group-a"],
			});
			expect(await effects(db)).toEqual({
				attempt: "finalized",
				lifted: 2,
				devices: '["removed"]',
				audit: 1,
			});
			expect(await finalizeNewDeviceRejoin(backend(db), scope, input)).toBeNull();
		}));

	it("rolls back the finalized attempt and tombstone lifts if enrollment writes no row", () =>
		withFixture(async (db) => {
			const input = await signedFinalize(db);
			await db.run(`CREATE TRIGGER fixture_skip_rejoin BEFORE INSERT ON enrolled_devices
		WHEN NEW.device_id = 'removed' BEGIN SELECT RAISE(IGNORE); END`);
			expect(await finalizeNewDeviceRejoin(backend(db), scope, input)).toBeNull();
			expect(await effects(db)).toEqual({
				attempt: "confirmed",
				lifted: 0,
				devices: "[]",
				audit: 0,
			});
		}));

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
			expect(await finalizeNewDeviceRejoin(b, scope, input)).toBeNull();
			expect(await effects(db)).toEqual({
				attempt: "confirmed",
				lifted: 0,
				devices: "[]",
				audit: 3,
			});
		}));

	registerFinalizeRaceTests(withFixture);
}

function registerFinalizeRaceTests(
	withFixture: (use: (db: Fixture) => Promise<void>) => Promise<void>,
) {
	it.each(["link revoked", "group archived", "grant added"] as const)(
		"refuses when the %s just before the batch",
		(scenario) =>
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
				expect(await finalizeNewDeviceRejoin(b, scope, input)).toBeNull();
				expect(await effects(db)).toEqual({
					attempt: "confirmed",
					lifted: 0,
					devices: "[]",
					audit: 0,
				});
			}),
	);
}
