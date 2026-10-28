import { deepStrictEqual } from "node:assert/strict";
import { copyFileSync, renameSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type ControllerHistoryEvidence,
	parseControllerHistoryRecord,
} from "../../../core/src/coordinator-auth-controller-history.js";
import { invitation } from "../../../core/src/coordinator-device-ownership-evidence-test-fixtures.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "../../../core/src/coordinator-legacy-team-completion.js";
import type {
	RecoveryPreview,
	RecoveryProfile,
} from "../../../ui/src/tabs/account-owner-recovery-types.js";
import {
	expectNoConfirmation,
	recoveryFixture,
	recoveryTests,
	scope,
	selectionFor,
} from "../../test/owner-recovery-service-fixture.js";
import { createAccountOwnerRecoveryService } from "./owner-recovery-service.js";

recoveryTests();
describe("trusted recovery profile and scoped preview", () => {
	it("discovers the coordinator from conflicting current-actor status without requiring owner authority", async () => {
		// Arrange: B is the retained historical assignment; A has a real account birth.
		const f = await recoveryFixture();
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		const before = f.immutableSnapshot();
		// Act
		const result = await service.getProfile();
		const profile: RecoveryProfile = result.profile;
		// Assert
		expect(result).toMatchObject({
			version: 1,
			reviewAccess: "operator",
			candidates: expect.any(Array),
		});
		expect(profile).toMatchObject({
			memoryActorId: "identity-b",
			deviceId: f.deviceId,
			fingerprint: f.fingerprint,
			coordinatorId: f.ownerProfile().coordinatorId,
			configuredGroups: ["group-a"],
		});
		expect(JSON.stringify(result)).not.toMatch(
			/dbPath|keysDir|publicKey|adminSecret|fixture-server-admin/,
		);
		expect(JSON.stringify(result)).not.toContain(f.directory);
		expect(f.readRemoteStatus).toHaveBeenCalledWith(
			expect.objectContaining({ identityId: "identity-b" }),
		);
		deepStrictEqual(f.immutableSnapshot(), before);
	});
	it("keeps semantic context stable across display, model, unrelated config and secret changes", async () => {
		// Arrange
		const f = await recoveryFixture();
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		const before = await service.getProfile();
		f.profile.identityLabel = "Renamed label";
		Object.assign(f.config, { model: "different-model", unrelated_setting: 123 });
		f.setAdmin("rotated-server-secret");
		// Act
		const after = await service.getProfile();
		// Assert
		expect(after.profile).toEqual(before.profile);
	});
	it.each(["actor", "inode", "groups"])(
		"changes semantic context when trusted %s changes",
		async (change) => {
			// Arrange
			const f = await recoveryFixture();
			const service = createAccountOwnerRecoveryService(f.serviceOptions);
			f.cleanup(() => service.close());
			const before = await service.getProfile();
			if (change === "actor") {
				f.profile.identityId = "identity-other";
				f.config.actor_id = "identity-other";
			}
			if (change === "inode") {
				copyFileSync(f.dbPath, `${f.dbPath}.new`);
				renameSync(`${f.dbPath}.new`, f.dbPath);
			}
			if (change === "groups") f.config.sync_coordinator_groups = ["group-a", "group-other"];
			// Act
			const after = await service.getProfile();
			// Assert
			expect(after.profile.contextId).not.toBe(before.profile.contextId);
		},
	);
	it("rejects captured consent after the trusted coordinator origin changes", async () => {
		// Arrange: no discovery or authority is assumed for the unknown new origin.
		const f = await recoveryFixture();
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		const selection = await selectionFor(service);
		const preview = await service.preview({
			...selection,
			requestId: "origin-change",
			purpose: "review",
		});
		f.config.sync_coordinator_url = "https://different.example.test";
		// Act / Assert
		await expect(
			service.confirm({ preview, approvalDigest: preview.approvalDigest }),
		).rejects.toThrow();
		expectNoConfirmation(f);
		expect(f.readRemoteReceiptStatus).not.toHaveBeenCalled();
		expect(f.association()).toBeNull();
	});
});

