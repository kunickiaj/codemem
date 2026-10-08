import { expect } from "vitest";
import { OWNERSHIP_TABLE } from "./coordinator-device-ownership-test-harness.js";
import type {
	RevocationFixture,
	revocationHarness,
} from "./coordinator-device-revocation-test-harness.js";
import {
	ACCEPTED_ALIASES,
	CANONICAL_PUBLIC_KEY,
	NODE_ONLY_ALIASES,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import {
	projectGuardedD1,
	projectInvite,
	revokeProjectReceiver,
} from "./coordinator-project-revocation-test-harness.js";
import { recipientSnapshot } from "./coordinator-recipient-revocation-test-harness.js";
import { D1CoordinatorStore, type D1DatabaseLike } from "./d1-coordinator-store.js";
import { OWNED_DENIAL, OWNED_UNAVAILABLE } from "./shared-owned-device-enrollment-test-harness.js";
import {
	bindInviter,
	bindRecipient,
	ownedRecipientSnapshot,
} from "./shared-owned-recipient-invites-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

type Test = ReturnType<typeof revocationHarness>;
type Input = Awaited<ReturnType<typeof projectInvite>>["input"];
type Stage = "first" | "retry" | "repair" | "recovery";
export function bindProjectRecipient(
	f: RevocationFixture,
	input: Input,
	subject = "key",
	identityId = input.recipientActorId,
) {
	// Raw ledger rows are denial evidence, NEVER verified-owner proof.
	return bindRecipient(f, { ...input, identityId, inviteKind: "add_device" }, subject, identityId);
}
export async function stageProject(f: RevocationFixture, stage: Stage) {
	const setup = await projectInvite(f);
	if (stage === "recovery")
		await f.store.setDeviceEnabled(setup.seed.groupId, setup.seed.deviceId, false);
	if (stage !== "first") await f.store.consumeProjectInvite(setup.input);
	if (stage === "repair")
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
			setup.input.deviceId,
		);
	if (stage === "recovery")
		await f.store.setDeviceEnabled(setup.seed.groupId, setup.seed.deviceId, true);
	return setup;
}
export function registerOwnedProjectContract(test: Test, backend = "D1") {
	registerSuccess(test);
	registerMissingGrantRecovery(test, backend);
	registerDenials(test, backend);
	registerValidation(test);
}
function registerSuccess(test: Test) {
	for (const ownedInviter of [false, true]) {
		for (const stage of ["first", "repair", "recovery"] as const) {
			test(`project ${stage} permits unbound receiver with ${ownedInviter ? "owned" : "unbound"} inviter`, async ({
				fixture: f,
			}) => {
				// Arrange: only current inviter is bound; actor metadata supplies no owner proof.
				const { input, seed } = await stageProject(f, stage);
				if (ownedInviter) await bindInviter(f, seed);
				const ledger = await f.rows(OWNERSHIP_TABLE);
				const inviter = await f.store.getEnrollment(seed.groupId, seed.deviceId, true);
				// Act
				const accepted = await f.store.consumeProjectInvite(input);
				const retry = await f.store.consumeProjectInvite(input);
				// Assert: returned intent/grants remain identical and ownership is never minted.
				expect(accepted.status).toBe(stage === "first" ? "accepted" : "existing");
				expect(retry.status).toBe("existing");
				expect(retry.enrollment).toMatchObject({
					identity_id: input.recipientActorId,
					public_key: input.publicKey,
					enabled: 1,
				});
				expect(accepted.bootstrap_grant).toMatchObject({
					seed_device_id: seed.deviceId,
					worker_device_id: input.deviceId,
				});
				expect(retry.bootstrap_grant).toEqual(accepted.bootstrap_grant);
				expect(JSON.parse(String(accepted.invite.project_intent_json))).toEqual([
					{
						canonical_identity: "https://git.example.invalid/example/project.git",
						display_name: "Project",
						existing_memory_count: 3,
					},
				]);
				expect(retry.invite.project_intent_json).toEqual(accepted.invite.project_intent_json);
				expect(await f.rows("coordinator_bootstrap_grants")).toHaveLength(1);
				expect(await f.store.getEnrollment(seed.groupId, seed.deviceId, true)).toEqual(inviter);
				expect(await f.rows(OWNERSHIP_TABLE)).toEqual(ledger);
			});
		}
	}
}
function registerMissingGrantRecovery(test: Test, backend: string) {
	for (const ownedRecipient of [false, true]) {
		let outcome = "restores pinned grant";
		if (backend === "SQLite") outcome = "preserves legacy missing grant";
		if (ownedRecipient) outcome = "denies owned recipient";
		test(`project retry ${outcome} after grant-row loss`, async ({ fixture: f }) => {
			// Arrange: lose only the grant row in this disposable fixture; retain consumed pointer.
			const { input } = await projectInvite(f);
			const accepted = await f.store.consumeProjectInvite(input);
			const grant = accepted.bootstrap_grant;
			expect(grant).not.toBeNull();
			if (!grant) throw new Error("Missing first-acceptance fixture grant");
			await f.exec("DELETE FROM coordinator_bootstrap_grants WHERE grant_id = ?", grant.grant_id);
			expect(await f.store.getInviteByTokenForInspection(input.token)).toMatchObject({
				bootstrap_grant_id: grant.grant_id,
			});
			if (ownedRecipient) await bindProjectRecipient(f, input);
			const before = await ownedRecipientSnapshot(f);
			// Act
			const pending = f.store.consumeProjectInvite(input);
			// Assert: clean recovery reuses committed authority; ownership blocks restoration entirely.
			if (ownedRecipient) {
				await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
				expect(await ownedRecipientSnapshot(f)).toEqual(before);
				return;
			}
			const retry = await pending;
			expect(retry.status).toBe("existing");
			if (backend === "SQLite") {
				expect(retry.bootstrap_grant).toBeNull();
				expect(await ownedRecipientSnapshot(f)).toEqual(before);
				return;
			}
			expect(retry.bootstrap_grant).toEqual(grant);
			expect(await f.rows("coordinator_bootstrap_grants")).toEqual([grant]);
			expect(await recipientSnapshot(f)).toEqual(
				before.slice(0, 4).map((rows, index) => (index === 2 ? [grant] : rows)),
			);
			expect(await f.rows(OWNERSHIP_TABLE)).toEqual([]);
		});
	}
}
function registerDenials(test: Test, backend: string) {
	registerBindings(test);
	registerStoredKeys(test, backend);
	registerRetainedAliases(test);
	registerRevocations(test);
	registerCapture(test, backend);
}
function registerBindings(test: Test) {
	for (const stage of ["first", "retry", "repair", "recovery"] as const) {
		for (const subject of ["ID", "key"] as const) {
			for (const identity of ["matching", "foreign"] as const) {
				test(`project ${stage} denies retained ${subject} with ${identity} actor hint without effects`, async ({
					fixture: f,
				}) => {
					// Arrange: isolated ID/key evidence, including already-consumed history.
					const { input } = await stageProject(f, stage);
					await bindProjectRecipient(
						f,
						input,
						subject,
						identity === "matching" ? input.recipientActorId : "foreign-identity",
					);
					const before = await ownedRecipientSnapshot(f);
					// Act
					const pending = f.store.consumeProjectInvite(input);
					// Assert: no consumption, overwrite, identity repair or fresh grant.
					await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
					expect(await ownedRecipientSnapshot(f)).toEqual(before);
				});
			}
		}
	}
}
function registerStoredKeys(test: Test, backend: string) {
	for (const stage of ["first", "retry", "repair", "recovery"] as const) {
		for (const owned of [false, true]) {
			test(`project ${stage} preserves current ${owned ? "owned" : "unbound"} stored key against clean request`, async ({
				fixture: f,
			}) => {
				// Arrange: committed/request tuple differs from actual enrollment key.
				const { input } = await projectInvite(f);
				input.publicKey = UNRELATED_PUBLIC_KEY;
				input.fingerprint = fingerprintPublicKey(input.publicKey);
				if (stage === "first")
					await f.store.enrollDevice(f.input.groupId, {
						...f.input,
						...input,
						identityId: input.recipientActorId,
					});
				else await f.store.consumeProjectInvite(input);
				await f.exec(
					"UPDATE enrolled_devices SET public_key = ?, fingerprint = ?, identity_id = ? WHERE device_id = ?",
					CANONICAL_PUBLIC_KEY,
					fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
					stage === "repair" ? null : input.recipientActorId,
					input.deviceId,
				);
				if (owned) await bindProjectRecipient(f, input);
				const before = await ownedRecipientSnapshot(f);
				// Act
				const pending = f.store.consumeProjectInvite(input);
				// Assert: ownership denies the actual stored key; clean mismatch keeps backend legacy error.
				const error = storedKeyError({ backend, owned });
				await expect(pending).rejects.toThrow(new RegExp(`^${error}$`));
				expect(await ownedRecipientSnapshot(f)).toEqual(before);
			});
		}
	}
}
function registerRetainedAliases(test: Test) {
	for (const alias of [...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES]) {
		test(`project canonical ownership survives last-group cleanup under ${alias.name}`, async ({
			fixture: f,
		}) => {
			// Arrange: remove all enrollment evidence before creating a new invitation.
			await f.store.createGroup(f.input.groupId);
			await f.store.enrollDevice(f.input.groupId, f.input);
			await bindProjectRecipient(f, {
				...f.input,
				token: "unused",
				operationId: "unused",
				recipientActorId: "recipient-identity",
				recipientDisplayName: "Recipient",
				deviceDisplayName: "Device",
				now: "2026-10-06T00:00:00Z",
			});
			await f.store.removeDevice(f.input.groupId, f.input.deviceId);
			await f.exec("DELETE FROM groups WHERE group_id = ?", f.input.groupId);
			const { input } = await projectInvite(f);
			input.deviceId += "-alias";
			input.publicKey = alias.publicKey;
			input.fingerprint = fingerprintPublicKey(input.publicKey);
			const before = await ownedRecipientSnapshot(f);
			// Act
			const pending = f.store.consumeProjectInvite(input);
			// Assert: canonical key evidence, not textual fingerprint equality, denies.
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
			expect(await ownedRecipientSnapshot(f)).toEqual(before);
		});
	}
}
function storedKeyError(options: { backend: string; owned: boolean }) {
	if (options.owned) return OWNED_DENIAL;
	return "invite_identity_conflict";
}
function registerRevocations(test: Test) {
	for (const subject of ["recipient", "inviter"] as const) {
		test(`project ${subject} revocation still takes precedence over ownership`, async ({
			fixture: f,
		}) => {
			// Arrange: genuine revocation before simulated ownership.
			const { input, seed } = await projectInvite(f);
			if (subject === "recipient") await revokeProjectReceiver(f, input);
			else await f.store.createDeviceRevocation(seed);
			await bindProjectRecipient(
				f,
				subject === "recipient" ? input : { ...input, deviceId: seed.deviceId },
				"ID",
			);
			const before = await ownedRecipientSnapshot(f);
			// Act
			const pending = f.store.consumeProjectInvite(input);
			// Assert
			await expect(pending).rejects.toThrow(/^device_revoked$/);
			expect(await ownedRecipientSnapshot(f)).toEqual(before);
		});
	}
}
function registerCapture(test: Test, backend: string) {
	for (const mutateCaller of [false, true]) {
		// SQLite executes synchronously: use its real transaction-write gate in the entry file.
		if (!mutateCaller && backend === "SQLite") continue;
		test(`project hashing race retains owned receiver despite caller mutation=${mutateCaller}`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { input } = await projectInvite(f);
			if (mutateCaller) await bindProjectRecipient(f, input);
			const before = await recipientSnapshot(f);
			// Act: insertion executes while acceptance awaits hashing.
			const pending = f.store.consumeProjectInvite(input);
			if (mutateCaller)
				Object.assign(input, {
					deviceId: "clean-device",
					publicKey: UNRELATED_PUBLIC_KEY,
					fingerprint: fingerprintPublicKey(UNRELATED_PUBLIC_KEY),
				});
			else await bindProjectRecipient(f, input);
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
			expect(await recipientSnapshot(f)).toEqual(before);
			expect(await f.rows(OWNERSHIP_TABLE)).toHaveLength(1);
		});
	}
}
function registerValidation(test: Test) {
	for (const failure of ["missing", "expired", "fingerprint", "operation", "schema"] as const) {
		test(`project ${failure} retains exact private error without effects`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { input } = await projectInvite(f);
			await bindProjectRecipient(f, input);
			if (failure === "schema") await f.exec(`DROP TABLE ${OWNERSHIP_TABLE}`);
			Object.assign(
				input,
				{
					missing: { token: "missing" },
					expired: { now: "2100-01-01T00:00:00Z" },
					fingerprint: { fingerprint: "f".repeat(64) },
					operation: { operationId: "wrong" },
					schema: {},
				}[failure],
			);
			const before = await recipientSnapshot(f);
			// Act
			const pending = f.store.consumeProjectInvite(input);
			// Assert
			const error = {
				missing: "invite_invalid",
				expired: "invite_expired",
				fingerprint: "fingerprint_mismatch",
				operation: "invite_invalid",
				schema: OWNED_UNAVAILABLE,
			}[failure];
			await expect(pending).rejects.toThrow(new RegExp(`^${error}$`));
			expect(await recipientSnapshot(f)).toEqual(before);
		});
	}
}
export function registerOwnedProjectD1(
	test: Test,
	database: (f: RevocationFixture) => D1DatabaseLike,
) {
	registerFinalWrites(test, database);
	registerDrift(test, database);
	registerReceipts(test, database);
}
function registerFinalWrites(test: Test, database: (f: RevocationFixture) => D1DatabaseLike) {
	for (const stage of ["first", "repair", "recovery"] as const) {
		for (const subject of ["ID", "key"] as const) {
			test(`D1 project final ${stage} write denies new ${subject} binding`, async ({
				fixture: f,
			}) => {
				// Arrange: keep native statements and real ledger rows at the execution gate.
				const { input } = await stageProject(f, stage);
				let atGate: unknown[][] = [];
				const racing = projectGuardedD1(database(f), async (writes) => {
					if (
						atGate.length ||
						!writes.some((w) =>
							/consumed_at =|UPDATE enrolled_devices SET identity_id|SET bootstrap_grant_id/.test(
								w.query,
							),
						)
					)
						return;
					await bindProjectRecipient(f, input, subject);
					atGate = await ownedRecipientSnapshot(f);
				});
				// Act
				const pending = racing.consumeProjectInvite(input);
				// Assert
				await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
				expect(atGate).toHaveLength(5);
				expect(await ownedRecipientSnapshot(f)).toEqual(atGate);
			});
		}
	}
}
function registerDrift(test: Test, database: (f: RevocationFixture) => D1DatabaseLike) {
	for (const drift of ["seed key", "recipient key", "token", "clean winner"] as const) {
		test(`D1 project pins ${drift} and preserves real winning state`, async ({ fixture: f }) => {
			// Arrange
			const { input, seed } = await projectInvite(f);
			let atGate: unknown[][] = [];
			const racing = projectGuardedD1(database(f), async (writes, phase) => {
				if (
					atGate.length ||
					phase !== "batch" ||
					!writes.some((w) => w.query.includes("consumed_at ="))
				)
					return;
				await changePinnedProject(f, { input, seed, drift });
				atGate = await ownedRecipientSnapshot(f);
			});
			// Act
			const pending = racing.consumeProjectInvite(input);
			// Assert: clean CAS winner is history, not a rollback.
			if (drift === "clean winner") expect((await pending).status).toBe("existing");
			else await expect(pending).rejects.toThrow(/^invite_acceptance_incomplete$/);
			expect(atGate).toHaveLength(5);
			expect(await ownedRecipientSnapshot(f)).toEqual(atGate);
		});
	}
}
async function changePinnedProject(
	f: RevocationFixture,
	options: { input: Input; seed: Awaited<ReturnType<typeof projectInvite>>["seed"]; drift: string },
) {
	const { input, seed, drift } = options;
	if (drift === "clean winner") return f.store.consumeProjectInvite(input);
	if (drift === "token")
		return f.exec(
			"UPDATE coordinator_invites SET token = ?, token_digest = ? WHERE group_id = ?",
			"replacement",
			"e".repeat(64),
			f.input.groupId,
		);
	if (drift === "recipient key")
		return f.store.enrollDevice(f.input.groupId, {
			...f.input,
			identityId: input.recipientActorId,
			publicKey: UNRELATED_PUBLIC_KEY,
			fingerprint: fingerprintPublicKey(UNRELATED_PUBLIC_KEY),
		});
	return f.exec(
		"UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE device_id = ?",
		"rotated-seed",
		fingerprintPublicKey("rotated-seed"),
		seed.deviceId,
	);
}
function registerReceipts(test: Test, database: (f: RevocationFixture) => D1DatabaseLike) {
	for (const receipt of [
		{},
		{ success: false, meta: { changes: 1 } },
		{ success: true, meta: { changes: Number.NaN } },
	]) {
		test(`D1 project lost receipt ${JSON.stringify(receipt)} reports unavailable after real commit`, async ({
			fixture: f,
		}) => {
			// Arrange: corrupt only acknowledgment, never pretend this rolls back.
			const { input } = await projectInvite(f);
			const db = database(f);
			const store = new D1CoordinatorStore({
				prepare: (q) => db.prepare(q),
				batch: async (statements) => {
					if (!db.batch) throw new Error("Missing fixture batch");
					return (await db.batch(statements)).map(() => receipt);
				},
			});
			// Act
			const pending = store.consumeProjectInvite(input);
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_UNAVAILABLE}$`));
			expect(await f.store.getInviteByTokenForInspection(input.token)).toMatchObject({
				bound_device_id: input.deviceId,
			});
			expect(await f.store.getEnrollment(f.input.groupId, input.deviceId)).not.toBeNull();
			expect(await f.rows("coordinator_bootstrap_grants")).toHaveLength(1);
			expect(await f.rows(OWNERSHIP_TABLE)).toEqual([]);
		});
	}
	test("D1 project malformed ownership decision fails privately before writes", async ({
		fixture: f,
	}) => {
		// Arrange: real clean rows, invalid authorization receipt.
		const { input } = await projectInvite(f);
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
		const pending = store.consumeProjectInvite(input);
		// Assert
		await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_UNAVAILABLE}$`));
		expect(await ownedRecipientSnapshot(f)).toEqual(before);
	});
}
