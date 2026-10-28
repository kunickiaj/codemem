import { deepStrictEqual } from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { invitation } from "../../../core/src/coordinator-device-ownership-evidence-test-fixtures.js";
import { readCoordinatorResolvedAccountOwnerReceiptStatus } from "../../../core/src/coordinator-resolved-account-owner-status-client.js";
import { verifySignature } from "../../../core/src/sync-auth.js";
import {
	deferred,
	recoveryFixture,
	recoveryTests,
} from "../../test/owner-recovery-service-fixture.js";
import { createAccountLinkRegistry } from "./link-registry.js";

recoveryTests();
async function setup(createRegistry = createAccountLinkRegistry) {
	const f = await recoveryFixture();
	const pending = deferred<{
		coordinatorId: string;
		identityId: string;
		attemptId: string;
		state: "finalized";
	}>();
	const entered = deferred<void>();
	const link = vi.fn(async () => {
		entered.resolve();
		return pending.promise;
	});
	const readContext = vi.fn(f.readContext);
	const registry = createRegistry({ readContext, link });
	f.cleanup(async () => {
		pending.resolve({
			coordinatorId: "coordinator-a",
			identityId: "identity-b",
			attemptId: "test-attempt",
			state: "finalized",
		});
		await registry.close();
	});
	const ready = f.readContext("group-a");
	if (!("context" in ready) || !ready.context) throw new Error("Missing real context");
	const context = ready.context;
	const start = () =>
		registry.start({
			context,
			expectedCoordinatorId: "coordinator-a",
			expectedAuthority: "device_claim",
		});
	return { ...f, registry, link, readContext, pending, entered, start, context: ready.context };
}

describe("recovery reservation shutdown during retained-job cleanup", () => {
	it("does not claim the runtime owner after the cleanup clock synchronously closes its registry", async () => {
		// Arrange: keep a completed job so the real cleanup path must call the injected clock.
		let armed = false;
		let shutdownCallbacks = 0;
		let closing: Promise<void> | undefined;
		const first = await setup((options) => {
			const registry: ReturnType<typeof createAccountLinkRegistry> = createAccountLinkRegistry({
				...options,
				now: () => {
					if (armed) {
						armed = false;
						shutdownCallbacks++;
						closing = registry.close();
					}
					return Date.now();
				},
			});
			return registry;
		});
		const started = first.start();
		if (!("operation" in started)) throw new Error("Completed-job fixture did not start");
		await first.entered.promise;
		first.pending.resolve({
			coordinatorId: "coordinator-a",
			identityId: "identity-b",
			attemptId: "test-attempt",
			state: "finalized",
		});
		// Drain controlled Core completion, promise adoption, and the original owner's release.
		for (let index = 0; index < 8; index++) await Promise.resolve();
		expect(first.registry.get(started.operation.operationId)?.state).toBe("succeeded");
		expect(first.registry.hasActive()).toBe(false);
		expect(shutdownCallbacks).toBe(0);
		const second = await setup();
		armed = true;
		// Act: close() sets shutdown synchronously inside the retained-job cleanup callback.
		const reservation = first.registry.tryReserveRecovery?.();
		const secondReservation = second.registry.tryReserveRecovery?.();
		try {
			// Assert before releasing either handle: an invalid first owner must not block the second.
			expect(shutdownCallbacks).toBe(1);
			expect(armed).toBe(false);
			expect(closing).toBeInstanceOf(Promise);
			expect(reservation?.isCurrent() ?? false).toBe(false);
			expect.soft(reservation).toBeNull();
			expect.soft(secondReservation).toBeTruthy();
			expect.soft(secondReservation?.isCurrent()).toBe(true);
		} finally {
			// Use only public owner-specific release, including the invalid handle on the RED path.
			reservation?.release();
			secondReservation?.release();
			await closing;
		}
	});
});

