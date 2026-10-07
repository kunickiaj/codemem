import { expect } from "vitest";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import type {
	RevocationFixture,
	revocationHarness,
} from "./coordinator-device-revocation-test-harness.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import {
	type RecipientWriteHook,
	recipientGuardedD1,
	recipientSnapshot,
} from "./coordinator-recipient-revocation-test-harness.js";
import type { CoordinatorConsumeProjectInviteInput } from "./coordinator-store-contract.js";
import type { D1DatabaseLike } from "./d1-coordinator-store.js";
import { shareProjectSetDigest } from "./project-share-intent.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

type ProjectTest = ReturnType<typeof revocationHarness>;
type Guarded = (
	f: RevocationFixture,
	hook: RecipientWriteHook,
	afterBatch?: () => Promise<void>,
) => Store;
// Reuse the native-statement wrapper; add only a committed-batch execution gate.
export function projectGuardedD1(
	db: D1DatabaseLike,
	hook: RecipientWriteHook,
	afterBatch?: () => Promise<void>,
) {
	return recipientGuardedD1(
		{
			prepare: (query) => db.prepare(query),
			batch: async (statements) => {
				if (!db.batch) throw new Error("Fixture batch unavailable");
				const result = await db.batch(statements);
				await afterBatch?.();
				return result;
			},
		},
		hook,
	);
}
export async function projectInvite(f: RevocationFixture) {
	await f.store.createGroup(f.input.groupId);
	const seed = {
		...f.input,
		deviceId: `${f.input.deviceId}-seed`,
		publicKey: UNRELATED_PUBLIC_KEY,
		identityId: "inviter-identity",
	};
	seed.fingerprint = fingerprintPublicKey(seed.publicKey);
	await f.store.enrollDevice(seed.groupId, seed);
	const project = {
		canonical_identity: "https://git.example.invalid/example/project.git",
		display_name: "Project",
		existing_memory_count: 3,
	};
	const operationId = `share_${"a".repeat(40)}`;
	const invite = await f.store.createInvite({
		groupId: seed.groupId,
		policy: "auto_admit",
		expiresAt: "2099-01-01T00:00:00Z",
		operationId,
		inviterDeviceId: seed.deviceId,
		inviterActorId: seed.identityId,
		projectIntent: [project],
		projectSummaries: [project],
		reviewedProjectSetDigest: shareProjectSetDigest([
			{
				canonicalIdentity: project.canonical_identity,
				displayName: project.display_name,
				existingMemoryCount: 3,
				identitySource: "git_remote",
			},
		]),
	});
	const input: CoordinatorConsumeProjectInviteInput = {
		token: invite.token,
		operationId,
		deviceId: f.input.deviceId,
		publicKey: f.input.publicKey,
		fingerprint: fingerprintPublicKey(f.input.publicKey),
		recipientActorId: "recipient-identity",
		recipientDisplayName: "Recipient",
		deviceDisplayName: "Recipient device",
		now: "2026-10-06T00:00:00.000Z",
	};
	return { input, seed, invite };
}

export async function revokeProjectReceiver(
	f: RevocationFixture,
	input: CoordinatorConsumeProjectInviteInput,
) {
	const tuple = { ...f.input, ...input, identityId: input.recipientActorId };
	const existing = await f.store.getEnrollment(tuple.groupId, tuple.deviceId, true);
	if (!existing) await f.store.enrollDevice(tuple.groupId, tuple);
	expect(await f.store.createDeviceRevocation(tuple)).toMatchObject({ kind: "revoked" });
	if (!existing) await f.store.removeDevice(tuple.groupId, tuple.deviceId);
}

type Stage = "first" | "retry" | "repair" | "recovery";
async function prepareStage(
	f: RevocationFixture,
	setup: Awaited<ReturnType<typeof projectInvite>>,
	stage: Stage,
) {
	const { input, seed } = setup;
	if (stage === "recovery") await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, false);
	if (stage !== "first") await f.store.consumeProjectInvite(input);
	if (stage === "repair")
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
			input.deviceId,
		);
	if (stage === "recovery") await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, true);
}

export function registerProjectRevocationContract(test: ProjectTest) {
	registerSuccess(test);
	registerPending(test);
	registerReceiverDenials(test);
	registerInviterDenials(test);
}

