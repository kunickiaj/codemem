import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceKey } from "./coordinator-device-headless-link-test-fixtures.js";
import { reconcileCoordinatorEnrollmentSnapshot } from "./coordinator-enrollment-reconciler.js";
import {
	LEGACY_SETUP,
	type LinkedLegacySetupFixture,
	legacySetupEvidenceSnapshot,
	legacySetupPreservationSnapshot,
	linkedLegacySetupFixture,
} from "./linked-legacy-setup-test-fixtures.js";

function registerOwnClaimEvidenceTest(fixture: () => LinkedLegacySetupFixture): void {
	it("retains valid own account proof independently of NULL enrollment and B ownership", async () => {
		// Arrange
		const f = fixture();
		const { signer, config } = f.account;
		// Act
		const status = await f.coordinator.store.readAccountLinkStatus(signer, config, {
			identityId: LEGACY_SETUP.identityId,
		});
		const enrollments = await f.coordinator.store.listEnrolledDevices(LEGACY_SETUP.groupId);
		// Assert: a linked account does not imply an own-device ownership binding.
		expect(status).toMatchObject({ state: "linked", identityId: LEGACY_SETUP.identityId });
		expect(
			f.coordinator.db
				.prepare(
					"SELECT identity_id, device_id, public_key, fingerprint FROM coordinator_auth_device_claims",
				)
				.get(),
		).toEqual({
			identity_id: LEGACY_SETUP.identityId,
			device_id: f.keyA.deviceId,
			public_key: f.keyA.publicKey,
			fingerprint: f.keyA.fingerprint,
		});
		expect(
			f.coordinator.db
				.prepare(
					"SELECT identity_id, authority_kind, revoked_at_ms FROM coordinator_auth_account_links",
				)
				.get(),
		).toEqual({
			identity_id: LEGACY_SETUP.identityId,
			authority_kind: "device_claim",
			revoked_at_ms: null,
		});
		expect(
			f.coordinator.db
				.prepare("SELECT identity_id, group_id, status FROM coordinator_identity_group_grants")
				.all(),
		).toEqual([
			{ identity_id: LEGACY_SETUP.identityId, group_id: LEGACY_SETUP.groupId, status: "active" },
		]);
		expect(enrollments.find((row) => row.device_id === f.keyA.deviceId)).toMatchObject({
			identity_id: null,
			enabled: 1,
			public_key: f.keyA.publicKey,
			fingerprint: f.keyA.fingerprint,
		});
		expect(
			enrollments.find((row) => row.device_id === f.keyA.deviceId)?.ownership_identity_id,
		).toBeUndefined();
		expect(enrollments.find((row) => row.device_id === f.keyB.deviceId)).toMatchObject({
			identity_id: LEGACY_SETUP.identityId,
			ownership_identity_id: LEGACY_SETUP.identityId,
			public_key: f.keyB.publicKey,
			fingerprint: f.keyB.fingerprint,
		});
	});
}

function registerControllerOnlyEvidenceTest(backend: "SQLite" | "D1"): void {
	it("keeps a linked controller-only account distinct from own-device ownership", async () => {
		// Arrange: this negative fixture has an actual active controller but no own claim.
		const controller = await linkedLegacySetupFixture(backend, {
			accountAuthority: "controller_attestation",
		});
		try {
			// Act
			const status = await controller.coordinator.store.readAccountLinkStatus(
				controller.account.signer,
				controller.account.config,
				{ identityId: LEGACY_SETUP.identityId },
			);
			const result = await controller.reconcile();
			const own = (
				await controller.coordinator.store.listEnrolledDevices(LEGACY_SETUP.groupId)
			).find((row) => row.device_id === controller.keyA.deviceId);
			// Assert: a linked account and controller proof must not manufacture ownership or trust.
			expect(status).toMatchObject({ state: "linked", identityId: LEGACY_SETUP.identityId });
			expect(
				controller.coordinator.db
					.prepare("SELECT count(*) AS n FROM coordinator_auth_device_claims")
					.get(),
			).toEqual({ n: 0 });
			expect(own?.ownership_identity_id).toBeUndefined();
			expect(result.issues).toEqual([
				{ kind: "device", referenceId: "device-b", code: "identity_not_active" },
			]);
			expect(controller.local.prepare("SELECT count(*) AS n FROM sync_peers").get()).toEqual({
				n: 0,
			});
		} finally {
			await controller.close();
		}
	});
}