describe("real signed fixture controls", () => {
	it("real store previews new and restored reviews with complete canonical history", async () => {
		// Arrange
		const f = await recoveryFixture({ fact: false });
		invitation(f, {
			invite_id: "project-label-reference",
			group_id: "group-a",
			bound_device_id: f.deviceId,
			bound_public_key: f.publicKey,
			bound_fingerprint: f.fingerprint,
			invite_kind: "project_share",
			assigned_identity_id: null,
			target_identity_id: null,
			recipient_actor_id: "project-author-label",
		});
		const input = {
			remoteUrl: String(f.config.sync_coordinator_url),
			adminSecret: "fixture-server-admin",
			purpose: "existing_account_owner" as const,
			resolutionScope: "historical_included_owner_labels_only" as const,
			groupId: "group-a",
			deviceId: f.deviceId,
			fingerprint: f.fingerprint,
			identityId: "identity-a",
		};
		// Act
		const preview = await f.reviewOwner(input);
		const digest = preview.owner_resolution_digest;
		if (typeof digest !== "string") throw new Error("Real preview missing digest");
		const confirmed = await f.reviewOwner({ ...input, confirmOwnerResolutionDigest: digest });
		const restored = await f.reviewOwner(input);
		// Assert
		expect(preview).toMatchObject({
			state: "ready",
			legacy_history: expect.any(Array),
			reviewed_weak_labels: expect.any(Array),
		});
		expect(preview.reviewed_weak_labels).toContainEqual(
			expect.objectContaining({
				label: "project-author-label",
				kind: "consumed_project_actor_label",
			}),
		);
		expect(confirmed).toHaveProperty("owner_resolution.resolution_id");
		expect(restored).toMatchObject({
			state: "restored",
			legacy_history: expect.any(Array),
			reviewed_weak_labels: expect.any(Array),
		});
	});
	it("accepts exact stored references through the real signed receipt route", async () => {
		// Arrange: A birth, current B author, checked resolution, generated requester key.
		const f = await recoveryFixture();
		const before = f.immutableSnapshot();
		// Act
		const result = await readCoordinatorResolvedAccountOwnerReceiptStatus({
			dbPath: f.dbPath,
			keysDir: f.keysDir,
			groupId: "group-a",
			coordinatorUrl: String(f.config.sync_coordinator_url),
			ownerIdentityId: "identity-a",
			receipt: f.receipt(),
			fetch: f.transport,
		});
		// Assert
		expect(result).toMatchObject({
			kind: "owner_status",
			status: {
				state: "owner_confirmed",
				ownerIdentity: "identity-a",
				profileState: "linked",
				deviceId: f.deviceId,
			},
		});
		const request = f.requests[0];
		if (!request) throw new Error("Missing signed request");
		const url = new URL(request.url);
		expect(
			verifySignature({
				method: request.method,
				pathWithQuery: url.pathname + url.search,
				bodyBytes: Buffer.alloc(0),
				deviceId: f.deviceId,
				publicKey: f.publicKey,
				timestamp: request.headers.get("X-Opencode-Timestamp") ?? "",
				nonce: request.headers.get("X-Opencode-Nonce") ?? "",
				signature: request.headers.get("X-Opencode-Signature") ?? "",
			}),
		).toBe(true);
		deepStrictEqual(f.immutableSnapshot(), before);
	});
	it("rejects wrong receipt references despite an otherwise valid persisted owner fact", async () => {
		// Arrange
		const f = await recoveryFixture();
		// Act
		const result = await f.readRemoteReceiptStatus({
			dbPath: f.dbPath,
			keysDir: f.keysDir,
			groupId: "group-a",
			coordinatorUrl: String(f.config.sync_coordinator_url),
			ownerIdentityId: "identity-a",
			receipt: { ...f.receipt(), resolutionId: "wrong-resolution" },
		});
		// Assert
		expect(result).toMatchObject({
			kind: "owner_status",
			status: { state: "owner_unconfirmed", ownerIdentity: null, profile: null },
		});
		expect(f.association()).toBeNull();
	});
	it("existing normal link control starts and runs the real registry's injected held promise", async () => {
		// Arrange
		const f = await setup();
		// Act
		const result = f.start();
		await f.entered.promise;
		// Assert
		expect(result).toHaveProperty("operation");
		expect(f.link).toHaveBeenCalledOnce();
		expect(f.registry.hasActive()).toBe(true);
	});
});

