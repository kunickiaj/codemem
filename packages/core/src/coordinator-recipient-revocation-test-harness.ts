import { expect } from "vitest";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import type {
	RevocationFixture,
	revocationHarness,
} from "./coordinator-device-revocation-test-harness.js";
import { ACCEPTED_ALIASES, NODE_ONLY_ALIASES } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import type { CoordinatorConsumeRecipientInviteInput } from "./coordinator-store-contract.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";
import { recipientReviewedIntentDigest } from "./recipient-reviewed-intent.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

type RecipientTest = ReturnType<typeof revocationHarness>;
export const recipientTables = [
	"enrolled_devices",
	"coordinator_invites",
	"coordinator_bootstrap_grants",
	"coordinator_device_revocations",
];
export async function recipientSnapshot(f: RevocationFixture) {
	return Promise.all(recipientTables.map((table) => f.rows(table)));
}

export async function recipientInvite(f: RevocationFixture, kind: "team_member" | "add_device") {
	await f.store.createGroup(f.input.groupId);
	const seed = {
		...f.input,
		deviceId: `${f.input.deviceId}-seed`,
		publicKey: UNRELATED_PUBLIC_KEY,
		identityId: "identity-recipient",
	};
	seed.fingerprint = fingerprintPublicKey(seed.publicKey);
	await f.store.enrollDevice(seed.groupId, seed);
	const reviewedIntent =
		kind === "team_member"
			? {
					version: 1,
					journey: "team",
					team: { teamId: "policy-team", displayName: "Team", futureProjectsInherit: true },
					projects: [],
					excludedProjects: [],
				}
			: {
					version: 1,
					journey: "add_device",
					targetIdentity: { identityId: seed.identityId, displayName: "Recipient" },
					projects: [],
					excludedProjects: [],
				};
	const invite = await f.store.createInvite({
		groupId: f.input.groupId,
		policy: "auto_admit",
		expiresAt: "2099-01-01T00:00:00Z",
		inviteKind: kind,
		inviterDeviceId: seed.deviceId,
		...(kind === "team_member"
			? { policyTeamId: "policy-team" }
			: { targetIdentityId: seed.identityId }),
		reviewedIntent,
		reviewedPreviewDigest: await recipientReviewedIntentDigest(reviewedIntent),
	});
	const input: CoordinatorConsumeRecipientInviteInput = {
		token: invite.token,
		inviteKind: kind,
		identityId: kind === "team_member" ? String(invite.assigned_identity_id) : seed.identityId,
		deviceId: f.input.deviceId,
		publicKey: f.input.publicKey,
		fingerprint: fingerprintPublicKey(f.input.publicKey),
		recipientDisplayName: "Recipient",
		deviceDisplayName: "Recipient device",
		now: "2026-10-06T00:00:00.000Z",
	};
	return { input, seed, invite };
}

export async function revokeRecipient(
	f: RevocationFixture,
	input: CoordinatorConsumeRecipientInviteInput,
) {
	const tuple = { ...f.input, ...input };
	const enrollment = await f.store.getEnrollment(tuple.groupId, tuple.deviceId, true);
	if (!enrollment) await f.store.enrollDevice(tuple.groupId, tuple);
	expect(await f.store.createDeviceRevocation(tuple)).toMatchObject({ kind: "revoked" });
	if (!enrollment) await f.store.removeDevice(tuple.groupId, tuple.deviceId);
}

export function registerRecipientRevocationContract(test: RecipientTest) {
	registerSuccess(test);
	registerRecipientDenials(test);
	registerInviterDenials(test);
	registerPending(test);
}