describe("scoped remote history preview", () => {
	it("displays unrelated history decisions without guessing aliases from matching fingerprints", async () => {
		// Arrange: a complete canonical record contains another device with the same fingerprint string.
		const f = await recoveryFixture({ fact: false });
		const input: Parameters<typeof f.reviewOwner>[0] = {
			remoteUrl: String(f.config.sync_coordinator_url),
			adminSecret: "fixture-server-admin",
			purpose: "existing_account_owner" as const,
			resolutionScope: scope,
			groupId: "group-a",
			deviceId: f.deviceId,
			fingerprint: f.fingerprint,
			identityId: "identity-a",
		};
		const original = await f.reviewOwner(input);
		const row = (original.legacy_history as ControllerHistoryEvidence[])[0];
		if (!row) throw new Error("Missing real canonical history");
		const manifest = normalizeCoordinatorLegacyTeamCompletionManifest({
			...row.manifest,
			device_decisions: [
				...row.manifest.device_decisions,
				{
					device_id: "fingerprint-only-other",
					key_fingerprint: f.fingerprint,
					enabled: false,
					identity_id: null,
					decision: "excluded",
				},
			],
		});
		f.db
			.prepare(
				"UPDATE coordinator_legacy_team_completions SET manifest_json=? WHERE group_id=? AND candidate_ref=?",
			)
			.run(
				canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
				row.group_id,
				row.candidate_ref,
			);
		// Fixture control: the real collector and canonical parser accept the persisted record.
		const collected = await f.reviewOwner(input);
		expect(collected.state).toBe("ready");
		const records = (collected.legacy_history as ControllerHistoryEvidence[]).map((record) =>
			parseControllerHistoryRecord(record, f.ownerProfile().coordinatorId),
		);
		expect(records.flatMap((record) => record.manifest.device_decisions)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					device_id: f.deviceId,
					identity_id: "identity-b",
					decision: "included",
				}),
				expect.objectContaining({
					device_id: "fingerprint-only-other",
					identity_id: null,
					decision: "excluded",
				}),
			]),
		);
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		const selection = await selectionFor(service);
		// Act
		const preview = await service.preview({
			...selection,
			requestId: "not-an-alias",
			purpose: "review",
		});
		// Assert
		expect(preview.history.rows).toContainEqual(
			expect.objectContaining({
				deviceId: "fingerprint-only-other",
				identityId: "",
				relation: "other",
				assignment: "excluded",
			}),
		);
		expect(preview.history).toMatchObject({
			complete: true,
			rows: expect.arrayContaining([
				expect.objectContaining({
					deviceId: f.deviceId,
					identityId: "identity-b",
					relation: "exact_subject",
				}),
			]),
		});
	});
});

describe("scoped remote history preview: project weak labels", () => {
	it("shows verified project weak labels separately without inventing history fingerprints or assignments", async () => {
		// Arrange: an actual consumed project invitation is not a team completion row.
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
		const provenance = f.db
			.prepare("SELECT reviewed_preview_digest FROM coordinator_invites WHERE invite_id=?")
			.get("project-label-reference") as { reviewed_preview_digest: string };
		const expectedLabel = {
			kind: "consumed_project_actor_label",
			label: "project-author-label",
			evidence_ref: provenance.reviewed_preview_digest,
			group_id: "group-a",
			device_id: f.deviceId,
			effect: "account_owner_display_only",
		};
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		const selection = await selectionFor(service);
		// Act
		const preview = await service.preview({
			...selection,
			requestId: "project-label",
			purpose: "review",
		});
		// Assert
		const response = f.reviewOwner.mock.results[0];
		if (!response) throw new Error("Missing real collected review response");
		expect((await response.value).reviewed_weak_labels).toContainEqual(expectedLabel);
		expect(expectedLabel.evidence_ref).toMatch(/^[a-f0-9]{64}$/);
		expect(expectedLabel.evidence_ref).not.toBe("project-label-reference");
		expect(preview.reviewedWeakLabels).toContainEqual(expectedLabel);
		const projectLabel = preview.reviewedWeakLabels.find(
			(label) => label.kind === "consumed_project_actor_label",
		);
		expect(projectLabel).not.toHaveProperty("fingerprint");
		expect(projectLabel).not.toHaveProperty("key_fingerprint");
		expect(projectLabel).not.toHaveProperty("assignment");
		expect(preview.history.rows.some((row) => row.identityId === "project-author-label")).toBe(
			false,
		);
		expectNoConfirmation(f);
	});
});

