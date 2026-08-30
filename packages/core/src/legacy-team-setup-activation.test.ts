import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverLegacyTeamCandidates } from "./legacy-team-candidate.js";
import {
	finishLegacyTeamSetupActivation,
	inspectLegacyTeamSetupActivation,
	previewLegacyTeamSetupActivation,
} from "./legacy-team-setup-activation.js";
import { latestLegacyTeamSetupAttempt } from "./legacy-team-setup-attempt.js";
import {
	refreshLegacyTeamSetupDraft,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
	setLegacyTeamSetupProjectMapping,
} from "./legacy-team-setup-draft.js";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
	legacyTeamRosterFingerprint,
	recipientPolicyDigest,
} from "./recipient-policy-identifiers.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";
import {
	serializeRecipientPolicyCoordinatorGroupMutation,
	serializeRecipientPolicyTeamMutation,
} from "./recipient-policy-team-metadata.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-08-21T12:00:00.000Z";
const CANDIDATE = "legacy-team-candidate:activation";
const PROJECT_A = "https://git.example.invalid/acme/api.git";
const PROJECT_B = "https://git.example.invalid/acme/web.git";
const roster = [
	{ deviceId: "device-a", fingerprint: "key-a", displayName: "Laptop", enabled: true },
	{ deviceId: "device-b", fingerprint: "key-b", displayName: "Desktop", enabled: true },
];

function snapshot() {
	return {
		candidateId: CANDIDATE,
		coordinatorId: "coordinator-private",
		groupId: "group-private",
		displayName: "Engineering",
		devices: roster,
		projects: [
			{
				projectRef: "project-ref-a",
				sourceProjectIdentity: PROJECT_A,
				displayName: "API",
				sourceFingerprint: "source-a",
				deterministicProjectIdentity: PROJECT_A,
				targetScopeId: "scope-engineering",
			},
			{
				projectRef: "project-ref-b",
				sourceProjectIdentity: "unmapped:web",
				displayName: "Web",
				sourceFingerprint: "source-b",
				deterministicProjectIdentity: null,
				targetScopeId: "scope-engineering",
			},
		],
		now: NOW,
	};
}

type ReadyDraft = ReturnType<typeof refreshLegacyTeamSetupDraft>;