function registerSuccess(test: RecipientTest) {
	for (const kind of ["team_member", "add_device"] as const) {
		test(`${kind} preserves unrevoked opaque legacy-key acceptance and retry`, async ({
			fixture: f,
		}) => {
			// Arrange: D1 must retain existing fixture-key semantics, not require Ed25519 here.
			const { input } = await recipientInvite(f, kind);
			input.publicKey = "opaque-legacy-recipient";
			input.fingerprint = fingerprintPublicKey(input.publicKey);
			// Act
			const accepted = await f.store.consumeRecipientInvite(input);
			const retry = await f.store.consumeRecipientInvite(input);
			// Assert
			expect([accepted.status, retry.status]).toEqual(["accepted", "existing"]);
			expect(await f.store.getEnrollment(f.input.groupId, input.deviceId)).toMatchObject({
				public_key: input.publicKey,
				identity_id: input.identityId,
				enabled: 1,
			});
		});
		test(`${kind} accepts, repairs identity, and retries without revocation`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { input } = await recipientInvite(f, kind);
			// Act
			const accepted = await f.store.consumeRecipientInvite(input);
			await f.exec(
				"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
				input.deviceId,
			);
			const retry = await f.store.consumeRecipientInvite(input);
			// Assert
			expect([accepted.status, retry.status]).toEqual(["accepted", "existing"]);
			expect(await f.store.getEnrollment(f.input.groupId, input.deviceId)).toMatchObject({
				identity_id: input.identityId,
				enabled: 1,
			});
			expect(retry.bootstrap_grant).toEqual(accepted.bootstrap_grant);
			expect(await f.rows("coordinator_device_revocations")).toEqual([]);
		});
	}
	test("add-device recovers one grant after the unrevoked seed is enabled", async ({
		fixture: f,
	}) => {
		// Arrange
		const { input, seed } = await recipientInvite(f, "add_device");
		await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, false);
		const accepted = await f.store.consumeRecipientInvite(input);
		await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, true);
		// Act
		const recovered = await f.store.consumeRecipientInvite(input);
		const retry = await f.store.consumeRecipientInvite(input);
		// Assert
		expect(accepted.bootstrap_grant).toBeNull();
		expect(recovered).toMatchObject({
			status: "existing",
			bootstrap_grant: { seed_device_id: seed.deviceId, worker_device_id: input.deviceId },
		});
		expect(retry.bootstrap_grant).toEqual(recovered.bootstrap_grant);
		expect(await f.rows("coordinator_bootstrap_grants")).toHaveLength(1);
	});
}

function registerRecipientDenials(test: RecipientTest) {
	for (const kind of ["team_member", "add_device"] as const) {
		for (const stage of ["first", "retry", "identity repair", "grant recovery"] as const) {
			test(`${kind} denies revoked recipient during ${stage} without changing retained state`, async ({
				fixture: f,
			}) => {
				// Arrange: create real revocation evidence from the recipient's enrolled tuple.
				const { input, seed } = await recipientInvite(f, kind);
				await prepareRecipientStage(f, input, seed, stage);
				await revokeRecipient(f, input);
				const before = await recipientSnapshot(f);
				// Act
				const pending = f.store.consumeRecipientInvite(input);
				// Assert: existing legitimate grants are history, not collateral damage.
				await expect(pending).rejects.toThrow(/^device_revoked$/);
				expect(await recipientSnapshot(f)).toEqual(before);
			});
		}
		for (const alias of [...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES]) {
			test(`${kind} denies canonical revoked recipient key under ${alias.name} and a new ID`, async ({
				fixture: f,
			}) => {
				// Arrange
				const { input } = await recipientInvite(f, kind);
				await revokeRecipient(f, input);
				const candidate = {
					...input,
					deviceId: `${input.deviceId}-alias`,
					publicKey: alias.publicKey,
					fingerprint: fingerprintPublicKey(alias.publicKey),
				};
				const before = await recipientSnapshot(f);
				// Act
				const pending = f.store.consumeRecipientInvite(candidate);
				// Assert
				await expect(pending).rejects.toThrow(/^device_revoked$/);
				expect(await recipientSnapshot(f)).toEqual(before);
			});
		}
		test(`${kind} denies revoked recipient ID with an unrelated new key`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { input } = await recipientInvite(f, kind);
			await revokeRecipient(f, input);
			const before = await recipientSnapshot(f);
			// Act
			const pending = f.store.consumeRecipientInvite({
				...input,
				publicKey: UNRELATED_PUBLIC_KEY,
				fingerprint: fingerprintPublicKey(UNRELATED_PUBLIC_KEY),
			});
			// Assert
			await expect(pending).rejects.toThrow(/^device_revoked$/);
			expect(await recipientSnapshot(f)).toEqual(before);
		});
	}
}

