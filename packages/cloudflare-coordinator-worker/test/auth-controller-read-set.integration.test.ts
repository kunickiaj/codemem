import { env } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoordinatorAuthControllerReviewInput } from "../../core/src/coordinator-auth-controller.js";
import { CANONICAL_PUBLIC_KEY } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { controllerGuardedStage, hookNativeD1 } from "./controller-guarded-batch-hook.js";

const db = env.COORDINATOR_DB;
const timestamp = "2026-10-01T00:00:00.000Z";
const cleanup: (() => Promise<unknown>)[] = [];

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(Date.parse(timestamp));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(async () => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	for (const step of cleanup.splice(0)) await step();
});

async function attestations(coordinatorId: string) {
	return (
		await db
			.prepare("SELECT * FROM coordinator_auth_controller_attestations WHERE coordinator_id = ?")
			.bind(coordinatorId)
			.all()
	).results;
}

it.each(["create", "retry"] as const)(
	"native %s batch refuses a reviewed invite changed after the review's reads",
	async (stage) => {
		// Arrange: one consumed invite is in the reviewed snapshot.
		let change: (() => Promise<void>) | undefined;
		const store = new D1CoordinatorStore(
			hookNativeD1(db, async (execution) => {
				if (!change || controllerGuardedStage(execution) !== stage) return;
				const run = change;
				change = undefined;
				await run();
			}),
			{ authClock: () => Date.parse(timestamp) },
		);
		const review: CoordinatorAuthControllerReviewInput = {
			coordinatorId: randomUUID(),
			groupId: randomUUID(),
			deviceId: randomUUID(),
			identityId: randomUUID(),
			attestationId: randomUUID(),
			reviewReceiptId: randomUUID(),
			publicKey: CANONICAL_PUBLIC_KEY,
			fingerprint: "a".repeat(64),
			evidenceDigest: "b".repeat(64),
		};
		cleanup.push(() =>
			db.batch([
				db
					.prepare("DELETE FROM coordinator_auth_controller_attestations WHERE coordinator_id = ?")
					.bind(review.coordinatorId),
				db.prepare("DELETE FROM coordinator_invites WHERE group_id = ?").bind(review.groupId),
				db.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(review.groupId),
				db.prepare("DELETE FROM groups WHERE group_id = ?").bind(review.groupId),
			]),
		);
		await store.createGroup(review.groupId);
		await store.enrollDevice(review.groupId, {
			deviceId: review.deviceId,
			publicKey: review.publicKey,
			fingerprint: review.fingerprint,
		});
		const invite = await store.createInvite({
			groupId: review.groupId,
			policy: "auto",
			expiresAt: "2030-01-01T00:00:00Z",
		});
		await db
			.prepare(`UPDATE coordinator_invites SET invite_kind = 'add_device', consumed_at = 'consumed',
				bound_device_id = ?, bound_public_key = ?, bound_fingerprint = ?, recipient_actor_id = ?,
				target_identity_id = ?, reviewed_preview_digest = ? WHERE invite_id = ?`)
			.bind(
				review.deviceId,
				review.publicKey,
				review.fingerprint,
				review.identityId,
				review.identityId,
				"c".repeat(64),
				invite.invite_id,
			)
			.run();
		const row = await db
			.prepare(
				"SELECT invite_kind, recipient_actor_id, assigned_identity_id, target_identity_id FROM coordinator_invites WHERE invite_id = ?",
			)
			.bind(invite.invite_id)
			.first<Record<string, string | null>>();
		review.verifiedSnapshot = {
			enrollmentIdentityId: null,
			invites: [
				{
					inviteId: invite.invite_id,
					kind: "add_device",
					actorId: String(row?.recipient_actor_id),
					assignedIdentityId: row?.assigned_identity_id ?? null,
					targetIdentityId: row?.target_identity_id ?? null,
					digest: "c".repeat(64),
				},
			],
			legacyHistory: await store.captureAuthControllerLegacyHistory(review),
		};
		if (stage === "retry")
			expect((await store.createAuthControllerAttestation(review)).kind).toBe("created");
		const before = await attestations(review.coordinatorId);
		const changed = vi.fn(async () => {
			await db
				.prepare("UPDATE coordinator_invites SET reviewed_preview_digest = ? WHERE invite_id = ?")
				.bind("d".repeat(64), invite.invite_id)
				.run();
		});
		change = changed;
		// Act
		const result = await store.createAuthControllerAttestation(review);
		// Assert: native D1 ran the guards after the change, and nothing was written.
		expect(changed).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ kind: "rejected", error: "review_stale" });
		expect(await attestations(review.coordinatorId)).toEqual(before);
	},
);
