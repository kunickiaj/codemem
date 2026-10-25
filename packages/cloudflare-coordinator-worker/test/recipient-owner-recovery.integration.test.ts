import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoordinatorConsumeRecipientInviteInput } from "../../core/src/coordinator-store-contract.js";
import {
	db,
	exec,
	insert,
	nativeHarness,
	producer,
	reset,
	retain,
	sourceTable,
	state,
	timestamp,
} from "./owner-producer-consistency-test-fixtures.js";

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(timestamp));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	await reset();
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function missingGrant() {
	const p = await producer("add_device");
	await retain(p.subject);
	const invite = await db
		.prepare("SELECT token FROM coordinator_invites")
		.first<{ token: string }>();
	if (!invite) throw new Error("native invitation missing");
	const input: CoordinatorConsumeRecipientInviteInput = {
		...p.subject,
		token: invite.token,
		inviteKind: "add_device",
		identityId: p.subject.ownerIdentityId,
		recipientDisplayName: "Recipient",
		deviceDisplayName: "Recipient device",
		now: timestamp,
	};
	await p.h.store.setDeviceEnabled("group-a", "invite-seed", false);
	expect(await p.run()).toMatchObject({ status: "accepted", bootstrap_grant: null });
	await p.h.store.setDeviceEnabled("group-a", "invite-seed", true);
	expect(await p.h.store.getEnrollment("group-a", input.deviceId)).toMatchObject({
		identity_id: input.identityId,
		enabled: 1,
	});
	return input;
}

async function conflictingController(input: CoordinatorConsumeRecipientInviteInput) {
	await insert(sourceTable, {
		attestation_id: "native-recovery-conflicting-controller",
		coordinator_id: input.coordinatorId ?? null,
		identity_id: "owner-B",
		group_id: "native-recovery-race-group",
		device_id: input.deviceId,
		public_key: input.publicKey,
		fingerprint: input.fingerprint,
		review_receipt_id: "native-recovery-race-review",
		evidence_digest: "b".repeat(64),
		enrollment_identity_id: null,
		revision: 1,
		created_at: timestamp,
		revoked_at: null,
	});
}

const stages = {
	repair: /UPDATE enrolled_devices SET identity_id\s*=/u,
	grant: /UPDATE coordinator_invites SET bootstrap_grant_id\s*=/u,
};

async function lostTokenRetry() {
	const p = await producer("add_device");
	await retain(p.subject);
	const invite = await db
		.prepare("SELECT token FROM coordinator_invites")
		.first<{ token: string }>();
	if (!invite) throw new Error("native invitation missing");
	const input: CoordinatorConsumeRecipientInviteInput = {
		...p.subject,
		token: invite.token,
		inviteKind: "add_device",
		identityId: p.subject.ownerIdentityId,
		now: timestamp,
	};
	const h = nativeHarness(/UPDATE coordinator_invites SET token\s*=/u);
	const readInvite = h.store.getInviteByTokenForInspection.bind(h.store);
	vi.spyOn(h.store, "getInviteByTokenForInspection").mockImplementationOnce(async (token) => {
		const initial = await readInvite(token);
		expect(initial?.consumed_at).toBeNull();
		// Finish another invocation after the outer initial read, before its owner capture.
		await exec("UPDATE enrolled_devices SET enabled=0 WHERE device_id='invite-seed'");
		expect(await p.run()).toMatchObject({ status: "accepted", bootstrap_grant: null });
		await exec("UPDATE enrolled_devices SET enabled=1 WHERE device_id='invite-seed'");
		return initial;
	});
	return { h, input };
}

it.each(["unchanged owner", "conflicting owner"] as const)(
	"native losing token update preserves authorization with %s",
	async (mode) => {
		// Both requests read an unused token; only the inner request consumes it.
		const { h, input } = await lostTokenRetry();
		h.arm(async () => {
			if (mode === "conflicting owner") await conflictingController(input);
		});
		const outcome = await h.store.consumeRecipientInvite(input).then(
			(value) => ({ kind: "accepted", value }),
			(error: unknown) => ({ kind: "denied", error }),
		);
		expect(h.observed()).toBe(true);
		if (mode === "conflicting owner") {
			expect(outcome).toMatchObject({
				kind: "denied",
				error: { message: "device_ownership_authorization_unavailable" },
			});
			expect.soft(await state()).toEqual(h.afterMutation());
			expect(
				(await db.prepare("SELECT * FROM coordinator_bootstrap_grants").all()).results,
			).toEqual([]);
			return;
		}
		expect(outcome).toMatchObject({
			kind: "accepted",
			value: { status: "existing", bootstrap_grant: { worker_device_id: input.deviceId } },
		});
		expect(
			(await db.prepare("SELECT * FROM coordinator_bootstrap_grants").all()).results,
		).toHaveLength(1);
	},
);