function registerInviterDenials(test: RecipientTest) {
	for (const kind of ["team_member", "add_device"] as const) {
		for (const stage of ["first", "retry", "recovery"] as const) {
			for (const retained of ["enabled", "disabled", "removed"] as const) {
				test(`${kind} denies revoked ${retained} inviter on ${stage}`, async ({ fixture: f }) => {
					// Arrange
					const { input, seed } = await recipientInvite(f, kind);
					await prepareRecipientStage(f, input, seed, stage);
					expect(await f.store.createDeviceRevocation(seed)).toMatchObject({ kind: "revoked" });
					await retainInviter(f, seed, retained);
					const before = await recipientSnapshot(f);
					// Act
					const pending = f.store.consumeRecipientInvite(input);
					// Assert
					await expect(pending).rejects.toThrow(/^device_revoked$/);
					expect(await recipientSnapshot(f)).toEqual(before);
				});
			}
		}
		for (const alias of [...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES]) {
			test(`${kind} denies inviter current key ${alias.name} revoked through another ID`, async ({
				fixture: f,
			}) => {
				// Arrange: invite-time key is unrelated; only the current inviter key is denied.
				const { input, seed } = await recipientInvite(f, kind);
				await revokeRecipient(f, input);
				await f.exec(
					"UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE device_id = ?",
					alias.publicKey,
					fingerprintPublicKey(alias.publicKey),
					seed.deviceId,
				);
				await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, false);
				const candidate = {
					...input,
					deviceId: `${input.deviceId}-clean`,
					publicKey: "opaque-recipient",
					fingerprint: fingerprintPublicKey("opaque-recipient"),
				};
				const before = await recipientSnapshot(f);
				// Act
				const pending = f.store.consumeRecipientInvite(candidate);
				// Assert
				await expect(pending).rejects.toThrow(/^device_revoked$/);
				expect(await recipientSnapshot(f)).toEqual(before);
			});
		}
	}
}

function registerPending(test: RecipientTest) {
	for (const retained of ["disabled", "removed"] as const) {
		test(`unrevoked ${retained} inviter leaves add-device accepted and pending without a grant`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { input, seed } = await recipientInvite(f, "add_device");
			if (retained === "disabled")
				await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, false);
			else await f.store.removeDevice(seed.groupId, seed.deviceId);
			// Act
			const accepted = await f.store.consumeRecipientInvite(input);
			const retry = await f.store.consumeRecipientInvite(input);
			// Assert
			expect([accepted.status, retry.status]).toEqual(["accepted", "existing"]);
			expect([accepted.bootstrap_grant, retry.bootstrap_grant]).toEqual([null, null]);
			expect(await f.rows("coordinator_bootstrap_grants")).toEqual([]);
		});
	}
	test("historical inviter key does not infer current ownership after the enrollment is removed", async ({
		fixture: f,
	}) => {
		// Arrange
		const { input, seed } = await recipientInvite(f, "add_device");
		const historicalAlias = { ...seed, deviceId: `${seed.deviceId}-historical` };
		await f.store.enrollDevice(seed.groupId, historicalAlias);
		await f.store.removeDevice(seed.groupId, seed.deviceId);
		await f.store.createDeviceRevocation(historicalAlias);
		// Act
		const accepted = await f.store.consumeRecipientInvite(input);
		// Assert
		expect(accepted).toMatchObject({ status: "accepted", bootstrap_grant: null });
		expect(await f.rows("coordinator_bootstrap_grants")).toEqual([]);
	});
}

