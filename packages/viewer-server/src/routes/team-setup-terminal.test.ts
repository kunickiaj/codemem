import {
	deriveLegacyTeamSetupCompletionManifest,
	deterministicPolicyTeamId,
	finishLegacyTeamSetupActivation,
	getLegacyTeamSetupDraft,
	inspectLegacyTeamSetupActivation,
	type LegacyTeamConfiguredGroupSnapshot,
	legacyTeamCandidateId,
	legacyTeamCandidateProjectInventory,
	MemoryStore,
	readCoordinatorSyncConfig,
	serializeRecipientPolicyActorMutations,
	serializeRecipientPolicyCoordinatorGroupMutation,
	serializeRecipientPolicyPublicationMutation,
	serializeRecipientPolicyTeamMutation,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
} from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
import { __teamSetupTestHooks, teamSetupRoutes } from "./team-setup.js";

const COORDINATOR_ID = "https://coordinator.example.test";
const GROUP_ID = "group-alpha";
const CANDIDATE_REF = legacyTeamCandidateId(COORDINATOR_ID, GROUP_ID);
const NOW = "2026-08-26T00:00:00.000Z";
const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);
const SNAPSHOTS: LegacyTeamConfiguredGroupSnapshot[] = [
	{
		coordinatorId: COORDINATOR_ID,
		groupId: GROUP_ID,
		displayName: "Migration Team",
		devices: [
			{
				deviceId: "device-a",
				fingerprint: FINGERPRINT_A,
				displayName: "Laptop",
				enabled: true,
			},
		],
	},
];

function insertTeam(
	store: MemoryStore,
	draft: NonNullable<ReturnType<typeof getLegacyTeamSetupDraft>>,
	options: {
		status: "active" | "inactive";
		provenance: "legacy_team_candidate" | "reviewed_team_candidate";
		sourceFingerprint?: string;
	},
): string {
	const teamId = deterministicPolicyTeamId(CANDIDATE_REF);
	store.db
		.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, device_eligibility_mode, provenance,
			 revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Migration Team', ?, 'reviewed_allowlist', ?, 'revision-1',
			 'completed', ?, 'team-key', ?, ?)`,
		)
		.run(
			teamId,
			options.status,
			options.provenance,
			options.sourceFingerprint ?? draft.rosterFingerprint,
			NOW,
			NOW,
		);
	return teamId;
}

function completeDraft(
	store: MemoryStore,
	draft: NonNullable<ReturnType<typeof getLegacyTeamSetupDraft>>,
	teamId: string | null,
): void {
	store.db
		.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', completed_team_id = ?, completed_at = ?, updated_at = ?
			 WHERE attempt_id = ?`,
		)
		.run(teamId, NOW, NOW, draft.attemptId);
}