describe("atomic runtime-wide recovery reservation", () => {
	it("reserves synchronously and excludes link start before any Core microtask", async () => {
		// Arrange
		const f = await setup();
		// Act
		const reservation = f.registry.tryReserveRecovery?.();
		try {
			// Assert
			expect(reservation).toBeTruthy();
			expect(reservation?.isCurrent()).toBe(true);
			expect(f.start()).toEqual({ error: "account_link_in_progress" });
			expect(f.link).not.toHaveBeenCalled();
		} finally {
			reservation?.release();
		}
	});
	it("an active existing link blocks recovery reservation without cancelling the link", async () => {
		// Arrange
		const f = await setup();
		f.start();
		await f.entered.promise;
		// Act
		const reserved = f.registry.tryReserveRecovery?.();
		// Assert
		expect(reserved).toBeNull();
		expect(f.registry.hasActive()).toBe(true);
		expect(f.link).toHaveBeenCalledOnce();
	});
	it("reentrant readContext reservation wins before the outer start gate publishes a link", async () => {
		// Arrange
		const f = await setup();
		let reservation: ReturnType<NonNullable<typeof f.registry.tryReserveRecovery>> | undefined;
		f.readContext.mockImplementation((group) => {
			reservation = f.registry.tryReserveRecovery?.();
			return f.serviceOptions.readContext(group);
		});
		// Act
		const result = f.start();
		try {
			// Assert
			expect(reservation).toBeTruthy();
			expect(result).toEqual({ error: "account_link_in_progress" });
			expect(f.link).not.toHaveBeenCalled();
		} finally {
			reservation?.release();
		}
	});
	it("release is idempotent and cannot release a later owner's reservation", async () => {
		// Arrange
		const f = await setup();
		const first = f.registry.tryReserveRecovery?.();
		first?.release();
		const second = f.registry.tryReserveRecovery?.();
		try {
			// Act
			first?.release();
			// Assert
			expect(first?.isCurrent()).toBe(false);
			expect(second?.isCurrent()).toBe(true);
			expect(f.start()).toEqual({ error: "account_link_in_progress" });
		} finally {
			second?.release();
		}
	});
	it("registry close invalidates its current reservation and permanently rejects new ones", async () => {
		// Arrange
		const f = await setup();
		const reservation = f.registry.tryReserveRecovery?.();
		// Act
		await f.registry.close();
		// Assert
		expect(reservation?.isCurrent()).toBe(false);
		expect(f.registry.tryReserveRecovery?.()).toBeNull();
		reservation?.release();
	});
	it("closing an unrelated registry cannot release another registry's recovery owner", async () => {
		// Arrange
		const first = await setup(),
			second = await setup();
		const reservation = first.registry.tryReserveRecovery?.();
		try {
			// Act
			await second.registry.close();
			// Assert
			expect(reservation?.isCurrent()).toBe(true);
			expect(first.start()).toEqual({ error: "account_link_in_progress" });
		} finally {
			reservation?.release();
		}
	});
	it("reservation lifecycle changes reject a stale preflight link even after release", async () => {
		// Arrange
		const f = await setup();
		const token = f.registry.lifecycleToken();
		const reservation = f.registry.tryReserveRecovery?.();
		reservation?.release();
		// Act
		const result = f.registry.start({
			context: f.context,
			expectedCoordinatorId: "coordinator-a",
			expectedAuthority: "device_claim",
			expectedLifecycleToken: token,
		});
		// Assert
		expect(result).toEqual({ error: "account_context_changed" });
		expect(f.link).not.toHaveBeenCalled();
	});
	it("shares one gate across independently loaded registry modules in the same JS runtime", async () => {
		// Arrange: resetModules creates another module instance, not another worker.
		const first = await setup();
		vi.resetModules();
		const other = await import("./link-registry.js");
		const second = await setup(other.createAccountLinkRegistry);
		const reservation = first.registry.tryReserveRecovery?.();
		try {
			// Act
			const result = second.start();
			// Assert
			expect(reservation?.isCurrent()).toBe(true);
			expect(result).toEqual({ error: "account_link_in_progress" });
			expect(second.registry.tryReserveRecovery?.()).toBeNull();
			expect(second.link).not.toHaveBeenCalled();
		} finally {
			reservation?.release();
		}
	});
});