function registerSuccess(test: ProjectTest) {
	for (const key of ["canonical", "opaque"] as const) {
		test(`accepts ${key} receiver, repairs identity, and preserves its sole grant on retry`, async ({
			fixture: f,
		}) => {
			// Arrange: actorId is audit metadata, not the enrollment identity.
			const { input, seed } = await projectInvite(f);
			if (key === "opaque") {
				input.publicKey = "opaque-project-fixture";
				input.fingerprint = fingerprintPublicKey(input.publicKey);
			}
			// Act
			const accepted = await f.store.consumeProjectInvite(input);
			await f.exec(
				"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
				input.deviceId,
			);
			const retry = await f.store.consumeProjectInvite(input);
			// Assert
			expect([accepted.status, retry.status]).toEqual(["accepted", "existing"]);
			expect(retry.enrollment).toMatchObject({
				device_id: input.deviceId,
				identity_id: input.recipientActorId,
				public_key: input.publicKey,
				enabled: 1,
			});
			expect(accepted.bootstrap_grant).toMatchObject({
				seed_device_id: seed.deviceId,
				worker_device_id: input.deviceId,
			});
			expect(retry.bootstrap_grant).toEqual(accepted.bootstrap_grant);
			expect(await f.rows("coordinator_bootstrap_grants")).toHaveLength(1);
		});
	}
}

function registerPending(test: ProjectTest) {
	for (const state of ["disabled", "removed"] as const) {
		test(`unrevoked ${state} seed preserves accepted pending setup without a grant`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { input, seed } = await projectInvite(f);
			if (state === "disabled") await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, false);
			else await f.store.removeDevice(seed.groupId, seed.deviceId);
			// Act
			const accepted = await f.store.consumeProjectInvite(input);
			const retry = await f.store.consumeProjectInvite(input);
			// Assert
			expect([accepted.status, retry.status]).toEqual(["accepted", "existing"]);
			expect([accepted.bootstrap_grant, retry.bootstrap_grant]).toEqual([null, null]);
			expect(await f.rows("coordinator_bootstrap_grants")).toEqual([]);
		});
	}
	test("recovers exactly one grant once an unrevoked seed is enabled", async ({ fixture: f }) => {
		// Arrange
		const setup = await projectInvite(f);
		await prepareStage(f, setup, "recovery");
		// Act
		const recovered = await f.store.consumeProjectInvite(setup.input);
		const retry = await f.store.consumeProjectInvite(setup.input);
		// Assert
		expect(recovered).toMatchObject({
			status: "existing",
			bootstrap_grant: { worker_device_id: setup.input.deviceId },
		});
		expect(retry.bootstrap_grant).toEqual(recovered.bootstrap_grant);
		expect(await f.rows("coordinator_bootstrap_grants")).toHaveLength(1);
	});
	test("removed seed's historical key alone does not infer current ownership", async ({
		fixture: f,
	}) => {
		// Arrange
		const { input, seed } = await projectInvite(f);
		const historical = { ...seed, deviceId: `${seed.deviceId}-historical` };
		await f.store.enrollDevice(seed.groupId, historical);
		await f.store.removeDevice(seed.groupId, seed.deviceId);
		expect(await f.store.createDeviceRevocation(historical)).toMatchObject({ kind: "revoked" });
		// Act
		const accepted = await f.store.consumeProjectInvite(input);
		// Assert
		expect(accepted).toMatchObject({ status: "accepted", bootstrap_grant: null });
		expect(await f.rows("coordinator_bootstrap_grants")).toEqual([]);
	});
}

