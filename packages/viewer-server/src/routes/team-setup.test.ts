import {
	fingerprintPublicKey,
	legacyTeamCandidateId,
	readCoordinatorSyncConfig,
} from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
import { __teamSetupTestHooks } from "./team-setup.js";

describe("Team setup roster loading", () => {
	it("reuses successful summary snapshots until the cache expires", async () => {
		let now = 1_000;
		const snapshots = [{ groupId: "group-alpha" }] as never;
		const source = vi.fn(async () => snapshots);
		const load = __teamSetupTestHooks.createCachedSnapshotLoader(source, 30_000, () => now);

		await expect(Promise.all([load(), load()])).resolves.toEqual([snapshots, snapshots]);
		await expect(load()).resolves.toBe(snapshots);
		expect(source).toHaveBeenCalledTimes(1);

		now += 30_000;
		await expect(load()).resolves.toBe(snapshots);
		expect(source).toHaveBeenCalledTimes(2);
	});

	it("retries summary snapshot loading after a failure", async () => {
		const snapshots = [{ groupId: "group-alpha" }] as never;
		const source = vi
			.fn<() => Promise<typeof snapshots>>()
			.mockRejectedValueOnce(new Error("temporarily unavailable"))
			.mockResolvedValueOnce(snapshots);
		const load = __teamSetupTestHooks.createCachedSnapshotLoader(source, 30_000);

		await expect(load()).rejects.toThrow("temporarily unavailable");
		await expect(load()).resolves.toBe(snapshots);
		expect(source).toHaveBeenCalledTimes(2);
	});

	it("retries an in-flight summary after invalidation", async () => {
		let resolveFirst: ((snapshots: never) => void) | undefined;
		const staleSnapshots = [{ groupId: "stale" }] as never;
		const freshSnapshots = [{ groupId: "fresh" }] as never;
		const source = vi
			.fn<() => Promise<typeof freshSnapshots>>()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockResolvedValue(freshSnapshots);
		const load = __teamSetupTestHooks.createCachedSnapshotLoader(source, 30_000);

		const staleLoad = load();
		load.invalidate();
		const freshLoad = load();
		resolveFirst?.(staleSnapshots);

		await expect(staleLoad).resolves.toBe(freshSnapshots);
		await expect(freshLoad).resolves.toBe(freshSnapshots);
		await expect(load()).resolves.toBe(freshSnapshots);
		expect(source).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ configuredTimeoutS: 17, expectedTimeoutS: 17 },
		{ configuredTimeoutS: 0, expectedTimeoutS: 1 },
	])("uses normalized coordinator settings with timeout $expectedTimeoutS", async ({
		configuredTimeoutS,
		expectedTimeoutS,
	}) => {
		const publicKey = "public-key-a";
		const listGroups = vi.fn(async () => [
			{
				group_id: "group-alpha",
				display_name: "Migration Team",
				archived_at: null,
				created_at: "2026-08-24T00:00:00.000Z",
			},
		]);
		const listDevices = vi.fn(async () => [
			{
				group_id: "group-alpha",
				device_id: "device-a",
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
				identity_id: null,
				display_name: "Laptop",
				enabled: 1,
				created_at: "2026-08-24T00:00:00.000Z",
			},
		]);

		const snapshots = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith({
			readConfig: () => ({
				...readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: "localhost:8787/",
				syncCoordinatorGroups: ["group-alpha"],
				syncCoordinatorAdminSecret: "private-admin-secret",
				syncCoordinatorTimeoutS: configuredTimeoutS,
			}),
			listGroups,
			listDevices,
		});

		expect(snapshots[0]?.coordinatorId).toBe("http://localhost:8787");
		expect(listGroups).toHaveBeenCalledWith(
			expect.objectContaining({
				remoteUrl: "http://localhost:8787",
				timeoutS: expectedTimeoutS,
			}),
		);
		expect(listDevices).toHaveBeenCalledWith(
			expect.objectContaining({
				remoteUrl: "http://localhost:8787",
				timeoutS: expectedTimeoutS,
			}),
		);
	});

	it.each([
		"https://private.example.invalid/person",
		"/Users/private/person",
		"host.internal",
		"Person identity-secret-id",
		"Person ＩＤＥＮＴＩＴＹ－ＳＥＣＲＥＴ－ＩＤ",
		"ssh-rsa AAAAB3Nza private material",
	])("redacts unsafe active identity label %s", (label) => {
		expect(__teamSetupTestHooks.safeChoiceLabel(label, "Person", ["identity-secret-id"])).toBe(
			"Person",
		);
	});

	it("keeps bounded human identity labels", () => {
		expect(__teamSetupTestHooks.safeChoiceLabel("  Alex Example  ", "Person", ["actor-a"])).toBe(
			"Alex Example",
		);
	});

	it("adds a stable opaque disambiguator to redacted labels", () => {
		expect(
			__teamSetupTestHooks.safeChoiceLabel(
				"private.example.invalid",
				"Person",
				[],
				"legacy-team-viewer-identity-ref-v1:abcdef",
			),
		).toBe("Person abcdef");
	});

	it("adds stable opaque disambiguators when safe labels collide", () => {
		expect(
			__teamSetupTestHooks.disambiguateChoiceLabels(
				[
					{ displayName: "Alex Example", identityRef: "identity-ref-abcdef" },
					{ displayName: "alex example", identityRef: "identity-ref-123456" },
					{ displayName: "Blair Example", identityRef: "identity-ref-fedcba" },
				],
				(choice) => choice.identityRef,
			),
		).toEqual([
			{ displayName: "Alex Example abcdef", identityRef: "identity-ref-abcdef" },
			{ displayName: "alex example 123456", identityRef: "identity-ref-123456" },
			{ displayName: "Blair Example", identityRef: "identity-ref-fedcba" },
		]);
	});

	it("extends opaque disambiguators until final labels are globally unique", () => {
		expect(
			__teamSetupTestHooks.disambiguateChoiceLabels(
				[
					{ displayName: "Alex", identityRef: "identity-ref-xxabcdef" },
					{ displayName: "Alex", identityRef: "identity-ref-yyabcdef" },
					{ displayName: "Alex abcdef", identityRef: "identity-ref-zzzzzzzz" },
				],
				(choice) => choice.identityRef,
			),
		).toEqual([
			{ displayName: "Alex xxabcdef", identityRef: "identity-ref-xxabcdef" },
			{ displayName: "Alex yyabcdef", identityRef: "identity-ref-yyabcdef" },
			{ displayName: "Alex abcdef", identityRef: "identity-ref-zzzzzzzz" },
		]);
	});

	it("preserves oversized-roster errors for a direct candidate load", async () => {
		const coordinatorId = "http://localhost:8787";
		const groupId = "group-alpha";
		await expect(
			__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(
				{
					readConfig: () => ({
						...readCoordinatorSyncConfig({}),
						syncCoordinatorUrl: coordinatorId,
						syncCoordinatorGroups: [groupId],
						syncCoordinatorAdminSecret: "private-admin-secret",
					}),
					listGroups: vi.fn(async () => [
						{
							group_id: groupId,
							display_name: "Migration Team",
							archived_at: null,
							created_at: "2026-08-24T00:00:00.000Z",
						},
					]),
					listDevices: vi.fn(async () => {
						throw new Error("coordinator_response_too_large");
					}),
				},
				{ candidateRef: legacyTeamCandidateId(coordinatorId, groupId) },
			),
		).rejects.toThrow("legacy_team_setup_roster_too_large");
	});

	it("rejects mapping-choice responses that cannot include every opaque choice", () => {
		expect(() => __teamSetupTestHooks.requireCompleteMappingChoices(21, 500)).toThrow(
			"legacy_team_setup_roster_too_large",
		);
		expect(() => __teamSetupTestHooks.requireCompleteMappingChoices(20, 500)).not.toThrow();
	});

	it("loads only the requested candidate roster", async () => {
		const coordinatorId = "http://localhost:8787";
		const targetGroupId = "group-alpha";
		const unrelatedGroupId = "group-beta";
		const listDevices = vi.fn(async () => []);

		const snapshots = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(
			{
				readConfig: () => ({
					...readCoordinatorSyncConfig({}),
					syncCoordinatorUrl: `${coordinatorId}/`,
					syncCoordinatorGroups: [targetGroupId, unrelatedGroupId],
					syncCoordinatorAdminSecret: "private-admin-secret",
				}),
				listGroups: async () => [
					{
						group_id: targetGroupId,
						display_name: "Migration Team",
						archived_at: null,
						created_at: "2026-08-24T00:00:00.000Z",
					},
					{
						group_id: unrelatedGroupId,
						display_name: "Archived Team",
						archived_at: "2026-08-23T00:00:00.000Z",
						created_at: "2026-08-22T00:00:00.000Z",
					},
				],
				listDevices,
			},
			{ candidateRef: legacyTeamCandidateId(coordinatorId, targetGroupId) },
		);

		expect(snapshots).toEqual([
			expect.objectContaining({ groupId: targetGroupId, displayName: "Migration Team" }),
		]);
		expect(listDevices).toHaveBeenCalledTimes(1);
		expect(listDevices).toHaveBeenCalledWith(expect.objectContaining({ groupId: targetGroupId }));
	});
});
