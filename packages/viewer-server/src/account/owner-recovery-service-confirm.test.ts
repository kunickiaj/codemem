import { deepStrictEqual } from "node:assert/strict";
import { copyFileSync, readFileSync, renameSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CoordinatorResolvedAccountOwnerStatusRead } from "../../../core/src/coordinator-resolved-account-owner-status-client.js";
import {
	deferred,
	expectNoConfirmation,
	recoveryAssociationFiles,
	recoveryFixture,
	recoveryTests,
	selectionFor,
} from "../../test/owner-recovery-service-fixture.js";
import { createAccountLinkRegistry } from "./link-registry.js";
import { createAccountOwnerRecoveryService } from "./owner-recovery-service.js";

recoveryTests();

describe("invalidation inside the maintained action's fresh preview await", () => {
	it.each(["actor", "shutdown"])(
		"dispatches no coordinator confirmation after %s invalidates the pending action",
		async (change) => {
			// Arrange: every review POST goes through the maintained action and the real Hono coordinator.
			const f = await recoveryFixture({ fact: false, maintainedReview: true });
			const previewReached = deferred<void>(),
				resumePreview = deferred<void>();
			let suspend = false,
				freshPreviews = 0,
				confirmationDispatches = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>(async (input, init) => {
					const request = new Request(input, init);
					const isReview = new URL(request.url).pathname === "/v1/admin/auth-controller-reviews";
					const body = isReview ? ((await request.clone().json()) as Record<string, unknown>) : {};
					const confirms = Object.hasOwn(body, "confirm_owner_resolution_digest");
					if (confirms) confirmationDispatches++;
					const response = await f.transport(request);
					if (suspend && isReview && !confirms) {
						freshPreviews++;
						suspend = false;
						previewReached.resolve();
						await resumePreview.promise;
					}
					return response;
				}),
			);
			const service = createAccountOwnerRecoveryService(f.serviceOptions);
			f.cleanup(() => service.close());
			const selection = await selectionFor(service);
			const preview = await service.preview({
				...selection,
				requestId: "dispatch-boundary",
				purpose: "review",
			});
			expect(preview.groupPreviews).toMatchObject([{ groupId: "group-a", action: "new" }]);
			const counts = () => ({
				controllers: f.db
					.prepare("SELECT count(*) AS n FROM coordinator_auth_controller_attestations")
					.get(),
				resolutions: f.db
					.prepare("SELECT count(*) AS n FROM coordinator_legacy_owner_resolutions")
					.get(),
			});
			const beforeCounts = counts();
			const oldProof = f.db.prepare("SELECT * FROM coordinator_auth_controller_attestations").all();
			const history = f.db.prepare("SELECT * FROM coordinator_legacy_team_completions").all();
			suspend = true;
			// Act: invalidate only after the helper has issued and completed its genuine read-only POST.
			const pending = service.confirm({ preview, approvalDigest: preview.approvalDigest }).then(
				(result) => ({ result }),
				(error: unknown) => ({ error }),
			);
			await previewReached.promise;
			const second = createAccountLinkRegistry({ readContext: f.readContext });
			f.cleanup(() => second.close());
			let secondReservation: ReturnType<NonNullable<typeof second.tryReserveRecovery>> = null;
			try {
				if (change === "actor") {
					f.profile.identityId = "identity-next";
					f.config.actor_id = "identity-next";
				} else {
					await service.close();
					secondReservation = second.tryReserveRecovery?.() ?? null;
					expect(secondReservation?.isCurrent()).toBe(true);
				}
				const expectedLocal = f.immutableSnapshot();
				resumePreview.resolve();
				const outcome = await pending;
				// Assert: detecting staleness after dispatch is too late; the POST itself must never happen.
				expect(freshPreviews).toBe(1);
				if ("result" in outcome) expect(outcome.result.groups[0]?.status).toBe("unknown");
				else expect(outcome.error).toBeInstanceOf(Error);
				deepStrictEqual(f.immutableSnapshot(), expectedLocal);
				expect(
					f.db.prepare("SELECT * FROM coordinator_auth_controller_attestations").all(),
				).toEqual(oldProof);
				expect(f.db.prepare("SELECT * FROM coordinator_legacy_team_completions").all()).toEqual(
					history,
				);
				expect(recoveryAssociationFiles()).toEqual([]);
				expect.soft(confirmationDispatches).toBe(0);
				expect.soft(counts()).toEqual(beforeCounts);
			} finally {
				resumePreview.resolve();
				await pending;
				secondReservation?.release();
			}
		},
	);
});