function registerReceiverDenials(test: ProjectTest) {
	for (const stage of ["first", "retry", "repair", "recovery"] as const) {
		for (const subject of [
			"ID with new key",
			"key with new ID",
			"key comment with new ID",
		] as const) {
			test(`revoked receiver ${subject} blocks ${stage} and preserves all retained state`, async ({
				fixture: f,
			}) => {
				// Arrange: bound retries must retain their exact binding; revoke a separate same-key alias.
				const setup = await projectInvite(f);
				const { input } = setup;
				if (subject === "ID with new key") {
					input.publicKey = UNRELATED_PUBLIC_KEY;
					input.fingerprint = fingerprintPublicKey(input.publicKey);
				} else {
					input.deviceId += "-clean";
					if (subject.startsWith("key comment")) input.publicKey += " project-comment";
					input.fingerprint = fingerprintPublicKey(input.publicKey);
				}
				await prepareStage(f, setup, stage);
				const evidence = {
					...input,
					deviceId: f.input.deviceId,
					publicKey: f.input.publicKey,
					fingerprint: fingerprintPublicKey(f.input.publicKey),
				};
				if (subject === "ID with new key" && stage !== "first") {
					await revokeProjectReceiver(f, input);
					await f.exec(
						"DELETE FROM coordinator_device_revocations WHERE evidence_group_id = ? AND subject_kind = 'ed25519_key'",
						f.input.groupId,
					);
				} else await revokeProjectReceiver(f, evidence);
				const before = await recipientSnapshot(f);
				// Act
				const pending = f.store.consumeProjectInvite(input);
				// Assert: retained grants are history, not collateral damage.
				await expect(pending).rejects.toThrow(/^device_revoked$/);
				expect(await recipientSnapshot(f)).toEqual(before);
			});
		}
	}
}

function registerInviterDenials(test: ProjectTest) {
	for (const stage of ["first", "retry", "repair", "recovery"] as const) {
		for (const state of ["enabled", "disabled", "removed"] as const) {
			test(`revoked ${state} inviter ID blocks ${stage} without side effects`, async ({
				fixture: f,
			}) => {
				// Arrange
				const setup = await projectInvite(f);
				await prepareStage(f, setup, stage);
				expect(await f.store.createDeviceRevocation(setup.seed)).toMatchObject({ kind: "revoked" });
				if (state === "disabled")
					await f.store.setDeviceEnabled(setup.seed.groupId, setup.seed.deviceId, false);
				if (state === "removed")
					await f.store.removeDevice(setup.seed.groupId, setup.seed.deviceId);
				const before = await recipientSnapshot(f);
				// Act
				const pending = f.store.consumeProjectInvite(setup.input);
				// Assert
				await expect(pending).rejects.toThrow(/^device_revoked$/);
				expect(await recipientSnapshot(f)).toEqual(before);
			});
		}
		test(`current disabled inviter key revoked through a different ID blocks ${stage}`, async ({
			fixture: f,
		}) => {
			// Arrange: both receiver subjects stay clean so only current inviter key can deny.
			const setup = await projectInvite(f);
			setup.input.deviceId += "-clean";
			setup.input.publicKey = "opaque-clean-receiver";
			setup.input.fingerprint = fingerprintPublicKey(setup.input.publicKey);
			await prepareStage(f, setup, stage);
			await revokeProjectReceiver(f, {
				...setup.input,
				deviceId: f.input.deviceId,
				publicKey: f.input.publicKey,
				fingerprint: fingerprintPublicKey(f.input.publicKey),
			});
			await f.exec(
				"UPDATE enrolled_devices SET public_key = ?, fingerprint = ?, enabled = 0 WHERE device_id = ?",
				`${f.input.publicKey} current-seed-comment`,
				fingerprintPublicKey(`${f.input.publicKey} current-seed-comment`),
				setup.seed.deviceId,
			);
			const before = await recipientSnapshot(f);
			// Act
			const pending = f.store.consumeProjectInvite(setup.input);
			// Assert
			await expect(pending).rejects.toThrow(/^device_revoked$/);
			expect(await recipientSnapshot(f)).toEqual(before);
		});
	}
}

export function registerProjectWriteGuards(test: ProjectTest, guarded: Guarded) {
	registerFirstGate(test, guarded);
	registerPinnedInviterGate(test, guarded);
	registerStateRaces(test, guarded);
	registerLaterGate(test, guarded);
}

async function revokePinnedInviterKey(
	f: RevocationFixture,
	seed: Awaited<ReturnType<typeof projectInvite>>["seed"],
) {
	const alias = { ...seed, deviceId: `${seed.deviceId}-key-alias` };
	await f.store.enrollDevice(alias.groupId, alias);
	expect(await f.store.createDeviceRevocation(alias)).toMatchObject({ kind: "revoked" });
	await f.store.removeDevice(alias.groupId, alias.deviceId);
	await f.exec(
		"DELETE FROM coordinator_device_revocations WHERE evidence_group_id = ? AND subject_kind = 'device_id'",
		seed.groupId,
	);
}

