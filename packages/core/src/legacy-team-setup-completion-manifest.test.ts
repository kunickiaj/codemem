import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import {
	applyAdditiveCanonicalLegacyTeamSetupProjectsInTransaction,
	applyCanonicalLegacyTeamSetupActivationInTransaction,
	finishLegacyTeamSetupActivation,
	inspectLegacyTeamSetupActivation,
	requireLegacyTeamSetupAccessDeltaWithinLimit,
} from "./legacy-team-setup-activation.js";
import {
	applyLegacyTeamSetupCompletionManifest,
	areLegacyTeamSetupCompletionPolicyFactsAdditivelyCompatible,
	deriveLegacyTeamSetupCompletionManifest,
	LegacyTeamSetupAdditiveConvergenceError,
	reconstructLegacyTeamSetupCompletionManifest,
	validateLegacyTeamSetupCompletionManifest,
	validateLegacyTeamSetupCompletionManifestBinding,
} from "./legacy-team-setup-completion-manifest.js";
import {
	legacyTeamResolvedProjectRef,
	refreshLegacyTeamSetupDraft,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
} from "./legacy-team-setup-draft.js";
import {
	legacyTeamCandidateId,
	legacyTeamProjectRef,
	recipientPolicyDigest,
} from "./recipient-policy-identifiers.js";
import { renameRecipientPolicyTeam } from "./recipient-policy-team-metadata.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-09-01T12:00:00.000Z";
const COORDINATOR_ID = "coordinator-private";
const GROUP_ID = "group-private";
const CANDIDATE = legacyTeamCandidateId(COORDINATOR_ID, GROUP_ID);
const PROJECT_A = "https://git.example.invalid/acme/api.git";
const PROJECT_B = "https://git.example.invalid/acme/web.git";
const PROJECT_C = "https://git.example.invalid/acme/new.git";
const PROJECT_REF_A = legacyTeamProjectRef(CANDIDATE, PROJECT_A);
const PROJECT_REF_C = legacyTeamProjectRef(CANDIDATE, PROJECT_C);
const KEY_A = "a".repeat(64);
const FRESH_ROSTER = [
	{ deviceId: "device-a", fingerprint: KEY_A, displayName: "Laptop", enabled: true },
];

function rawDigest(domain: string, value: unknown): string {
	return recipientPolicyDigest(domain, value).slice(domain.length + 1);
}

function refreshManifestDigests(
	manifest: CoordinatorLegacyTeamCompletionManifestV1,
): CoordinatorLegacyTeamCompletionManifestV1 {
	const candidateDigest = rawDigest("legacy-team-completion-candidate-v1", {
		coordinatorId: COORDINATOR_ID,
		groupId: GROUP_ID,
		candidateRef: manifest.candidate_ref,
	});
	const teamDigest = rawDigest("legacy-team-completion-team-v1", {
		teamId: manifest.team_id,
		displayName: manifest.team.display_name,
		deviceEligibilityMode: manifest.team.device_eligibility_mode,
	});
	const sourceDigest = rawDigest("legacy-team-completion-source-v1", {
		deviceDecisions: manifest.device_decisions,
		projectMappings: manifest.project_mappings,
	});
	const accessDeltaDigest = rawDigest("legacy-team-completion-access-delta-v1", {
		memberships: manifest.memberships,
		projectRecipients: manifest.project_recipients,
	});
	const finishDigest = rawDigest("legacy-team-completion-finish-v1", {
		candidateDigest,
		teamDigest,
		sourceDigest,
		accessDeltaDigest,
	});
	return {
		...manifest,
		candidate_digest: candidateDigest,
		team_digest: teamDigest,
		source_digest: sourceDigest,
		access_delta_digest: accessDeltaDigest,
		finish_digest: finishDigest,
		team: {
			...manifest.team,
			policy_revision: rawDigest("legacy-team-completion-policy-revision-v1", finishDigest),
		},
	};
}