describe("Team setup terminal migration routing", () => {
	function completionConfig(timeoutS?: number) {
		return {
			readConfig: () => ({
				...readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: COORDINATOR_ID,
				syncCoordinatorGroups: [GROUP_ID],
				syncCoordinatorAdminSecret: "private-admin-secret",
				...(timeoutS == null ? {} : { syncCoordinatorTimeoutS: timeoutS }),
			}),
			listGroups: vi.fn(async () => []),
			listDevices: vi.fn(async () => []),
		};
	}

	async function readyDraftThroughSummary(
		store: MemoryStore,
		app: ReturnType<typeof teamSetupRoutes>,
		candidateRef = CANDIDATE_REF,
	) {
		expect((await app.request("/api/sync/team-setup/v1")).status).toBe(200);
		store.db
			.prepare(
				`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
				 VALUES ('identity-a', 'Person A', 0, 'active', ?, ?)`,
			)
			.run(NOW, NOW);
		let draft = getLegacyTeamSetupDraft(store.db, candidateRef);
		if (!draft) throw new Error("Team setup draft missing");
		const device = draft.devices[0];
		if (!device) throw new Error("Team setup device missing");
		draft = setLegacyTeamSetupDeviceAssignment(store.db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			targetIdentityId: "identity-a",
			expectation: device.expectation,
			now: NOW,
		});
		return setLegacyTeamSetupDeviceDecision(store.db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			decision: "included",
			now: NOW,
		});
	}

	it("publishes before activating the immutable winner", async () => {
		const store = new MemoryStore(":memory:");
		const loadSnapshots = vi.fn(async () => SNAPSHOTS);
		const create = vi.fn(async ({ manifest }) => {
			expect(store.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
			return { status: "created" as const, manifest };
		});
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
			snapshotLoaderDependencies: completionConfig(),
			completionDependencies: { create, list: async () => [] },
		});
		try {
			const draft = await readyDraftThroughSummary(store, app);
			const detail = (await (
				await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`)
			).json()) as {
				finishDigest: string;
				accessDeltaDigest: string;
				viewerAccessDeltaDigest: string;
			};
			const finishRequest = {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					attemptId: draft.attemptId,
					finishDigest: detail.finishDigest,
					confirmedAccessDeltaDigest: detail.accessDeltaDigest,
					confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
				}),
			};
			const response = await app.request(
				`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`,
				finishRequest,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				accessDeltaDigest: detail.accessDeltaDigest,
			});
			const completion = store.db
				.prepare(
					`SELECT finish_digest, confirmed_access_delta_digest
					 FROM legacy_team_setup_completions WHERE attempt_id = ?`,
				)
				.get(draft.attemptId) as {
				finish_digest: string;
				confirmed_access_delta_digest: string;
			};
			expect(completion).toEqual({
				finish_digest: detail.finishDigest,
				confirmed_access_delta_digest: detail.accessDeltaDigest,
			});
			expect(completion.finish_digest).toMatch(/^legacy-team-activation-finish-v1:[0-9a-f]{64}$/u);
			expect(completion.confirmed_access_delta_digest).toMatch(
				/^legacy-team-access-delta:[0-9a-f]{64}$/u,
			);
			expect(create).toHaveBeenCalledTimes(1);
			expect(store.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(1);
			expect(store.db.prepare("SELECT display_name FROM policy_teams").pluck().get()).toBe(
				"Migration Team",
			);
			loadSnapshots.mockRejectedValue(new Error("coordinator unavailable"));
			const replay = await app.request(
				`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`,
				finishRequest,
			);
			expect(replay.status).toBe(200);
			expect(await replay.json()).toMatchObject({ accessDeltaDigest: detail.accessDeltaDigest });
			expect(create).toHaveBeenCalledTimes(1);
			const staleReplay = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`, {
				...finishRequest,
				body: JSON.stringify({
					attemptId: draft.attemptId,
					finishDigest: `legacy-team-activation-finish-v1:${"0".repeat(64)}`,
					confirmedAccessDeltaDigest: detail.accessDeltaDigest,
					confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
				}),
			});
			expect(staleReplay.status).toBe(409);
			expect(await staleReplay.json()).toEqual({ error: "team_setup_confirmation_stale" });
			expect(create).toHaveBeenCalledTimes(1);
			const staleAccessReplay = await app.request(
				`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`,
				{
					...finishRequest,
					body: JSON.stringify({
						attemptId: draft.attemptId,
						finishDigest: detail.finishDigest,
						confirmedAccessDeltaDigest: `legacy-team-access-delta:${"1".repeat(64)}`,
						confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
					}),
				},
			);
			expect(staleAccessReplay.status).toBe(409);
			expect(await staleAccessReplay.json()).toEqual({ error: "team_setup_confirmation_stale" });
			expect(create).toHaveBeenCalledTimes(1);
			expect(store.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(1);
			expect(
				store.db
					.prepare("SELECT state FROM legacy_team_setup_drafts WHERE candidate_id = ?")
					.pluck()
					.get(CANDIDATE_REF),
			).toBe("completed");
		} finally {
			store.close();
		}
	});

	it("rejects a roster change that occurs while finish waits for publication locks", async () => {
		const store = new MemoryStore(":memory:");
		let currentSnapshots = SNAPSHOTS;
		const loadSnapshots = vi.fn(async () => currentSnapshots);
		const create = vi.fn(async ({ manifest }) => ({ status: "created" as const, manifest }));
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
			snapshotLoaderDependencies: completionConfig(),
			completionDependencies: { create, list: async () => [] },
		});
		try {
			const draft = await readyDraftThroughSummary(store, app);
			const detail = (await (
				await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`)
			).json()) as {
				finishDigest: string;
				accessDeltaDigest: string;
				viewerAccessDeltaDigest: string;
			};
			let releasePublicationLock = () => undefined;
			const publicationLockPending = new Promise<void>((resolve) => {
				releasePublicationLock = resolve;
			});
			let publicationLockHeld = false;
			const publicationMutation = serializeRecipientPolicyPublicationMutation(
				store.db,
				async () => {
					publicationLockHeld = true;
					await publicationLockPending;
				},
			);
			await vi.waitFor(() => expect(publicationLockHeld).toBe(true));
			const loadCountBeforeFinish = loadSnapshots.mock.calls.length;
			const finish = app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					attemptId: draft.attemptId,
					finishDigest: detail.finishDigest,
					confirmedAccessDeltaDigest: detail.accessDeltaDigest,
					confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
				}),
			});
			await vi.waitFor(() =>
				expect(loadSnapshots.mock.calls.length).toBeGreaterThan(loadCountBeforeFinish),
			);
			const snapshot = SNAPSHOTS[0];
			if (!snapshot) throw new Error("missing test snapshot");
			currentSnapshots = [
				{
					...snapshot,
					devices: snapshot.devices.map((device) => ({ ...device, enabled: false })),
				},
			];
			releasePublicationLock();
			await publicationMutation;

			const response = await finish;
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "team_setup_roster_changed" });
			expect(create).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	it("rejects finish when authorization is revoked during the locked roster reload", async () => {
		const store = new MemoryStore(":memory:");
		let configuredGroups = [GROUP_ID];
		let trackFinishLoads = false;
		let finishLoadCount = 0;
		let releaseLockedRosterReload = () => undefined;
		const lockedRosterReloadPending = new Promise<void>((resolve) => {
			releaseLockedRosterReload = resolve;
		});
		let lockedRosterReloadStarted = false;
		const loadSnapshots = vi.fn(async () => {
			if (!trackFinishLoads) return SNAPSHOTS;
			finishLoadCount += 1;
			if (finishLoadCount === 2) {
				lockedRosterReloadStarted = true;
				await lockedRosterReloadPending;
			}
			return SNAPSHOTS;
		});
		const config = completionConfig();
		const create = vi.fn(async ({ manifest }) => ({ status: "created" as const, manifest }));
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
			snapshotLoaderDependencies: {
				...config,
				readConfig: () => ({ ...config.readConfig(), syncCoordinatorGroups: configuredGroups }),
			},
			completionDependencies: { create, list: async () => [] },
		});
		try {
			const draft = await readyDraftThroughSummary(store, app);
			const detail = (await (
				await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`)
			).json()) as {
				finishDigest: string;
				accessDeltaDigest: string;
				viewerAccessDeltaDigest: string;
			};
			trackFinishLoads = true;
			const finish = app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					attemptId: draft.attemptId,
					finishDigest: detail.finishDigest,
					confirmedAccessDeltaDigest: detail.accessDeltaDigest,
					confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
				}),
			});
			await vi.waitFor(() => expect(lockedRosterReloadStarted).toBe(true));
			configuredGroups = [];
			releaseLockedRosterReload();

			const response = await finish;
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "team_setup_completion_invalid" });
			expect(create).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	it("keeps local policy uncommitted when completion publication fails", async () => {
		const store = new MemoryStore(":memory:");
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			snapshotLoaderDependencies: completionConfig(),
			completionDependencies: {
				create: async () => {
					throw new Error("private upstream detail");
				},
				list: async () => [],
			},
		});
		try {
			const draft = await readyDraftThroughSummary(store, app);
			const detail = (await (
				await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`)
			).json()) as {
				finishDigest: string;
				accessDeltaDigest: string;
				viewerAccessDeltaDigest: string;
			};
			const response = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					attemptId: draft.attemptId,
					finishDigest: detail.finishDigest,
					confirmedAccessDeltaDigest: detail.accessDeltaDigest,
					confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
				}),
			});
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: "team_setup_completion_unavailable" });
			expect(store.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
			await Promise.all([
				serializeRecipientPolicyPublicationMutation(store.db, async () => undefined),
				serializeRecipientPolicyActorMutations(store.db, ["identity-a"], async () => undefined),
			]);
		} finally {
			store.close();
		}
	});

	it("recovers a completion committed before its create response was lost", async () => {
		const store = new MemoryStore(":memory:");
		let published: ReturnType<typeof deriveLegacyTeamSetupCompletionManifest> | null = null;
		const create = vi.fn(async ({ manifest }) => {
			published = { ...manifest, completed_at: NOW };
			throw new Error("completion_conflict");
		});
		const get = vi
			.fn()
			.mockRejectedValueOnce(new Error("Remote coordinator request failed (503): unavailable"))
			.mockImplementation(async () => published);
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			snapshotLoaderDependencies: completionConfig(),
			completionDependencies: { create, get, list: async () => [] },
		});
		try {
			const draft = await readyDraftThroughSummary(store, app);
			const detail = (await (
				await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`)
			).json()) as {
				finishDigest: string;
				accessDeltaDigest: string;
				viewerAccessDeltaDigest: string;
			};
			const response = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					attemptId: draft.attemptId,
					finishDigest: detail.finishDigest,
					confirmedAccessDeltaDigest: detail.accessDeltaDigest,
					confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
				}),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ completedAt: NOW });
			expect(create).toHaveBeenCalledWith(
				expect.objectContaining({ timeoutS: expect.any(Number) }),
			);
			expect(get).toHaveBeenCalledTimes(2);
			expect(get).toHaveBeenCalledWith(
				expect.objectContaining({
					groupId: GROUP_ID,
					candidateRef: CANDIDATE_REF,
					timeoutS: expect.any(Number),
				}),
			);
			expect(getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)?.state).toBe("completed");
		} finally {
			store.close();
		}
	});

	it("rejects a coordinator manifest that differs from the proposed completion", async () => {
		const store = new MemoryStore(":memory:");
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			snapshotLoaderDependencies: completionConfig(),
			completionDependencies: {
				create: async ({ manifest }) => ({
					status: "existing" as const,
					manifest: { ...manifest, completed_at: "2026-08-30T00:00:01.000Z" },
				}),
				list: async () => [],
			},
		});
		try {
			const draft = await readyDraftThroughSummary(store, app);
			const detail = (await (
				await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`)
			).json()) as {
				finishDigest: string;
				accessDeltaDigest: string;
				viewerAccessDeltaDigest: string;
			};
			const response = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					attemptId: draft.attemptId,
					finishDigest: detail.finishDigest,
					confirmedAccessDeltaDigest: detail.accessDeltaDigest,
					confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
				}),
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "team_setup_completion_conflict" });
			expect(store.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		} finally {
			store.close();
		}
	});

	it("applies a remote completion before suppressing its candidate", async () => {
		const source = new MemoryStore(":memory:");
		const target = new MemoryStore(":memory:");
		const sourceApp = teamSetupRoutes({
			getStore: () => source,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const sourceDraft = await readyDraftThroughSummary(source, sourceApp);
			const manifest = deriveLegacyTeamSetupCompletionManifest(source.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: sourceDraft.attemptId,
				completedAt: NOW,
			});
			const targetApp = teamSetupRoutes({
				getStore: () => target,
				loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
				snapshotLoaderDependencies: completionConfig(),
				completionDependencies: {
					create: async ({ manifest }) => ({ status: "existing", manifest }),
					list: async () => [
						{
							group_id: GROUP_ID,
							manifest: {
								...manifest,
								candidate_ref: "legacy-team-candidate:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
							},
						},
						{ group_id: GROUP_ID, manifest },
					],
				},
			});
			target.db
				.prepare(
					`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
					 VALUES ('identity-a', 'Person A', 0, 'active', ?, ?)`,
				)
				.run(NOW, NOW);
			const response = await targetApp.request("/api/sync/team-setup/v1");
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ version: 1, candidates: [] });
			expect(target.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(1);
		} finally {
			source.close();
			target.close();
		}
	});

	it("isolates an invalid completion to its group during summary reconciliation", async () => {
		const source = new MemoryStore(":memory:");
		const target = new MemoryStore(":memory:");
		const sourceApp = teamSetupRoutes({
			getStore: () => source,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const sourceDraft = await readyDraftThroughSummary(source, sourceApp);
			const manifest = deriveLegacyTeamSetupCompletionManifest(source.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: sourceDraft.attemptId,
				completedAt: NOW,
			});
			const secondGroup = {
				...SNAPSHOTS[0],
				groupId: "group-beta",
				displayName: "Other Team",
			} as LegacyTeamConfiguredGroupSnapshot;
			const app = teamSetupRoutes({
				getStore: () => target,
				loadLegacyTeamConfiguredGroupSnapshots: async () => [...SNAPSHOTS, secondGroup],
				snapshotLoaderDependencies: completionConfig(),
				completionDependencies: {
					create: vi.fn(),
					list: async () => [
						{ group_id: GROUP_ID, manifest: { ...manifest, team_id: "team-invalid" } },
					],
				},
			});

			const response = await app.request("/api/sync/team-setup/v1");
			expect(response.status).toBe(200);
			const body = (await response.json()) as { candidates: unknown[] };
			expect(body.candidates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ candidateRef: CANDIDATE_REF }),
					expect.objectContaining({
						candidateRef: legacyTeamCandidateId(COORDINATOR_ID, secondGroup.groupId),
					}),
				]),
			);
		} finally {
			source.close();
			target.close();
		}
	});

	it("isolates an undecodable batch record to its group during summary reconciliation", async () => {
		const store = new MemoryStore(":memory:");
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const draft = await readyDraftThroughSummary(store, setupApp);
			const manifest = deriveLegacyTeamSetupCompletionManifest(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				completedAt: NOW,
			});
			const secondGroup = {
				...SNAPSHOTS[0],
				groupId: "group-beta",
				displayName: "Other Team",
			} as LegacyTeamConfiguredGroupSnapshot;
			// The production batch action rejects the whole payload when any one
			// record fails decoding, so the route must re-query per group.
			const list = vi.fn(async (input: { groupIds: string[] }) => {
				if (input.groupIds.length === 1 && input.groupIds[0] === GROUP_ID) {
					return [{ group_id: GROUP_ID, manifest }];
				}
				throw new Error("coordinator_completion_response_malformed");
			});
			const twoGroupConfig = completionConfig();
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: async () => [...SNAPSHOTS, secondGroup],
				snapshotLoaderDependencies: {
					...twoGroupConfig,
					readConfig: () => ({
						...twoGroupConfig.readConfig(),
						syncCoordinatorGroups: [GROUP_ID, secondGroup.groupId],
					}),
				},
				completionDependencies: { create: vi.fn(), list },
			});

			const response = await app.request("/api/sync/team-setup/v1");
			expect(response.status).toBe(200);
			const body = (await response.json()) as { candidates: unknown[] };
			// The decodable group's completion applied (so it no longer needs setup)
			// while the undecodable group still surfaces its own setup state.
			expect(body.candidates).toEqual([
				expect.objectContaining({
					candidateRef: legacyTeamCandidateId(COORDINATOR_ID, secondGroup.groupId),
					status: "needs_setup",
				}),
			]);
			expect(list.mock.calls.map(([input]) => input.groupIds)).toEqual([
				[GROUP_ID, secondGroup.groupId],
				[GROUP_ID],
				[secondGroup.groupId],
			]);
			expect(getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)?.state).toBe("completed");
		} finally {
			store.close();
		}
	});

	it("refreshes detail presentation after reconciling a completed draft", async () => {
		const source = new MemoryStore(":memory:");
		const target = new MemoryStore(":memory:");
		const canonicalSnapshots = [
			{
				...SNAPSHOTS[0],
				displayName: "Canonical Team",
				devices: [
					...(SNAPSHOTS[0]?.devices ?? []),
					{
						deviceId: "device-b",
						displayName: "Spare laptop",
						fingerprint: FINGERPRINT_B,
						identityId: null,
						enabled: true,
					},
				],
			},
		];
		const sourceApp = teamSetupRoutes({
			getStore: () => source,
			loadLegacyTeamConfiguredGroupSnapshots: async () => canonicalSnapshots,
			completionDependencies: null,
		});
		const targetSetupApp = teamSetupRoutes({
			getStore: () => target,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			let sourceDraft = await readyDraftThroughSummary(source, sourceApp);
			const excludedDevice = sourceDraft.devices.find(
				(device) => device.displayName === "Spare laptop",
			);
			if (!excludedDevice) throw new Error("canonical excluded device missing");
			sourceDraft = setLegacyTeamSetupDeviceDecision(source.db, {
				attemptId: sourceDraft.attemptId,
				deviceRef: excludedDevice.deviceRef,
				decision: "excluded",
				now: NOW,
			});
			const manifest = deriveLegacyTeamSetupCompletionManifest(source.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: sourceDraft.attemptId,
				completedAt: NOW,
			});
			const targetDraft = await readyDraftThroughSummary(target, targetSetupApp);
			const review = inspectLegacyTeamSetupActivation(target.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: targetDraft.attemptId,
			});
			await finishLegacyTeamSetupActivation(target.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: targetDraft.attemptId,
				finishDigest: review.finishDigest,
				confirmedAccessDeltaDigest: review.accessDeltaDigest,
				loadFreshRoster: async () => SNAPSHOTS[0]?.devices ?? [],
				loadProjectInventory: () => [],
				validateLockedPreview: () => true,
				now: NOW,
			});
			const app = teamSetupRoutes({
				getStore: () => target,
				loadLegacyTeamConfiguredGroupSnapshots: async () => canonicalSnapshots,
				snapshotLoaderDependencies: completionConfig(),
				completionDependencies: {
					create: async ({ manifest: replay }) => ({ status: "existing", manifest: replay }),
					list: async () => [{ group_id: GROUP_ID, manifest }],
				},
			});

			let releasePublication: () => void = () => undefined;
			const publicationGate = new Promise<void>((resolve) => {
				releasePublication = resolve;
			});
			let markPublicationStarted: () => void = () => undefined;
			const publicationStarted = new Promise<void>((resolve) => {
				markPublicationStarted = resolve;
			});
			const heldPublication = serializeRecipientPolicyPublicationMutation(target.db, async () => {
				markPublicationStarted();
				await publicationGate;
			});
			await publicationStarted;
			let detailSettled = false;
			const detailRequest = app
				.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`)
				.then((response) => {
					detailSettled = true;
					return response;
				});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(detailSettled).toBe(false);
			releasePublication();
			const response = await detailRequest;
			await heldPublication;
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				candidate: { displayName: "Canonical Team" },
				state: "completed",
			});
		} finally {
			source.close();
			target.close();
		}
	});

	it("does not republish an existing coordinator completion during loading", async () => {
		const store = new MemoryStore(":memory:");
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const draft = await readyDraftThroughSummary(store, setupApp);
			const manifest = deriveLegacyTeamSetupCompletionManifest(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				completedAt: NOW,
			});
			const review = inspectLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
			});
			await finishLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				finishDigest: review.finishDigest,
				confirmedAccessDeltaDigest: review.accessDeltaDigest,
				loadFreshRoster: async () => SNAPSHOTS[0]?.devices ?? [],
				loadProjectInventory: () => [],
				validateLockedPreview: () => true,
				now: NOW,
			});
			const create = vi.fn(async ({ manifest: replay }) => ({
				status: "existing" as const,
				manifest: replay,
			}));
			const list = vi.fn(async () => [{ group_id: GROUP_ID, manifest }]);
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
				snapshotLoaderDependencies: completionConfig(),
				completionDependencies: {
					create,
					list,
				},
			});
			const response = await app.request("/api/sync/team-setup/v1");
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ version: 1, candidates: [] });
			expect(list).toHaveBeenCalledOnce();
			expect(create).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	it("does not block loading when existing-completion publication fails", async () => {
		const store = new MemoryStore(":memory:");
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const draft = await readyDraftThroughSummary(store, setupApp);
			const review = inspectLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
			});
			await finishLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				finishDigest: review.finishDigest,
				confirmedAccessDeltaDigest: review.accessDeltaDigest,
				loadFreshRoster: async () => SNAPSHOTS[0]?.devices ?? [],
				loadProjectInventory: () => [],
				validateLockedPreview: () => true,
				now: NOW,
			});
			let publicationMutationStarted = false;
			let publicationMutation: Promise<void> | undefined;
			let teamMutationStarted = false;
			let teamMutation: Promise<void> | undefined;
			let publicationStartedDuringCreate: boolean | undefined;
			let teamStartedDuringCreate: boolean | undefined;
			const create = vi.fn(async () => {
				publicationMutation = serializeRecipientPolicyPublicationMutation(store.db, async () => {
					publicationMutationStarted = true;
				});
				teamMutation = serializeRecipientPolicyTeamMutation(
					store.db,
					deterministicPolicyTeamId(CANDIDATE_REF),
					async () => {
						teamMutationStarted = true;
					},
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
				publicationStartedDuringCreate = publicationMutationStarted;
				teamStartedDuringCreate = teamMutationStarted;
				throw new Error("coordinator temporarily unavailable");
			});
			const list = vi.fn(async () => []);
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
				snapshotLoaderDependencies: completionConfig(),
				completionDependencies: { create, list },
			});

			const response = await app.request("/api/sync/team-setup/v1");
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ version: 1, candidates: [] });
			expect(create).toHaveBeenCalledOnce();
			expect(publicationStartedDuringCreate).toBe(false);
			expect(teamStartedDuringCreate).toBe(false);
			if (!publicationMutation) throw new Error("publication mutation was not queued");
			if (!teamMutation) throw new Error("Team mutation was not queued");
			await Promise.all([publicationMutation, teamMutation]);
			expect(publicationMutationStarted).toBe(true);
			expect(teamMutationStarted).toBe(true);
			expect(list).toHaveBeenCalledOnce();
			expect(
				store.db
					.prepare("SELECT status, migration_state FROM policy_teams WHERE team_id = ?")
					.get(deterministicPolicyTeamId(CANDIDATE_REF)),
			).toEqual({ status: "active", migration_state: "completed" });
			expect(getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)?.state).toBe("completed");
		} finally {
			store.close();
		}
	});

	it("applies the canonical winner when existing-completion publication conflicts", async () => {
		const source = new MemoryStore(":memory:");
		const target = new MemoryStore(":memory:");
		const sourceApp = teamSetupRoutes({
			getStore: () => source,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		const targetSetupApp = teamSetupRoutes({
			getStore: () => target,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const sourceDraft = await readyDraftThroughSummary(source, sourceApp);
			source.db
				.prepare(
					`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
					 VALUES ('identity-b', 'Person B', 0, 'active', ?, ?)`,
				)
				.run(NOW, NOW);
			source.db
				.prepare(
					"UPDATE legacy_team_setup_draft_devices SET target_identity_id = 'identity-b' WHERE attempt_id = ?",
				)
				.run(sourceDraft.attemptId);
			const canonicalManifest = deriveLegacyTeamSetupCompletionManifest(source.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: sourceDraft.attemptId,
				completedAt: NOW,
			});
			const targetDraft = await readyDraftThroughSummary(target, targetSetupApp);
			const review = inspectLegacyTeamSetupActivation(target.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: targetDraft.attemptId,
			});
			await finishLegacyTeamSetupActivation(target.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: targetDraft.attemptId,
				finishDigest: review.finishDigest,
				confirmedAccessDeltaDigest: review.accessDeltaDigest,
				loadFreshRoster: async () => SNAPSHOTS[0]?.devices ?? [],
				loadProjectInventory: () => [],
				validateLockedPreview: () => true,
				now: NOW,
			});
			target.db
				.prepare(
					`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
					 VALUES ('identity-b', 'Person B', 0, 'active', ?, ?)`,
				)
				.run(NOW, NOW);
			const get = vi.fn(async () => canonicalManifest);
			const app = teamSetupRoutes({
				getStore: () => target,
				loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
				snapshotLoaderDependencies: completionConfig(),
				completionDependencies: {
					create: async () => {
						throw new Error("completion_conflict");
					},
					get,
					list: async () => [],
				},
			});

			const response = await app.request("/api/sync/team-setup/v1");
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ version: 1, candidates: [] });
			expect(get).toHaveBeenCalledWith(
				expect.objectContaining({
					groupId: GROUP_ID,
					candidateRef: CANDIDATE_REF,
					timeoutS: expect.any(Number),
				}),
			);
			expect(
				target.db
					.prepare(
						"SELECT identity_id FROM policy_team_memberships WHERE team_id = ? AND status = 'reviewed_active'",
					)
					.pluck()
					.get(deterministicPolicyTeamId(CANDIDATE_REF)),
			).toBe("identity-b");
		} finally {
			source.close();
			target.close();
		}
	});

	it.each([
		"roster-unavailable",
		"additive-roster-unavailable",
		"group-missing",
		"digest-invalid",
		"binding-mismatch",
		"malformed",
		"partial-roster-unavailable",
	] as const)(
		"handles a divergent local completion when a listed winner is %s",
		async (failureMode) => {
			const source = new MemoryStore(":memory:");
			const target = new MemoryStore(":memory:");
			const sourceApp = teamSetupRoutes({
				getStore: () => source,
				loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
				completionDependencies: null,
			});
			const targetSetupApp = teamSetupRoutes({
				getStore: () => target,
				loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
				completionDependencies: null,
			});
			try {
				if (failureMode === "additive-roster-unavailable") {
					const projectIdentity = "https://example.test/additive-project.git";
					source.db
						.prepare(
							`INSERT INTO replication_scopes(
							 scope_id, label, kind, authority_type, coordinator_id, group_id,
							 membership_epoch, status, created_at, updated_at
							 ) VALUES ('scope-additive', 'Additive', 'team', 'coordinator', ?, ?, 1,
							 'active', ?, ?)`,
						)
						.run(COORDINATOR_ID, GROUP_ID, NOW, NOW);
					const sessionId = Number(
						source.db
							.prepare(
								`INSERT INTO sessions(started_at, project, git_remote)
								 VALUES (?, 'additive-project', ?)`,
							)
							.run(NOW, projectIdentity).lastInsertRowid,
					);
					source.db
						.prepare(
							`INSERT INTO memory_items(
							 session_id, kind, title, body_text, active, created_at, updated_at,
							 visibility, project, scope_id
							 ) VALUES (?, 'discovery', 'Additive Project', 'body', 1, ?, ?, 'shared',
							 'additive-project', 'scope-additive')`,
						)
						.run(sessionId, NOW, NOW);
					source.db
						.prepare(
							`INSERT INTO project_scope_mappings(
							 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
							 ) VALUES (?, ?, 'scope-additive', 1000, 'reviewed_team_setup', ?, ?)`,
						)
						.run(projectIdentity, projectIdentity, NOW, NOW);
				}
				const sourceDraft = await readyDraftThroughSummary(source, sourceApp);
				if (failureMode !== "additive-roster-unavailable") {
					source.db
						.prepare(
							`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
						 VALUES ('identity-b', 'Person B', 0, 'active', ?, ?)`,
						)
						.run(NOW, NOW);
					source.db
						.prepare(
							"UPDATE legacy_team_setup_draft_devices SET target_identity_id = 'identity-b' WHERE attempt_id = ?",
						)
						.run(sourceDraft.attemptId);
				}
				const canonicalManifest = deriveLegacyTeamSetupCompletionManifest(source.db, {
					candidateRef: CANDIDATE_REF,
					attemptId: sourceDraft.attemptId,
					completedAt: NOW,
				});
				const targetDraft = await readyDraftThroughSummary(target, targetSetupApp);
				const review = inspectLegacyTeamSetupActivation(target.db, {
					candidateRef: CANDIDATE_REF,
					attemptId: targetDraft.attemptId,
				});
				await finishLegacyTeamSetupActivation(target.db, {
					candidateRef: CANDIDATE_REF,
					attemptId: targetDraft.attemptId,
					finishDigest: review.finishDigest,
					confirmedAccessDeltaDigest: review.accessDeltaDigest,
					loadFreshRoster: async () => SNAPSHOTS[0]?.devices ?? [],
					loadProjectInventory: () => [],
					validateLockedPreview: () => true,
					now: NOW,
				});
				let unscopedLoadCount = 0;
				const primarySnapshot = SNAPSHOTS[0];
				if (!primarySnapshot) throw new Error("missing primary test snapshot");
				const secondSnapshot = { ...primarySnapshot, groupId: "other-group" };
				const loadSnapshots = vi.fn(async (options?: { candidateRef?: string }) => {
					if (failureMode === "partial-roster-unavailable") {
						if (options?.candidateRef) throw new Error("team_setup_roster_unavailable");
						unscopedLoadCount += 1;
						return unscopedLoadCount === 1 ? [...SNAPSHOTS, secondSnapshot] : [secondSnapshot];
					}
					if (options?.candidateRef && failureMode === "group-missing") return [];
					if (options?.candidateRef) throw new Error("team_setup_roster_unavailable");
					return SNAPSHOTS;
				});
				const listedManifest = (() => {
					if (failureMode === "digest-invalid") {
						return { ...canonicalManifest, finish_digest: "0".repeat(64) };
					}
					if (failureMode === "binding-mismatch") {
						return { ...canonicalManifest, coordinator_id: "other-coordinator" };
					}
					if (failureMode === "malformed") {
						return null as unknown as typeof canonicalManifest;
					}
					return canonicalManifest;
				})();
				const snapshotDependencies = completionConfig();
				if (failureMode === "partial-roster-unavailable") {
					snapshotDependencies.readConfig = () => ({
						...readCoordinatorSyncConfig({}),
						syncCoordinatorUrl: COORDINATOR_ID,
						syncCoordinatorGroups: [GROUP_ID, secondSnapshot.groupId],
						syncCoordinatorAdminSecret: "private-admin-secret",
					});
				}
				const app = teamSetupRoutes({
					getStore: () => target,
					loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
					snapshotLoaderDependencies: snapshotDependencies,
					completionDependencies: {
						create: vi.fn(),
						list: async () => [{ group_id: GROUP_ID, manifest: listedManifest }],
					},
				});

				const response = await app.request("/api/sync/team-setup/v1");

				expect(response.status).toBe(200);
				const shouldContain =
					failureMode !== "additive-roster-unavailable" &&
					failureMode !== "binding-mismatch" &&
					failureMode !== "malformed" &&
					failureMode !== "partial-roster-unavailable";
				const body = await response.json();
				if (shouldContain) {
					expect(body).toMatchObject({
						candidates: [expect.objectContaining({ candidateRef: CANDIDATE_REF })],
					});
				}
				expect(
					target.db
						.prepare("SELECT status, migration_state FROM policy_teams WHERE team_id = ?")
						.get(deterministicPolicyTeamId(CANDIDATE_REF)),
				).toEqual(
					shouldContain
						? { status: "inactive", migration_state: "needs_setup" }
						: { status: "active", migration_state: "completed" },
				);
			} finally {
				source.close();
				target.close();
			}
		},
	);

	it("contains local completion when a fetched winner cannot load a fresh roster", async () => {
		const store = new MemoryStore(":memory:");
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const draft = await readyDraftThroughSummary(store, setupApp);
			const manifest = deriveLegacyTeamSetupCompletionManifest(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				completedAt: NOW,
			});
			const review = inspectLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
			});
			await finishLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				finishDigest: review.finishDigest,
				confirmedAccessDeltaDigest: review.accessDeltaDigest,
				loadFreshRoster: async () => SNAPSHOTS[0]?.devices ?? [],
				loadProjectInventory: () => [],
				validateLockedPreview: () => true,
				now: NOW,
			});
			const loadSnapshots = vi.fn(async (options?: { candidateRef?: string }) => {
				if (options?.candidateRef) throw new Error("team_setup_roster_unavailable");
				return SNAPSHOTS;
			});
			const get = vi.fn(async () => manifest);
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
				snapshotLoaderDependencies: completionConfig(),
				completionDependencies: {
					create: async () => {
						throw new Error("completion_conflict");
					},
					get,
					list: async () => [],
				},
			});

			const detail = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			expect(detail.status).toBe(409);
			expect(await detail.json()).toEqual({ error: "team_setup_completion_conflict" });
			const summary = await app.request("/api/sync/team-setup/v1");
			expect(summary.status).toBe(200);
			expect(await summary.json()).toMatchObject({
				candidates: [expect.objectContaining({ candidateRef: CANDIDATE_REF })],
			});
			expect(get).toHaveBeenCalledOnce();
			expect(
				store.db
					.prepare("SELECT status, migration_state FROM policy_teams WHERE team_id = ?")
					.get(deterministicPolicyTeamId(CANDIDATE_REF)),
			).toEqual({ status: "inactive", migration_state: "needs_setup" });
		} finally {
			store.close();
		}
	});

	it("contains local completion when a publication conflict has no fetchable winner", async () => {
		const store = new MemoryStore(":memory:");
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const draft = await readyDraftThroughSummary(store, setupApp);
			const review = inspectLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
			});
			await finishLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				finishDigest: review.finishDigest,
				confirmedAccessDeltaDigest: review.accessDeltaDigest,
				loadFreshRoster: async () => SNAPSHOTS[0]?.devices ?? [],
				loadProjectInventory: () => [],
				validateLockedPreview: () => true,
				now: NOW,
			});
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
				snapshotLoaderDependencies: completionConfig(),
				completionDependencies: {
					create: async () => {
						throw new Error("completion_conflict");
					},
					get: async () => null,
					list: async () => [],
				},
			});

			const detail = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			expect(detail.status).toBe(409);
			expect(await detail.json()).toEqual({ error: "team_setup_completion_conflict" });
			expect(
				store.db
					.prepare("SELECT finish_digest FROM legacy_team_setup_drafts WHERE attempt_id = ?")
					.pluck()
					.get(draft.attemptId),
			).toBeNull();
			const summary = await app.request("/api/sync/team-setup/v1");
			expect(summary.status).toBe(200);
			expect(await summary.json()).toMatchObject({
				candidates: [expect.objectContaining({ candidateRef: CANDIDATE_REF })],
			});
			expect(
				store.db
					.prepare("SELECT status, migration_state FROM policy_teams WHERE team_id = ?")
					.get(deterministicPolicyTeamId(CANDIDATE_REF)),
			).toEqual({ status: "inactive", migration_state: "needs_setup" });
		} finally {
			store.close();
		}
	});

	it("does not publish a persisted completion to a newly configured coordinator", async () => {
		const store = new MemoryStore(":memory:");
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const draft = await readyDraftThroughSummary(store, setupApp);
			const review = inspectLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
			});
			await finishLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				finishDigest: review.finishDigest,
				confirmedAccessDeltaDigest: review.accessDeltaDigest,
				loadFreshRoster: async () => SNAPSHOTS[0]?.devices ?? [],
				loadProjectInventory: () => [],
				validateLockedPreview: () => true,
				now: NOW,
			});
			const create = vi.fn();
			const list = vi.fn(async () => []);
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: async () => [],
				snapshotLoaderDependencies: {
					...completionConfig(),
					readConfig: () => ({
						...readCoordinatorSyncConfig({}),
						syncCoordinatorUrl: "https://other-coordinator.example.test",
						syncCoordinatorGroups: [GROUP_ID],
						syncCoordinatorAdminSecret: "other-private-admin-secret",
					}),
				},
				completionDependencies: { create, list },
			});

			const response = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ state: "completed" });
			expect(list).not.toHaveBeenCalled();
			expect(create).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	it("does not publish a persisted completion for a group removed from configuration", async () => {
		const store = new MemoryStore(":memory:");
		let configuredGroups = [GROUP_ID];
		const create = vi.fn();
		const list = vi.fn(async () => []);
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			snapshotLoaderDependencies: {
				...completionConfig(),
				readConfig: () => ({
					...readCoordinatorSyncConfig({}),
					syncCoordinatorUrl: COORDINATOR_ID,
					syncCoordinatorGroups: configuredGroups,
					syncCoordinatorAdminSecret: "private-admin-secret",
				}),
			},
			completionDependencies: { create, list },
		});
		try {
			const draft = await readyDraftThroughSummary(store, app);
			const review = inspectLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
			});
			await finishLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				finishDigest: review.finishDigest,
				confirmedAccessDeltaDigest: review.accessDeltaDigest,
				loadFreshRoster: async () => SNAPSHOTS[0]?.devices ?? [],
				loadProjectInventory: () => [],
				validateLockedPreview: () => true,
				now: NOW,
			});
			configuredGroups = [];
			create.mockClear();
			list.mockClear();

			const response = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ state: "completed" });
			expect(list).not.toHaveBeenCalled();
			expect(create).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	it("does not publish finish data when the coordinator changes after roster loading", async () => {
		const store = new MemoryStore(":memory:");
		let changedConfig = false;
		let changeAfterNextSnapshot = false;
		const create = vi.fn();
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => {
				if (changeAfterNextSnapshot) changedConfig = true;
				return SNAPSHOTS;
			},
			snapshotLoaderDependencies: {
				...completionConfig(),
				readConfig: () => ({
					...readCoordinatorSyncConfig({}),
					syncCoordinatorUrl: changedConfig
						? "https://other-coordinator.example.test"
						: COORDINATOR_ID,
					syncCoordinatorGroups: [GROUP_ID],
					syncCoordinatorAdminSecret: "private-admin-secret",
				}),
			},
			completionDependencies: { create, list: async () => [] },
		});
		try {
			const draft = await readyDraftThroughSummary(store, app);
			const detail = (await (
				await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`)
			).json()) as {
				finishDigest: string;
				accessDeltaDigest: string;
				viewerAccessDeltaDigest: string;
			};
			changeAfterNextSnapshot = true;

			const response = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					attemptId: draft.attemptId,
					finishDigest: detail.finishDigest,
					confirmedAccessDeltaDigest: detail.accessDeltaDigest,
					confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
				}),
			});

			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "team_setup_completion_invalid" });
			expect(create).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	it("does not publish finish data when its group is removed during roster loading", async () => {
		const store = new MemoryStore(":memory:");
		let configuredGroups = [GROUP_ID];
		let removeAfterNextSnapshot = false;
		const create = vi.fn();
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => {
				if (removeAfterNextSnapshot) configuredGroups = [];
				return SNAPSHOTS;
			},
			snapshotLoaderDependencies: {
				...completionConfig(),
				readConfig: () => ({
					...readCoordinatorSyncConfig({}),
					syncCoordinatorUrl: COORDINATOR_ID,
					syncCoordinatorGroups: configuredGroups,
					syncCoordinatorAdminSecret: "private-admin-secret",
				}),
			},
			completionDependencies: { create, list: async () => [] },
		});
		try {
			const draft = await readyDraftThroughSummary(store, app);
			const detail = (await (
				await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`)
			).json()) as {
				finishDigest: string;
				accessDeltaDigest: string;
				viewerAccessDeltaDigest: string;
			};
			removeAfterNextSnapshot = true;

			const response = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					attemptId: draft.attemptId,
					finishDigest: detail.finishDigest,
					confirmedAccessDeltaDigest: detail.accessDeltaDigest,
					confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
				}),
			});

			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "team_setup_completion_invalid" });
			expect(create).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	it("locks an excluded device's existing identity through completion publication", async () => {
		const store = new MemoryStore(":memory:");
		let releaseCreate: () => void = () => undefined;
		const createGate = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		let markCreateStarted: () => void = () => undefined;
		const createStarted = new Promise<void>((resolve) => {
			markCreateStarted = resolve;
		});
		let existingActorMutationStarted = false;
		let existingActorMutation: Promise<void> | undefined;
		const create = vi.fn(async ({ manifest }) => {
			// The reviewed device belongs to identity-existing and is excluded; a
			// merge or deactivation of that identity must wait for publication.
			existingActorMutation = serializeRecipientPolicyActorMutations(
				store.db,
				["identity-existing"],
				async () => {
					existingActorMutationStarted = true;
				},
			);
			markCreateStarted();
			await createGate;
			return { status: "created" as const, manifest };
		});
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			snapshotLoaderDependencies: completionConfig(),
			completionDependencies: { create, list: async () => [] },
		});
		try {
			store.db
				.prepare(
					`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
					 VALUES ('identity-existing', 'Existing Person', 0, 'active', ?, ?)`,
				)
				.run(NOW, NOW);
			store.db
				.prepare(
					`INSERT INTO identity_devices(
					 device_id, identity_id, display_name, status, provenance, revision, migration_state,
					 assignment_version, idempotency_key, created_at, updated_at
					 ) VALUES ('device-a', 'identity-existing', 'Laptop', 'active', 'invitation', 'r1',
					 'completed', 0, 'existing-a', ?, ?)`,
				)
				.run(NOW, NOW);
			expect((await app.request("/api/sync/team-setup/v1")).status).toBe(200);
			let draft = getLegacyTeamSetupDraft(store.db, CANDIDATE_REF);
			if (!draft) throw new Error("Team setup draft missing");
			const device = draft.devices[0];
			if (!device) throw new Error("Team setup device missing");
			expect(device.existingIdentityId).toBe("identity-existing");
			draft = setLegacyTeamSetupDeviceDecision(store.db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				decision: "excluded",
				now: NOW,
			});
			const detail = (await (
				await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`)
			).json()) as {
				finishDigest: string;
				accessDeltaDigest: string;
				viewerAccessDeltaDigest: string;
			};
			const finishRequest = app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					attemptId: draft.attemptId,
					finishDigest: detail.finishDigest,
					confirmedAccessDeltaDigest: detail.accessDeltaDigest,
					confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
				}),
			});
			await createStarted;
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(existingActorMutationStarted).toBe(false);
			releaseCreate();
			const response = await finishRequest;
			expect(response.status).toBe(200);
			if (!existingActorMutation) throw new Error("actor mutation was not queued");
			await existingActorMutation;
			expect(existingActorMutationStarted).toBe(true);
		} finally {
			store.close();
		}
	});

	it("serializes a draft mutation behind completion publication", async () => {
		const store = new MemoryStore(":memory:");
		let groupMutationStarted = false;
		let groupMutation: Promise<void> | undefined;
		let policyMutationStarted = false;
		let policyMutation: Promise<void> | undefined;
		let actorMutationStarted = false;
		let actorMutation: Promise<void> | undefined;
		let publicationMutationStarted = false;
		let publicationMutation: Promise<void> | undefined;
		let releaseCreate: () => void = () => undefined;
		const createGate = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		let markCreateStarted: () => void = () => undefined;
		const createStarted = new Promise<void>((resolve) => {
			markCreateStarted = resolve;
		});
		let listedManifest: ReturnType<typeof deriveLegacyTeamSetupCompletionManifest> | null = null;
		let listInvalidDigest = false;
		const create = vi.fn(async ({ manifest }) => {
			listedManifest = manifest;
			groupMutation = serializeRecipientPolicyCoordinatorGroupMutation(
				store.db,
				GROUP_ID,
				async () => {
					groupMutationStarted = true;
				},
			);
			policyMutation = serializeRecipientPolicyTeamMutation(
				store.db,
				deterministicPolicyTeamId(CANDIDATE_REF),
				async () => {
					policyMutationStarted = true;
				},
			);
			const includedActorId = getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)?.devices.find(
				(device) => device.decision === "included",
			)?.targetIdentityId;
			if (!includedActorId) throw new Error("included actor was not assigned");
			actorMutation = serializeRecipientPolicyActorMutations(
				store.db,
				[includedActorId],
				async () => {
					actorMutationStarted = true;
				},
			);
			publicationMutation = serializeRecipientPolicyPublicationMutation(store.db, async () => {
				publicationMutationStarted = true;
			});
			markCreateStarted();
			await createGate;
			return { status: "created" as const, manifest };
		});
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			snapshotLoaderDependencies: completionConfig(),
			completionDependencies: {
				create,
				list: async () => {
					if (!listedManifest) return [];
					return [
						{
							group_id: GROUP_ID,
							manifest: listInvalidDigest
								? { ...listedManifest, finish_digest: "0".repeat(64) }
								: listedManifest,
						},
					];
				},
			},
		});
		try {
			const draft = await readyDraftThroughSummary(store, app);
			const deviceRef = draft.devices[0]?.deviceRef ?? "";
			const detail = (await (
				await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`)
			).json()) as {
				finishDigest: string;
				accessDeltaDigest: string;
				viewerAccessDeltaDigest: string;
			};

			const finishRequest = app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					attemptId: draft.attemptId,
					finishDigest: detail.finishDigest,
					confirmedAccessDeltaDigest: detail.accessDeltaDigest,
					confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
				}),
			});
			await createStarted;
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(groupMutationStarted).toBe(false);
			expect(policyMutationStarted).toBe(false);
			expect(actorMutationStarted).toBe(false);
			expect(publicationMutationStarted).toBe(false);
			const summaryResponse = await app.request("/api/sync/team-setup/v1");
			expect(summaryResponse.status).toBe(200);
			expect(store.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
			listInvalidDigest = true;
			const detailConflict = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			expect(detailConflict.status).toBe(409);
			listInvalidDigest = false;
			const mutationResponse = await app.request(
				`/api/sync/team-setup/v1/${CANDIDATE_REF}/devices/${deviceRef}/decision`,
				{
					method: "DELETE",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ attemptId: draft.attemptId }),
				},
			);
			expect(mutationResponse.status).toBe(409);
			releaseCreate();

			const response = await finishRequest;
			expect(response.status).toBe(200);
			if (!groupMutation) throw new Error("group mutation was not queued");
			if (!policyMutation) throw new Error("policy mutation was not queued");
			if (!actorMutation) throw new Error("actor mutation was not queued");
			if (!publicationMutation) throw new Error("publication mutation was not queued");
			await Promise.all([groupMutation, policyMutation, actorMutation, publicationMutation]);
			expect(groupMutationStarted).toBe(true);
			expect(policyMutationStarted).toBe(true);
			expect(actorMutationStarted).toBe(true);
			expect(publicationMutationStarted).toBe(true);
			expect(create).toHaveBeenCalledOnce();
			expect(getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)?.devices[0]?.decision).toBe(
				"included",
			);
			expect(store.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(1);
		} finally {
			store.close();
		}
	});

	it("keeps summary and detail reads available when an older coordinator lacks completion queries", async () => {
		const store = new MemoryStore(":memory:");
		const list = vi.fn(async () => {
			throw new Error("Remote coordinator request failed (404): HTTP 404");
		});
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			snapshotLoaderDependencies: completionConfig(),
			completionDependencies: { create: vi.fn(), list },
		});
		try {
			const summary = await app.request("/api/sync/team-setup/v1");
			expect(summary.status).toBe(200);
			const detail = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			expect(detail.status).toBe(200);
			expect(list).toHaveBeenCalledTimes(2);
		} finally {
			store.close();
		}
	});

	it("reconciles an existing draft without a cold-cache roster read", async () => {
		const store = new MemoryStore(":memory:");
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			expect((await setupApp.request("/api/sync/team-setup/v1")).status).toBe(200);
			const loadSnapshots = vi.fn(async () => {
				throw new Error("team_setup_roster_unavailable");
			});
			const list = vi.fn(async () => []);
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
				snapshotLoaderDependencies: completionConfig(),
				completionDependencies: { create: vi.fn(), list },
			});

			const detail = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			expect(detail.status).toBe(200);
			expect(loadSnapshots).not.toHaveBeenCalled();
			expect(list).toHaveBeenCalledOnce();
		} finally {
			store.close();
		}
	});

	it("ignores completion records for other candidate identities of the same group", async () => {
		const store = new MemoryStore(":memory:");
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const draft = await readyDraftThroughSummary(store, setupApp);
			const manifest = deriveLegacyTeamSetupCompletionManifest(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				completedAt: NOW,
			});
			// The coordinator lists every candidate the group ever completed,
			// including one recorded under an earlier coordinator address.
			const historicalRecord = {
				group_id: GROUP_ID,
				manifest: {
					...manifest,
					candidate_ref: legacyTeamCandidateId("https://old.coordinator.example.test", GROUP_ID),
				},
			};
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
				snapshotLoaderDependencies: completionConfig(),
				completionDependencies: {
					create: vi.fn(),
					list: vi.fn(async () => [historicalRecord, { group_id: GROUP_ID, manifest }]),
				},
			});

			const detail = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			expect(detail.status).toBe(404);
			expect(await detail.json()).toEqual({ error: "team_setup_confirmation_stale" });
			expect(getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)?.state).toBe("completed");
		} finally {
			store.close();
		}
	});

	it("loads the fresh roster for an equivalently spelled persisted coordinator", async () => {
		const store = new MemoryStore(":memory:");
		const spelledCoordinatorId = "HTTPS://COORDINATOR.EXAMPLE.TEST";
		const spelledCandidateRef = legacyTeamCandidateId(spelledCoordinatorId, GROUP_ID);
		const spelledSnapshots = SNAPSHOTS.map((snapshot) => ({
			...snapshot,
			coordinatorId: spelledCoordinatorId,
		}));
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => spelledSnapshots,
			completionDependencies: null,
		});
		try {
			expect((await setupApp.request("/api/sync/team-setup/v1")).status).toBe(200);
			store.db
				.prepare(
					`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
					 VALUES ('identity-a', 'Person A', 0, 'active', ?, ?)`,
				)
				.run(NOW, NOW);
			let draft = getLegacyTeamSetupDraft(store.db, spelledCandidateRef);
			if (!draft) throw new Error("Team setup draft missing");
			const device = draft.devices[0];
			if (!device) throw new Error("Team setup device missing");
			draft = setLegacyTeamSetupDeviceAssignment(store.db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				targetIdentityId: "identity-a",
				expectation: device.expectation,
				now: NOW,
			});
			draft = setLegacyTeamSetupDeviceDecision(store.db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				decision: "included",
				now: NOW,
			});
			const manifest = deriveLegacyTeamSetupCompletionManifest(store.db, {
				candidateRef: spelledCandidateRef,
				attemptId: draft.attemptId,
				completedAt: NOW,
			});
			// Configuration now uses the canonical spelling; the production loader
			// keys its snapshots by that spelling, not the persisted one.
			const loadSnapshots = vi.fn(async (input?: { candidateRef?: string }) =>
				input?.candidateRef && input.candidateRef !== CANDIDATE_REF ? [] : SNAPSHOTS,
			);
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
				snapshotLoaderDependencies: completionConfig(),
				completionDependencies: {
					create: vi.fn(),
					list: vi.fn(async () => [{ group_id: GROUP_ID, manifest }]),
				},
			});

			await app.request(`/api/sync/team-setup/v1/${spelledCandidateRef}`);
			expect(getLegacyTeamSetupDraft(store.db, spelledCandidateRef)?.state).toBe("completed");
			expect(
				store.db
					.prepare("SELECT status FROM policy_teams WHERE team_id = ?")
					.pluck()
					.get(manifest.team_id),
			).toBe("active");
		} finally {
			store.close();
		}
	});

	it("does not apply a completion after coordinator authorization changes mid-flight", async () => {
		const store = new MemoryStore(":memory:");
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const draft = await readyDraftThroughSummary(store, setupApp);
			const manifest = deriveLegacyTeamSetupCompletionManifest(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				completedAt: NOW,
			});
			// The user removes the group while the completion list is in flight.
			let configuredGroups = [GROUP_ID];
			const config = completionConfig();
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
				snapshotLoaderDependencies: {
					...config,
					readConfig: () => ({ ...config.readConfig(), syncCoordinatorGroups: configuredGroups }),
				},
				completionDependencies: {
					create: vi.fn(),
					list: vi.fn(async () => {
						configuredGroups = [];
						return [{ group_id: GROUP_ID, manifest }];
					}),
				},
			});

			await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			expect(getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)?.state).not.toBe("completed");
			expect(store.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		} finally {
			store.close();
		}
	});

	it("discovers scope-backed groups without authorizing completion reconciliation", async () => {
		const store = new MemoryStore(":memory:");
		const scopeBackedGroupId = "group-beta";
		const scopeBackedCandidateRef = legacyTeamCandidateId(COORDINATOR_ID, scopeBackedGroupId);
		const scopeBackedSnapshot: LegacyTeamConfiguredGroupSnapshot = {
			...SNAPSHOTS[0],
			groupId: scopeBackedGroupId,
			displayName: "Scope-backed Team",
			devices: [
				{
					deviceId: "device-beta",
					fingerprint: FINGERPRINT_B,
					displayName: "Beta laptop",
					enabled: true,
				},
			],
		};
		store.db
			.prepare(
				`INSERT INTO replication_scopes(
				 scope_id, label, kind, authority_type, coordinator_id, group_id,
				 membership_epoch, status, created_at, updated_at
				 ) VALUES ('scope-beta', 'Beta', 'team', 'coordinator', ?, ?, 1, 'active', ?, ?)`,
			)
			.run(COORDINATOR_ID, scopeBackedGroupId, NOW, NOW);
		const list = vi.fn(async () => []);
		const create = vi.fn();
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => [...SNAPSHOTS, scopeBackedSnapshot],
			snapshotLoaderDependencies: completionConfig(),
			completionDependencies: { create, list },
		});
		try {
			const response = await app.request("/api/sync/team-setup/v1");

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				candidates: expect.arrayContaining([
					expect.objectContaining({ candidateRef: CANDIDATE_REF }),
					expect.objectContaining({ candidateRef: scopeBackedCandidateRef }),
				]),
			});
			expect(list).toHaveBeenCalledWith(expect.objectContaining({ groupIds: [GROUP_ID] }));
			expect(create).not.toHaveBeenCalled();
			expect(
				store.db
					.prepare("SELECT COUNT(*) FROM policy_teams WHERE team_id = ?")
					.pluck()
					.get(deterministicPolicyTeamId(scopeBackedCandidateRef)),
			).toBe(0);
		} finally {
			store.close();
		}
	});

	it("rejects finish publication for a scope-backed group absent from configuration", async () => {
		const store = new MemoryStore(":memory:");
		const scopeBackedGroupId = "group-beta";
		const scopeBackedCandidateRef = legacyTeamCandidateId(COORDINATOR_ID, scopeBackedGroupId);
		const snapshot = SNAPSHOTS[0];
		if (!snapshot) throw new Error("missing test snapshot");
		const scopeBackedSnapshot = {
			...snapshot,
			groupId: scopeBackedGroupId,
			displayName: "Scope-backed Team",
		};
		store.db
			.prepare(
				`INSERT INTO replication_scopes(
				 scope_id, label, kind, authority_type, coordinator_id, group_id,
				 membership_epoch, status, created_at, updated_at
				 ) VALUES ('scope-beta', 'Beta', 'team', 'coordinator', ?, ?, 1, 'active', ?, ?)`,
			)
			.run(COORDINATOR_ID, scopeBackedGroupId, NOW, NOW);
		const create = vi.fn();
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => [scopeBackedSnapshot],
			snapshotLoaderDependencies: completionConfig(),
			completionDependencies: { create, list: async () => [] },
		});
		try {
			const draft = await readyDraftThroughSummary(store, app, scopeBackedCandidateRef);
			const detail = (await (
				await app.request(`/api/sync/team-setup/v1/${scopeBackedCandidateRef}`)
			).json()) as {
				finishDigest: string;
				accessDeltaDigest: string;
				viewerAccessDeltaDigest: string;
			};
			const response = await app.request(
				`/api/sync/team-setup/v1/${scopeBackedCandidateRef}/finish`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						attemptId: draft.attemptId,
						finishDigest: detail.finishDigest,
						confirmedAccessDeltaDigest: detail.accessDeltaDigest,
						confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
					}),
				},
			);

			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "team_setup_completion_invalid" });
			expect(create).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	it("does not apply a completion when authorization is revoked while the Team lock is held", async () => {
		const store = new MemoryStore(":memory:");
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const draft = await readyDraftThroughSummary(store, setupApp);
			const manifest = deriveLegacyTeamSetupCompletionManifest(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				completedAt: NOW,
			});
			let configuredGroups = [GROUP_ID];
			const config = completionConfig();
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
				snapshotLoaderDependencies: {
					...config,
					readConfig: () => ({ ...config.readConfig(), syncCoordinatorGroups: configuredGroups }),
				},
				completionDependencies: {
					create: vi.fn(),
					list: vi.fn(async () => [{ group_id: GROUP_ID, manifest }]),
				},
			});
			// Another policy mutation holds the Team lock while reconciliation
			// waits; the user removes the group before that lock is released.
			let releaseTeamLock = () => undefined;
			const teamLockPending = new Promise<void>((resolve) => {
				releaseTeamLock = resolve;
			});
			let teamLockHeld = false;
			const teamMutation = serializeRecipientPolicyTeamMutation(
				store.db,
				manifest.team_id,
				async () => {
					teamLockHeld = true;
					await teamLockPending;
				},
			);
			await vi.waitFor(() => expect(teamLockHeld).toBe(true));
			const detail = app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(store.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
			configuredGroups = [];
			releaseTeamLock();
			await teamMutation;
			await detail;

			expect(getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)?.state).not.toBe("completed");
			expect(store.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		} finally {
			store.close();
		}
	});

	it("does not republish a local completion after authorization is revoked under the lock", async () => {
		const store = new MemoryStore(":memory:");
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const draft = await readyDraftThroughSummary(store, setupApp);
			const review = inspectLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
			});
			await finishLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				finishDigest: review.finishDigest,
				confirmedAccessDeltaDigest: review.accessDeltaDigest,
				loadFreshRoster: async () => SNAPSHOTS[0]?.devices ?? [],
				loadProjectInventory: () => [],
				validateLockedPreview: () => true,
				now: NOW,
			});
			let configuredGroups = [GROUP_ID];
			const config = completionConfig();
			const create = vi.fn(async ({ manifest }) => ({ status: "created" as const, manifest }));
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
				snapshotLoaderDependencies: {
					...config,
					readConfig: () => ({ ...config.readConfig(), syncCoordinatorGroups: configuredGroups }),
				},
				completionDependencies: { create, list: vi.fn(async () => []) },
			});
			const teamId = deterministicPolicyTeamId(CANDIDATE_REF);
			let releaseTeamLock = () => undefined;
			const teamLockPending = new Promise<void>((resolve) => {
				releaseTeamLock = resolve;
			});
			let teamLockHeld = false;
			const teamMutation = serializeRecipientPolicyTeamMutation(store.db, teamId, async () => {
				teamLockHeld = true;
				await teamLockPending;
			});
			await vi.waitFor(() => expect(teamLockHeld).toBe(true));
			const summary = app.request("/api/sync/team-setup/v1");
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(create).not.toHaveBeenCalled();
			configuredGroups = [];
			releaseTeamLock();
			await teamMutation;
			expect((await summary).status).toBe(200);

			expect(create).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	it("returns the committed result to an identical finish that overlapped the commit", async () => {
		const store = new MemoryStore(":memory:");
		let releaseCreate = () => undefined;
		const createPending = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		let createStarted = () => undefined;
		const createStartedPromise = new Promise<void>((resolve) => {
			createStarted = resolve;
		});
		const create = vi.fn(async ({ manifest }) => {
			createStarted();
			await createPending;
			return { status: "created" as const, manifest };
		});
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			snapshotLoaderDependencies: completionConfig(),
			completionDependencies: { create, list: async () => [] },
		});
		try {
			const draft = await readyDraftThroughSummary(store, app);
			const detail = (await (
				await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`)
			).json()) as {
				finishDigest: string;
				accessDeltaDigest: string;
				viewerAccessDeltaDigest: string;
			};
			const finishRequest = {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					attemptId: draft.attemptId,
					finishDigest: detail.finishDigest,
					confirmedAccessDeltaDigest: detail.accessDeltaDigest,
					confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
				}),
			};
			const first = app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`, finishRequest);
			await createStartedPromise;
			// The retry arrives while the first request is publishing.
			const retry = app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}/finish`, finishRequest);
			await new Promise((resolve) => setTimeout(resolve, 10));
			releaseCreate();

			const [firstResponse, retryResponse] = await Promise.all([first, retry]);
			expect(firstResponse.status).toBe(200);
			expect(retryResponse.status).toBe(200);
			expect(await retryResponse.json()).toEqual(await firstResponse.json());
			expect(create).toHaveBeenCalledOnce();
		} finally {
			store.close();
		}
	});

	it("applies a canonical completion during a cold-cache detail read", async () => {
		const store = new MemoryStore(":memory:");
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const draft = await readyDraftThroughSummary(store, setupApp);
			const manifest = deriveLegacyTeamSetupCompletionManifest(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				completedAt: NOW,
			});
			const loadSnapshots = vi.fn(async () => SNAPSHOTS);
			const list = vi.fn(async () => [{ group_id: GROUP_ID, manifest }]);
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
				snapshotLoaderDependencies: completionConfig(),
				completionDependencies: { create: vi.fn(), list },
			});

			const detail = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			expect(detail.status).toBe(404);
			expect(await detail.json()).toEqual({ error: "team_setup_confirmation_stale" });
			expect(loadSnapshots).toHaveBeenCalledOnce();
			expect(loadSnapshots).toHaveBeenCalledWith(
				expect.objectContaining({
					candidateRef: CANDIDATE_REF,
					deadlineMs: expect.any(Number),
				}),
			);
			expect(list).toHaveBeenCalledOnce();
			expect(getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)?.state).toBe("completed");
		} finally {
			store.close();
		}
	});

	it("rejects a canonical completion after an included device is re-keyed", async () => {
		const store = new MemoryStore(":memory:");
		const setupApp = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const draft = await readyDraftThroughSummary(store, setupApp);
			const manifest = deriveLegacyTeamSetupCompletionManifest(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: draft.attemptId,
				completedAt: NOW,
			});
			const originalSnapshot = SNAPSHOTS[0];
			const originalDevice = originalSnapshot?.devices[0];
			if (!originalSnapshot || !originalDevice) throw new Error("Team setup snapshot missing");
			const rekeyedSnapshots: LegacyTeamConfiguredGroupSnapshot[] = [
				{
					...originalSnapshot,
					devices: [{ ...originalDevice, fingerprint: FINGERPRINT_B }],
				},
			];
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: async () => rekeyedSnapshots,
				snapshotLoaderDependencies: completionConfig(),
				completionDependencies: {
					create: vi.fn(),
					list: vi.fn(async () => [{ group_id: GROUP_ID, manifest }]),
				},
			});

			const detail = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			expect(detail.status).toBe(409);
			expect(await detail.json()).toEqual({ error: "team_setup_completion_invalid" });
			expect(store.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
			expect(
				store.db
					.prepare(
						"SELECT key_fingerprint FROM legacy_team_setup_draft_devices WHERE attempt_id = ?",
					)
					.pluck()
					.get(draft.attemptId),
			).toBe(FINGERPRINT_A);
		} finally {
			store.close();
		}
	});

	it("retries transient completion reads with the configured timeout", async () => {
		const store = new MemoryStore(":memory:");
		const list = vi
			.fn()
			.mockRejectedValueOnce(new Error("Remote coordinator request failed (503): unavailable"))
			.mockResolvedValue([]);
		const config = completionConfig(17);
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			snapshotLoaderDependencies: config,
			readCoordinatorConfig: config.readConfig,
			completionDependencies: { create: vi.fn(), list },
		});
		try {
			expect((await app.request("/api/sync/team-setup/v1")).status).toBe(200);
			expect(list).toHaveBeenCalledTimes(2);
			expect(list).toHaveBeenCalledWith(expect.objectContaining({ timeoutS: 17 }));
		} finally {
			store.close();
		}
	});

	it("revalidates pre-marker completions in detail and summary reads", async () => {
		const store = new MemoryStore(":memory:");
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			expect((await app.request("/api/sync/team-setup/v1")).status).toBe(200);
			const first = getLegacyTeamSetupDraft(store.db, CANDIDATE_REF);
			if (!first) throw new Error("initial Team setup draft missing");
			const teamId = insertTeam(store, first, {
				status: "active",
				provenance: "legacy_team_candidate",
				sourceFingerprint: "drifted-roster",
			});
			completeDraft(store, first, teamId);

			const detail = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			expect(detail.status).toBe(200);
			expect(await detail.json()).toMatchObject({
				candidate: { candidateRef: CANDIDATE_REF, status: "needs_setup" },
				state: "reviewing",
			});
			const second = getLegacyTeamSetupDraft(store.db, CANDIDATE_REF);
			expect(second?.attemptId).not.toBe(first.attemptId);

			if (!second) throw new Error("replacement Team setup draft missing");
			completeDraft(store, second, teamId);
			const summary = await app.request("/api/sync/team-setup/v1");
			expect(summary.status).toBe(200);
			expect(await summary.json()).toMatchObject({
				version: 1,
				candidates: [
					expect.objectContaining({ candidateRef: CANDIDATE_REF, status: "needs_setup" }),
				],
			});
			expect(getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)?.attemptId).not.toBe(
				second.attemptId,
			);
		} finally {
			store.close();
		}
	});

	it("preserves a pre-marker completion when fresh detail evidence is unavailable", async () => {
		const store = new MemoryStore(":memory:");
		const loadSnapshots = vi.fn(async (options?: { candidateRef?: string }) => {
			if (options?.candidateRef) throw new Error("team_setup_roster_unavailable");
			return SNAPSHOTS;
		});
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
			completionDependencies: null,
		});
		try {
			expect((await app.request("/api/sync/team-setup/v1")).status).toBe(200);
			const draft = getLegacyTeamSetupDraft(store.db, CANDIDATE_REF);
			if (!draft) throw new Error("initial Team setup draft missing");
			completeDraft(store, draft, null);

			const detail = await app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
			expect(detail.status).toBe(503);
			expect(await detail.json()).toEqual({ error: "team_setup_roster_unavailable" });
			expect(getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)).toMatchObject({
				attemptId: draft.attemptId,
				state: "completed",
			});
			expect((await app.request("/api/sync/team-setup/v1")).status).toBe(200);
			expect(loadSnapshots).toHaveBeenCalledTimes(2);
		} finally {
			store.close();
		}
	});

	it.each([
		["serves the completed draft", true, 200],
		["rejects the superseded draft", false, 404],
	] as const)(
		"rechecks a migration marker after detail roster loading and %s",
		async (_label, remainsCompleted, expectedStatus) => {
			const store = new MemoryStore(":memory:");
			let resolveCandidateLoad!: () => void;
			const loadSnapshots = vi.fn((options?: { candidateRef?: string }) =>
				options?.candidateRef
					? new Promise<LegacyTeamConfiguredGroupSnapshot[]>((resolve) => {
							resolveCandidateLoad = () => resolve(SNAPSHOTS);
						})
					: Promise.resolve(SNAPSHOTS),
			);
			const app = teamSetupRoutes({
				getStore: () => store,
				loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
				completionDependencies: null,
			});
			try {
				expect((await app.request("/api/sync/team-setup/v1")).status).toBe(200);
				const draft = getLegacyTeamSetupDraft(store.db, CANDIDATE_REF);
				if (!draft) throw new Error("initial Team setup draft missing");
				completeDraft(store, draft, null);
				const detailPromise = app.request(`/api/sync/team-setup/v1/${CANDIDATE_REF}`);
				await vi.waitFor(() => expect(loadSnapshots).toHaveBeenCalledTimes(2));
				const teamId = insertTeam(store, draft, {
					status: "active",
					provenance: "reviewed_team_candidate",
				});
				if (remainsCompleted) {
					store.db
						.prepare(
							`UPDATE legacy_team_setup_drafts SET completed_team_id = ?
							 WHERE attempt_id = ?`,
						)
						.run(teamId, draft.attemptId);
				} else {
					store.db
						.prepare(
							`UPDATE legacy_team_setup_drafts
							 SET state = 'needs_setup', completed_at = NULL WHERE attempt_id = ?`,
						)
						.run(draft.attemptId);
				}
				resolveCandidateLoad();

				const detail = await detailPromise;
				expect(detail.status).toBe(expectedStatus);
				if (remainsCompleted) {
					expect(await detail.json()).toMatchObject({
						candidate: { candidateRef: CANDIDATE_REF, status: "ready" },
						state: "completed",
					});
				} else {
					expect(await detail.json()).toEqual({ error: "team_setup_confirmation_stale" });
				}
			} finally {
				store.close();
			}
		},
	);

	it("does not treat an inactive migration marker as terminal", async () => {
		const store = new MemoryStore(":memory:");
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			expect((await app.request("/api/sync/team-setup/v1")).status).toBe(200);
			const draft = getLegacyTeamSetupDraft(store.db, CANDIDATE_REF);
			if (!draft) throw new Error("initial Team setup draft missing");
			const teamId = insertTeam(store, draft, {
				status: "inactive",
				provenance: "reviewed_team_candidate",
			});
			completeDraft(store, draft, teamId);

			const summary = await app.request("/api/sync/team-setup/v1");
			expect(summary.status).toBe(200);
			expect(await summary.json()).toMatchObject({
				candidates: [
					expect.objectContaining({ candidateRef: CANDIDATE_REF, status: "needs_setup" }),
				],
			});
			expect(getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)?.attemptId).not.toBe(draft.attemptId);
		} finally {
			store.close();
		}
	});

	it("does not churn a draft when a migration marker lacks a canonical completion", async () => {
		const store = new MemoryStore(":memory:");
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			expect((await app.request("/api/sync/team-setup/v1")).status).toBe(200);
			const draft = getLegacyTeamSetupDraft(store.db, CANDIDATE_REF);
			if (!draft) throw new Error("initial Team setup draft missing");
			insertTeam(store, draft, {
				status: "active",
				provenance: "reviewed_team_candidate",
			});
			const attemptCount = store.db
				.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts WHERE candidate_id = ?")
				.pluck()
				.get(CANDIDATE_REF);

			const summary = await app.request("/api/sync/team-setup/v1");
			expect(summary.status).toBe(200);
			expect(await summary.json()).toEqual({ version: 1, candidates: [] });
			expect(getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)?.attemptId).toBe(draft.attemptId);
			expect(
				store.db
					.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts WHERE candidate_id = ?")
					.pluck()
					.get(CANDIDATE_REF),
			).toBe(attemptCount);
		} finally {
			store.close();
		}
	});

	it("keeps a newer attempt stable when a terminal migration marker exists", async () => {
		const store = new MemoryStore(":memory:");
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
			completionDependencies: null,
		});
		try {
			const projectIdentity = "https://example.test/terminal-project.git";
			store.db
				.prepare(
					`INSERT INTO replication_scopes(
					 scope_id, label, kind, authority_type, coordinator_id, group_id,
					 membership_epoch, status, created_at, updated_at
					 ) VALUES ('scope-terminal', 'Terminal', 'team', 'coordinator', ?, ?, 1,
					 'active', ?, ?)`,
				)
				.run(COORDINATOR_ID, GROUP_ID, NOW, NOW);
			const sessionId = Number(
				store.db
					.prepare(
						`INSERT INTO sessions(started_at, project, git_remote)
						 VALUES (?, 'terminal-project', ?)`,
					)
					.run(NOW, projectIdentity).lastInsertRowid,
			);
			store.db
				.prepare(
					`INSERT INTO memory_items(
					 session_id, kind, title, body_text, active, created_at, updated_at,
					 visibility, project, scope_id
					 ) VALUES (?, 'discovery', 'Terminal Project', 'body', 1, ?, ?, 'shared',
					 'terminal-project', 'scope-terminal')`,
				)
				.run(sessionId, NOW, NOW);
			store.db
				.prepare(
					`INSERT INTO project_scope_mappings(
					 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
					 ) VALUES (?, ?, 'scope-terminal', 1000, 'reviewed_team_setup', ?, ?)`,
				)
				.run(projectIdentity, projectIdentity, NOW, NOW);
			expect((await app.request("/api/sync/team-setup/v1")).status).toBe(200);
			let completed = getLegacyTeamSetupDraft(store.db, CANDIDATE_REF);
			if (!completed) throw new Error("initial Team setup draft missing");
			expect(
				store.db
					.prepare(
						`SELECT source_project_identity, resolved_project_identity, target_scope_id
						 FROM legacy_team_setup_draft_projects WHERE attempt_id = ?`,
					)
					.get(completed.attemptId),
			).toEqual({
				source_project_identity: projectIdentity,
				resolved_project_identity: projectIdentity,
				target_scope_id: "scope-terminal",
			});
			store.db
				.prepare(
					`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
					 VALUES ('identity-a', 'Person A', 0, 'active', ?, ?)`,
				)
				.run(NOW, NOW);
			const device = completed.devices[0];
			if (!device) throw new Error("initial Team setup device missing");
			completed = setLegacyTeamSetupDeviceAssignment(store.db, {
				attemptId: completed.attemptId,
				deviceRef: device.deviceRef,
				targetIdentityId: "identity-a",
				expectation: device.expectation,
				now: NOW,
			});
			completed = setLegacyTeamSetupDeviceDecision(store.db, {
				attemptId: completed.attemptId,
				deviceRef: device.deviceRef,
				decision: "included",
				now: NOW,
			});
			const review = inspectLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: completed.attemptId,
			});
			const completion = await finishLegacyTeamSetupActivation(store.db, {
				candidateRef: CANDIDATE_REF,
				attemptId: completed.attemptId,
				finishDigest: review.finishDigest,
				confirmedAccessDeltaDigest: review.accessDeltaDigest,
				loadFreshRoster: async () => SNAPSHOTS[0]?.devices ?? [],
				loadProjectInventory: () =>
					legacyTeamCandidateProjectInventory(
						store.db,
						{ localActorId: store.actorId, localDeviceId: store.deviceId },
						CANDIDATE_REF,
					),
				validateLockedPreview: () => true,
				now: NOW,
			});
			const teamId = completion.teamId;
			store.db
				.prepare(
					`DELETE FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`,
				)
				.run(projectIdentity, teamId);
			const newerAttemptId = "legacy-team-attempt:00000000-0000-4000-8000-000000000099";
			store.db
				.prepare(
					`INSERT INTO legacy_team_setup_drafts(
					 attempt_id, candidate_id, coordinator_id, group_id, state, display_name,
					 roster_fingerprint, projection_fingerprint, created_at, updated_at
					 ) VALUES (?, ?, ?, ?, 'needs_setup', 'Migration Team', 'new-roster',
					 'new-projection', ?, ?)`,
				)
				.run(newerAttemptId, CANDIDATE_REF, COORDINATOR_ID, GROUP_ID, NOW, NOW);

			const summary = await app.request("/api/sync/team-setup/v1");
			expect(summary.status).toBe(200);
			expect(await summary.json()).toEqual({ version: 1, candidates: [] });
			expect(getLegacyTeamSetupDraft(store.db, CANDIDATE_REF)?.attemptId).toBe(newerAttemptId);
			expect(
				store.db
					.prepare(
						`SELECT status, provenance FROM project_recipients
						 WHERE canonical_project_identity = ? AND recipient_kind = 'team'
						   AND recipient_id = ?`,
					)
					.get(projectIdentity, teamId),
			).toEqual({ status: "active", provenance: "reviewed_team_setup" });
		} finally {
			store.close();
		}
	});
});

describe("Team setup coordinator retry classification", () => {
	it.each([408, 429, 503])("retries transient coordinator HTTP %i errors", async (status) => {
		const listGroups = vi
			.fn()
			.mockRejectedValueOnce(
				new Error(`Remote coordinator request failed (${status}): unavailable`),
			)
			.mockResolvedValue([
				{
					group_id: GROUP_ID,
					display_name: "Migration Team",
					archived_at: null,
					created_at: NOW,
				},
			]);

		await expect(
			__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith({
				readConfig: () => ({
					...readCoordinatorSyncConfig({}),
					syncCoordinatorUrl: COORDINATOR_ID,
					syncCoordinatorGroups: [GROUP_ID],
					syncCoordinatorAdminSecret: "private-admin-secret",
				}),
				listGroups,
				listDevices: vi.fn(async () => []),
			}),
		).resolves.toEqual([expect.objectContaining({ groupId: GROUP_ID })]);
		expect(listGroups).toHaveBeenCalledTimes(2);
	});

	it("does not let timeout-like response text override a permanent HTTP status", async () => {
		const listGroups = vi
			.fn()
			.mockRejectedValue(
				new Error("Remote coordinator request failed (403): upstream request_timeout"),
			);

		await expect(
			__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith({
				readConfig: () => ({
					...readCoordinatorSyncConfig({}),
					syncCoordinatorUrl: COORDINATOR_ID,
					syncCoordinatorGroups: [GROUP_ID],
					syncCoordinatorAdminSecret: "private-admin-secret",
				}),
				listGroups,
				listDevices: vi.fn(async () => []),
			}),
		).rejects.toThrow("team_setup_roster_unavailable");
		expect(listGroups).toHaveBeenCalledTimes(1);
	});
});