function registerPinnedInviterGate(test: ProjectTest, guarded: Guarded) {
	for (const stage of ["first", "retry"] as const) {
		for (const state of ["removed", "rotated"] as const) {
			test(`pinned inviter key revocation blocks ${stage} batch with ${state} current seed`, async ({
				fixture: f,
			}) => {
				// Arrange: revoke only the original seed key, never either receiver subject or seed ID.
				const setup = await projectInvite(f);
				const { input, seed } = setup;
				await prepareStage(f, setup, stage);
				let called = false;
				let atGate: unknown[][] = [];
				const racing = guarded(f, async (writes, phase) => {
					if (called || phase !== "batch" || !writes.some((w) => w.query.includes("consumed_at =")))
						return;
					called = true;
					await revokePinnedInviterKey(f, seed);
					if (state === "removed") await f.store.removeDevice(seed.groupId, seed.deviceId);
					else {
						const key = "opaque-clean-rotated-seed";
						await f.exec(
							"UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE device_id = ?",
							key,
							fingerprintPublicKey(key),
							seed.deviceId,
						);
					}
					expect(await f.store.listDeviceRevocations(input)).toEqual([]);
					expect(await f.store.listDeviceRevocations({ deviceId: seed.deviceId })).toEqual([]);
					atGate = await recipientSnapshot(f);
					expect(atGate[3]).toMatchObject([
						{ subject_kind: "ed25519_key", evidence_device_id: `${seed.deviceId}-key-alias` },
					]);
					expect(atGate[3]).toHaveLength(1);
				});
				// Act
				const error = await racing.consumeProjectInvite(input).then(
					() => null,
					(error: unknown) => error,
				);
				// Assert: the pinned key must retain its denial classification after seed churn.
				expect(called).toBe(true);
				expect(await recipientSnapshot(f)).toEqual(atGate);
				expect(error).toBeInstanceOf(Error);
				expect(error).toHaveProperty("message", "device_revoked");
			});
		}
	}
}

function registerFirstGate(test: ProjectTest, guarded: Guarded) {
	for (const subject of [
		"receiver ID",
		"receiver key",
		"inviter ID",
		"inviter key",
		"seed rotation",
		"missing seed appears",
		"clean rotation",
		"clean seed appears",
	] as const) {
		test(`actual first batch rejects ${subject} after preflight with zero downstream writes`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { input, seed } = await projectInvite(f);
			await revokeProjectReceiver(f, input);
			const records = (await f.rows("coordinator_device_revocations")) as Record<string, unknown>[];
			await f.exec(
				"DELETE FROM coordinator_device_revocations WHERE evidence_group_id = ?",
				f.input.groupId,
			);
			const seedChange = subject.includes("rotation") || subject.includes("appears");
			if (seedChange) {
				input.deviceId += "-clean";
				input.publicKey = "opaque-clean-receiver";
				input.fingerprint = fingerprintPublicKey(input.publicKey);
			}
			if (subject.includes("appears")) await f.store.removeDevice(seed.groupId, seed.deviceId);
			let called = false;
			let atGate: unknown[][] = [];
			const racing = guarded(f, async (writes, phase) => {
				if (called || phase !== "batch" || !writes.some((w) => w.query.includes("consumed_at =")))
					return;
				called = true;
				await changeFirstGate(f, { input, seed }, subject, records);
				atGate = await recipientSnapshot(f);
			});
			// Act
			const pending = racing.consumeProjectInvite(input);
			// Assert: rotated revoked seeds carry key-only R and a clean receiver (no false-positive ID denial).
			await expect(pending).rejects.toThrow(
				subject.startsWith("clean") ? /^invite_acceptance_incomplete$/ : /^device_revoked$/,
			);
			expect(called).toBe(true);
			if (seedChange && !subject.startsWith("clean"))
				expect(atGate[3]).toMatchObject([{ subject_kind: "ed25519_key" }]);
			expect(await recipientSnapshot(f)).toEqual(atGate);
		});
	}
}