export type RecipientWrite = { query: string; values: readonly unknown[] };
export type RecipientWriteHook = (
	writes: readonly RecipientWrite[],
	phase: "batch" | "write",
) => Promise<void>;
export function registerRecipientWriteGuards(
	test: RecipientTest,
	guarded: (f: RevocationFixture, hook: RecipientWriteHook) => Store,
) {
	registerFirstWriteGuards(test, guarded);
	registerLaterWriteGuards(test, guarded);
	registerUnrevokedTupleGuards(test, guarded);
	registerInvitationStateGuards(test, guarded);
}

function registerInvitationStateGuards(
	test: RecipientTest,
	guarded: (f: RevocationFixture, hook: RecipientWriteHook) => Store,
) {
	for (const kind of ["team_member", "add_device"] as const) {
		for (const scenario of [
			"revoked invite",
			"missing invite",
			"archived group",
			"missing group",
		] as const) {
			test(`${kind} preserves the ${scenario} error when state changes before the first batch`, async ({
				fixture: f,
			}) => {
				// Arrange: mutate real persisted state only at the prepared batch's execution gate.
				const { input, invite } = await recipientInvite(f, kind);
				let called = false;
				let atGate: unknown[][] = [];
				const racing = guarded(f, async (writes, phase) => {
					if (called || phase !== "batch" || !writes.some((w) => w.query.includes("consumed_at =")))
						return;
					called = true;
					await changeInvitationState(f, invite.invite_id, scenario);
					atGate = await recipientSnapshot(f);
				});
				// Act
				const pending = racing.consumeRecipientInvite(input);
				// Assert: the intentional state change is retained; binding, enrollment, and grants are not written.
				const errors = {
					"revoked invite": "invite_invalid",
					"missing invite": "invite_invalid",
					"archived group": "group_archived",
					"missing group": "group_not_found",
				};
				await expect(pending).rejects.toThrow(new RegExp(`^${errors[scenario]}$`));
				expect(called).toBe(true);
				expect(await recipientSnapshot(f)).toEqual(atGate);
			});
		}
	}
}

async function changeInvitationState(f: RevocationFixture, inviteId: string, scenario: string) {
	if (scenario === "revoked invite") {
		await f.exec(
			"UPDATE coordinator_invites SET revoked_at = ? WHERE invite_id = ?",
			"2026-10-06T00:00:01.000Z",
			inviteId,
		);
		return;
	}
	if (scenario === "missing invite") {
		await f.exec("DELETE FROM coordinator_invites WHERE invite_id = ?", inviteId);
		return;
	}
	if (scenario === "archived group") {
		await f.exec(
			"UPDATE groups SET archived_at = ? WHERE group_id = ?",
			"2026-10-06T00:00:01.000Z",
			f.input.groupId,
		);
		return;
	}
	await f.exec("DELETE FROM groups WHERE group_id = ?", f.input.groupId);
}

function registerUnrevokedTupleGuards(
	test: RecipientTest,
	guarded: (f: RevocationFixture, hook: RecipientWriteHook) => Store,
) {
	for (const absent of [false, true]) {
		test(`pins the unrevoked inviter tuple when ${absent ? "a missing seed appears" : "its key rotates"} before native batch`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { input, seed } = await recipientInvite(f, "add_device");
			if (absent) await f.store.removeDevice(seed.groupId, seed.deviceId);
			let called = false;
			let atGate: unknown[][] = [];
			const racing = guarded(f, async (writes, phase) => {
				if (called || phase !== "batch" || !writes.some((w) => w.query.includes("consumed_at =")))
					return;
				called = true;
				await f.exec(
					"INSERT OR REPLACE INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at) VALUES (?,?,?,?,?,1,?)",
					seed.groupId,
					seed.deviceId,
					"clean-rotated-seed",
					fingerprintPublicKey("clean-rotated-seed"),
					seed.identityId,
					input.now,
				);
				atGate = await recipientSnapshot(f);
			});
			// Act
			const pending = racing.consumeRecipientInvite(input);
			// Assert: a stale enrollment snapshot cannot authorize grant creation even without R.
			await expect(pending).rejects.toThrow(/^invite_acceptance_incomplete$/);
			expect(called).toBe(true);
			expect(await recipientSnapshot(f)).toEqual(atGate);
		});
	}
}