describe("operator and request review access", () => {
	it("shows all canonical history and explicit weak labels, including unselected historical groups", async () => {
		// Arrange
		const f = await recoveryFixture();
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		const selection = await selectionFor(service);
		const before = f.immutableSnapshot();
		// Act
		const result = await service.preview({
			...selection,
			requestId: "review-1",
			purpose: "review",
		});
		const preview: RecoveryPreview = result;
		// Assert
		expect(preview).toMatchObject({
			scope,
			approvalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			history: {
				complete: true,
				rows: expect.arrayContaining([
					expect.objectContaining({
						groupId: "retained-history-c",
						identityId: "identity-b",
						relation: "exact_subject",
					}),
				]),
			},
			groupPreviews: [{ groupId: "group-a", action: "reuse" }],
		});
		expect(result.reviewedWeakLabels).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: "identity-b", group_id: "retained-history-c" }),
			]),
		);
		expect(f.reviewOwner).toHaveBeenCalledWith(
			expect.objectContaining({
				purpose: "existing_account_owner",
				resolutionScope: scope,
				identityId: "identity-a",
				deviceId: f.deviceId,
			}),
		);
		expectNoConfirmation(f);
		expect(f.association()).toBeNull();
		deepStrictEqual(f.immutableSnapshot(), before);
	});
	it("returns request-only assistance with incomplete history when no trusted admin callback credential exists", async () => {
		// Arrange
		const f = await recoveryFixture({ admin: false });
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		const selection = await selectionFor(service);
		// Act
		const preview = await service.preview({
			...selection,
			requestId: "assistance",
			purpose: "review",
		});
		// Assert
		expect(await service.getProfile()).toMatchObject({ reviewAccess: "request" });
		expect(preview.history).toMatchObject({ complete: false, operatorHelp: expect.any(String) });
		expect(preview.groupPreviews.every((group) => group.action === "blocked")).toBe(true);
		expect(f.reviewOwner).not.toHaveBeenCalled();
		await expect(
			service.confirm({ preview, approvalDigest: preview.approvalDigest }),
		).rejects.toThrow();
		expect(f.association()).toBeNull();
	});
});

describe("strict browser selections and complete remote evidence", () => {
	it.each(["empty", "duplicate", "unconfigured", "all-without-selection"])(
		"rejects %s browser group selection",
		async (mode) => {
			// Arrange
			const f = await recoveryFixture({ groups: ["group-a", "group-two"] });
			const service = createAccountOwnerRecoveryService(f.serviceOptions);
			f.cleanup(() => service.close());
			const selection = await selectionFor(service);
			const groups = {
				empty: [],
				duplicate: ["group-a", "group-a"],
				unconfigured: ["foreign"],
				"all-without-selection": undefined,
			}[mode];
			// Act / Assert
			await expect(
				service.preview({
					...selection,
					groups,
					requestId: "invalid",
					purpose: "review",
				} as unknown as Parameters<typeof service.preview>[0]),
			).rejects.toThrow();
			expect(f.reviewOwner).not.toHaveBeenCalled();
		},
	);
	it.each([
		"coordinator_id",
		"device_id",
		"fingerprint",
		"resolution_scope",
		"legacy_history",
		"reviewed_weak_labels",
		"attestation_id",
		"recovery_receipt",
		"owner_resolution",
	])("fails closed on incomplete or mismatched remote %s", async (field) => {
		// Arrange: start from a valid real store DTO, never a synthetic success marker.
		const f = await recoveryFixture();
		const original = f.reviewOwner.getMockImplementation();
		if (!original) throw new Error("Missing fixture action");
		f.reviewOwner.mockImplementation(async (input) => {
			const dto = await original(input);
			if (
				[
					"legacy_history",
					"reviewed_weak_labels",
					"attestation_id",
					"recovery_receipt",
					"owner_resolution",
				].includes(field)
			)
				delete dto[field];
			else dto[field] = "foreign";
			return dto;
		});
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		const selection = await selectionFor(service);
		// Act / Assert
		await expect(
			service.preview({ ...selection, requestId: "bad-remote", purpose: "review" }),
		).rejects.toThrow();
		expectNoConfirmation(f);
		expect(f.association()).toBeNull();
	});
});

describe("coordinator timeout for owner reviews", () => {
	it.each([
		{ configured: undefined, expected: 10 },
		{ configured: 3, expected: 10 },
		{ configured: 45, expected: 45 },
	])(
		"uses $expected s for suggestions, preview, and confirm when configured as $configured",
		async ({ configured, expected }) => {
			// Arrange
			const f = await recoveryFixture({ fact: false });
			const service = createAccountOwnerRecoveryService({
				...f.serviceOptions,
				...(configured === undefined ? {} : { readCoordinatorTimeoutS: () => configured }),
			});
			f.cleanup(() => service.close());
			// Act
			const selection = await selectionFor(service);
			const preview = await service.preview({
				...selection,
				requestId: "timeout",
				purpose: "review",
			});
			await service.confirm({ preview, approvalDigest: preview.approvalDigest });
			// Assert
			expect(f.previewDeviceOwner).toHaveBeenCalledWith(
				expect.objectContaining({ timeoutS: expected }),
			);
			const reviews = f.reviewOwner.mock.calls.map(([input]) => input);
			expect(reviews.map((input) => input.timeoutS)).toEqual([expected, expected]);
			expect(reviews[1]?.confirmOwnerResolutionDigest).toBeDefined();
		},
	);
});
