import { expect } from "vitest";
import { OWNERSHIP_TABLE } from "./coordinator-device-ownership-test-harness.js";
import type {
	RevocationFixture,
	revocationHarness,
} from "./coordinator-device-revocation-test-harness.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import {
	recipientGuardedD1,
	recipientInvite,
	recipientSnapshot,
} from "./coordinator-recipient-revocation-test-harness.js";
import { D1CoordinatorStore, type D1DatabaseLike } from "./d1-coordinator-store.js";
import { OWNED_DENIAL, OWNED_UNAVAILABLE } from "./shared-owned-device-enrollment-test-harness.js";
import {
	bindRecipient,
	ownedRecipientSnapshot,
	ownedRecipientTables,
} from "./shared-owned-recipient-invites-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

type Test = ReturnType<typeof revocationHarness>;
type Database = (f: RevocationFixture) => D1DatabaseLike;
export function registerOwnedRecipientD1(test: Test, database: Database) {
	registerWriteRaces(test, database);
	registerCapture(test);
	registerInviterCapture(test, database);
	registerWinner(test, database);
	registerPins(test, database);
	registerReceipts(test, database);
}
function registerPins(test: Test, database: Database) {
	for (const change of ["token", "tuple", "clean winner"] as const) {
		test(`D1 final batch pins ${change} and never issues duplicate authority`, async ({
			fixture: f,
		}) => {
			// Arrange: alter actual database state after authorization preflight.
			const { input } = await recipientInvite(f, "add_device");
			let atGate: unknown[][] = [];
			const racing = recipientGuardedD1(database(f), async (writes, phase) => {
				if (
					atGate.length ||
					phase !== "batch" ||
					!writes.some((w) => w.query.includes("consumed_at ="))
				)
					return;
				await changePinnedState(f, input, change);
				atGate = await ownedRecipientSnapshot(f);
			});
			// Act
			const pending = racing.consumeRecipientInvite(input);
			// Assert: clean CAS loser reuses history; mismatched token/tuple cannot create grants.
			if (change === "clean winner") {
				expect((await pending).status).toBe("existing");
				expect(await f.rows("coordinator_bootstrap_grants")).toHaveLength(1);
			} else await expect(pending).rejects.toThrow(/^invite_acceptance_incomplete$/);
			expect(atGate).toHaveLength(ownedRecipientTables.length);
			expect(await ownedRecipientSnapshot(f)).toEqual(atGate);
		});
	}
}
async function changePinnedState(
	f: RevocationFixture,
	input: Parameters<typeof bindRecipient>[1],
	change: string,
) {
	if (change === "clean winner") {
		await f.store.consumeRecipientInvite(input);
		return;
	}
	if (change === "token") {
		await f.exec(
			"UPDATE coordinator_invites SET token = ?, token_digest = ? WHERE group_id = ?",
			"replacement-token",
			"e".repeat(64),
			f.input.groupId,
		);
		return;
	}
	await f.store.enrollDevice(f.input.groupId, {
		...f.input,
		deviceId: input.deviceId,
		publicKey: UNRELATED_PUBLIC_KEY,
		fingerprint: fingerprintPublicKey(UNRELATED_PUBLIC_KEY),
		identityId: input.identityId,
	});
}
async function stageRecipient(f: RevocationFixture, stage: string) {
	const fixture = await recipientInvite(f, "add_device");
	const { input, seed } = fixture;
	if (stage === "grant recovery")
		await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, false);
	if (stage !== "first") await f.store.consumeRecipientInvite(input);
	if (stage === "identity repair")
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
			input.deviceId,
		);
	if (stage === "grant recovery") await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, true);
	return fixture;
}
function registerWriteRaces(test: Test, database: Database) {
	for (const stage of ["first", "identity repair", "grant recovery"] as const) {
		for (const subject of ["ID", "key"] as const) {
			test(`D1 atomic ${stage} denies ${subject} binding appearing after preflight`, async ({
				fixture: f,
			}) => {
				// Arrange: stage real recipient history before introducing retained authority.
				const { input } = await stageRecipient(f, stage);
				let atGate: unknown[][] = [];
				const racing = recipientGuardedD1(database(f), async (writes) => {
					if (
						atGate.length ||
						!writes.some((w) =>
							/consumed_at =|UPDATE enrolled_devices SET identity_id|SET bootstrap_grant_id/.test(
								w.query,
							),
						)
					)
						return;
					await bindRecipient(f, input, subject);
					atGate = await ownedRecipientSnapshot(f);
				});
				// Act
				const pending = racing.consumeRecipientInvite(input);
				// Assert: actual rows, not merely SQL metadata, remain unchanged.
				await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
				expect(atGate).toHaveLength(ownedRecipientTables.length);
				expect(await ownedRecipientSnapshot(f)).toEqual(atGate);
			});
		}
	}
}
function registerCapture(test: Test) {
	for (const subject of ["ID", "key"] as const) {
		test(`D1 ${subject} binding arriving during hashing prevents recipient effects`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { input } = await recipientInvite(f, "team_member");
			const before = await recipientSnapshot(f);
			// Act: raw insertion begins while acceptance awaits hashing.
			const pending = f.store.consumeRecipientInvite(input);
			await bindRecipient(f, input, subject);
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
			expect(await recipientSnapshot(f)).toEqual(before);
			expect(await f.rows(OWNERSHIP_TABLE)).toHaveLength(1);
		});
	}
	test("D1 captures owned caller tuple before caller mutation", async ({ fixture: f }) => {
		// Arrange
		const { input } = await recipientInvite(f, "team_member");
		await bindRecipient(f, input);
		const before = await ownedRecipientSnapshot(f);
		// Act
		const pending = f.store.consumeRecipientInvite(input);
		Object.assign(input, {
			deviceId: "clean-device",
			publicKey: UNRELATED_PUBLIC_KEY,
			fingerprint: fingerprintPublicKey(UNRELATED_PUBLIC_KEY),
		});
		// Assert
		await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
		expect(await ownedRecipientSnapshot(f)).toEqual(before);
	});
}
function registerInviterCapture(test: Test, database: Database) {
	for (const retained of ["rotated", "removed"] as const) {
		test(`D1 captured inviter key revocation precedes owner after source ${retained}`, async ({
			fixture: f,
		}) => {
			// Arrange: retain only old-key revocation when the source row changes at the gate.
			const { input, seed } = await recipientInvite(f, "add_device");
			let atGate: unknown[][] = [];
			const racing = recipientGuardedD1(database(f), async (writes, phase) => {
				if (
					atGate.length ||
					phase !== "batch" ||
					!writes.some((w) => w.query.includes("consumed_at ="))
				)
					return;
				await f.store.createDeviceRevocation(seed);
				await f.exec(
					"DELETE FROM coordinator_device_revocations WHERE subject_kind = ?",
					"device_id",
				);
				if (retained === "removed") await f.store.removeDevice(seed.groupId, seed.deviceId);
				else
					await f.exec(
						"UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE device_id = ?",
						"clean-rotated-key",
						fingerprintPublicKey("clean-rotated-key"),
						seed.deviceId,
					);
				await bindRecipient(f, input);
				atGate = await ownedRecipientSnapshot(f);
			});
			// Act
			const pending = racing.consumeRecipientInvite(input);
			// Assert: rereading only the replacement tuple would lose old-key evidence.
			await expect(pending).rejects.toThrow(/^device_revoked$/);
			expect(atGate[3]).toMatchObject([{ subject_kind: "ed25519_key" }]);
			expect(await ownedRecipientSnapshot(f)).toEqual(atGate);
		});
	}
}
function registerWinner(test: Test, database: Database) {
	test("D1 different clean recipient wins; loser preserves bound history and reports already bound", async ({
		fixture: f,
	}) => {
		// Arrange: both callers use the server-assigned identity without owner proof.
		const { input } = await recipientInvite(f, "add_device");
		const other = {
			...input,
			deviceId: "other-clean-recipient",
			publicKey: UNRELATED_PUBLIC_KEY,
			fingerprint: fingerprintPublicKey(UNRELATED_PUBLIC_KEY),
		};
		let atGate: unknown[][] = [];
		const racing = recipientGuardedD1(database(f), async (writes, phase) => {
			if (
				atGate.length ||
				phase !== "batch" ||
				!writes.some((w) => w.query.includes("consumed_at ="))
			)
				return;
			expect((await f.store.consumeRecipientInvite(other)).status).toBe("accepted");
			atGate = await ownedRecipientSnapshot(f);
		});
		// Act: the losing caller passed preflight before the clean winner committed.
		const pending = racing.consumeRecipientInvite(input);
		// Assert: classify the stored winner without granting the loser any authority.
		await expect(pending).rejects.toThrow(/^invite_already_bound$/);
		expect(atGate).toHaveLength(ownedRecipientTables.length);
		expect(await ownedRecipientSnapshot(f)).toEqual(atGate);
		expect(await f.store.getEnrollment(f.input.groupId, input.deviceId)).toBeNull();
		expect(await f.rows(OWNERSHIP_TABLE)).toEqual([]);
	});
	test("D1 concurrent winner remains consumed once; owned loser cannot freshen grants", async ({
		fixture: f,
	}) => {
		// Arrange
		const { input } = await recipientInvite(f, "add_device");
		let winner:
			| Awaited<ReturnType<RevocationFixture["store"]["consumeRecipientInvite"]>>
			| undefined;
		let atGate: unknown[][] = [];
		const racing = recipientGuardedD1(database(f), async (writes, phase) => {
			if (winner || phase !== "batch" || !writes.some((w) => w.query.includes("consumed_at =")))
				return;
			winner = await f.store.consumeRecipientInvite(input);
			await bindRecipient(f, input);
			atGate = await ownedRecipientSnapshot(f);
		});
		// Act
		const pending = racing.consumeRecipientInvite(input);
		// Assert: the committed winner is history, not a rollback claim.
		await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
		expect(winner?.status).toBe("accepted");
		expect(await ownedRecipientSnapshot(f)).toEqual(atGate);
		expect(await f.rows("coordinator_bootstrap_grants")).toHaveLength(1);
	});
}
function registerReceipts(test: Test, database: Database) {
	registerDecision(test, database);
	registerBatchReceipts(test, database);
	registerRollback(test, database);
}
function registerDecision(test: Test, database: Database) {
	test("D1 malformed ownership decision fails closed without consuming", async ({ fixture: f }) => {
		// Arrange: corrupt the receipt, not the underlying authority.
		const { input } = await recipientInvite(f, "team_member");
		const db = database(f);
		const store = new D1CoordinatorStore({
			prepare: (query) => {
				const statement = db.prepare(query);
				if (!query.includes("AS owned")) return statement;
				return {
					...statement,
					bind: (...values) => ({
						...statement.bind(...values),
						first: async <T>() => ({ revoked: 0, owned: "0", eligible: 1 }) as T,
					}),
				};
			},
			batch: (statements) => {
				if (!db.batch) throw new Error("Missing fixture batch");
				return db.batch(statements);
			},
		});
		const before = await ownedRecipientSnapshot(f);
		// Act
		const pending = store.consumeRecipientInvite(input);
		// Assert
		await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_UNAVAILABLE}$`));
		expect(await ownedRecipientSnapshot(f)).toEqual(before);
	});
}
function registerBatchReceipts(test: Test, database: Database) {
	for (const receipt of [
		{},
		{ success: false, meta: { changes: 1 } },
		{ success: true, meta: { changes: Number.NaN } },
	]) {
		test(`D1 lost batch receipt ${JSON.stringify(receipt)} fails closed after real commit`, async ({
			fixture: f,
		}) => {
			// Arrange: only the acknowledgment is corrupted.
			const { input } = await recipientInvite(f, "add_device");
			const db = database(f);
			const store = new D1CoordinatorStore({
				prepare: (q) => db.prepare(q),
				batch: async (statements) => {
					if (!db.batch) throw new Error("Missing fixture batch");
					return (await db.batch(statements)).map(() => receipt);
				},
			});
			// Act
			const pending = store.consumeRecipientInvite(input);
			// Assert: unavailable receipt is not proof of rollback.
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_UNAVAILABLE}$`));
			expect(await f.store.getInviteByTokenForInspection(input.token)).toMatchObject({
				bound_device_id: input.deviceId,
			});
			expect(await f.store.getEnrollment(f.input.groupId, input.deviceId)).not.toBeNull();
			expect(await f.rows(OWNERSHIP_TABLE)).toEqual([]);
		});
	}
}
function registerRollback(test: Test, database: Database) {
	test("D1 real SQL failure after consumption rolls back the entire batch", async ({
		fixture: f,
	}) => {
		// Arrange: append a genuine failing SQL statement after the real writes.
		const { input } = await recipientInvite(f, "add_device");
		const db = database(f);
		const store = new D1CoordinatorStore({
			prepare: (q) => db.prepare(q),
			batch: (statements) => {
				if (!db.batch) throw new Error("Missing fixture batch");
				return db.batch([
					...statements,
					db.prepare("INSERT INTO coordinator_invites (invite_id) VALUES (NULL)"),
				]);
			},
		});
		const before = await ownedRecipientSnapshot(f);
		// Act
		const pending = store.consumeRecipientInvite(input);
		// Assert: actual snapshots verify atomic rollback.
		await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_UNAVAILABLE}$`));
		expect(await ownedRecipientSnapshot(f)).toEqual(before);
	});
}