describe("legacy Team setup activation", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id,
			 membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-engineering', 'Engineering', 'team', 'coordinator',
			 'coordinator-private', 'group-private', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
		for (const [identityId, displayName] of [
			["identity-a", "Person A"],
			["identity-b", "Person B"],
		] as const) {
			db.prepare(
				`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
				 VALUES (?, ?, 0, 'active', ?, ?)`,
			).run(identityId, displayName, NOW, NOW);
		}
	});

	afterEach(() => db.close());

	function readyDraft(input = snapshot()): ReadyDraft {
		let draft = refreshLegacyTeamSetupDraft(db, input);
		for (const device of draft.devices) {
			const identityId =
				device.displayName === "Laptop"
					? "identity-a"
					: device.displayName === "Desktop"
						? "identity-b"
						: null;
			if (!identityId) throw new Error("invalid activation fixture");
			draft = setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				targetIdentityId: identityId,
				expectation: device.expectation,
				now: NOW,
			});
			draft = setLegacyTeamSetupDeviceDecision(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				decision: "included",
				now: NOW,
			});
		}
		return setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: PROJECT_B,
			now: NOW,
		});
	}

	function preview(draft = readyDraft()) {
		return previewLegacyTeamSetupActivation(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
		});
	}

	// Reconstructs the live inventory the way discovery would supply it; the
	// projection fingerprint hashes projectRef/sourceFingerprint/deterministic
	// identity, so the reconstruction matches the draft's persisted value.
	function draftProjectInventory(attemptId: string) {
		return (
			db
				.prepare(
					`SELECT project_ref, source_project_identity, display_name, source_fingerprint,
					        resolution_kind, resolved_project_identity, target_scope_id
					 FROM legacy_team_setup_draft_projects WHERE attempt_id = ?`,
				)
				.all(attemptId) as Array<{
				project_ref: string;
				source_project_identity: string;
				display_name: string;
				source_fingerprint: string;
				resolution_kind: string;
				resolved_project_identity: string | null;
				target_scope_id: string | null;
			}>
		).map((row) => ({
			projectRef: row.project_ref,
			sourceProjectIdentity: row.source_project_identity,
			displayName: row.display_name,
			sourceFingerprint: row.source_fingerprint,
			deterministicProjectIdentity:
				row.resolution_kind === "deterministic" ? row.resolved_project_identity : null,
			targetScopeId: row.target_scope_id,
		}));
	}

	function finish(
		draft: ReadyDraft,
		review = preview(draft),
		loadFreshRoster = vi.fn(async () => roster),
		loadProjectInventory = vi.fn(() => draftProjectInventory(draft.attemptId)),
	) {
		return finishLegacyTeamSetupActivation(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			finishDigest: review.finishDigest,
			confirmedAccessDeltaDigest: review.accessDeltaDigest,
			loadFreshRoster,
			loadProjectInventory,
			validateLockedPreview: () => true,
			now: NOW,
		});
	}

	it("previews the complete access delta without writing authorization state", () => {
		// Arrange
		const draft = readyDraft();
		const before = db.prepare("SELECT total_changes()").pluck().get();

		// Act
		const review = preview(draft);

		// Assert
		expect(review).toMatchObject({
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			accessDelta: {
				teamChanges: [
					expect.objectContaining({
						teamId: deterministicPolicyTeamId(CANDIDATE),
						change: "add",
						toDeviceEligibilityMode: "reviewed_allowlist",
					}),
				],
				membershipChanges: expect.arrayContaining([
					expect.objectContaining({ identityId: "identity-a", change: "add" }),
					expect.objectContaining({ identityId: "identity-b", change: "add" }),
				]),
				projectChanges: [
					expect.objectContaining({ projectRef: "project-ref-a", toProjectIdentity: PROJECT_A }),
					expect.objectContaining({ projectRef: "project-ref-b", toProjectIdentity: PROJECT_B }),
				],
				recipientChanges: [
					expect.objectContaining({ canonicalProjectIdentity: PROJECT_A, change: "add" }),
					expect.objectContaining({ canonicalProjectIdentity: PROJECT_B, change: "add" }),
				],
				deviceAccessChanges: expect.arrayContaining([
					expect.objectContaining({
						canonicalProjectIdentity: PROJECT_A,
						deviceId: "device-a",
						change: "add",
					}),
					expect.objectContaining({
						canonicalProjectIdentity: PROJECT_B,
						deviceId: "device-b",
						change: "add",
					}),
				]),
			},
		});
		expect(review.accessDeltaDigest).toMatch(/^legacy-team-access-delta:/u);
		expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(before);
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
	});

	it("lists a shared canonical recipient addition once for merged Project resolutions", async () => {
		// Arrange: two ambiguous Projects explicitly resolved to the same
		// canonical identity materialize a single recipient edge, so the
		// confirmed delta (and its digest) must list that addition once.
		let draft = refreshLegacyTeamSetupDraft(db, {
			...snapshot(),
			projects: [
				{
					projectRef: "project-ref-b",
					sourceProjectIdentity: "unmapped:web",
					displayName: "Web",
					sourceFingerprint: "source-b",
					deterministicProjectIdentity: null,
				},
				{
					projectRef: "project-ref-c",
					sourceProjectIdentity: "unmapped:web-mirror",
					displayName: "Web mirror",
					sourceFingerprint: "source-c",
					deterministicProjectIdentity: null,
				},
			],
		});
		for (const device of draft.devices) {
			const identityId = device.displayName === "Laptop" ? "identity-a" : "identity-b";
			draft = setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				targetIdentityId: identityId,
				expectation: device.expectation,
				now: NOW,
			});
			draft = setLegacyTeamSetupDeviceDecision(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				decision: "included",
				now: NOW,
			});
		}
		for (const projectRef of ["project-ref-b", "project-ref-c"]) {
			draft = setLegacyTeamSetupProjectMapping(db, {
				attemptId: draft.attemptId,
				projectRef,
				resolvedProjectIdentity: PROJECT_B,
				now: NOW,
			});
		}

		// Act
		const review = preview(draft);

		// Assert
		expect(
			review.accessDelta.recipientChanges.filter(
				(change) => change.canonicalProjectIdentity === PROJECT_B,
			),
		).toHaveLength(1);
		expect(review.accessDelta.projectChanges).toHaveLength(2);

		// The finish must also succeed: selection can pick only one of the two
		// merged mappings, so the post-write authority check accepts the
		// selected pattern matching ANY confirmed source.
		const result = await finish(draft, review);
		expect(result).toMatchObject({ status: "completed" });
		expect(
			db
				.prepare(
					`SELECT COUNT(*) FROM project_recipients
					 WHERE canonical_project_identity = ? AND status = 'active'`,
				)
				.pluck()
				.get(PROJECT_B),
		).toBe(1);
	});

	it("represents an exact no-op as a complete empty access delta", async () => {
		// Arrange
		const firstDraft = readyDraft();
		await finish(firstDraft);
		const secondDraft = readyDraft();

		// Act
		const review = preview(secondDraft);

		// Assert
		expect(review.accessDelta).toEqual({
			teamChanges: [],
			membershipChanges: [],
			projectChanges: [],
			recipientChanges: [],
			deviceAccessChanges: [],
		});
		expect(review.accessDeltaDigest).toMatch(/^legacy-team-access-delta:/u);
	});

	it("preserves effective access from invitation decisions outside the setup roster", async () => {
		// Arrange
		await finish(readyDraft());
		const teamId = deterministicPolicyTeamId(CANDIDATE);
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-invited', 'Invited Person', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO identity_devices(
			 identity_id, device_id, display_name, status, provenance, revision, migration_state,
			 assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('identity-invited', 'device-invited', 'Invited Device', 'active',
			 'invitation', 'invite-r1', 'completed', 0, 'invite-device', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_memberships(
			 team_id, identity_id, role, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-invited', 'member', 'reviewed_active', 'coordinator_invite',
			 'invite-r1', 'completed', 'invite-membership', ?, ?)`,
		).run(teamId, NOW, NOW);
		// Only decisions carrying a canonical invite provenance survive the
		// reconcile — that is the provenance production invite writers emit,
		// and readiness classifies anything else outside the draft as
		// unexplained drift.
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
			 team_id, device_id, decision, assignment_version, provenance, revision, created_at, updated_at
			 ) VALUES (?, 'device-invited', 'included', 0, 'coordinator_invite', 'invite-r1', ?, ?)`,
		).run(teamId, NOW, NOW);
		const draft = readyDraft();

		// Act
		const review = preview(draft);
		await finish(draft, review);

		// Assert
		expect(review.accessDelta.deviceAccessChanges).not.toContainEqual(
			expect.objectContaining({ deviceId: "device-invited" }),
		);
		expect(
			deriveRecipientPolicyEffectiveDevicesFromDatabase(db, PROJECT_A).devices.map(
				(device) => device.deviceId,
			),
		).toContain("device-invited");
	});

	it("atomically materializes the Team, post-write decisions, mappings, recipients, and completion", async () => {
		// Arrange
		const draft = readyDraft();
		const review = preview(draft);
		const teamId = deterministicPolicyTeamId(CANDIDATE);

		// Act
		const result = await finish(draft, review);

		// Assert
		expect(result).toMatchObject({
			status: "completed",
			teamId,
			attemptId: draft.attemptId,
			accessDeltaDigest: review.accessDeltaDigest,
		});
		expect(
			db.prepare("SELECT status, device_eligibility_mode, provenance FROM policy_teams").get(),
		).toEqual({
			status: "active",
			device_eligibility_mode: "reviewed_allowlist",
			provenance: "reviewed_team_candidate",
		});
		expect(
			db
				.prepare(
					"SELECT identity_id, status, provenance FROM policy_team_memberships ORDER BY identity_id",
				)
				.all(),
		).toEqual([
			{
				identity_id: "identity-a",
				status: "reviewed_active",
				provenance: "reviewed_active",
			},
			{
				identity_id: "identity-b",
				status: "reviewed_active",
				provenance: "reviewed_active",
			},
		]);
		expect(
			db
				.prepare(
					`SELECT decision.device_id, decision.decision, decision.assignment_version
				 FROM policy_team_device_decisions decision ORDER BY decision.device_id`,
				)
				.all(),
		).toEqual([
			{ device_id: "device-a", decision: "included", assignment_version: 0 },
			{ device_id: "device-b", decision: "included", assignment_version: 0 },
		]);
		expect(
			db.prepare("SELECT device_id, identity_id FROM identity_devices ORDER BY device_id").all(),
		).toEqual([
			{ device_id: "device-a", identity_id: "identity-a" },
			{ device_id: "device-b", identity_id: "identity-b" },
		]);
		expect(
			db
				.prepare(
					`SELECT workspace_identity, project_pattern, scope_id
					 FROM project_scope_mappings ORDER BY project_pattern`,
				)
				.all(),
		).toEqual([
			{
				workspace_identity: PROJECT_A,
				project_pattern: PROJECT_A,
				scope_id: "scope-engineering",
			},
			{
				workspace_identity: PROJECT_B,
				project_pattern: "unmapped:web",
				scope_id: "scope-engineering",
			},
		]);
		expect(
			db
				.prepare(
					`SELECT canonical_project_identity, recipient_kind, recipient_id, status
				 FROM project_recipients ORDER BY canonical_project_identity`,
				)
				.all(),
		).toEqual([
			{
				canonical_project_identity: PROJECT_A,
				recipient_kind: "team",
				recipient_id: teamId,
				status: "active",
			},
			{
				canonical_project_identity: PROJECT_B,
				recipient_kind: "team",
				recipient_id: teamId,
				status: "active",
			},
		]);
		expect(
			db.prepare("SELECT state, completed_team_id FROM legacy_team_setup_drafts").get(),
		).toEqual({
			state: "completed",
			completed_team_id: teamId,
		});
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_completions").pluck().get()).toBe(1);
		// The stored fingerprints reflect the assignments this activation created,
		// so the next discovery of the same roster reads the completion as Ready
		// instead of reopening it.
		const postFingerprint = legacyTeamRosterFingerprint(
			roster.map((device) => ({
				deviceId: device.deviceId,
				fingerprint: device.fingerprint,
				enabled: device.enabled,
				identityId: device.deviceId === "device-a" ? "identity-a" : "identity-b",
			})),
		);
		expect(
			db.prepare("SELECT roster_fingerprint FROM legacy_team_setup_drafts").pluck().get(),
		).toBe(postFingerprint);
		expect(db.prepare("SELECT source_fingerprint FROM policy_teams").pluck().get()).toBe(
			postFingerprint,
		);
	});

	it.each([
		"unresolved device",
		"unresolved Project",
	] as const)("rejects an incomplete draft with no canonical writes: %s", (label) => {
		// Arrange
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		if (label === "unresolved device") {
			draft = setLegacyTeamSetupProjectMapping(db, {
				attemptId: draft.attemptId,
				projectRef: "project-ref-b",
				resolvedProjectIdentity: PROJECT_B,
				now: NOW,
			});
		} else {
			for (const [index, identityId] of ["identity-a", "identity-b"].entries()) {
				const device = draft.devices[index];
				if (!device) throw new Error("invalid activation fixture");
				draft = setLegacyTeamSetupDeviceAssignment(db, {
					attemptId: draft.attemptId,
					deviceRef: device.deviceRef,
					targetIdentityId: identityId,
					expectation: device.expectation,
					now: NOW,
				});
				draft = setLegacyTeamSetupDeviceDecision(db, {
					attemptId: draft.attemptId,
					deviceRef: device.deviceRef,
					decision: "included",
					now: NOW,
				});
			}
		}

		// Act
		const operation = () => preview(draft);

		// Assert
		expect(operation).toThrow("team_setup_incomplete");
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	});

	it("keeps read-only inspection from persisting activation errors", () => {
		const draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const input = { candidateRef: draft.candidateRef, attemptId: draft.attemptId };

		expect(() => inspectLegacyTeamSetupActivation(db, input)).toThrow("team_setup_incomplete");
		expect(
			db
				.prepare("SELECT state, safe_error_code FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.get(draft.attemptId),
		).toEqual({ state: "needs_setup", safe_error_code: null });

		expect(() => previewLegacyTeamSetupActivation(db, input)).toThrow("team_setup_incomplete");
		expect(
			db
				.prepare("SELECT state, safe_error_code FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.get(draft.attemptId),
		).toEqual({ state: "needs_setup", safe_error_code: "team_setup_incomplete" });
	});

	it.each([
		["attempt", { attemptId: "wrong-attempt" }],
		["finish digest", { finishDigest: "wrong-finish" }],
		["access delta", { confirmedAccessDeltaDigest: "wrong-delta" }],
	] as const)("rejects stale %s confirmation without writes", async (_label, override) => {
		// Arrange
		const draft = readyDraft();
		const review = preview(draft);

		// Act
		const operation = finishLegacyTeamSetupActivation(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			finishDigest: review.finishDigest,
			confirmedAccessDeltaDigest: review.accessDeltaDigest,
			loadFreshRoster: vi.fn(async () => roster),
			loadProjectInventory: vi.fn(() => draftProjectInventory(draft.attemptId)),
			validateLockedPreview: () => true,
			now: NOW,
			...override,
		});

		// Assert
		await expect(operation).rejects.toThrow("team_setup_confirmation_stale");
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		// A bad confirmation token is a caller problem, not draft evidence
		// drift: the attempt stays retryable with the correct tokens.
		expect(
			db
				.prepare("SELECT state FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(draft.attemptId),
		).not.toBe("stale");
		await expect(finish(draft, review)).resolves.toMatchObject({ status: "completed" });
	});

	it("waits for an in-flight Team metadata mutation before writing the activation revision", async () => {
		const draft = readyDraft();
		const review = preview(draft);
		const teamId = deterministicPolicyTeamId(CANDIDATE);
		let releaseMutation = () => undefined;
		const mutationPending = new Promise<void>((resolve) => {
			releaseMutation = resolve;
		});
		let mutationStarted = false;
		const mutation = serializeRecipientPolicyTeamMutation(db, teamId, async () => {
			mutationStarted = true;
			await mutationPending;
		});
		await vi.waitFor(() => expect(mutationStarted).toBe(true));

		const activation = finish(draft, review);
		await Promise.resolve();
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);

		releaseMutation();
		await mutation;
		await expect(activation).resolves.toMatchObject({ status: "completed", teamId });
	});

	it("waits for an in-flight coordinator group mutation before activating the Team", async () => {
		const draft = readyDraft();
		const review = preview(draft);
		let releaseMutation = () => undefined;
		const mutationPending = new Promise<void>((resolve) => {
			releaseMutation = resolve;
		});
		let mutationStarted = false;
		const mutation = serializeRecipientPolicyCoordinatorGroupMutation(
			db,
			"group-private",
			async () => {
				mutationStarted = true;
				await mutationPending;
			},
		);
		await vi.waitFor(() => expect(mutationStarted).toBe(true));

		const activation = finish(draft, review);
		await Promise.resolve();
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);

		releaseMutation();
		await mutation;
		await expect(activation).resolves.toMatchObject({
			status: "completed",
			teamId: deterministicPolicyTeamId(CANDIDATE),
		});
	});

	it("rejects preview and finish for a mutable attempt superseded by a newer row", async () => {
		// Arrange
		const draft = readyDraft();
		const review = preview(draft);
		const replacement = refreshLegacyTeamSetupDraft(db, {
			...snapshot(),
			projects: [
				...snapshot().projects,
				{
					projectRef: "project-ref-c",
					sourceProjectIdentity: "https://git.example.invalid/acme/worker.git",
					displayName: "Worker",
					sourceFingerprint: "source-c",
					deterministicProjectIdentity: "https://git.example.invalid/acme/worker.git",
				},
			],
		});
		expect(replacement.attemptId).not.toBe(draft.attemptId);
		db.prepare(
			"UPDATE legacy_team_setup_drafts SET state = 'in_progress' WHERE attempt_id = ?",
		).run(draft.attemptId);

		// Act / Assert
		expect(() => preview(draft)).toThrow("team_setup_confirmation_stale");
		await expect(finish(draft, review)).rejects.toThrow("team_setup_confirmation_stale");
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_completions").pluck().get()).toBe(0);
	});

	it("rejects a changed roster and fetches it before opening the SQLite write transaction", async () => {
		// Arrange
		const draft = readyDraft();
		const review = preview(draft);
		const loadFreshRoster = vi.fn(async () => {
			expect(db.inTransaction).toBe(false);
			return [{ ...roster[0], fingerprint: "changed-key" }, roster[1]];
		});

		// Act
		const operation = finish(draft, review, loadFreshRoster);

		// Assert
		await expect(operation).rejects.toThrow("team_setup_roster_changed");
		expect(loadFreshRoster).toHaveBeenCalledOnce();
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		expect(
			db
				.prepare("SELECT state FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(draft.attemptId),
		).toBe("stale");
	});

	it("returns roster unavailable after a failed pre-lock fetch without canonical writes", async () => {
		// Arrange
		const draft = readyDraft();
		const review = preview(draft);
		const loadFreshRoster = vi.fn(async () => {
			expect(db.inTransaction).toBe(false);
			throw new Error("private coordinator failure");
		});

		// Act
		const operation = finish(draft, review, loadFreshRoster);

		// Assert
		await expect(operation).rejects.toThrow("team_setup_roster_unavailable");
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		expect(
			db.prepare("SELECT safe_error_code FROM legacy_team_setup_drafts").pluck().get(),
		).not.toBe("private coordinator failure");
	});

	it("rejects a changed assignment before activation and preserves the winner", async () => {
		// Arrange
		const draft = readyDraft();
		const review = preview(draft);
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-a', 'identity-b', 'Laptop', 'active', 'test', 'r1', 'completed',
			 1, 'assignment-winner', ?, ?)`,
		).run(NOW, NOW);

		// Act
		const operation = finish(draft, review);

		// Assert
		await expect(operation).rejects.toThrow("team_setup_assignment_changed");
		expect(
			db
				.prepare("SELECT identity_id FROM identity_devices WHERE device_id = 'device-a'")
				.pluck()
				.get(),
		).toBe("identity-b");
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		expect(
			db
				.prepare("SELECT state FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(draft.attemptId),
		).toBe("stale");
	});

	it.each([
		[
			"Team",
			() =>
				db
					.prepare(
						`INSERT INTO policy_teams(team_id, display_name, status, device_eligibility_mode, provenance, revision, migration_state, idempotency_key, created_at, updated_at) VALUES (?, 'Other', 'active', 'person_all_devices', 'invitation', 'r1', 'completed', 'conflicting-team', ?, ?)`,
					)
					.run(deterministicPolicyTeamId(CANDIDATE), NOW, NOW),
		],
		[
			"Project recipient",
			() =>
				db
					.prepare(
						`INSERT INTO project_recipients(canonical_project_identity, recipient_kind, recipient_id, status, provenance, policy_revision, migration_state, idempotency_key, created_at, updated_at) VALUES (?, 'team', 'policy-team-v1:other-claimant', 'active', 'user', 'r1', 'completed', 'conflicting-recipient', ?, ?)`,
					)
					.run(PROJECT_A, NOW, NOW),
		],
		[
			"Project mapping",
			() =>
				db
					.prepare(
						`INSERT INTO project_scope_mappings(workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at) VALUES (?, ?, 'other-scope', 1000, 'user', ?, ?)`,
					)
					.run(PROJECT_B, "unmapped:web", NOW, NOW),
		],
	] as const)("fails closed on a canonical %s conflict", async (_label, createConflict) => {
		// Arrange
		const draft = readyDraft();
		const review = preview(draft);
		createConflict();

		// Act
		const operation = finish(draft, review);

		// Assert
		await expect(operation).rejects.toThrow("team_setup_conflict");
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_completions").pluck().get()).toBe(0);
		expect(
			db
				.prepare("SELECT state, safe_error_code FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.get(draft.attemptId),
		).toEqual({ state: "in_progress", safe_error_code: "team_setup_conflict" });
	});

	it("revalidates Project canonical state after the pre-lock model was accepted", async () => {
		// Arrange: preview and the finish's initial model are valid. The external
		// roster fetch yields control before BEGIN IMMEDIATE, during which another
		// writer can add a conflicting claim. The locked loadModel must reject it
		// before inventory derivation or any setup write.
		const draft = readyDraft();
		const review = preview(draft);
		const loadFreshRoster = vi.fn(async () => {
			expect(db.inTransaction).toBe(false);
			db.prepare(
				`INSERT INTO project_recipients(
				 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
				 policy_revision, migration_state, idempotency_key, created_at, updated_at
				 ) VALUES (?, 'team', 'policy-team-v1:foreign', 'active', 'user', 'r1',
				 'completed', 'late-foreign-team-claim', ?, ?)`,
			).run(PROJECT_A, NOW, NOW);
			return roster;
		});
		const loadProjectInventory = vi.fn(() => draftProjectInventory(draft.attemptId));

		// Act
		const operation = finish(draft, review, loadFreshRoster, loadProjectInventory);

		// Assert
		await expect(operation).rejects.toThrow("team_setup_conflict");
		expect(loadFreshRoster).toHaveBeenCalledOnce();
		expect(loadProjectInventory).not.toHaveBeenCalled();
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_completions").pluck().get()).toBe(0);
	});

	it("replays the exact immutable response only for the same candidate route and confirmation", async () => {
		// Arrange
		const draft = readyDraft();
		const review = preview(draft);
		const first = await finish(draft, review);
		db.prepare("UPDATE policy_teams SET display_name = 'Later name'").run();
		const loadFreshRoster = vi.fn(async () => {
			throw new Error("exact replay must not fetch");
		});

		// Act
		const replay = await finish(draft, review, loadFreshRoster);
		const wrongRoute = finishLegacyTeamSetupActivation(db, {
			candidateRef: "legacy-team-candidate:other",
			attemptId: draft.attemptId,
			finishDigest: review.finishDigest,
			confirmedAccessDeltaDigest: review.accessDeltaDigest,
			loadFreshRoster,
			loadProjectInventory: vi.fn(() => draftProjectInventory(draft.attemptId)),
			validateLockedPreview: () => true,
			now: NOW,
		});

		// Assert
		expect(replay).toEqual(first);
		expect(loadFreshRoster).not.toHaveBeenCalled();
		await expect(wrongRoute).rejects.toThrow("team_setup_confirmation_stale");
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_completions").pluck().get()).toBe(1);
	});

	it("rolls back every canonical write when a late write fails", async () => {
		// Arrange
		const draft = readyDraft();
		const review = preview(draft);
		db.exec(`CREATE TRIGGER fail_activation_completion
			BEFORE INSERT ON legacy_team_setup_completions
			BEGIN SELECT RAISE(ABORT, 'completion failed'); END`);

		// Act
		const operation = finish(draft, review);

		// Assert
		await expect(operation).rejects.toThrow("team_setup_failed");
		for (const table of [
			"policy_teams",
			"policy_team_memberships",
			"policy_team_device_decisions",
			"identity_devices",
			"project_scope_mappings",
			"project_recipients",
			"legacy_team_setup_completions",
		]) {
			expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), table).toBe(0);
		}
		expect(db.prepare("SELECT state FROM legacy_team_setup_drafts").pluck().get()).not.toBe(
			"completed",
		);
	});

	it("reconciles setup-managed memberships while preserving invitation provenance", async () => {
		// Arrange
		const firstDraft = readyDraft();
		await finish(firstDraft);
		const teamId = deterministicPolicyTeamId(CANDIDATE);
		db.prepare(
			`UPDATE policy_team_memberships SET provenance = 'team_invite' WHERE team_id = ? AND identity_id = 'identity-b'`,
		).run(teamId);
		db.prepare(
			`INSERT INTO policy_team_memberships(
			 team_id, identity_id, role, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-obsolete', 'member', 'reviewed_active', 'reviewed_active', 'old',
			 'completed', 'old-roster', 'obsolete-membership', ?, ?)`,
		).run(teamId, NOW, NOW);
		const secondDraft = readyDraft();
		const excludedDevice = secondDraft.devices.find((device) => device.displayName === "Desktop");
		if (!excludedDevice) throw new Error("invalid activation fixture");
		const reconciledDraft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: secondDraft.attemptId,
			deviceRef: excludedDevice.deviceRef,
			decision: "excluded",
			now: NOW,
		});
		const review = preview(reconciledDraft);

		// Act
		await finish(reconciledDraft, review);

		// Assert
		expect(
			db
				.prepare(
					"SELECT status FROM policy_team_memberships WHERE team_id = ? AND identity_id = 'identity-a'",
				)
				.pluck()
				.get(teamId),
		).toBe("reviewed_active");
		expect(
			db
				.prepare(
					"SELECT status, provenance FROM policy_team_memberships WHERE team_id = ? AND identity_id = 'identity-b'",
				)
				.get(teamId),
		).toEqual({ status: "reviewed_active", provenance: "team_invite" });
		expect(
			db
				.prepare(
					"SELECT status FROM policy_team_memberships WHERE team_id = ? AND identity_id = 'identity-obsolete'",
				)
				.pluck()
				.get(teamId),
		).toBe("revoked");
		expect(
			db
				.prepare(
					"SELECT decision FROM policy_team_device_decisions WHERE team_id = ? AND device_id = 'device-b'",
				)
				.pluck()
				.get(teamId),
		).toBe("excluded");
	});

	it("accepts a matching inactive assignment when the device is excluded", async () => {
		// Arrange
		let draft = readyDraft();
		const excludedDevice = draft.devices.find((device) => device.displayName === "Desktop");
		if (!excludedDevice) throw new Error("invalid activation fixture");
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef: excludedDevice.deviceRef,
			decision: "excluded",
			now: NOW,
		});
		const review = preview(draft);
		db.prepare("UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-b'").run();

		// Act
		await finish(draft, review);

		// Assert
		expect(
			db
				.prepare(
					"SELECT decision FROM policy_team_device_decisions WHERE team_id = ? AND device_id = 'device-b'",
				)
				.pluck()
				.get(deterministicPolicyTeamId(CANDIDATE)),
		).toBe("excluded");
	});

	function insertHistoricalResolution(input: {
		reviewItemId: string;
		sourceFingerprint: string;
		projectIdentity: string;
		memberIds: string[];
	}): void {
		db.prepare(
			`INSERT INTO recipient_policy_review_resolutions(
			 review_item_id, source_fingerprint, decision, decision_input_json, preview_json,
			 decided_by_identity_id, decided_by_device_id, resolved_at
			 ) VALUES (?, ?, 'choose_recipients', ?, ?, 'identity-a', 'device-a', ?)`,
		).run(
			input.reviewItemId,
			input.sourceFingerprint,
			JSON.stringify({ recipientIds: [CANDIDATE] }),
			JSON.stringify({
				effectiveDevices: input.memberIds.map((identityId, index) => ({
					deviceId: `historical-device-${index}`,
					assignment: "assigned",
					identityId,
				})),
				projects: [{ canonicalIdentity: input.projectIdentity }],
			}),
			NOW,
		);
	}

	function insertHistoricalTeam(input: {
		teamId: string;
		teamFingerprint: string;
		memberIds: string[];
		projectIdentities: string[];
	}): void {
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, device_eligibility_mode, provenance, revision,
			 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Engineering', 'active', 'person_all_devices', 'reviewed_team_candidate',
			 'historical', 'projected', ?, 'historical-team', ?, ?)`,
		).run(input.teamId, input.teamFingerprint, NOW, NOW);
		for (const identityId of input.memberIds) {
			db.prepare(
				`INSERT INTO policy_team_memberships(
				 team_id, identity_id, role, status, provenance, revision, migration_state,
				 source_fingerprint, idempotency_key, created_at, updated_at
				 ) VALUES (?, ?, 'member', 'active', 'reviewed_team_candidate', 'historical',
				 'projected', ?, ?, ?, ?)`,
			).run(input.teamId, identityId, input.teamFingerprint, `historical-${identityId}`, NOW, NOW);
		}
		for (const projectIdentity of input.projectIdentities) {
			db.prepare(
				`INSERT INTO project_recipients(
				 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
				 policy_revision, migration_state, source_fingerprint, idempotency_key,
				 created_at, updated_at
				 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_candidate', 'historical',
				 'projected', ?, ?, ?, ?)`,
			).run(
				projectIdentity,
				input.teamId,
				input.teamFingerprint,
				`historical-edge-${projectIdentity}`,
				NOW,
				NOW,
			);
		}
	}

	it("adopts a Team from the previous migration path and covers its preserved edges in the delta", async () => {
		// Arrange
		const preservedProject = "https://git.example.invalid/acme/preserved.git";
		const teamId = deterministicPolicyTeamId(CANDIDATE);
		insertHistoricalResolution({
			reviewItemId: "review-a",
			sourceFingerprint: "resolution-a",
			projectIdentity: PROJECT_A,
			memberIds: ["identity-a", "identity-b"],
		});
		insertHistoricalResolution({
			reviewItemId: "review-b",
			sourceFingerprint: "resolution-b",
			projectIdentity: preservedProject,
			memberIds: ["identity-a"],
		});
		insertHistoricalTeam({
			teamId,
			teamFingerprint: "resolution-b",
			memberIds: ["identity-a", "identity-b"],
			projectIdentities: [PROJECT_A, preservedProject],
		});
		// An invite-owned member added after the historical migration does not
		// block adoption; only the resolution-owned subset must match exactly.
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-invited', 'Invited Person', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_memberships(
			 team_id, identity_id, role, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-invited', 'member', 'active', 'coordinator_invite',
			 'invite-r1', 'user_managed', 'historical-invite-membership', ?, ?)`,
		).run(teamId, NOW, NOW);
		// A direct identity share created by the same historical resolution can
		// coexist with the Team edge without blocking adoption.
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity', 'identity-a', 'active', 'review_resolution', 'r1',
			 'completed', 'historical-identity-edge', ?, ?)`,
		).run(PROJECT_A, NOW, NOW);
		const draft = readyDraft();
		const review = preview(draft);

		// Act
		const adopted = await finish(draft, review);

		// Assert
		expect(review.accessDelta.teamChanges).toEqual([
			expect.objectContaining({
				teamId,
				change: "update",
				fromDeviceEligibilityMode: "person_all_devices",
				toDeviceEligibilityMode: "reviewed_allowlist",
			}),
		]);
		expect(review.accessDelta.membershipChanges).toContainEqual({
			teamId,
			identityId: "identity-invited",
			change: "update",
		});
		expect(review.accessDelta.deviceAccessChanges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					canonicalProjectIdentity: preservedProject,
					deviceId: "device-a",
					change: "add",
				}),
				expect.objectContaining({
					canonicalProjectIdentity: preservedProject,
					deviceId: "device-b",
					change: "add",
				}),
			]),
		);
		expect(adopted).toMatchObject({ status: "completed", teamId });
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(1);
		expect(
			db
				.prepare("SELECT device_eligibility_mode FROM policy_teams WHERE team_id = ?")
				.pluck()
				.get(teamId),
		).toBe("reviewed_allowlist");
		expect(
			db
				.prepare(
					`SELECT status FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_id = ?`,
				)
				.pluck()
				.get(preservedProject, teamId),
		).toBe("active");
		expect(
			db
				.prepare(
					"SELECT status, provenance FROM policy_team_memberships WHERE identity_id = 'identity-a'",
				)
				.get(),
		).toEqual({ status: "reviewed_active", provenance: "reviewed_active" });
		expect(
			db
				.prepare(
					`SELECT status, provenance, revision, migration_state, idempotency_key
					 FROM policy_team_memberships WHERE identity_id = 'identity-invited'`,
				)
				.get(),
		).toEqual({
			status: "reviewed_active",
			provenance: "coordinator_invite",
			revision: "invite-r1",
			migration_state: "user_managed",
			idempotency_key: "historical-invite-membership",
		});
	});

	it.each([
		[
			"no saved resolution selected this candidate",
			() => {
				insertHistoricalTeam({
					teamId: deterministicPolicyTeamId(CANDIDATE),
					teamFingerprint: "resolution-a",
					memberIds: ["identity-a"],
					projectIdentities: [PROJECT_A],
				});
			},
		],
		[
			"the Team fingerprint matches no saved resolution",
			() => {
				insertHistoricalResolution({
					reviewItemId: "review-a",
					sourceFingerprint: "resolution-a",
					projectIdentity: PROJECT_A,
					memberIds: ["identity-a"],
				});
				insertHistoricalTeam({
					teamId: deterministicPolicyTeamId(CANDIDATE),
					teamFingerprint: "unexplained-fingerprint",
					memberIds: ["identity-a"],
					projectIdentities: [PROJECT_A],
				});
			},
		],
		[
			"a recipient edge is not justified by any saved resolution",
			() => {
				insertHistoricalResolution({
					reviewItemId: "review-a",
					sourceFingerprint: "resolution-a",
					projectIdentity: PROJECT_A,
					memberIds: ["identity-a"],
				});
				insertHistoricalTeam({
					teamId: deterministicPolicyTeamId(CANDIDATE),
					teamFingerprint: "resolution-a",
					memberIds: ["identity-a"],
					projectIdentities: [PROJECT_A, "https://git.example.invalid/acme/unexplained.git"],
				});
			},
		],
		[
			"the membership set does not match the saved resolutions",
			() => {
				insertHistoricalResolution({
					reviewItemId: "review-a",
					sourceFingerprint: "resolution-a",
					projectIdentity: PROJECT_A,
					memberIds: ["identity-a"],
				});
				insertHistoricalTeam({
					teamId: deterministicPolicyTeamId(CANDIDATE),
					teamFingerprint: "resolution-a",
					memberIds: ["identity-a", "identity-b"],
					projectIdentities: [PROJECT_A],
				});
			},
		],
	] as const)("rejects historical Team adoption when %s", (_label, createHistoricalState) => {
		// Arrange
		createHistoricalState();
		const draft = readyDraft();

		// Act
		const operation = () => preview(draft);

		// Assert
		expect(operation).toThrow("team_setup_conflict");
		expect(db.prepare("SELECT device_eligibility_mode FROM policy_teams").pluck().get()).toBe(
			"person_all_devices",
		);
	});

	it("rejects an incompatible historical Team before activation", () => {
		// Arrange
		const draft = readyDraft();
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, device_eligibility_mode, provenance, revision,
			 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Other Team', 'active', 'reviewed_allowlist', 'invitation', 'historical',
			 'completed', 'incompatible-source', 'incompatible-team', ?, ?)`,
		).run(deterministicPolicyTeamId(CANDIDATE), NOW, NOW);

		// Act
		const operation = () => preview(draft);

		// Assert
		expect(operation).toThrow("team_setup_conflict");
		expect(db.prepare("SELECT COUNT(*) FROM policy_team_memberships").pluck().get()).toBe(0);
	});

	it("includes preserved recipient projects in the access delta on repeat setup", async () => {
		// Arrange
		const preservedProject = "https://git.example.invalid/acme/preserved.git";
		const firstDraft = readyDraft();
		const first = await finish(firstDraft);
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'team', ?, 'active', 'review_resolution', 'historical', 'completed',
			 'preserved-edge', ?, ?)`,
		).run(preservedProject, first.teamId, NOW, NOW);
		const secondDraft = readyDraft();
		const excludedDevice = secondDraft.devices.find((device) => device.displayName === "Desktop");
		if (!excludedDevice) throw new Error("invalid activation fixture");
		const reconciledDraft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: secondDraft.attemptId,
			deviceRef: excludedDevice.deviceRef,
			decision: "excluded",
			now: NOW,
		});

		// Act
		const review = preview(reconciledDraft);

		// Assert
		expect(review.accessDelta.deviceAccessChanges).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: preservedProject,
				deviceId: "device-b",
				change: "remove",
			}),
		);
	});

	it("reconciles stale setup-owned decisions for devices dropped from the roster", async () => {
		// Arrange
		const first = await finish(readyDraft());
		// Assign device-b's identity a second device so the identity remains an
		// active member while device-b disappears from the roster entirely.
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-b2', 'identity-b', 'Second Desktop', 'active', 'test', 'r1',
			 'completed', 0, 'device-b2', ?, ?)`,
		).run(NOW, NOW);
		const secondDraft = readyDraft();
		// Simulate a refreshed roster that omits device-b: the attempt has no
		// draft row for it at all and its roster evidence covers device-a only.
		db.prepare(
			`DELETE FROM legacy_team_setup_draft_devices
			 WHERE attempt_id = ? AND device_id = 'device-b'`,
		).run(secondDraft.attemptId);
		const reducedRoster = roster.filter((device) => device.deviceId === "device-a");
		const reducedFingerprint = legacyTeamRosterFingerprint(
			reducedRoster.map((device) => ({
				deviceId: device.deviceId,
				fingerprint: device.fingerprint,
				enabled: device.enabled,
				identityId: "identity-a",
			})),
		);
		db.prepare(
			"UPDATE legacy_team_setup_drafts SET roster_fingerprint = ? WHERE attempt_id = ?",
		).run(reducedFingerprint, secondDraft.attemptId);
		const trimmedDraft = {
			...secondDraft,
			devices: secondDraft.devices.filter((device) => device.displayName !== "Desktop"),
		};
		const review = preview(trimmedDraft);

		// Act
		await finish(
			trimmedDraft,
			review,
			vi.fn(async () => reducedRoster),
		);

		// Assert
		expect(review.accessDelta.deviceAccessChanges).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: PROJECT_A,
				deviceId: "device-b",
				change: "remove",
			}),
		);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) FROM policy_team_device_decisions WHERE team_id = ? AND device_id = 'device-b'",
				)
				.pluck()
				.get(first.teamId),
		).toBe(0);
	});

	it("activates across multiple group scopes when every mapping is unambiguous", async () => {
		// Arrange
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id,
			 membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-engineering-2', 'Engineering Web', 'managed_project', 'coordinator',
			 'coordinator-private', 'group-private', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 'scope-engineering', 1000, 'user', ?, ?)`,
		).run(PROJECT_A, PROJECT_A, NOW, NOW);
		db.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, 'unmapped:web', 'scope-engineering-2', 1000, 'user', ?, ?)`,
		).run(PROJECT_B, NOW, NOW);
		const current = snapshot();
		const draft = readyDraft({
			...current,
			projects: current.projects.map((project) => ({
				...project,
				targetScopeId:
					project.projectRef === "project-ref-b" ? "scope-engineering-2" : project.targetScopeId,
			})),
		});

		// Act
		const result = await finish(draft);

		// Assert
		expect(result).toMatchObject({ status: "completed" });
		expect(
			db
				.prepare(
					"SELECT scope_id FROM project_scope_mappings WHERE project_pattern = 'unmapped:web'",
				)
				.pluck()
				.get(),
		).toBe("scope-engineering-2");
	});

	it.each([
		"unresolved",
		"included",
	] as const)("settles a %s invite decision to excluded when its device is removed", async (initialDecision) => {
		// Arrange: a completed setup with an invite-owned decision for a roster
		// device that later gets removed. The reviewed removal retires the
		// device's access: `unresolved` would reopen setup forever and
		// `included` would keep granting Project access to a removed device.
		await finish(readyDraft());
		const teamId = deterministicPolicyTeamId(CANDIDATE);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
			 team_id, device_id, decision, assignment_version, provenance, revision,
			 created_at, updated_at
			 ) VALUES (?, 'device-b', ?, 0, 'coordinator_invite', 'invite-r1', ?, ?)
			 ON CONFLICT(team_id, device_id) DO UPDATE SET
			 decision = excluded.decision, provenance = 'coordinator_invite', revision = 'invite-r1'`,
		).run(teamId, initialDecision, NOW, NOW);
		let draft = refreshLegacyTeamSetupDraft(db, {
			...snapshot(),
			devices: [
				{ deviceId: "device-a", fingerprint: "key-a", displayName: "Laptop", enabled: true },
				{ deviceId: "device-b", fingerprint: "key-b", displayName: "Desktop", enabled: false },
			],
		});
		for (const device of draft.devices) {
			if (device.displayName === "Laptop") {
				draft = setLegacyTeamSetupDeviceAssignment(db, {
					attemptId: draft.attemptId,
					deviceRef: device.deviceRef,
					targetIdentityId: "identity-a",
					expectation: device.expectation,
					now: NOW,
				});
				draft = setLegacyTeamSetupDeviceDecision(db, {
					attemptId: draft.attemptId,
					deviceRef: device.deviceRef,
					decision: "included",
					now: NOW,
				});
			} else {
				draft = setLegacyTeamSetupDeviceDecision(db, {
					attemptId: draft.attemptId,
					deviceRef: device.deviceRef,
					decision: "removed",
					now: NOW,
				});
			}
		}
		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: PROJECT_B,
			now: NOW,
		});
		expect(draft.canFinish).toBe(true);

		// Act
		const result = await finish(
			draft,
			preview(draft),
			vi.fn(async () => [
				{ deviceId: "device-a", fingerprint: "key-a", displayName: "Laptop", enabled: true },
				{ deviceId: "device-b", fingerprint: "key-b", displayName: "Desktop", enabled: false },
			]),
		);

		// Assert: the invite decision settles to the non-granting resolved
		// state instead of blocking Ready forever or being revoked outright.
		expect(result).toMatchObject({ status: "completed" });
		expect(
			db
				.prepare(
					`SELECT decision, provenance FROM policy_team_device_decisions
					 WHERE team_id = ? AND device_id = 'device-b'`,
				)
				.get(teamId),
		).toEqual({ decision: "excluded", provenance: "coordinator_invite" });
	});

	it("settles an unresolved invite decision when its device drops out of the roster", async () => {
		// Arrange: an invite-owned unresolved decision for a device the
		// refreshed roster no longer contains at all — there is no draft row
		// through which the user could ever resolve it, so preserving it
		// verbatim would reopen setup forever with no actionable device.
		await finish(readyDraft());
		const teamId = deterministicPolicyTeamId(CANDIDATE);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
			 team_id, device_id, decision, assignment_version, provenance, revision,
			 created_at, updated_at
			 ) VALUES (?, 'device-vanished', 'unresolved', 0, 'coordinator_invite', 'invite-r1', ?, ?)`,
		).run(teamId, NOW, NOW);
		const draft = readyDraft();

		// Act
		const result = await finish(draft);

		// Assert: settled to the non-granting resolved state.
		expect(result).toMatchObject({ status: "completed" });
		expect(
			db
				.prepare(
					`SELECT decision, provenance FROM policy_team_device_decisions
					 WHERE team_id = ? AND device_id = 'device-vanished'`,
				)
				.get(teamId),
		).toEqual({ decision: "excluded", provenance: "coordinator_invite" });
	});

	it("rejects activation instead of retargeting another group's setup mapping", async () => {
		// Arrange: a different coordinator group's completed setup already maps
		// the same source pattern into ITS scope. Treating that row as this
		// setup's stale mapping would silently reroute the other group's
		// Project and break its completed Team.
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id,
			 membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-other-group', 'Other Group', 'team', 'coordinator',
			 'coordinator-other', 'group-other', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES ('https://git.example.invalid/other/web.git', 'unmapped:web',
			 'scope-other-group', 1000, 'reviewed_team_setup', ?, ?)`,
		).run(NOW, NOW);
		const draft = readyDraft();

		// Act + Assert: cross-group conflict already at preview, nothing
		// persisted, foreign mapping untouched.
		expect(() => preview(draft)).toThrow("team_setup_conflict");
		expect(
			db
				.prepare(
					`SELECT workspace_identity FROM project_scope_mappings
					 WHERE scope_id = 'scope-other-group'`,
				)
				.pluck()
				.get(),
		).toBe("https://git.example.invalid/other/web.git");
		expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
	});

	it("supersedes the setup-owned mapping when a repeat setup re-resolves a Project", async () => {
		// Arrange: first setup resolved the ambiguous Project to PROJECT_B; a
		// repeat setup corrects the resolution to a different identity. The
		// prior setup-owned mapping must be replaced in place, not treated as
		// a permanent conflict or left competing on priority.
		const PROJECT_C = "https://git.example.invalid/acme/web-actual.git";
		await finish(readyDraft());
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		for (const device of draft.devices) {
			const identityId = device.displayName === "Laptop" ? "identity-a" : "identity-b";
			draft = setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				targetIdentityId: identityId,
				expectation: device.expectation,
				now: NOW,
			});
			draft = setLegacyTeamSetupDeviceDecision(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				decision: "included",
				now: NOW,
			});
		}
		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: PROJECT_C,
			now: NOW,
		});

		// Act
		const review = preview(draft);
		const result = await finish(draft, review);

		// Assert: one superseded mapping, revoked old edge, active new edge,
		// and a confirmed payload that presents the replacement as an update.
		expect(result).toMatchObject({ status: "completed" });
		expect(review.accessDelta.projectChanges).toContainEqual(
			expect.objectContaining({
				change: "update",
				fromProjectIdentity: PROJECT_B,
				toProjectIdentity: PROJECT_C,
			}),
		);
		expect(
			db
				.prepare(
					`SELECT workspace_identity FROM project_scope_mappings
					 WHERE project_pattern = 'unmapped:web' AND source = 'reviewed_team_setup'`,
				)
				.pluck()
				.all(),
		).toEqual([PROJECT_C]);
		expect(
			db
				.prepare("SELECT status FROM project_recipients WHERE canonical_project_identity = ?")
				.pluck()
				.get(PROJECT_B),
		).toBe("revoked");
		expect(
			db
				.prepare("SELECT status FROM project_recipients WHERE canonical_project_identity = ?")
				.pluck()
				.get(PROJECT_C),
		).toBe("active");
	});

	it("preserves independently owned recipient edges across repeat setups", async () => {
		// Arrange: another flow already owns the PROJECT_A edge.
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'team', ?, 'active', 'review_resolution', 'review-r1', 'completed',
			 'independent-edge', ?, ?)`,
		).run(PROJECT_A, deterministicPolicyTeamId(CANDIDATE), NOW, NOW);
		await finish(readyDraft());
		// Reactivation must not steal ownership.
		expect(
			db
				.prepare("SELECT provenance FROM project_recipients WHERE canonical_project_identity = ?")
				.pluck()
				.get(PROJECT_A),
		).toBe("review_resolution");

		// A repeat setup that drops PROJECT_A must leave the independently
		// owned edge active instead of revoking it as setup-owned.
		let draft = refreshLegacyTeamSetupDraft(db, {
			...snapshot(),
			projects: [snapshot().projects[1] as ReturnType<typeof snapshot>["projects"][number]],
		});
		for (const device of draft.devices) {
			const identityId = device.displayName === "Laptop" ? "identity-a" : "identity-b";
			draft = setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				targetIdentityId: identityId,
				expectation: device.expectation,
				now: NOW,
			});
			draft = setLegacyTeamSetupDeviceDecision(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				decision: "included",
				now: NOW,
			});
		}
		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: PROJECT_B,
			now: NOW,
		});
		const review = preview(draft);
		await finish(draft, review);

		expect(
			db
				.prepare(
					"SELECT status, provenance FROM project_recipients WHERE canonical_project_identity = ?",
				)
				.get(PROJECT_A),
		).toEqual({ status: "active", provenance: "review_resolution" });
		expect(review.accessDelta.recipientChanges).not.toContainEqual(
			expect.objectContaining({ canonicalProjectIdentity: PROJECT_A, change: "remove" }),
		);
	});

	it("confirms and applies setup-owned mapping removal when repeat setup drops a Project", async () => {
		// Arrange: first setup authorizes PROJECT_A and PROJECT_B; the
		// refreshed inventory then drops PROJECT_B entirely.
		await finish(readyDraft());
		let draft = refreshLegacyTeamSetupDraft(db, {
			...snapshot(),
			projects: [snapshot().projects[0] as ReturnType<typeof snapshot>["projects"][number]],
		});
		for (const device of draft.devices) {
			const identityId = device.displayName === "Laptop" ? "identity-a" : "identity-b";
			draft = setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				targetIdentityId: identityId,
				expectation: device.expectation,
				now: NOW,
			});
			draft = setLegacyTeamSetupDeviceDecision(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				decision: "included",
				now: NOW,
			});
		}
		const review = preview(draft);

		// Act
		const result = await finish(draft, review);

		// Assert: the confirmed delta lists the removal and the stale
		// setup-owned edge is revoked, while the surviving Project stays
		// active.
		expect(review.accessDelta.recipientChanges).toContainEqual({
			canonicalProjectIdentity: PROJECT_B,
			recipientKind: "team",
			recipientId: deterministicPolicyTeamId(CANDIDATE),
			change: "remove",
		});
		expect(review.accessDelta.projectChanges).toContainEqual({
			projectRef: expect.stringMatching(/^legacy-team-project-ref-v1:/u),
			fromProjectIdentity: PROJECT_B,
			toProjectIdentity: null,
			change: "remove",
		});
		expect(review.accessDeltaDigest).toBe(
			recipientPolicyDigest("legacy-team-access-delta", review.accessDelta),
		);
		expect(result).toMatchObject({ status: "completed" });
		expect(
			db
				.prepare("SELECT status FROM project_recipients WHERE canonical_project_identity = ?")
				.pluck()
				.get(PROJECT_B),
		).toBe("revoked");
		expect(
			db
				.prepare("SELECT status FROM project_recipients WHERE canonical_project_identity = ?")
				.pluck()
				.get(PROJECT_A),
		).toBe("active");
		// The dropped Project's setup-owned mapping is reconciled away as well:
		// scope stamping resolves mappings independently of recipient status,
		// so a surviving row would keep routing the dropped Project's new
		// sessions into the coordinator scope.
		expect(
			db
				.prepare(
					`SELECT COUNT(*) FROM project_scope_mappings
					 WHERE workspace_identity = ? AND source = 'reviewed_team_setup'`,
				)
				.pluck()
				.get(PROJECT_B),
		).toBe(0);
		expect(
			db
				.prepare(
					`SELECT COUNT(*) FROM project_scope_mappings
					 WHERE workspace_identity = ? AND source = 'reviewed_team_setup'`,
				)
				.pluck()
				.get(PROJECT_A),
		).toBe(1);
	});

	it("preserves a dropped-pattern setup mapping owned by another coordinator group", async () => {
		// Arrange: establish this group's setup, then add a setup-owned mapping
		// for another group whose pattern is absent from the repeat draft. The
		// canonical preflight only examines current draft patterns, so cleanup's
		// ownership filter is the protection under test.
		await finish(readyDraft());
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id,
			 membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-other-group-dropped', 'Other Group', 'team', 'coordinator',
			 'coordinator-other', 'group-other', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
		const foreignProject = "https://git.example.invalid/other/dropped.git";
		db.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, 'unmapped:other-dropped', 'scope-other-group-dropped', 1000,
			 'reviewed_team_setup', ?, ?)`,
		).run(foreignProject, NOW, NOW);
		let draft = refreshLegacyTeamSetupDraft(db, {
			...snapshot(),
			projects: [snapshot().projects[0] as ReturnType<typeof snapshot>["projects"][number]],
		});
		for (const device of draft.devices) {
			const identityId = device.displayName === "Laptop" ? "identity-a" : "identity-b";
			draft = setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				targetIdentityId: identityId,
				expectation: device.expectation,
				now: NOW,
			});
			draft = setLegacyTeamSetupDeviceDecision(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				decision: "included",
				now: NOW,
			});
		}
		const review = preview(draft);

		// Act
		await finish(draft, review);

		// Assert: neither simulation nor commit treats another group's mapping
		// as this setup's dropped mapping.
		expect(review.accessDelta.projectChanges).not.toContainEqual(
			expect.objectContaining({ fromProjectIdentity: foreignProject, change: "remove" }),
		);
		expect(
			db
				.prepare(
					`SELECT workspace_identity, project_pattern, scope_id, source
					 FROM project_scope_mappings WHERE scope_id = 'scope-other-group-dropped'`,
				)
				.get(),
		).toEqual({
			workspace_identity: foreignProject,
			project_pattern: "unmapped:other-dropped",
			scope_id: "scope-other-group-dropped",
			source: "reviewed_team_setup",
		});
	});

	it("finishes when an excluded device carries a revoked assignment", async () => {
		// Arrange: the inactive row stores an identity as review evidence, but
		// draft creation fingerprints it as unassigned; the finish-time roster
		// freshness gate must apply the same rule or an unchanged roster would
		// always mismatch and the setup could never complete.
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision,
			 migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-b', 'identity-b', 'Desktop', 'revoked', 'test', 'r1',
			 'projected', 2, 'revoked-device-b', ?, ?)`,
		).run(NOW, NOW);
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		for (const device of draft.devices) {
			if (device.displayName === "Laptop") {
				draft = setLegacyTeamSetupDeviceAssignment(db, {
					attemptId: draft.attemptId,
					deviceRef: device.deviceRef,
					targetIdentityId: "identity-a",
					expectation: device.expectation,
					now: NOW,
				});
				draft = setLegacyTeamSetupDeviceDecision(db, {
					attemptId: draft.attemptId,
					deviceRef: device.deviceRef,
					decision: "included",
					now: NOW,
				});
			} else {
				draft = setLegacyTeamSetupDeviceDecision(db, {
					attemptId: draft.attemptId,
					deviceRef: device.deviceRef,
					decision: "excluded",
					now: NOW,
				});
			}
		}
		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: PROJECT_B,
			now: NOW,
		});
		expect(draft.canFinish).toBe(true);

		// Act
		const result = await finish(draft);

		// Assert
		expect(result).toMatchObject({ status: "completed" });
	});

	it("rejects the finish when the displayed Project inventory changed after preview", async () => {
		// Arrange: a Project appears in the live inventory after the preview —
		// committing would confirm a digest for an inventory the user never
		// reviewed, and discovery would immediately replace the completion.
		const draft = readyDraft();
		const review = preview(draft);
		const grown = vi.fn(() => [
			...draftProjectInventory(draft.attemptId),
			{
				projectRef: "project-ref-new",
				sourceProjectIdentity: "https://git.example.invalid/acme/new.git",
				displayName: "New",
				sourceFingerprint: "source-new",
				deterministicProjectIdentity: "https://git.example.invalid/acme/new.git",
			},
		]);

		// Act + Assert
		await expect(
			finish(
				draft,
				review,
				vi.fn(async () => roster),
				grown,
			),
		).rejects.toThrow("team_setup_projection_changed");
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		expect(
			db
				.prepare("SELECT state FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(draft.attemptId),
		).toBe("stale");
	});

	it("rejects activation when a higher-priority mapping already claims the resolved Project", async () => {
		// Arrange: an exact mapping for PROJECT_B with priority above the
		// setup-created 1000 but a different pattern and foreign scope wins
		// selection; completing anyway would attach the Team recipient while
		// replication stays directed at the other boundary.
		db.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 'scope-foreign', 5000, 'test', ?, ?)`,
		).run(PROJECT_B, "other-pattern", NOW, NOW);
		const draft = readyDraft();

		// Act + Assert
		await expect(finish(draft)).rejects.toThrow("team_setup_conflict");
		expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
		expect(
			db
				.prepare("SELECT COUNT(*) FROM project_scope_mappings WHERE source = 'reviewed_team_setup'")
				.pluck()
				.get(),
		).toBe(0);
	});

	it("reads as Ready in candidate discovery after activation completes", async () => {
		// Arrange: the full seam — activation writes assignments, mappings
		// (including an explicit unmapped resolution), recipients, and the
		// post-activation roster fingerprint; discovery must then converge on
		// Ready instead of replacing the completed attempt.
		const candidateId = legacyTeamCandidateId("coordinator-private", "group-private");
		let draft = refreshLegacyTeamSetupDraft(db, { ...snapshot(), candidateId });
		for (const device of draft.devices) {
			const identityId = device.displayName === "Laptop" ? "identity-a" : "identity-b";
			draft = setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				targetIdentityId: identityId,
				expectation: device.expectation,
				now: NOW,
			});
			draft = setLegacyTeamSetupDeviceDecision(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				decision: "included",
				now: NOW,
			});
		}
		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: PROJECT_B,
			now: NOW,
		});

		// Act
		const result = await finish(draft);
		const [candidate] = discoverLegacyTeamCandidates(db, {
			projection: { localActorId: "identity-a", localDeviceId: "device-a" },
			groups: [
				{
					coordinatorId: "coordinator-private",
					groupId: "group-private",
					displayName: "Engineering",
					devices: roster,
				},
			],
			now: NOW,
		});

		// Assert
		expect(result).toMatchObject({ status: "completed" });
		expect(candidate).toMatchObject({ status: "ready", projectCount: 2 });
		expect(latestLegacyTeamSetupAttempt(db, candidateId)?.attemptId).toBe(draft.attemptId);
	});

	it("completes setup for a configured group without displayed Projects", async () => {
		// Arrange: no displayed Projects and no local active scope row — a
		// zero-Project completion writes no mappings, so activation must not
		// demand a scope the group has not replicated locally yet.
		db.prepare("DELETE FROM replication_scopes").run();
		let draft = refreshLegacyTeamSetupDraft(db, { ...snapshot(), projects: [] });
		for (const device of draft.devices) {
			const identityId = device.displayName === "Laptop" ? "identity-a" : "identity-b";
			draft = setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				targetIdentityId: identityId,
				expectation: device.expectation,
				now: NOW,
			});
			draft = setLegacyTeamSetupDeviceDecision(db, {
				attemptId: draft.attemptId,
				deviceRef: device.deviceRef,
				decision: "included",
				now: NOW,
			});
		}
		expect(draft.canFinish).toBe(true);
		const review = preview(draft);

		// Act
		const result = await finish(draft, review);

		// Assert
		expect(result).toMatchObject({ status: "completed" });
		expect(db.prepare("SELECT device_eligibility_mode FROM policy_teams").pluck().get()).toBe(
			"reviewed_allowlist",
		);
		expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM project_scope_mappings").pluck().get()).toBe(0);
	});

	it("permits and normalizes legacy active invite memberships during repeat setup", async () => {
		// Arrange
		await finish(readyDraft());
		const teamId = deterministicPolicyTeamId(CANDIDATE);
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-legacy-invite', 'Legacy Invitee', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		// Written as `active` by the pre-reviewed production invite path.
		db.prepare(
			`INSERT INTO policy_team_memberships(
			 team_id, identity_id, role, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-legacy-invite', 'member', 'active', 'coordinator_invite',
			 'legacy-invite-r1', 'user_managed', 'legacy-invite-membership', ?, ?)`,
		).run(teamId, NOW, NOW);
		const secondDraft = readyDraft();
		const review = preview(secondDraft);

		// Act
		const result = await finish(secondDraft, review);

		// Assert
		expect(review.accessDelta.membershipChanges).toContainEqual({
			teamId,
			identityId: "identity-legacy-invite",
			change: "update",
		});
		expect(result).toMatchObject({ status: "completed", teamId });
		expect(
			db
				.prepare(
					`SELECT status, provenance FROM policy_team_memberships
					 WHERE team_id = ? AND identity_id = 'identity-legacy-invite'`,
				)
				.get(teamId),
		).toEqual({ status: "reviewed_active", provenance: "coordinator_invite" });
	});

	it("blocks activation when the reviewed target scope is no longer active", async () => {
		// Arrange
		const draft = readyDraft();
		const review = preview(draft);
		db.prepare(
			"UPDATE replication_scopes SET status = 'retired' WHERE scope_id = 'scope-engineering'",
		).run();
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id,
			 membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-replacement', 'Replacement', 'team', 'coordinator',
			 'coordinator-private', 'group-private', 1, 'active', ?, ?)`,
		).run(NOW, NOW);

		// Act
		const operation = finish(draft, review);

		// Assert
		await expect(operation).rejects.toThrow("team_setup_conflict");
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
	});

	it("preserves invite ownership of decisions for devices in the setup draft", async () => {
		// Arrange
		await finish(readyDraft());
		const teamId = deterministicPolicyTeamId(CANDIDATE);
		db.prepare(
			`UPDATE policy_team_device_decisions
			 SET provenance = 'coordinator_invite', revision = 'invite-decision-r1'
			 WHERE team_id = ? AND device_id = 'device-b'`,
		).run(teamId);
		const secondDraft = readyDraft();

		// Act
		await finish(secondDraft);

		// Assert
		expect(
			db
				.prepare(
					`SELECT decision, provenance, revision FROM policy_team_device_decisions
					 WHERE team_id = ? AND device_id = 'device-b'`,
				)
				.get(teamId),
		).toEqual({
			decision: "included",
			provenance: "coordinator_invite",
			revision: "invite-decision-r1",
		});
	});

	it("rejects repeat setup while a preserved invite member's person is defunct", async () => {
		// Arrange
		await finish(readyDraft());
		const teamId = deterministicPolicyTeamId(CANDIDATE);
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-defunct', 'Defunct Invitee', 0, 'deactivated', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_memberships(
			 team_id, identity_id, role, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-defunct', 'member', 'reviewed_active', 'team_invite',
			 'invite-r1', 'user_managed', 'defunct-membership', ?, ?)`,
		).run(teamId, NOW, NOW);
		const secondDraft = readyDraft();

		// Act
		const operation = () => preview(secondDraft);

		// Assert
		expect(operation).toThrow("team_setup_conflict");
	});

	it("preserves invite-owned membership metadata for included members on repeat setup", async () => {
		// Arrange
		await finish(readyDraft());
		const teamId = deterministicPolicyTeamId(CANDIDATE);
		db.prepare(
			`UPDATE policy_team_memberships
			 SET provenance = 'team_invite', revision = 'invite-revision',
			     source_fingerprint = 'invite-source', migration_state = 'user_managed'
			 WHERE team_id = ? AND identity_id = 'identity-b'`,
		).run(teamId);
		const secondDraft = readyDraft();

		// Act
		await finish(secondDraft);

		// Assert
		expect(
			db
				.prepare(
					`SELECT provenance, revision, source_fingerprint, migration_state, status
					 FROM policy_team_memberships WHERE team_id = ? AND identity_id = 'identity-b'`,
				)
				.get(teamId),
		).toEqual({
			provenance: "team_invite",
			revision: "invite-revision",
			source_fingerprint: "invite-source",
			migration_state: "user_managed",
			status: "reviewed_active",
		});
	});

	it("restores the Team fingerprint after a repeat-setup device reassignment", async () => {
		// Arrange
		const firstDraft = readyDraft();
		await finish(firstDraft);
		let secondDraft = readyDraft();
		const reassignedDevice = secondDraft.devices.find((device) => device.displayName === "Desktop");
		if (!reassignedDevice) throw new Error("invalid activation fixture");
		secondDraft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: secondDraft.attemptId,
			deviceRef: reassignedDevice.deviceRef,
			targetIdentityId: "identity-a",
			expectation: reassignedDevice.expectation,
			now: NOW,
		});
		secondDraft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: secondDraft.attemptId,
			deviceRef: reassignedDevice.deviceRef,
			decision: "included",
			now: NOW,
		});

		// Act
		const result = await finish(secondDraft);

		// Assert
		expect(result).toMatchObject({ status: "completed" });
		// The stored fingerprint reflects the post-activation assignments so the
		// next discovery, which sees device-b assigned to identity-a, matches.
		const postFingerprint = legacyTeamRosterFingerprint(
			roster.map((device) => ({
				deviceId: device.deviceId,
				fingerprint: device.fingerprint,
				enabled: device.enabled,
				identityId: "identity-a",
			})),
		);
		expect(
			db
				.prepare("SELECT source_fingerprint FROM policy_teams WHERE team_id = ?")
				.pluck()
				.get(result.teamId),
		).toBe(postFingerprint);
		expect(
			db
				.prepare("SELECT roster_fingerprint FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(secondDraft.attemptId),
		).toBe(postFingerprint);
		expect(
			db
				.prepare("SELECT identity_id FROM identity_devices WHERE device_id = 'device-b'")
				.pluck()
				.get(),
		).toBe("identity-a");
	});

	it("includes cross-Team revocations from device reassignment in the confirmed delta", async () => {
		// Arrange
		const otherProject = "https://git.example.invalid/acme/other-team.git";
		const firstDraft = readyDraft();
		await finish(firstDraft);
		const otherTeamId = "policy-team-v1:other";
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, device_eligibility_mode, provenance, revision,
			 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Other Team', 'active', 'reviewed_allowlist', 'reviewed_team_candidate',
			 'other-r1', 'completed', 'other-roster', 'other-team', ?, ?)`,
		).run(otherTeamId, NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_memberships(
			 team_id, identity_id, role, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-b', 'member', 'reviewed_active', 'reviewed_active', 'other-r1',
			 'completed', 'other-membership', ?, ?)`,
		).run(otherTeamId, NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
			 team_id, device_id, decision, assignment_version, provenance, revision, created_at, updated_at
			 ) VALUES (?, 'device-b', 'included', 0, 'reviewed_team_setup', 'other-r1', ?, ?)`,
		).run(otherTeamId, NOW, NOW);
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', 'other-r1', 'completed',
			 'other-edge', ?, ?)`,
		).run(otherProject, otherTeamId, NOW, NOW);
		// A second project keeps device-b effective through a direct identity
		// path after the reassignment, so it must not report a removal.
		const coveredProject = "https://git.example.invalid/acme/covered.git";
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', 'other-r1', 'completed',
			 'covered-team-edge', ?, ?)`,
		).run(coveredProject, otherTeamId, NOW, NOW);
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity', 'identity-a', 'active', 'user', 'other-r1', 'completed',
			 'covered-identity-edge', ?, ?)`,
		).run(coveredProject, NOW, NOW);
		let secondDraft = readyDraft();
		const reassignedDevice = secondDraft.devices.find((device) => device.displayName === "Desktop");
		if (!reassignedDevice) throw new Error("invalid activation fixture");
		secondDraft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: secondDraft.attemptId,
			deviceRef: reassignedDevice.deviceRef,
			targetIdentityId: "identity-a",
			expectation: reassignedDevice.expectation,
			now: NOW,
		});
		secondDraft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: secondDraft.attemptId,
			deviceRef: reassignedDevice.deviceRef,
			decision: "included",
			now: NOW,
		});

		// Act
		const review = preview(secondDraft);
		await finish(secondDraft, review);

		// Assert
		expect(review.accessDelta.deviceAccessChanges).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: otherProject,
				deviceId: "device-b",
				change: "remove",
			}),
		);
		expect(review.accessDelta.deviceAccessChanges).not.toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: coveredProject,
				deviceId: "device-b",
			}),
		);
		expect(
			db
				.prepare(
					"SELECT decision FROM policy_team_device_decisions WHERE team_id = ? AND device_id = 'device-b'",
				)
				.pluck()
				.get(otherTeamId),
		).toBe("unresolved");
	});

	it("reuses the canonical Team for repeat setup without dropping existing recipient edges", async () => {
		// Arrange
		const firstDraft = readyDraft();
		const first = await finish(firstDraft);
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES ('https://git.example.invalid/acme/preserved.git', 'team', ?, 'active',
			 'review_resolution', 'historical', 'completed', 'preserved-edge', ?, ?)`,
		).run(first.teamId, NOW, NOW);
		const secondDraft = readyDraft();

		// Act
		const second = await finish(secondDraft);

		// Assert
		expect(second.teamId).toBe(first.teamId);
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(1);
		expect(
			db
				.prepare("SELECT status FROM project_recipients WHERE idempotency_key = 'preserved-edge'")
				.pluck()
				.get(),
		).toBe("active");
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_completions").pluck().get()).toBe(2);
	});
});
