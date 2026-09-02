import {
	deterministicPolicyTeamId,
	finishLegacyTeamSetupActivation,
	getLegacyTeamSetupDraft,
	inspectLegacyTeamSetupActivation,
	type LegacyTeamConfiguredGroupSnapshot,
	legacyTeamCandidateId,
	legacyTeamCandidateProjectInventory,
	MemoryStore,
	readCoordinatorSyncConfig,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
} from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
import { __teamSetupTestHooks, teamSetupRoutes } from "./team-setup.js";

const COORDINATOR_ID = "https://coordinator.example.test";
const GROUP_ID = "group-alpha";
const CANDIDATE_REF = legacyTeamCandidateId(COORDINATOR_ID, GROUP_ID);
const NOW = "2026-08-26T00:00:00.000Z";
const SNAPSHOTS: LegacyTeamConfiguredGroupSnapshot[] = [
	{
		coordinatorId: COORDINATOR_ID,
		groupId: GROUP_ID,
		displayName: "Migration Team",
		devices: [
			{
				deviceId: "device-a",
				fingerprint: "fingerprint-a",
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
	it("revalidates pre-marker completions in detail and summary reads", async () => {
		const store = new MemoryStore(":memory:");
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
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