async function setup(options: Parameters<typeof recoveryFixture>[0] = {}) {
	const f = await recoveryFixture(options);
	const service = createAccountOwnerRecoveryService(f.serviceOptions);
	f.cleanup(() => service.close());
	const selection = await selectionFor(service);
	const preview = await service.preview({ ...selection, purpose: "review", requestId: "consent" });
	return {
		...f,
		service,
		selection,
		preview,
		confirm: () => service.confirm({ preview, approvalDigest: preview.approvalDigest }),
	};
}
describe("private consent and owner association publication", () => {
	it("restores an existing remote fact only after fresh signed receipt proof and preserves authored state", async () => {
		// Arrange
		const f = await setup();
		// Changes outside the semantic pins must not invalidate already captured consent.
		f.profile.identityLabel = "New display label";
		f.config.model = "different-model";
		f.setAdmin("rotated-server-secret");
		const before = f.immutableSnapshot();
		// Act
		const result = await f.confirm();
		// Assert
		expect(result.groups).toMatchObject([{ groupId: "group-a", status: "confirmed" }]);
		expectNoConfirmation(f);
		expect(f.readRemoteReceiptStatus).toHaveBeenCalledWith(
			expect.objectContaining({ receipt: f.receipt(), ownerIdentityId: "identity-a" }),
		);
		expect(f.association()).toMatchObject({
			ownerIdentityId: "identity-a",
			actorId: "identity-b",
			attestationId: f.receipt().attestationId,
			reviewDigest: f.receipt().reviewEvidenceDigest,
		});
		deepStrictEqual(f.immutableSnapshot(), before);
	});
	it("confirms a new group with the distinct owner-resolution digest, then verifies and retains its original source", async () => {
		// Arrange
		const f = await setup({ fact: false });
		const before = f.immutableSnapshot();
		// Act
		const result = await f.confirm();
		// Assert
		expect(result.groups[0]?.status).toBe("confirmed");
		const calls = f.reviewOwner.mock.calls.filter(
			([input]) => input.confirmOwnerResolutionDigest !== undefined,
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toMatchObject({
			purpose: "existing_account_owner",
			resolutionScope: "historical_included_owner_labels_only",
			confirmOwnerResolutionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(calls[0]?.[0]).not.toHaveProperty("confirmEvidenceDigest");
		expect(f.readRemoteReceiptStatus).toHaveBeenCalled();
		expect(f.association()?.ownerIdentityId).toBe("identity-a");
		deepStrictEqual(f.immutableSnapshot(), before);
	});
	it("memoizes simultaneous and repeated confirms without duplicate remote mutation or publication", async () => {
		// Arrange
		const f = await setup({ fact: false });
		const waiting = deferred<void>();
		const original = f.readRemoteReceiptStatus.getMockImplementation();
		if (!original) throw new Error("Missing receipt client");
		f.readRemoteReceiptStatus.mockImplementation(async (input) => {
			await waiting.promise;
			return original(input);
		});
		// Act
		const first = f.confirm(),
			second = f.confirm();
		waiting.resolve();
		const results = await Promise.all([first, second]);
		const files = recoveryAssociationFiles().map((path) => [path, readFileSync(path)]);
		const repeated = await f.confirm();
		// Assert
		expect(results[0]).toEqual(results[1]);
		expect(repeated).toEqual(results[0]);
		expect(files).toHaveLength(1);
		expect(
			f.reviewOwner.mock.calls.filter(
				([input]) => input.confirmOwnerResolutionDigest !== undefined,
			),
		).toHaveLength(1);
		expect(f.readRemoteReceiptStatus).toHaveBeenCalledOnce();
		deepStrictEqual(
			recoveryAssociationFiles().map((path) => [path, readFileSync(path)]),
			files,
		);
	});
});

describe("final proof failure after real coordinator confirmation", () => {
	it.each(["unconfirmed", "unavailable"])(
		"preserves unknown after a new remote receipt persists but final proof is %s",
		async (mode) => {
			// Arrange: the injected review action still calls the real checked coordinator writer.
			const f = await setup({ fact: false });
			expect(f.preview.groupPreviews).toMatchObject([{ groupId: "group-a", action: "new" }]);
			const countReceipts = () =>
				f.db
					.prepare("SELECT count(*) AS count FROM coordinator_legacy_owner_resolutions")
					.get() as { count: number };
			const beforeCount = countReceipts().count;
			const before = f.immutableSnapshot();
			const original = f.readRemoteReceiptStatus.getMockImplementation();
			if (!original) throw new Error("Missing real signed receipt reader");
			const signedReads: CoordinatorResolvedAccountOwnerStatusRead[] = [];
			f.readRemoteReceiptStatus.mockImplementation(async (input) => {
				const actual = await original(input);
				signedReads.push(actual);
				if (mode === "unavailable") return { kind: "unavailable", code: "coordinator_unreachable" };
				if (actual.kind !== "owner_status") return actual;
				return {
					kind: "owner_status",
					status: {
						...actual.status,
						state: "owner_unconfirmed",
						ownerIdentity: null,
						profileState: "unavailable",
						profile: null,
					},
				};
			});
			// Act
			const result = await f.confirm();
			const repeated = await f.confirm();
			// Assert: prove the remote mutation succeeded before checking its ambiguous local outcome.
			expect(countReceipts().count).toBe(beforeCount + 1);
			const persisted = f.db
				.prepare(
					"SELECT resolution_id,source_attestation_id,source_review_receipt_id,source_evidence_digest,resolution_evidence_digest,owner_identity_id FROM coordinator_legacy_owner_resolutions",
				)
				.get() as {
				resolution_id: string;
				source_attestation_id: string;
				source_review_receipt_id: string;
				source_evidence_digest: string;
				resolution_evidence_digest: string;
				owner_identity_id: string;
			};
			expect(persisted).toMatchObject({
				owner_identity_id: "identity-a",
				source_attestation_id: f.proof.controller.attestation_id,
				source_review_receipt_id: f.proof.controller.review_receipt_id,
				source_evidence_digest: f.proof.controller.evidence_digest,
			});
			expect(signedReads).toMatchObject([
				{
					kind: "owner_status",
					status: {
						state: "owner_confirmed",
						ownerIdentity: "identity-a",
						profileState: "linked",
						deviceId: f.deviceId,
					},
				},
			]);
			expect(f.readRemoteReceiptStatus.mock.calls[0]?.[0].receipt).toEqual({
				attestationId: persisted.source_attestation_id,
				reviewReceiptId: persisted.source_review_receipt_id,
				reviewEvidenceDigest: persisted.source_evidence_digest,
				resolutionId: persisted.resolution_id,
				resolutionEvidenceDigest: persisted.resolution_evidence_digest,
			});
			expect(
				f.reviewOwner.mock.calls.filter(
					([input]) => input.confirmOwnerResolutionDigest !== undefined,
				),
			).toHaveLength(1);
			expect(f.readRemoteReceiptStatus).toHaveBeenCalledOnce();
			expect(repeated).toEqual(result);
			expect(f.association()).toBeNull();
			expect(recoveryAssociationFiles()).toEqual([]);
			deepStrictEqual(f.immutableSnapshot(), before);
			expect(result.groups).toMatchObject([{ groupId: "group-a", status: "unknown" }]);
		},
	);
});

describe("restored final proof failure without coordinator mutation", () => {
	it("keeps a definite restored-proof rejection failed without reconfirming or publishing locally", async () => {
		// Arrange: this fact already existed; this operation sends no coordinator confirmation.
		const f = await setup();
		const before = f.immutableSnapshot();
		const original = f.readRemoteReceiptStatus.getMockImplementation();
		if (!original) throw new Error("Missing real signed receipt reader");
		f.readRemoteReceiptStatus.mockImplementation(async (input) => {
			const actual = await original(input);
			if (actual.kind !== "owner_status") return actual;
			return {
				kind: "owner_status",
				status: {
					...actual.status,
					state: "owner_unconfirmed",
					ownerIdentity: null,
					profileState: "unavailable",
					profile: null,
				},
			};
		});
		const beforeCount = f.db
			.prepare("SELECT count(*) AS count FROM coordinator_legacy_owner_resolutions")
			.get();
		// Act
		const result = await f.confirm();
		// Assert
		expect(result.groups).toMatchObject([{ groupId: "group-a", status: "failed" }]);
		expectNoConfirmation(f);
		expect(
			f.db.prepare("SELECT count(*) AS count FROM coordinator_legacy_owner_resolutions").get(),
		).toEqual(beforeCount);
		expect(f.association()).toBeNull();
		expect(recoveryAssociationFiles()).toEqual([]);
		deepStrictEqual(f.immutableSnapshot(), before);
	});
});

describe("retained consent handles", () => {
	it.each(["digest", "history", "groups", "expiry", "restart"])(
		"rejects %s consent without replaying a remote write",
		async (mode) => {
			// Arrange
			const f = await setup({ fact: false });
			const preview = structuredClone(f.preview);
			let approvalDigest = preview.approvalDigest;
			let service = f.service;
			if (mode === "digest") approvalDigest = "f".repeat(64);
			if (mode === "history") Object.assign(preview, { history: { complete: true, rows: [] } });
			if (mode === "groups") Object.assign(preview, { groups: ["group-other"] });
			if (mode === "expiry") f.advance(5 * 60_000);
			if (mode === "restart") {
				await service.close();
				service = createAccountOwnerRecoveryService(f.serviceOptions);
				f.cleanup(() => service.close());
			}
			// Act / Assert
			await expect(service.confirm({ preview, approvalDigest })).rejects.toThrow();
			expectNoConfirmation(f);
			expect(f.association()).toBeNull();
		},
	);
	it("client mutation cannot rewrite the retained consent copy", async () => {
		// Arrange
		const f = await setup();
		const saved = structuredClone(f.preview);
		Object.assign(f.preview, {
			existingOwnerId: "identity-other",
			history: { complete: true, rows: [] },
		});
		// Act
		await expect(f.confirm()).rejects.toThrow();
		const result = await f.service.confirm({
			preview: saved,
			approvalDigest: saved.approvalDigest,
		});
		// Assert
		expect(result.groups[0]?.status).toBe("confirmed");
		expect(f.association()?.ownerIdentityId).toBe("identity-a");
	});
	it("evicts the oldest handle after sixteen retained previews", async () => {
		// Arrange
		const f = await setup();
		for (let index = 0; index < 16; index++)
			await f.service.preview({ ...f.selection, requestId: `new-${index}`, purpose: "review" });
		// Act / Assert
		await expect(f.confirm()).rejects.toThrow();
		expectNoConfirmation(f);
		expect(f.association()).toBeNull();
	});
	it("check_status remains read-only even when every receipt is already restored", async () => {
		// Arrange
		const f = await setup();
		const preview = await f.service.preview({
			...f.selection,
			requestId: "status-only",
			purpose: "check_status",
		});
		// Act / Assert
		await expect(
			f.service.confirm({ preview, approvalDigest: preview.approvalDigest }),
		).rejects.toThrow();
		expectNoConfirmation(f);
		expect(f.association()).toBeNull();
	});
});

describe("publication safety and partial outcomes", () => {
	it("reuses an existing same-owner proposal without replacing its original receipt metadata", async () => {
		// Arrange
		const f = await setup();
		f.retain("identity-a");
		const original = f.association();
		// Act
		const result = await f.confirm();
		// Assert
		expect(result.groups[0]?.status).toBe("confirmed");
		expect(f.readRemoteReceiptStatus).toHaveBeenCalled();
		expect(f.association()).toEqual(original);
	});
	it("blocks a different-owner proposal in an unselected configured group", async () => {
		// Arrange
		const f = await setup({ groups: ["group-a", "group-two"] });
		f.retain("identity-other", "group-two");
		// Act / Assert
		await expect(f.confirm()).rejects.toThrow();
		expectNoConfirmation(f);
		expect(f.association()).toBeNull();
		expect(f.association("group-two")?.ownerIdentityId).toBe("identity-other");
	});
	it("does not publish into a replacement DB generation after the receipt await", async () => {
		// Arrange
		const f = await setup();
		const original = f.readRemoteReceiptStatus.getMockImplementation();
		if (!original) throw new Error("Missing receipt client");
		f.readRemoteReceiptStatus.mockImplementation(async (input) => {
			const result = await original(input);
			copyFileSync(f.dbPath, `${f.dbPath}.replacement`);
			renameSync(`${f.dbPath}.replacement`, f.dbPath);
			return result;
		});
		// Act
		const result = await f.confirm();
		// Assert
		expect(result.groups[0]?.status).toBe("unknown");
		expect(f.association()).toBeNull();
		expect(recoveryAssociationFiles()).toEqual([]);
	});
	it.each(["lost", "denied"])(
		"keeps earlier group success when later carried receipt proof is %s, without blind retry",
		async (mode) => {
			// Arrange
			const f = await setup({ fact: false, groups: ["group-a", "group-two"] });
			const selection = await selectionFor(f.service, ["group-a", "group-two"]);
			const preview = await f.service.preview({
				...selection,
				requestId: "partial",
				purpose: "review",
			});
			const original = f.readRemoteReceiptStatus.getMockImplementation();
			if (!original) throw new Error("Missing signed receipt reader");
			f.readRemoteReceiptStatus.mockImplementation(async (input) => {
				if (input.groupId === "group-two") {
					if (mode === "denied") return { kind: "unavailable", code: "coordinator_rejected" };
					throw new Error("receipt_status_outcome_unknown");
				}
				return original(input);
			});
			const before = f.immutableSnapshot();
			const beforeRemote = f
				.snapshot()
				.filter(([name]) => name !== "coordinator_legacy_owner_resolutions");
			// Act
			const result = await f.service.confirm({ preview, approvalDigest: preview.approvalDigest });
			const repeated = await f.service.confirm({ preview, approvalDigest: preview.approvalDigest });
			// Assert
			expect(result.groups).toMatchObject([
				{ groupId: "group-a", status: "confirmed" },
				{ groupId: "group-two", status: "unknown" },
			]);
			expect(repeated).toEqual(result);
			expect(f.association()?.ownerIdentityId).toBe("identity-a");
			expect(f.association("group-two")).toBeNull();
			expect(
				f.reviewOwner.mock.calls.filter(
					([input]) => input.confirmOwnerResolutionDigest !== undefined,
				),
			).toHaveLength(1);
			expect(
				f.reviewOwner.mock.calls.filter(([input]) => input.groupId === "group-two"),
			).toHaveLength(1);
			expect(f.readRemoteReceiptStatus.mock.calls.map(([input]) => input.groupId)).toEqual([
				"group-a",
				"group-two",
			]);
			expect(f.readRemoteReceiptStatus.mock.calls[1]?.[0].receipt).toEqual(
				f.readRemoteReceiptStatus.mock.calls[0]?.[0].receipt,
			);
			deepStrictEqual(f.immutableSnapshot(), before);
			expect(
				f.snapshot().filter(([name]) => name !== "coordinator_legacy_owner_resolutions"),
			).toEqual(beforeRemote);
		},
	);
});

describe("recovery and link share one mutation gate", () => {
	it("reserves before a reentrant trusted context reader can start a link", async () => {
		// Arrange
		const f = await recoveryFixture();
		const ready = f.readContext("group-a");
		if (!("context" in ready) || !ready.context) throw new Error("Missing context");
		const context = ready.context;
		let armed = false;
		const attempts: unknown[] = [];
		const service = createAccountOwnerRecoveryService({
			...f.serviceOptions,
			readContext: (group?: string) => {
				if (armed)
					attempts.push(
						f.registry.start({
							context,
							expectedCoordinatorId: "coordinator-a",
							expectedAuthority: "device_claim",
						}),
					);
				return f.readContext(group);
			},
		});
		f.cleanup(() => service.close());
		const selection = await selectionFor(service);
		const preview = await service.preview({
			...selection,
			requestId: "reentrant",
			purpose: "review",
		});
		armed = true;
		// Act
		const result = await service.confirm({ preview, approvalDigest: preview.approvalDigest });
		// Assert
		expect(result.groups[0]?.status).toBe("confirmed");
		expect(attempts.length).toBeGreaterThan(0);
		expect(
			attempts.every(
				(value) => JSON.stringify(value) === JSON.stringify({ error: "account_link_in_progress" }),
			),
		).toBe(true);
		expect(f.link).not.toHaveBeenCalled();
	});
	it("rejects mutation when the registry lacks the atomic reservation capability", async () => {
		// Arrange
		const f = await setup();
		Object.defineProperty(f.registry, "tryReserveRecovery", { value: undefined });
		// Act / Assert
		await expect(f.confirm()).rejects.toThrow();
		expectNoConfirmation(f);
		expect(f.readRemoteReceiptStatus).not.toHaveBeenCalled();
		expect(f.association()).toBeNull();
	});
	it("registry close during fresh proof invalidates recovery before local publication", async () => {
		// Arrange
		const f = await setup();
		const original = f.readRemoteReceiptStatus.getMockImplementation();
		if (!original) throw new Error("Missing receipt reader");
		f.readRemoteReceiptStatus.mockImplementation(async (input) => {
			const dto = await original(input);
			await f.registry.close();
			return dto;
		});
		// Act
		const result = await f.confirm();
		// Assert
		expect(result.groups[0]?.status).toBe("unknown");
		expect(f.association()).toBeNull();
	});
});