async function changeFirstGate(
	f: RevocationFixture,
	{ input, seed }: Pick<Awaited<ReturnType<typeof projectInvite>>, "input" | "seed">,
	subject: string,
	records: Record<string, unknown>[],
) {
	if (subject.startsWith("inviter")) {
		expect(await f.store.createDeviceRevocation(seed)).toMatchObject({ kind: "revoked" });
		await f.exec(
			"DELETE FROM coordinator_device_revocations WHERE evidence_group_id = ? AND subject_kind = ?",
			seed.groupId,
			subject === "inviter ID" ? "ed25519_key" : "device_id",
		);
	} else if (!subject.startsWith("clean")) {
		for (const row of records) {
			const kind = subject === "receiver ID" ? "device_id" : "ed25519_key";
			if (row.subject_kind !== kind) continue;
			const columns = Object.keys(row);
			await f.exec(
				`INSERT INTO coordinator_device_revocations (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
				...Object.values(row),
			);
		}
	}
	if (!subject.includes("rotation") && !subject.includes("appears")) return;
	const key = subject.startsWith("clean") ? "opaque-clean-rotated-seed" : f.input.publicKey;
	await f.exec(
		"INSERT OR REPLACE INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at) VALUES (?,?,?,?,?,1,?)",
		seed.groupId,
		seed.deviceId,
		key,
		fingerprintPublicKey(key),
		seed.identityId,
		input.now,
	);
}

function registerStateRaces(test: ProjectTest, guarded: Guarded) {
	const cases = [
		[
			"revoked invite",
			"UPDATE coordinator_invites SET revoked_at = '2026-10-06T00:00:01Z' WHERE invite_id = ?",
			"invite_invalid",
		],
		["missing invite", "DELETE FROM coordinator_invites WHERE invite_id = ?", "invite_invalid"],
		[
			"archived group",
			"UPDATE groups SET archived_at = '2026-10-06T00:00:01Z' WHERE group_id = ?",
			"group_archived",
		],
		["missing group", "DELETE FROM groups WHERE group_id = ?", "group_not_found"],
	] as const;
	for (const [name, sql, error] of cases) {
		test(`preserves ${name} classification when the first binding changes zero rows`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { input, invite } = await projectInvite(f);
			let called = false;
			let atGate: unknown[][] = [];
			const racing = guarded(f, async (writes, phase) => {
				if (called || phase !== "batch" || !writes.some((w) => w.query.includes("consumed_at =")))
					return;
				called = true;
				await f.exec(sql, name.includes("invite") ? invite.invite_id : f.input.groupId);
				atGate = await recipientSnapshot(f);
			});
			// Act
			const pending = racing.consumeProjectInvite(input);
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${error}$`));
			expect(called).toBe(true);
			expect(await recipientSnapshot(f)).toEqual(atGate);
		});
	}
}

function registerLaterGate(test: ProjectTest, guarded: Guarded) {
	for (const stage of ["repair", "recovery", "post-batch success"] as const) {
		test(`revocation at ${stage} blocks further writes and success without rolling back prior history`, async ({
			fixture: f,
		}) => {
			// Arrange
			const setup = await projectInvite(f);
			if (stage !== "post-batch success") await prepareStage(f, setup, stage);
			else await f.store.setDeviceEnabled(setup.seed.groupId, setup.seed.deviceId, false);
			let called = false;
			let atGate: unknown[][] = [];
			const inject = async () => {
				if (called) return;
				called = true;
				await revokeProjectReceiver(f, setup.input);
				atGate = await recipientSnapshot(f);
			};
			const racing = guarded(
				f,
				async (writes) => {
					if (stage === "post-batch success") return;
					const fragment =
						stage === "recovery"
							? "SET bootstrap_grant_id"
							: "UPDATE enrolled_devices SET identity_id";
					if (called || !writes.some((w) => w.query.includes(fragment))) return;
					await inject();
				},
				stage === "post-batch success" ? inject : undefined,
			);
			// Act
			const error = await racing.consumeProjectInvite(setup.input).then(
				() => null,
				(error: unknown) => error,
			);
			// Assert
			expect(called).toBe(true);
			expect(await recipientSnapshot(f)).toEqual(atGate);
			expect(error).toBeInstanceOf(Error);
			expect(error).toHaveProperty("message", "device_revoked");
		});
	}
}