function registerFirstWriteGuards(
	test: RecipientTest,
	guarded: (f: RevocationFixture, hook: RecipientWriteHook) => Store,
) {
	for (const kind of ["team_member", "add_device"] as const) {
		for (const subject of [
			"recipient ID",
			"recipient key",
			"inviter ID",
			"inviter key",
			"rotation",
			"missing seed",
		] as const) {
			test(`${kind} gates actual first batch against ${subject} changing after preflight`, async ({
				fixture: f,
			}) => {
				// Arrange: restore genuine revocation records immediately before the native batch.
				const { input, seed } = await recipientInvite(f, kind);
				await revokeRecipient(f, input);
				const records = (await f.rows("coordinator_device_revocations")) as Record<
					string,
					unknown
				>[];
				await f.exec(
					"DELETE FROM coordinator_device_revocations WHERE evidence_group_id = ?",
					f.input.groupId,
				);
				if (subject === "missing seed") await f.store.removeDevice(seed.groupId, seed.deviceId);
				const candidate = { ...input };
				if (subject === "rotation" || subject === "missing seed") {
					candidate.deviceId = `${input.deviceId}-clean`;
					candidate.publicKey = "opaque-clean-recipient";
					candidate.fingerprint = fingerprintPublicKey(candidate.publicKey);
				}
				let called = false;
				let atGate: unknown[][] = [];
				const racing = guarded(f, async (writes, phase) => {
					if (called || phase !== "batch" || !writes.some((w) => w.query.includes("consumed_at =")))
						return;
					called = true;
					await changeFirstGate(f, input, seed, subject, records);
					atGate = await recipientSnapshot(f);
				});
				// Act
				const pending = racing.consumeRecipientInvite(candidate);
				// Assert: no invite binding, repair, or grant statement may bypass the gate.
				await expect(pending).rejects.toThrow(/^device_revoked$/);
				expect(called).toBe(true);
				if (subject === "rotation" || subject === "missing seed") {
					expect(atGate[3]).toHaveLength(1);
					expect(atGate[3]).toMatchObject([{ subject_kind: "ed25519_key" }]);
				}
				expect(await recipientSnapshot(f)).toEqual(atGate);
			});
		}
	}
}