describe("legacy Team setup completion manifests", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-a', 'Person A', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id,
			 membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-engineering', 'Engineering', 'team', 'coordinator', ?, ?, 1,
			 'active', ?, ?)`,
		).run(COORDINATOR_ID, GROUP_ID, NOW, NOW);
	});

	afterEach(() => db.close());

	function readyDraft() {
		let draft = refreshLegacyTeamSetupDraft(db, {
			candidateId: CANDIDATE,
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			displayName: "Engineering",
			devices: [
				{
					deviceId: "device-a",
					fingerprint: KEY_A,
					displayName: "Laptop",
					enabled: true,
				},
			],
			projects: [],
			now: NOW,
		});
		const device = draft.devices[0];
		if (!device) throw new Error("missing test device");
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			targetIdentityId: "identity-a",
			expectation: device.expectation,
			now: NOW,
		});
		return setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			decision: "included",
			now: NOW,
		});
	}

	it("accepts bounded access delta categories whose aggregate exceeds 10,000", () => {
		expect(() =>
			requireLegacyTeamSetupAccessDeltaWithinLimit({
				teamChanges: [
					{
						teamId: "team-a",
						change: "add",
						fromDeviceEligibilityMode: null,
						toDeviceEligibilityMode: "reviewed_allowlist",
					},
				],
				membershipChanges: [],
				projectChanges: [],
				recipientChanges: [],
				deviceAccessChanges: Array.from({ length: 10_000 }, (_, index) => ({
					canonicalProjectIdentity: `project-${Math.floor(index / 500)}`,
					deviceId: `device-${index % 500}`,
					change: "add" as const,
				})),
			}),
		).not.toThrow();
	});

	it("rejects an oversized canonical activation delta", () => {
		expect(() =>
			requireLegacyTeamSetupAccessDeltaWithinLimit({
				teamChanges: Array.from({ length: 10_001 }, (_, index) => ({
					teamId: `team-${index}`,
					change: "add",
					fromDeviceEligibilityMode: null,
					toDeviceEligibilityMode: "reviewed_allowlist",
				})),
				membershipChanges: [],
				projectChanges: [],
				recipientChanges: [],
				deviceAccessChanges: [],
			}),
		).toThrow("team_setup_completion_invalid");
	});

	it("rejects a pre-limit completed attempt without reading past the device cap", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest,
		});
		// Simulate a historical completion persisted before the device cap.
		const insertDevice = db.prepare(
			`INSERT INTO legacy_team_setup_draft_devices(
			 attempt_id, device_id, device_ref, key_fingerprint, display_name, enabled,
			 existing_identity_id, existing_assignment_version, verified_evidence_kind,
			 decision, target_identity_id, expected_assignment_kind,
			 expected_assignment_version, updated_at
			 ) VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, NULL, 'excluded', NULL, 'absent', NULL, ?)`,
		);
		db.transaction(() => {
			for (let index = 0; index < 600; index += 1) {
				insertDevice.run(
					draft.attemptId,
					`device-legacy-${index.toString().padStart(4, "0")}`,
					`device-ref-legacy-${index}`,
					index.toString(16).padStart(64, "0"),
					`Legacy ${index}`,
					NOW,
				);
			}
		})();
		const originalPrepare = db.prepare.bind(db);
		const materializedDeviceRows: number[] = [];
		db.prepare = ((source: string) => {
			const statement = originalPrepare(source);
			if (!source.includes("FROM legacy_team_setup_draft_devices WHERE attempt_id = ?")) {
				return statement;
			}
			const originalAll = statement.all.bind(statement);
			statement.all = ((...args: unknown[]) => {
				const rows = originalAll(...args);
				materializedDeviceRows.push(rows.length);
				return rows;
			}) as typeof statement.all;
			return statement;
		}) as typeof db.prepare;

		expect(() =>
			reconstructLegacyTeamSetupCompletionManifest(db, { candidateRef: CANDIDATE }),
		).toThrow("team_setup_completion_invalid");
		expect(materializedDeviceRows).toEqual([501]);
	});

	it("rejects a pre-limit draft during full replacement without reading past the Project cap", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		const insertProject = db.prepare(
			`INSERT INTO legacy_team_setup_draft_projects(
			 attempt_id, project_ref, source_project_identity, display_name, source_fingerprint,
			 resolution_kind, resolved_project_identity, target_scope_id, updated_at
			 ) VALUES (?, ?, ?, ?, ?, 'explicit', ?, 'scope-a', ?)`,
		);
		db.transaction(() => {
			for (let index = 0; index < 600; index += 1) {
				const identity = `https://git.example.invalid/acme/legacy-${index.toString().padStart(4, "0")}.git`;
				insertProject.run(
					draft.attemptId,
					legacyTeamProjectRef(CANDIDATE, identity),
					identity,
					`Legacy ${index}`,
					`legacy-${index}`,
					identity,
					NOW,
				);
			}
		})();
		const originalPrepare = db.prepare.bind(db);
		const materializedProjectRows: number[] = [];
		db.prepare = ((source: string) => {
			const statement = originalPrepare(source);
			if (!source.includes("FROM legacy_team_setup_draft_projects WHERE attempt_id = ?")) {
				return statement;
			}
			const originalAll = statement.all.bind(statement);
			statement.all = ((...args: unknown[]) => {
				const rows = originalAll(...args);
				materializedProjectRows.push(rows.length);
				return rows;
			}) as typeof statement.all;
			return statement;
		}) as typeof db.prepare;

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).rejects.toThrow("team_setup_completion_invalid");
		expect(materializedProjectRows.every((count) => count <= 501)).toBe(true);
		expect(materializedProjectRows.length).toBeGreaterThan(0);
	});

	it("requires canonical activation helpers to run inside a transaction", () => {
		const draft = readyDraft();

		expect(() =>
			applyCanonicalLegacyTeamSetupActivationInTransaction(db, {
				candidateRef: draft.candidateRef,
				attemptId: draft.attemptId,
				policyRevision: "canonical-revision",
				completedAt: NOW,
				completionKey: "canonical-completion-key",
			}),
		).toThrow("team_setup_failed");
		expect(() =>
			applyAdditiveCanonicalLegacyTeamSetupProjectsInTransaction(db, {
				candidateRef: draft.candidateRef,
				attemptId: draft.attemptId,
				teamId: "policy-team-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				projectRefs: [],
				completedAt: NOW,
			}),
		).toThrow("team_setup_failed");
	});

	it("derives and validates bounded canonical policy facts", () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});

		expect(
			validateLegacyTeamSetupCompletionManifest(manifest, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
			}),
		).toEqual(manifest);
		expect(manifest.memberships).toEqual([{ identity_id: "identity-a", role: "member" }]);
		expect(manifest.finish_digest).toMatch(/^[0-9a-f]{64}$/u);
		expect(manifest.access_delta_digest).toMatch(/^[0-9a-f]{64}$/u);
		expect(manifest.device_decisions).toEqual([
			{
				device_id: "device-a",
				key_fingerprint: KEY_A,
				enabled: true,
				identity_id: "identity-a",
				decision: "included",
			},
		]);
	});

	it("rejects a validly digested manifest above the Project-device pair limit", () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		const deviceDecisions = Array.from({ length: 101 }, (_, index) => ({
			device_id: `device-${index.toString().padStart(3, "0")}`,
			key_fingerprint: index.toString(16).padStart(64, "0"),
			enabled: true,
			identity_id: "identity-a",
			decision: "included" as const,
		}));
		const projectMappings = Array.from({ length: 100 }, (_, index) => {
			const sourceIdentity = `https://git.example.invalid/acme/project-${index
				.toString()
				.padStart(3, "0")}.git`;
			const projectRef = legacyTeamProjectRef(CANDIDATE, sourceIdentity);
			return {
				project_ref: projectRef,
				resolved_project_ref: legacyTeamResolvedProjectRef(projectRef, sourceIdentity),
				scope_id: "scope-a",
			};
		}).toSorted((left, right) => left.project_ref.localeCompare(right.project_ref));
		const projectRecipients = projectMappings
			.map((mapping) => ({
				resolved_project_ref: mapping.resolved_project_ref,
				team_id: manifest.team_id,
			}))
			.toSorted((left, right) =>
				left.resolved_project_ref.localeCompare(right.resolved_project_ref),
			);
		const oversized = refreshManifestDigests({
			...manifest,
			device_decisions: deviceDecisions,
			project_mappings: projectMappings,
			project_recipients: projectRecipients,
		});

		expect(() =>
			validateLegacyTeamSetupCompletionManifest(oversized, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
			}),
		).toThrow("team_setup_completion_invalid");
	});

	it("rejects a digest or coordinator-group mismatch", () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});

		expect(() =>
			validateLegacyTeamSetupCompletionManifest(
				{ ...manifest, source_digest: "0".repeat(64) },
				{ coordinatorId: COORDINATOR_ID, groupId: GROUP_ID },
			),
		).toThrow("team_setup_completion_invalid");
		expect(() =>
			validateLegacyTeamSetupCompletionManifest(manifest, {
				coordinatorId: COORDINATOR_ID,
				groupId: "other-group",
			}),
		).toThrow("team_setup_completion_invalid");
	});

	it("proves coordinator-group binding without requiring valid digests", () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		const digestInvalidManifest = { ...manifest, finish_digest: "0".repeat(64) };

		expect(
			validateLegacyTeamSetupCompletionManifestBinding(digestInvalidManifest, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
			}),
		).toEqual(digestInvalidManifest);
		expect(() =>
			validateLegacyTeamSetupCompletionManifestBinding(manifest, {
				coordinatorId: COORDINATOR_ID,
				groupId: "other-group",
			}),
		).toThrow("team_setup_completion_invalid");
	});

	it("rejects policy collections that do not match their canonical source facts", () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});

		expect(() =>
			validateLegacyTeamSetupCompletionManifest(
				{ ...manifest, memberships: [] },
				{ coordinatorId: COORDINATOR_ID, groupId: GROUP_ID },
			),
		).toThrow("team_setup_completion_invalid");
		expect(() =>
			validateLegacyTeamSetupCompletionManifest(
				{
					...manifest,
					project_recipients: [
						{ resolved_project_ref: "unexpected-project", team_id: manifest.team_id },
					],
				},
				{ coordinatorId: COORDINATOR_ID, groupId: GROUP_ID },
			),
		).toThrow("team_setup_completion_invalid");
	});

	it("applies atomically and treats the same manifest as an exact replay", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		const localPreview = inspectLegacyTeamSetupActivation(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
		});
		db.prepare("UPDATE legacy_team_setup_drafts SET display_name = ? WHERE attempt_id = ?").run(
			"Stale local name",
			draft.attemptId,
		);

		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest,
		});
		const localCompletion = db
			.prepare(
				`SELECT finish_digest, confirmed_access_delta_digest
				 FROM legacy_team_setup_completions WHERE attempt_id = ?`,
			)
			.get(draft.attemptId) as {
			finish_digest: string;
			confirmed_access_delta_digest: string;
		};
		expect(localCompletion).toEqual({
			finish_digest: localPreview.finishDigest,
			confirmed_access_delta_digest: localPreview.accessDeltaDigest,
		});
		expect(localCompletion.finish_digest).toMatch(
			/^legacy-team-activation-finish-v1:[0-9a-f]{64}$/u,
		);
		expect(localCompletion.confirmed_access_delta_digest).toMatch(
			/^legacy-team-access-delta:[0-9a-f]{64}$/u,
		);
		expect(localCompletion.finish_digest).not.toBe(manifest.finish_digest);
		expect(localCompletion.confirmed_access_delta_digest).not.toBe(manifest.access_delta_digest);
		expect(
			db
				.prepare("SELECT display_name FROM policy_teams WHERE team_id = ?")
				.pluck()
				.get(manifest.team_id),
		).toBe(manifest.team.display_name);
		expect(reconstructLegacyTeamSetupCompletionManifest(db, { candidateRef: CANDIDATE })).toEqual(
			manifest,
		);
		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).resolves.toEqual(manifest);
		expect(reconstructLegacyTeamSetupCompletionManifest(db, { candidateRef: CANDIDATE })).toEqual(
			manifest,
		);
		expect(
			db
				.prepare("SELECT state FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(draft.attemptId),
		).toBe("completed");
	});

	it("preserves inactive assignment evidence when applying an excluded device", async () => {
		let draft = readyDraft();
		const device = draft.devices[0];
		if (!device) throw new Error("missing test device");
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			decision: "excluded",
			now: NOW,
		});
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		db.prepare(
			`INSERT INTO identity_devices(
			 identity_id, device_id, display_name, status, provenance, revision, migration_state,
			 assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('identity-a', 'device-a', 'Laptop', 'revoked', 'reviewed_team_setup',
			 'prior-revision', 'completed', 7, 'prior-device-assignment', ?, ?)`,
		).run(NOW, NOW);

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: [],
				manifest,
			}),
		).resolves.toEqual(manifest);
		expect(
			db
				.prepare(
					`SELECT display_name, existing_identity_id, existing_assignment_version, verified_evidence_kind,
					        expected_assignment_kind, expected_assignment_version
					 FROM legacy_team_setup_draft_devices
					 WHERE attempt_id = ? AND device_id = 'device-a'`,
				)
				.get(draft.attemptId),
		).toEqual({
			display_name: "Laptop",
			existing_identity_id: "identity-a",
			existing_assignment_version: 7,
			verified_evidence_kind: null,
			expected_assignment_kind: "existing",
			expected_assignment_version: 7,
		});
		expect(
			db
				.prepare(
					"SELECT decision FROM policy_team_device_decisions WHERE team_id = ? AND device_id = 'device-a'",
				)
				.pluck()
				.get(manifest.team_id),
		).toBe("excluded");
	});

	it("refreshes an existing draft device label from the live roster", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		db.prepare(
			"UPDATE legacy_team_setup_draft_devices SET display_name = ? WHERE attempt_id = ?",
		).run("Stale laptop", draft.attemptId);

		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: [
				{
					deviceId: "device-a",
					fingerprint: KEY_A,
					displayName: "  Renamed laptop  ",
					enabled: true,
				},
			],
			manifest,
		});

		expect(
			db
				.prepare(
					"SELECT display_name FROM legacy_team_setup_draft_devices WHERE attempt_id = ? AND device_id = 'device-a'",
				)
				.pluck()
				.get(draft.attemptId),
		).toBe("Renamed laptop");
		expect(
			db
				.prepare("SELECT display_name FROM identity_devices WHERE device_id = 'device-a'")
				.pluck()
				.get(),
		).toBe("Renamed laptop");
	});

	it("applies a canonical completion over a stale local draft", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		db.prepare("UPDATE legacy_team_setup_drafts SET state = 'stale' WHERE attempt_id = ?").run(
			draft.attemptId,
		);

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).resolves.toEqual(manifest);
		expect(
			db
				.prepare("SELECT state FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(draft.attemptId),
		).toBe("completed");
	});

	it("materializes missing canonical devices and removes newer local membership grants", async () => {
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-b', 'Person B', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		const source = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: source.candidateRef,
			attemptId: source.attemptId,
			completedAt: NOW,
		});
		let replacement = refreshLegacyTeamSetupDraft(db, {
			candidateId: CANDIDATE,
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			displayName: "Engineering",
			devices: [
				{
					deviceId: "device-new",
					fingerprint: "key-new",
					displayName: "New laptop",
					enabled: true,
				},
			],
			projects: [],
			now: "2026-09-01T12:01:00.000Z",
		});
		const newDevice = replacement.devices.find((device) => device.displayName === "New laptop");
		if (!newDevice) throw new Error("missing replacement device");
		replacement = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: replacement.attemptId,
			deviceRef: newDevice.deviceRef,
			targetIdentityId: "identity-b",
			expectation: newDevice.expectation,
			now: NOW,
		});
		replacement = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: replacement.attemptId,
			deviceRef: newDevice.deviceRef,
			decision: "included",
			now: NOW,
		});
		db.prepare(
			"DELETE FROM legacy_team_setup_draft_devices WHERE attempt_id = ? AND device_id = 'device-a'",
		).run(replacement.attemptId);

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).resolves.toEqual(manifest);
		expect(
			db
				.prepare(
					`SELECT identity_id, status FROM policy_team_memberships
					 WHERE team_id = ? ORDER BY identity_id`,
				)
				.all(manifest.team_id),
		).toEqual([{ identity_id: "identity-a", status: "reviewed_active" }]);
		expect(
			db
				.prepare(
					`SELECT device_id, decision FROM policy_team_device_decisions
					 WHERE team_id = ? ORDER BY device_id`,
				)
				.all(manifest.team_id),
		).toEqual([{ device_id: "device-a", decision: "included" }]);
		expect(
			db
				.prepare(
					`SELECT key_fingerprint, display_name, enabled FROM legacy_team_setup_draft_devices
					 WHERE attempt_id = ? AND device_id = 'device-a'`,
				)
				.get(replacement.attemptId),
		).toEqual({ key_fingerprint: KEY_A, display_name: "Laptop", enabled: 1 });
		expect(
			db
				.prepare(
					"SELECT device_id FROM legacy_team_setup_draft_devices WHERE attempt_id = ? ORDER BY device_id",
				)
				.pluck()
				.all(replacement.attemptId),
		).toEqual(["device-a"]);
		expect(replacement.attemptId).not.toBe(source.attemptId);
		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).resolves.toEqual(manifest);
		expect(
			db
				.prepare("SELECT state FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(replacement.attemptId),
		).toBe("completed");
	});

	it("adds newly resolvable Projects without replaying completed Team policy", async () => {
		const projectRefB = legacyTeamProjectRef(CANDIDATE, PROJECT_B);
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id,
			 membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-historical', 'Historical', 'team', 'coordinator', ?, ?, 1,
			 'active', ?, ?)`,
		).run(COORDINATOR_ID, GROUP_ID, NOW, NOW);
		let source = refreshLegacyTeamSetupDraft(db, {
			candidateId: CANDIDATE,
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			displayName: "Engineering",
			devices: [{ deviceId: "device-a", fingerprint: KEY_A, displayName: "Laptop", enabled: true }],
			projects: [
				{
					projectRef: PROJECT_REF_A,
					sourceProjectIdentity: PROJECT_A,
					displayName: "API",
					sourceFingerprint: "source-a",
					deterministicProjectIdentity: PROJECT_A,
					targetScopeId: "scope-engineering",
				},
				{
					projectRef: projectRefB,
					sourceProjectIdentity: PROJECT_B,
					displayName: "Web",
					sourceFingerprint: "source-b",
					deterministicProjectIdentity: PROJECT_B,
					targetScopeId: "scope-historical",
				},
			],
			now: NOW,
		});
		const sourceDevice = source.devices[0];
		if (!sourceDevice) throw new Error("missing source device");
		source = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: source.attemptId,
			deviceRef: sourceDevice.deviceRef,
			targetIdentityId: "identity-a",
			expectation: sourceDevice.expectation,
			now: NOW,
		});
		source = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: source.attemptId,
			deviceRef: sourceDevice.deviceRef,
			decision: "included",
			now: NOW,
		});
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: source.candidateRef,
			attemptId: source.attemptId,
			completedAt: NOW,
		});
		const replacement = refreshLegacyTeamSetupDraft(db, {
			candidateId: CANDIDATE,
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			displayName: "Engineering",
			devices: [{ deviceId: "device-a", fingerprint: KEY_A, displayName: "Laptop", enabled: true }],
			projects: [
				{
					projectRef: PROJECT_REF_A,
					sourceProjectIdentity: PROJECT_A,
					displayName: "API",
					sourceFingerprint: "source-a",
					deterministicProjectIdentity: PROJECT_A,
					targetScopeId: "scope-engineering",
				},
				{
					projectRef: PROJECT_REF_C,
					sourceProjectIdentity: PROJECT_C,
					displayName: "New Project",
					sourceFingerprint: "source-c",
					deterministicProjectIdentity: PROJECT_C,
					targetScopeId: "scope-engineering",
				},
			],
			now: "2026-09-01T12:01:00.000Z",
		});
		db.prepare("UPDATE replication_scopes SET status = 'inactive' WHERE scope_id = ?").run(
			"scope-historical",
		);

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).resolves.toEqual(manifest);
		expect(
			db
				.prepare(
					`SELECT canonical_project_identity FROM project_recipients
					 WHERE recipient_kind = 'team' AND recipient_id = ? AND status = 'active'
					 ORDER BY canonical_project_identity`,
				)
				.pluck()
				.all(manifest.team_id),
		).toEqual([PROJECT_A]);
		expect(
			db
				.prepare(
					`SELECT project_pattern, workspace_identity FROM project_scope_mappings
					 WHERE source = 'reviewed_team_setup' ORDER BY project_pattern`,
				)
				.all(),
		).toEqual([{ project_pattern: PROJECT_A, workspace_identity: PROJECT_A }]);
		expect(
			db
				.prepare(
					"SELECT project_ref FROM legacy_team_setup_draft_projects WHERE attempt_id = ? ORDER BY project_ref",
				)
				.pluck()
				.all(replacement.attemptId),
		).toEqual([PROJECT_REF_A]);
		expect(
			areLegacyTeamSetupCompletionPolicyFactsAdditivelyCompatible(
				reconstructLegacyTeamSetupCompletionManifest(db, { candidateRef: CANDIDATE }),
				manifest,
			),
		).toBe(true);
		db.prepare(
			`INSERT INTO legacy_team_setup_draft_projects(
			 attempt_id, project_ref, source_project_identity, display_name, source_fingerprint,
			 resolution_kind, resolved_project_identity, target_scope_id, updated_at
			 ) VALUES (?, ?, ?, 'Cross-scope project', 'cross-scope-source', 'explicit', ?,
			 'scope-historical', ?)`,
		).run(replacement.attemptId, projectRefB, PROJECT_B, PROJECT_A, NOW);
		const applyCrossScopeProject = db.transaction(() =>
			applyAdditiveCanonicalLegacyTeamSetupProjectsInTransaction(db, {
				candidateRef: CANDIDATE,
				attemptId: replacement.attemptId,
				teamId: manifest.team_id,
				projectRefs: [projectRefB],
				completedAt: NOW,
			}),
		);
		expect(() => applyCrossScopeProject.immediate()).toThrow("team_setup_conflict");
		db.prepare(
			"DELETE FROM legacy_team_setup_draft_projects WHERE attempt_id = ? AND project_ref = ?",
		).run(replacement.attemptId, projectRefB);
		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).resolves.toEqual(manifest);
		db.prepare(
			`UPDATE project_recipients
			 SET status = 'revoked', provenance = 'user', updated_at = ?
			 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`,
		).run("2026-09-01T12:01:30.000Z", PROJECT_A, manifest.team_id);
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-b', 'Person B', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`UPDATE identity_devices SET identity_id = 'identity-b', updated_at = ?
			 WHERE device_id = 'device-a' AND status = 'active'`,
		).run("2026-09-01T12:01:30.000Z");
		db.prepare(
			`DELETE FROM project_scope_mappings
			 WHERE project_pattern = ? AND source = 'reviewed_team_setup'`,
		).run(PROJECT_A);
		db.prepare("UPDATE replication_scopes SET status = 'active' WHERE scope_id = ?").run(
			"scope-historical",
		);
		db.prepare("INSERT INTO sessions(started_at, project, git_remote) VALUES (?, ?, ?)").run(
			NOW,
			"Web workspace",
			PROJECT_B,
		);
		db.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 'scope-engineering', 1000, 'user', ?, ?)`,
		).run(PROJECT_B, PROJECT_B, NOW, NOW);
		const completionCountBeforeFailedConvergence = db
			.prepare("SELECT COUNT(*) FROM legacy_team_setup_completions")
			.pluck()
			.get();
		let additiveFailure: unknown;
		try {
			await applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			});
		} catch (error) {
			additiveFailure = error;
		}
		expect(additiveFailure).toBeInstanceOf(LegacyTeamSetupAdditiveConvergenceError);
		expect(additiveFailure).toMatchObject({ code: "team_setup_conflict" });
		expect(
			db.prepare("SELECT status FROM policy_teams WHERE team_id = ?").pluck().get(manifest.team_id),
		).toBe("active");
		expect(
			db
				.prepare(
					"SELECT project_ref FROM legacy_team_setup_draft_projects WHERE attempt_id = ? ORDER BY project_ref",
				)
				.pluck()
				.all(replacement.attemptId),
		).toEqual([PROJECT_REF_A]);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_completions").pluck().get()).toBe(
			completionCountBeforeFailedConvergence,
		);
		db.prepare(
			"DELETE FROM project_scope_mappings WHERE workspace_identity = ? AND source = 'user'",
		).run(PROJECT_B);
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, source_fingerprint, idempotency_key,
			 created_at, updated_at
			 ) VALUES (?, 'team', ?, 'revoked', 'reviewed_team_setup', ?, 'completed', ?, ?, ?, ?)`,
		).run(
			PROJECT_B,
			manifest.team_id,
			manifest.team.policy_revision,
			"source-b",
			"revoked-before-convergence",
			NOW,
			NOW,
		);
		const insertNewerSession = db.prepare(
			"INSERT INTO sessions(started_at, project, git_remote) VALUES (?, ?, ?)",
		);
		for (let index = 0; index < 500; index += 1) {
			insertNewerSession.run(
				new Date(Date.parse(NOW) + (index + 1) * 1000).toISOString(),
				"API workspace",
				PROJECT_A,
			);
		}
		db.prepare(
			"UPDATE policy_teams SET display_name = 'Platform', revision = 'rename-revision' WHERE team_id = ?",
		).run(manifest.team_id);
		db.prepare(
			"UPDATE legacy_team_setup_drafts SET display_name = 'Platform' WHERE attempt_id = ?",
		).run(replacement.attemptId);
		const preservedTeam = db
			.prepare("SELECT * FROM policy_teams WHERE team_id = ?")
			.get(manifest.team_id);
		const preservedDraft = db
			.prepare("SELECT * FROM legacy_team_setup_drafts WHERE attempt_id = ?")
			.get(replacement.attemptId);
		const preservedCompletions = db
			.prepare(
				`SELECT * FROM legacy_team_setup_completions
				 WHERE candidate_ref = ? ORDER BY completed_at, finish_digest`,
			)
			.all(CANDIDATE);
		const preservedMemberships = db
			.prepare("SELECT * FROM policy_team_memberships WHERE team_id = ? ORDER BY identity_id")
			.all(manifest.team_id);
		const preservedDecisions = db
			.prepare("SELECT * FROM policy_team_device_decisions WHERE team_id = ? ORDER BY device_id")
			.all(manifest.team_id);
		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).resolves.toEqual(manifest);
		expect(
			db
				.prepare(
					`SELECT canonical_project_identity FROM project_recipients
					 WHERE recipient_kind = 'team' AND recipient_id = ? AND status = 'active'
					 ORDER BY canonical_project_identity`,
				)
				.pluck()
				.all(manifest.team_id),
		).toEqual([PROJECT_B]);
		expect(
			db
				.prepare(
					`SELECT project_pattern, workspace_identity FROM project_scope_mappings
					 WHERE source = 'reviewed_team_setup' ORDER BY project_pattern`,
				)
				.all(),
		).toEqual([{ project_pattern: PROJECT_B, workspace_identity: PROJECT_B }]);
		expect(
			db
				.prepare(
					`SELECT status, provenance, policy_revision FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`,
				)
				.get(PROJECT_A, manifest.team_id),
		).toEqual({
			status: "revoked",
			provenance: "user",
			policy_revision: manifest.team.policy_revision,
		});
		expect(
			db
				.prepare(
					`SELECT status, provenance, policy_revision FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`,
				)
				.get(PROJECT_B, manifest.team_id),
		).toEqual({
			status: "active",
			provenance: "reviewed_team_setup",
			policy_revision: "rename-revision",
		});
		expect(
			db
				.prepare(
					"SELECT display_name FROM legacy_team_setup_draft_projects WHERE attempt_id = ? AND project_ref = ?",
				)
				.pluck()
				.get(replacement.attemptId, projectRefB),
		).toBe("Web workspace");
		expect(
			db
				.prepare("SELECT display_name, revision FROM policy_teams WHERE team_id = ?")
				.get(manifest.team_id),
		).toEqual({ display_name: "Platform", revision: "rename-revision" });
		expect(
			db
				.prepare("SELECT display_name FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(replacement.attemptId),
		).toBe("Platform");
		expect(
			db
				.prepare("SELECT state FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(replacement.attemptId),
		).toBe("completed");
		expect(
			db
				.prepare(
					"SELECT identity_id FROM identity_devices WHERE device_id = 'device-a' AND status = 'active'",
				)
				.pluck()
				.get(),
		).toBe("identity-b");
		expect(
			db.prepare("SELECT * FROM policy_teams WHERE team_id = ?").get(manifest.team_id),
		).toEqual(preservedTeam);
		expect(
			db
				.prepare("SELECT * FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.get(replacement.attemptId),
		).toEqual(preservedDraft);
		expect(
			db
				.prepare(
					`SELECT * FROM legacy_team_setup_completions
					 WHERE candidate_ref = ? ORDER BY completed_at, finish_digest`,
				)
				.all(CANDIDATE),
		).toEqual(preservedCompletions);
		expect(
			db
				.prepare("SELECT * FROM policy_team_memberships WHERE team_id = ? ORDER BY identity_id")
				.all(manifest.team_id),
		).toEqual(preservedMemberships);
		expect(
			db
				.prepare("SELECT * FROM policy_team_device_decisions WHERE team_id = ? ORDER BY device_id")
				.all(manifest.team_id),
		).toEqual(preservedDecisions);

		const additiveFacts = {
			mappings: db.prepare("SELECT * FROM project_scope_mappings ORDER BY id").all(),
			recipients: db
				.prepare(
					`SELECT * FROM project_recipients
					 WHERE recipient_kind = 'team' AND recipient_id = ? ORDER BY canonical_project_identity`,
				)
				.all(manifest.team_id),
			projects: db
				.prepare(
					"SELECT * FROM legacy_team_setup_draft_projects WHERE attempt_id = ? ORDER BY project_ref",
				)
				.all(replacement.attemptId),
		};
		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).resolves.toEqual(manifest);
		expect({
			mappings: db.prepare("SELECT * FROM project_scope_mappings ORDER BY id").all(),
			recipients: db
				.prepare(
					`SELECT * FROM project_recipients
					 WHERE recipient_kind = 'team' AND recipient_id = ? ORDER BY canonical_project_identity`,
				)
				.all(manifest.team_id),
			projects: db
				.prepare(
					"SELECT * FROM legacy_team_setup_draft_projects WHERE attempt_id = ? ORDER BY project_ref",
				)
				.all(replacement.attemptId),
		}).toEqual(additiveFacts);
	});

	it("preserves a supported linked Team rename when reconciling the original manifest", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest,
		});
		db.prepare(
			"UPDATE policy_teams SET display_name = 'Platform', revision = 'rename-revision'",
		).run();
		db.prepare(
			"UPDATE legacy_team_setup_drafts SET display_name = 'Platform' WHERE attempt_id = ?",
		).run(draft.attemptId);

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).resolves.toEqual(manifest);
		expect(db.prepare("SELECT display_name, revision FROM policy_teams").get()).toEqual({
			display_name: "Platform",
			revision: "rename-revision",
		});
	});

	it("keeps the completion key stable across exact re-applications of a completed draft", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		const localPreview = inspectLegacyTeamSetupActivation(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
		});
		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest,
		});
		const completionKeys = () =>
			db
				.prepare(
					`SELECT draft.finish_digest AS draft_key, completion.finish_digest AS completion_key
					 FROM legacy_team_setup_drafts AS draft
					 JOIN legacy_team_setup_completions AS completion
					   ON completion.attempt_id = draft.attempt_id
					 WHERE draft.attempt_id = ?`,
				)
				.all(draft.attemptId);
		expect(completionKeys()).toEqual([
			{ draft_key: localPreview.finishDigest, completion_key: localPreview.finishDigest },
		]);

		// Force the full re-apply path (reconstruction reports a rename conflict)
		// twice: neither retry may rotate the key or append a completion row.
		for (let attempt = 0; attempt < 2; attempt += 1) {
			db.prepare("UPDATE policy_teams SET display_name = 'Platform'").run();
			db.prepare(
				"UPDATE legacy_team_setup_drafts SET display_name = 'Platform' WHERE attempt_id = ?",
			).run(draft.attemptId);
			await expect(
				applyLegacyTeamSetupCompletionManifest(db, {
					coordinatorId: COORDINATOR_ID,
					groupId: GROUP_ID,
					freshRoster: FRESH_ROSTER,
					manifest,
				}),
			).resolves.toEqual(manifest);
			expect(completionKeys()).toEqual([
				{ draft_key: localPreview.finishDigest, completion_key: localPreview.finishDigest },
			]);
		}
		await expect(
			finishLegacyTeamSetupActivation(db, {
				candidateRef: CANDIDATE,
				attemptId: draft.attemptId,
				finishDigest: localPreview.finishDigest,
				confirmedAccessDeltaDigest: localPreview.accessDeltaDigest,
				loadFreshRoster: async () => [],
				loadProjectInventory: () => [],
			}),
		).resolves.toMatchObject({ status: "completed", teamId: manifest.team_id });
	});

	it("treats a changed completion timestamp as metadata-only during replay", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest,
		});
		const restampedManifest = {
			...manifest,
			completed_at: "2026-09-01T12:01:00.000Z",
		};

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest: restampedManifest,
			}),
		).resolves.toEqual(restampedManifest);
		expect(db.prepare("SELECT status FROM policy_teams").pluck().get()).toBe("active");
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_completions").pluck().get()).toBe(1);
	});

	it("preserves completed policy when local Project candidates exceed the apply limit", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest,
		});
		const insertSession = db.prepare(
			"INSERT INTO sessions(started_at, project, git_remote) VALUES (?, ?, ?)",
		);
		const insertCandidates = db.transaction(() => {
			for (let index = 0; index <= 500; index += 1) {
				insertSession.run(NOW, `Project ${index}`, `https://git.example.invalid/acme/${index}.git`);
			}
		});
		insertCandidates();

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest: { ...manifest, completed_at: "2026-09-01T12:01:00.000Z" },
			}),
		).rejects.toThrow("team_setup_roster_unavailable");
		expect(db.prepare("SELECT status FROM policy_teams").pluck().get()).toBe("active");
	});

	it("preserves completed policy when the local Project scan exceeds its budget", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest,
		});
		const insertSession = db.prepare(
			"INSERT INTO sessions(started_at, project, git_remote) VALUES (?, ?, ?)",
		);
		const fillScanBudget = db.transaction(() => {
			for (let index = 0; index <= 10_000; index += 1) {
				insertSession.run(NOW, "Repeated project", PROJECT_A);
			}
		});
		fillScanBudget();

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest: { ...manifest, completed_at: "2026-09-01T12:01:00.000Z" },
			}),
		).rejects.toThrow("team_setup_roster_unavailable");
		expect(db.prepare("SELECT status FROM policy_teams").pluck().get()).toBe("active");
	});

	it("preserves an active Team rename when applying the original manifest to a replacement draft", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest,
		});
		const expandedRoster = [
			...FRESH_ROSTER,
			{
				deviceId: "device-b",
				fingerprint: "b".repeat(64),
				displayName: "Tablet",
				enabled: true,
			},
		];
		const replacement = refreshLegacyTeamSetupDraft(db, {
			candidateId: CANDIDATE,
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			displayName: "Platform",
			devices: expandedRoster,
			projects: [],
			now: "2026-09-01T12:01:00.000Z",
		});
		db.prepare(
			"UPDATE policy_teams SET display_name = 'Platform', revision = 'rename-revision'",
		).run();
		db.prepare("UPDATE legacy_team_setup_drafts SET display_name = 'Platform'").run();

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: expandedRoster,
				manifest,
			}),
		).resolves.toEqual(manifest);
		expect(db.prepare("SELECT display_name, revision FROM policy_teams").get()).toEqual({
			display_name: "Platform",
			revision: manifest.team.policy_revision,
		});
		expect(
			db
				.prepare("SELECT display_name, state FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.get(replacement.attemptId),
		).toEqual({ display_name: "Platform", state: "completed" });
	});

	it("validates fresh included-device evidence before completed replay", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest,
		});

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: [
					{ deviceId: "device-a", fingerprint: "key-b", displayName: "Laptop", enabled: true },
				],
				manifest,
			}),
		).rejects.toThrow("team_setup_completion_invalid");
		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).resolves.toEqual(manifest);
		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: [
					{ deviceId: "device-a", fingerprint: "key-b", displayName: "Laptop", enabled: true },
				],
				manifest,
			}),
		).rejects.toThrow("team_setup_completion_invalid");
		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).resolves.toEqual(manifest);
		// Quarantine cleared the completion key, so recovery mints a new one; the
		// second recovery then reuses it instead of rotating again.
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_completions").pluck().get()).toBe(2);

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: [
					{ deviceId: "device-a", fingerprint: "key-b", displayName: "Laptop", enabled: true },
				],
				manifest,
			}),
		).rejects.toThrow("team_setup_completion_invalid");
		db.prepare(
			`UPDATE legacy_team_setup_completions SET completed_team_id = 'unexpected-team'
			 WHERE rowid = (SELECT MAX(rowid) FROM legacy_team_setup_completions)`,
		).run();
		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).rejects.toThrow("team_setup_completion_invalid");
		expect(
			db.prepare("SELECT status FROM policy_teams WHERE team_id = ?").pluck().get(manifest.team_id),
		).toBe("inactive");
	});

	it("rejects a canonical completion when an included device was re-keyed", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		const replacement = refreshLegacyTeamSetupDraft(db, {
			candidateId: CANDIDATE,
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			displayName: "Engineering",
			devices: [
				{
					deviceId: "device-a",
					fingerprint: "key-b",
					displayName: "Laptop",
					enabled: true,
				},
			],
			projects: [],
			now: "2026-09-01T12:01:00.000Z",
		});
		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: [
					{ deviceId: "device-a", fingerprint: "key-b", displayName: "Laptop", enabled: true },
				],
				manifest,
			}),
		).rejects.toThrow("team_setup_completion_invalid");
		expect(
			db
				.prepare(
					"SELECT state, key_fingerprint FROM legacy_team_setup_drafts JOIN legacy_team_setup_draft_devices USING (attempt_id) WHERE attempt_id = ?",
				)
				.get(replacement.attemptId),
		).toEqual({ state: "needs_setup", key_fingerprint: "key-b" });
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
	});

	it("rejects a canonical completion when an included device was disabled", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: [
					{ deviceId: "device-a", fingerprint: KEY_A, displayName: "Laptop", enabled: false },
				],
				manifest,
			}),
		).rejects.toThrow("team_setup_completion_invalid");
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
	});

	it("contains active policy when canonical apply fails on a replacement draft", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest,
		});
		const replacement = refreshLegacyTeamSetupDraft(db, {
			candidateId: CANDIDATE,
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			displayName: "Engineering",
			devices: [
				{
					deviceId: "device-a",
					fingerprint: KEY_A,
					displayName: "Laptop",
					enabled: true,
				},
			],
			projects: [],
			now: "2026-09-01T12:01:00.000Z",
		});
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, source_fingerprint, idempotency_key,
			 created_at, updated_at
			 ) VALUES ('project-private', 'team', ?, 'active', 'reviewed_team_setup',
			 'local-revision', 'completed', 'local-source', 'local-key', ?, ?)`,
		).run(manifest.team_id, NOW, NOW);
		db.prepare("UPDATE actors SET status = 'inactive' WHERE actor_id = 'identity-a'").run();

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).rejects.toThrow("team_setup_conflict");
		expect(
			db.prepare("SELECT status FROM policy_teams WHERE team_id = ?").pluck().get(manifest.team_id),
		).toBe("inactive");
		expect(
			db
				.prepare(
					`SELECT status FROM project_recipients
					 WHERE canonical_project_identity = 'project-private'`,
				)
				.pluck()
				.get(),
		).toBe("revoked");
		expect(replacement.state).toBe("needs_setup");
	});

	it("quarantines divergent local policy when Project resolution exceeds its budget", async () => {
		const draft = readyDraft();
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-b', 'Person B', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		const localManifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		db.prepare(
			"UPDATE legacy_team_setup_draft_devices SET target_identity_id = 'identity-b' WHERE attempt_id = ?",
		).run(draft.attemptId);
		const canonicalManifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		db.prepare(
			"UPDATE legacy_team_setup_draft_devices SET target_identity_id = 'identity-a' WHERE attempt_id = ?",
		).run(draft.attemptId);
		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest: localManifest,
		});
		expect(db.prepare("SELECT status FROM policy_teams").pluck().get()).toBe("active");
		const insertSession = db.prepare(
			"INSERT INTO sessions(started_at, project, git_remote) VALUES (?, ?, ?)",
		);
		db.transaction(() => {
			for (let index = 0; index <= 10_000; index += 1) {
				insertSession.run(NOW, "Repeated project", PROJECT_A);
			}
		})();

		// The winner diverges from the active local policy and cannot be applied
		// while the local inventory is over budget, so the superseded policy must
		// not stay active across retries that keep failing the same way.
		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest: canonicalManifest,
			}),
		).rejects.toThrow("team_setup_roster_unavailable");
		expect(db.prepare("SELECT status FROM policy_teams").pluck().get()).toBe("inactive");
	});

	it("preserves a proven rename when a divergent winner is re-applied over a completed draft", async () => {
		const draft = readyDraft();
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-b', 'Person B', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		const localManifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		db.prepare(
			"UPDATE legacy_team_setup_draft_devices SET target_identity_id = 'identity-b' WHERE attempt_id = ?",
		).run(draft.attemptId);
		const divergentManifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		db.prepare(
			"UPDATE legacy_team_setup_draft_devices SET target_identity_id = 'identity-a' WHERE attempt_id = ?",
		).run(draft.attemptId);
		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest: localManifest,
		});
		// The user renames the completed Team through the real rename path.
		await renameRecipientPolicyTeam(db, {
			teamId: localManifest.team_id,
			displayName: "Platform",
			expectedDisplayName: localManifest.team.display_name,
			configuredCoordinatorGroups: [{ coordinatorId: COORDINATOR_ID, groupId: GROUP_ID }],
			renameCoordinatorGroup: async () => true,
			now: "2026-09-01T12:00:30.000Z",
		});

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest: divergentManifest,
			}),
		).resolves.toEqual(divergentManifest);
		// Memberships converge on the winner while the proven rename survives.
		expect(
			db
				.prepare("SELECT display_name, revision FROM policy_teams WHERE team_id = ?")
				.get(divergentManifest.team_id),
		).toEqual({ display_name: "Platform", revision: divergentManifest.team.policy_revision });
		expect(
			db
				.prepare(
					"SELECT identity_id FROM identity_devices WHERE device_id = 'device-a' AND status = 'active'",
				)
				.pluck()
				.get(),
		).toBe("identity-b");
	});

	it("supersedes a divergent pre-protocol local completion", async () => {
		const draft = readyDraft();
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-b', 'Person B', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		const localManifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		db.prepare("UPDATE legacy_team_setup_drafts SET display_name = ? WHERE attempt_id = ?").run(
			"Platform",
			draft.attemptId,
		);
		db.prepare(
			"UPDATE legacy_team_setup_draft_devices SET target_identity_id = 'identity-b' WHERE attempt_id = ?",
		).run(draft.attemptId);
		const canonicalManifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		db.prepare("UPDATE legacy_team_setup_drafts SET display_name = ? WHERE attempt_id = ?").run(
			"Engineering",
			draft.attemptId,
		);
		db.prepare(
			"UPDATE legacy_team_setup_draft_devices SET target_identity_id = 'identity-a' WHERE attempt_id = ?",
		).run(draft.attemptId);

		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest: localManifest,
		});
		const oldCompletion = db
			.prepare(
				`SELECT finish_digest, confirmed_access_delta_digest
				 FROM legacy_team_setup_completions WHERE attempt_id = ?`,
			)
			.get(draft.attemptId) as {
			finish_digest: string;
			confirmed_access_delta_digest: string;
		};

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest: canonicalManifest,
			}),
		).resolves.toEqual(canonicalManifest);
		expect(reconstructLegacyTeamSetupCompletionManifest(db, { candidateRef: CANDIDATE })).toEqual(
			canonicalManifest,
		);
		expect(
			db
				.prepare("SELECT display_name FROM policy_teams WHERE team_id = ?")
				.pluck()
				.get(canonicalManifest.team_id),
		).toBe("Platform");
		expect(
			db
				.prepare(
					"SELECT identity_id FROM identity_devices WHERE device_id = 'device-a' AND status = 'active'",
				)
				.pluck()
				.get(),
		).toBe("identity-b");
		await expect(
			finishLegacyTeamSetupActivation(db, {
				candidateRef: CANDIDATE,
				attemptId: draft.attemptId,
				finishDigest: oldCompletion.finish_digest,
				confirmedAccessDeltaDigest: oldCompletion.confirmed_access_delta_digest,
				loadFreshRoster: async () => [],
				loadProjectInventory: () => [],
			}),
		).rejects.toThrow("team_setup_confirmation_stale");
	});

	it("quarantines divergent local policy when the canonical winner cannot be applied", async () => {
		const draft = readyDraft();
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-b', 'Person B', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		const localManifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		db.prepare("UPDATE legacy_team_setup_drafts SET display_name = ? WHERE attempt_id = ?").run(
			"Platform",
			draft.attemptId,
		);
		db.prepare(
			"UPDATE legacy_team_setup_draft_devices SET target_identity_id = 'identity-b' WHERE attempt_id = ?",
		).run(draft.attemptId);
		const canonicalManifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		db.prepare("UPDATE legacy_team_setup_drafts SET display_name = ? WHERE attempt_id = ?").run(
			"Engineering",
			draft.attemptId,
		);
		db.prepare(
			"UPDATE legacy_team_setup_draft_devices SET target_identity_id = 'identity-a' WHERE attempt_id = ?",
		).run(draft.attemptId);
		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest: localManifest,
		});
		const oldCompletion = db
			.prepare(
				`SELECT finish_digest, confirmed_access_delta_digest
				 FROM legacy_team_setup_completions WHERE attempt_id = ?`,
			)
			.get(draft.attemptId) as {
			finish_digest: string;
			confirmed_access_delta_digest: string;
		};
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, source_fingerprint, idempotency_key,
			 created_at, updated_at
			 ) VALUES ('project-private', 'team', ?, 'active', 'reviewed_team_setup',
			 'local-revision', 'completed', 'local-source', 'local-key', ?, ?)`,
		).run(canonicalManifest.team_id, NOW, NOW);
		db.prepare("UPDATE actors SET status = 'inactive' WHERE actor_id = 'identity-b'").run();

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest: canonicalManifest,
			}),
		).rejects.toThrow("team_setup_conflict");
		expect(
			db
				.prepare("SELECT status, migration_state FROM policy_teams WHERE team_id = ?")
				.get(canonicalManifest.team_id),
		).toEqual({ status: "inactive", migration_state: "needs_setup" });
		expect(
			db
				.prepare(
					`SELECT status, migration_state FROM project_recipients
					 WHERE canonical_project_identity = 'project-private'`,
				)
				.get(),
		).toEqual({ status: "revoked", migration_state: "needs_setup" });
		db.prepare(
			"UPDATE legacy_team_setup_drafts SET state = 'in_progress' WHERE attempt_id = ?",
		).run(draft.attemptId);
		const assignmentVersion = db
			.prepare(
				"SELECT assignment_version FROM identity_devices WHERE device_id = 'device-a' AND status = 'active'",
			)
			.pluck()
			.get() as number;
		db.prepare(
			`UPDATE legacy_team_setup_draft_devices
			 SET existing_identity_id = 'identity-a', existing_assignment_version = ?,
			     verified_evidence_kind = 'active_assignment', expected_assignment_kind = 'existing',
			     expected_assignment_version = ?
			 WHERE attempt_id = ? AND device_id = 'device-a'`,
		).run(assignmentVersion, assignmentVersion, draft.attemptId);
		expect(() =>
			inspectLegacyTeamSetupActivation(db, {
				candidateRef: CANDIDATE,
				attemptId: draft.attemptId,
			}),
		).toThrow("team_setup_conflict");
		db.prepare("UPDATE legacy_team_setup_drafts SET state = 'completed' WHERE attempt_id = ?").run(
			draft.attemptId,
		);
		await expect(
			finishLegacyTeamSetupActivation(db, {
				candidateRef: CANDIDATE,
				attemptId: draft.attemptId,
				finishDigest: oldCompletion.finish_digest,
				confirmedAccessDeltaDigest: oldCompletion.confirmed_access_delta_digest,
				loadFreshRoster: async () => [],
				loadProjectInventory: () => [],
			}),
		).rejects.toThrow("team_setup_confirmation_stale");

		db.prepare("UPDATE actors SET status = 'active' WHERE actor_id = 'identity-b'").run();
		db.prepare("UPDATE policy_teams SET migration_state = 'completed' WHERE team_id = ?").run(
			canonicalManifest.team_id,
		);
		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest: canonicalManifest,
			}),
		).rejects.toThrow("team_setup_conflict");
		db.prepare("UPDATE policy_teams SET migration_state = 'needs_setup' WHERE team_id = ?").run(
			canonicalManifest.team_id,
		);
		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest: canonicalManifest,
			}),
		).resolves.toEqual(canonicalManifest);
		expect(
			db
				.prepare("SELECT status, migration_state FROM policy_teams WHERE team_id = ?")
				.get(canonicalManifest.team_id),
		).toEqual({ status: "active", migration_state: "completed" });
	});

	it("quarantines a bound completion whose digest validation fails", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		await applyLegacyTeamSetupCompletionManifest(db, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: FRESH_ROSTER,
			manifest,
		});
		const localRevision = db
			.prepare("SELECT revision FROM policy_teams WHERE team_id = ?")
			.pluck()
			.get(manifest.team_id) as string;
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, source_fingerprint, idempotency_key,
			 created_at, updated_at
			 ) VALUES ('project-private', 'team', ?, 'active', 'reviewed_team_setup',
			 'stale-revision', 'completed', 'local-source', 'local-key', ?, ?)`,
		).run(manifest.team_id, NOW, NOW);
		const invalidManifest = {
			...manifest,
			source_digest: "0".repeat(64),
			team: { ...manifest.team, policy_revision: "1".repeat(64) },
		};

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest: invalidManifest,
			}),
		).rejects.toThrow("team_setup_completion_invalid");
		expect(
			db
				.prepare("SELECT status, migration_state FROM policy_teams WHERE team_id = ?")
				.get(manifest.team_id),
		).toEqual({ status: "inactive", migration_state: "needs_setup" });
		expect(
			db
				.prepare(
					`SELECT status, policy_revision, migration_state FROM project_recipients
				 WHERE canonical_project_identity = 'project-private'`,
				)
				.get(),
		).toEqual({
			status: "revoked",
			policy_revision: localRevision,
			migration_state: "needs_setup",
		});
		expect(
			db
				.prepare("SELECT finish_digest FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.get(draft.attemptId),
		).toEqual({ finish_digest: null });
	});

	it.each([
		["malformed", {}],
		["bound to another coordinator", { coordinator_id: "coordinator-other" }],
		[
			"bound to another candidate",
			{
				candidate_ref: "legacy-team-candidate:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				team_id: "policy-team-v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			},
		],
	] as const)(
		"does not quarantine active policy for an %s payload",
		async (_label, replacement) => {
			const draft = readyDraft();
			const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
				candidateRef: draft.candidateRef,
				attemptId: draft.attemptId,
				completedAt: NOW,
			});
			await applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			});
			const finishDigest = db
				.prepare("SELECT finish_digest FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(draft.attemptId);
			const payload =
				Object.keys(replacement).length === 0 ? replacement : { ...manifest, ...replacement };

			await expect(
				applyLegacyTeamSetupCompletionManifest(db, {
					coordinatorId: COORDINATOR_ID,
					groupId: GROUP_ID,
					freshRoster: FRESH_ROSTER,
					manifest: payload,
				}),
			).rejects.toThrow("team_setup_completion_invalid");
			expect(
				db
					.prepare("SELECT status, migration_state FROM policy_teams WHERE team_id = ?")
					.get(manifest.team_id),
			).toEqual({ status: "active", migration_state: "completed" });
			expect(
				db
					.prepare("SELECT finish_digest FROM legacy_team_setup_drafts WHERE attempt_id = ?")
					.pluck()
					.get(draft.attemptId),
			).toBe(finishDigest);
		},
	);

	it("rolls back when canonical identity evidence is unavailable", async () => {
		const draft = readyDraft();
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
		db.prepare("UPDATE actors SET status = 'inactive' WHERE actor_id = 'identity-a'").run();

		await expect(
			applyLegacyTeamSetupCompletionManifest(db, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				freshRoster: FRESH_ROSTER,
				manifest,
			}),
		).rejects.toThrow("team_setup_conflict");
		expect(
			db
				.prepare("SELECT state FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(draft.attemptId),
		).not.toBe("completed");
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
	});
});