it.each(["repair", "grant"] as const)(
	"native no-op identity retry retains the full pin at the %s SQL stage",
	async (stage) => {
		// Arrange: a supported consumed invite has its identity, but no bootstrap grant yet.
		const input = await missingGrant();
		const h = nativeHarness(stages[stage]);
		h.arm(() => conflictingController(input));
		// Act: inject B after consistency capture, immediately before the real native batch.
		const outcome = await h.store.consumeRecipientInvite(input).then(
			(value) => ({ kind: "accepted", value }),
			(error: unknown) => ({ kind: "denied", error }),
		);
		// Assert: denial preserves external B and every identity, invite and access row.
		expect(h.observed()).toBe(true);
		expect(h.maxBinds()).toBeGreaterThan(0);
		expect(h.maxBinds()).toBeLessThanOrEqual(100);
		expect.soft(outcome).toMatchObject({
			kind: "denied",
			error: { message: "device_ownership_authorization_unavailable" },
		});
		expect.soft(await state()).toEqual(h.afterMutation());
		expect((await db.prepare("SELECT * FROM coordinator_bootstrap_grants").all()).results).toEqual(
			[],
		);
		expect(await h.store.getEnrollment("group-a", input.deviceId)).toMatchObject({
			identity_id: input.identityId,
			enabled: 1,
		});
	},
);

it("native allowed no-op retry recovers exactly one missing bootstrap grant", async () => {
	// Arrange
	const input = await missingGrant();
	const h = nativeHarness(stages.grant);
	h.arm(async () => {});
	// Act
	const recovered = await h.store.consumeRecipientInvite(input);
	const recoveredState = await state();
	const retry = await h.store.consumeRecipientInvite(input);
	// Assert: the no-op repair must not prevent a legitimate recovery or duplicate it.
	expect(h.observed()).toBe(true);
	expect(recovered).toMatchObject({
		status: "existing",
		bootstrap_grant: { worker_device_id: input.deviceId },
	});
	expect(retry.bootstrap_grant).toEqual(recovered.bootstrap_grant);
	expect(
		(await db.prepare("SELECT * FROM coordinator_bootstrap_grants").all()).results,
	).toHaveLength(1);
	expect(await state()).toEqual(recoveredState);
});

it.each([false, true])("native real identity repair with late conflict=%s", async (conflict) => {
	// Arrange: the identity UPDATE now changes one row, unlike the no-op regression.
	const input = await missingGrant();
	await exec("UPDATE enrolled_devices SET identity_id=NULL WHERE device_id=?", input.deviceId);
	const h = nativeHarness(stages.repair);
	h.arm(async () => {
		if (conflict) await conflictingController(input);
	});
	// Act
	const outcome = await h.store.consumeRecipientInvite(input).then(
		(value) => ({ kind: "accepted", value }),
		(error: unknown) => ({ kind: "denied", error }),
	);
	// Assert: only a successful, eligible repair may consume the full evidence pin.
	expect(h.observed()).toBe(true);
	if (conflict) {
		expect(outcome).toMatchObject({
			kind: "denied",
			error: { message: "device_ownership_authorization_unavailable" },
		});
		expect(await state()).toEqual(h.afterMutation());
		expect(await h.store.getEnrollment("group-a", input.deviceId)).toMatchObject({
			identity_id: null,
		});
		return;
	}
	expect(outcome).toMatchObject({
		kind: "accepted",
		value: { status: "existing", bootstrap_grant: { worker_device_id: input.deviceId } },
	});
	expect(await h.store.getEnrollment("group-a", input.deviceId)).toMatchObject({
		identity_id: input.identityId,
		enabled: 1,
	});
	expect(
		(await db.prepare("SELECT * FROM coordinator_bootstrap_grants").all()).results,
	).toHaveLength(1);
});