type Seed = Awaited<ReturnType<typeof recipientInvite>>["seed"];
async function prepareRecipientStage(
	f: RevocationFixture,
	input: CoordinatorConsumeRecipientInviteInput,
	seed: Seed,
	stage: string,
) {
	const recovery = stage === "recovery" || stage === "grant recovery";
	if (recovery) await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, false);
	if (stage !== "first") await f.store.consumeRecipientInvite(input);
	if (stage === "identity repair")
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
			input.deviceId,
		);
	if (recovery) await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, true);
}
async function retainInviter(f: RevocationFixture, seed: Seed, retained: string) {
	if (retained === "disabled") await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, false);
	if (retained === "removed") await f.store.removeDevice(seed.groupId, seed.deviceId);
}
async function changeFirstGate(
	f: RevocationFixture,
	input: CoordinatorConsumeRecipientInviteInput,
	seed: Seed,
	subject: string,
	records: Record<string, unknown>[],
) {
	if (subject.startsWith("inviter")) {
		await f.store.createDeviceRevocation(seed);
		await f.exec(
			"DELETE FROM coordinator_device_revocations WHERE evidence_group_id = ? AND subject_kind = ?",
			seed.groupId,
			subject === "inviter ID" ? "ed25519_key" : "device_id",
		);
		return;
	}
	const keyOnly = ["recipient key", "rotation", "missing seed"].includes(subject);
	for (const row of records) {
		if (subject === "recipient ID" && row.subject_kind !== "device_id") continue;
		if (keyOnly && row.subject_kind !== "ed25519_key") continue;
		const columns = Object.keys(row);
		await f.exec(
			`INSERT INTO coordinator_device_revocations (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
			...Object.values(row),
		);
	}
	if (subject !== "rotation" && subject !== "missing seed") return;
	await f.exec(
		"INSERT OR REPLACE INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at) VALUES (?,?,?,?,?,1,?)",
		seed.groupId,
		seed.deviceId,
		input.publicKey,
		input.fingerprint,
		seed.identityId,
		input.now,
	);
}

// Keep real prepared statements and transactional batch execution; only intercept execution.
export function recipientGuardedD1(db: D1DatabaseLike, hook: RecipientWriteHook) {
	const originals = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
	const writes = new WeakMap<D1PreparedStatementLike, RecipientWrite>();
	const wrap = (
		statement: D1PreparedStatementLike,
		query: string,
		values: readonly unknown[] = [],
	): D1PreparedStatementLike => {
		const adapter: D1PreparedStatementLike = {
			bind: (...bound) => wrap(statement.bind(...bound), query, bound),
			first: <T>() => statement.first<T>(),
			all: <T>() => statement.all<T>(),
			raw: <T>() => statement.raw<T>(),
			run: async () => {
				await hook([{ query, values }], "write");
				return statement.run();
			},
		};
		originals.set(adapter, statement);
		writes.set(adapter, { query, values });
		return adapter;
	};
	return new D1CoordinatorStore({
		prepare: (query) => wrap(db.prepare(query), query),
		batch: async (statements) => {
			await hook(
				statements.map((s) => {
					const write = writes.get(s);
					if (!write) throw new Error("Unknown recipient fixture statement");
					return write;
				}),
				"batch",
			);
			if (!db.batch) throw new Error("Fixture batch unavailable");
			return db.batch(
				statements.map((s) => {
					const original = originals.get(s);
					if (!original) throw new Error("Unknown recipient fixture statement");
					return original;
				}),
			);
		},
	});
}

function registerLaterWriteGuards(
	test: RecipientTest,
	guarded: (f: RevocationFixture, hook: RecipientWriteHook) => Store,
) {
	for (const stage of ["identity repair", "grant recovery", "post-commit repair"] as const) {
		test(`revocation immediately before ${stage} fails closed without rewriting committed history`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { input, seed } = await recipientInvite(f, "add_device");
			await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, false);
			if (stage !== "post-commit repair") await f.store.consumeRecipientInvite(input);
			if (stage === "identity repair")
				await f.exec(
					"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
					input.deviceId,
				);
			if (stage === "grant recovery")
				await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, true);
			let called = false;
			let atGate: unknown[][] = [];
			const racing = guarded(f, async (writes) => {
				const fragment =
					stage === "grant recovery"
						? "SET bootstrap_grant_id"
						: "UPDATE enrolled_devices SET identity_id";
				if (called || !writes.some((w) => w.query.includes(fragment))) return;
				called = true;
				if (stage === "post-commit repair")
					await f.exec(
						"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
						input.deviceId,
					);
				await f.store.createDeviceRevocation({ ...f.input, ...input });
				atGate = await recipientSnapshot(f);
			});
			// Act
			const pending = racing.consumeRecipientInvite(input);
			// Assert
			await expect(pending).rejects.toThrow(/^device_revoked$/);
			expect(called).toBe(true);
			expect(await recipientSnapshot(f)).toEqual(atGate);
		});
	}
}