describe.each(["SQLite", "D1"] as const)("%s linked legacy setup reproduction", (backend) => {
	let f: LinkedLegacySetupFixture;
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(LEGACY_SETUP.now);
		f = await linkedLegacySetupFixture(backend);
	});
	afterEach(async () => {
		await f?.close();
		vi.useRealTimers();
	});
	registerOwnClaimEvidenceTest(() => f);
	registerControllerOnlyEvidenceTest(backend);

	it("rejects B during ordinary reconciliation because own NULL enrollment cannot prove the local Identity", async () => {
		// Arrange: B already has an active local assignment, but no trusted peer row.
		const before = f.before;
		// Act
		const result = await f.reconcile();
		const retry = await f.reconcile();
		// Assert: reproduce the actual failure, rather than checking only the NULL field.
		expect(result).toMatchObject({
			devicesAdded: 0,
			issues: [{ kind: "device", referenceId: "device-b", code: "identity_not_active" }],
		});
		expect(retry).toEqual(result);
		expect(
			f.local.prepare("SELECT * FROM sync_peers WHERE peer_device_id = ?").get(f.keyB.deviceId),
		).toBeUndefined();
		expect(legacySetupPreservationSnapshot(f.local)).toEqual(before);
		expect(legacySetupEvidenceSnapshot(f.coordinator, f.local)).toEqual(f.evidenceBefore);
	});

	it("does not report a linked account after its real account link is revoked", async () => {
		// Arrange: historical account facts remain present, but the link is revoked.
		f.coordinator.db
			.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms = ?")
			.run(Date.parse(LEGACY_SETUP.now));
		// Act
		const status = await f.coordinator.store.readAccountLinkStatus(
			f.account.signer,
			f.account.config,
			{ identityId: LEGACY_SETUP.identityId },
		);
		// Assert
		expect(status.state).not.toBe("linked");
		expect(f.local.prepare("SELECT count(*) AS n FROM sync_peers").get()).toEqual({ n: 0 });
	});

	it("keeps existing direct grants and deliberate Team exclusions distinct from peer trust", async () => {
		// Arrange
		const before = f.before;
		// Act
		await f.reconcile();
		const direct = f.recipients();
		const team = f.recipients(LEGACY_SETUP.excludedProject);
		const reviewed = f.recipients(LEGACY_SETUP.reviewedProject);
		// Assert: authority exists even though transport trust is missing.
		expect(direct.status).toBe("eligible");
		expect(direct.devices.map(({ deviceId }) => deviceId)).toEqual([
			"device-a",
			"device-b",
			"device-excluded",
		]);
		expect(team.status).toBe("eligible");
		expect(team.devices.map(({ deviceId }) => deviceId)).toEqual(["device-a", "device-b"]);
		expect(reviewed.status).toBe("eligible");
		expect(reviewed.devices.map(({ deviceId }) => deviceId)).toEqual(["device-a"]);
		expect(legacySetupPreservationSnapshot(f.local).digest).toBe(before.digest);
	});

	it("accepts the same B assignment when the own enrollment names the current Identity, without adding transport trust", async () => {
		// Arrange: isolate the missing enrollment field as the cause, using the same normal reconciler.
		const enrollments = await f.coordinator.store.listEnrolledDevices(LEGACY_SETUP.groupId);
		const completeSnapshot = enrollments.map((row) =>
			row.device_id === f.keyA.deviceId ? { ...row, identity_id: LEGACY_SETUP.identityId } : row,
		);
		// Act
		const result = await reconcileCoordinatorEnrollmentSnapshot(f.local, {
			coordinatorId: LEGACY_SETUP.coordinatorId,
			groupId: LEGACY_SETUP.groupId,
			localDeviceId: f.keyA.deviceId,
			now: LEGACY_SETUP.now,
			consumedTeamInvites: [],
			enrollments: completeSnapshot,
		});
		// Assert: this control is not a recovery implementation or a successful sync assertion.
		expect(result).toMatchObject({ devicesAdded: 0, unchanged: 2, issues: [] });
		expect(f.local.prepare("SELECT count(*) AS n FROM sync_peers").get()).toEqual({ n: 0 });
		expect(legacySetupPreservationSnapshot(f.local)).toEqual(f.before);
	});

	it("allows signed peer discovery without converting discovered B into a local pin", async () => {
		// Arrange
		const path = `/v1/peers?group_id=${LEGACY_SETUP.groupId}`;
		// Act
		const response = await f.signed(f.keyA, "GET", path);
		// Assert
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			items: [expect.objectContaining({ device_id: "device-b", public_key: f.keyB.publicKey })],
		});
		expect(f.local.prepare("SELECT count(*) AS n FROM sync_peers").get()).toEqual({ n: 0 });
	});

	it("rejects a different key claiming A's device ID at the maintained signed API", async () => {
		// Arrange
		const impostor = deviceKey(f.keyA.deviceId);
		const before = f.before;
		// Act
		const response = await f.signed(impostor, "GET", `/v1/peers?group_id=${LEGACY_SETUP.groupId}`);
		// Assert
		expect(response.status).toBe(401);
		expect(legacySetupPreservationSnapshot(f.local)).toEqual(before);
	});
});
