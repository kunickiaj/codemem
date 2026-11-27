import {
	finishLegacyTeamSetupActivation,
	getLegacyTeamSetupDraft,
	inspectLegacyTeamSetupActivation,
	type LegacyTeamConfiguredGroupSnapshot,
	legacyTeamCandidateId,
	legacyTeamCandidateProjectInventory,
	listCachedScopesForDevice,
	MemoryStore,
	readCoordinatorSyncConfig,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
} from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
import { refreshTestScopeRows } from "../../../core/src/scope-membership-cache-test-fixtures.js";
import { teamSetupRoutes } from "./team-setup.js";
import type { TeamSetupReconciliation } from "./team-setup-reconciliation.js";

/*
 * Before the background check restores a completed Team's setup recipient, it
 * reads the coordinator's removals and must apply them: neither a removed
 * person's device nor a removed device gets the Team's Project scope back.
 */

const COORDINATOR_ID = "https://coordinator.example.test";
const GROUP_ID = "group-alpha";
const CANDIDATE_REF = legacyTeamCandidateId(COORDINATOR_ID, GROUP_ID);
const NOW = "2026-08-26T00:00:00.000Z";
const SCOPE_ID = "scope-terminal";
const PROJECT = "https://example.test/terminal-project.git";
const DEVICES = [
	{ deviceId: "device-a", fingerprint: "a".repeat(64), identityId: "identity-a" },
	{ deviceId: "device-b", fingerprint: "b".repeat(64), identityId: "identity-b" },
	{ deviceId: "device-c", fingerprint: "c".repeat(64), identityId: "identity-c" },
];
const SNAPSHOTS: LegacyTeamConfiguredGroupSnapshot[] = [
	{
		coordinatorId: COORDINATOR_ID,
		groupId: GROUP_ID,
		displayName: "Migration Team",
		devices: DEVICES.map(({ deviceId, fingerprint }) => ({
			deviceId,
			fingerprint,
			displayName: deviceId,
			enabled: true,
		})),
	},
];

function adminConfig() {
	return {
		...readCoordinatorSyncConfig({}),
		syncCoordinatorUrl: COORDINATOR_ID,
		syncCoordinatorGroups: [GROUP_ID],
		syncCoordinatorAdminSecret: "private-admin-secret",
	};
}

/** A Project in the setup group's scope, as the fixture in the terminal tests builds it. */
function seedSetupProject(store: MemoryStore): void {
	store.db
		.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id,
			 membership_epoch, status, created_at, updated_at
			 ) VALUES (?, 'Terminal', 'team', 'coordinator', ?, ?, 1, 'active', ?, ?)`,
		)
		.run(SCOPE_ID, COORDINATOR_ID, GROUP_ID, NOW, NOW);
	const sessionId = Number(
		store.db
			.prepare(
				"INSERT INTO sessions(started_at, project, git_remote) VALUES (?, 'terminal-project', ?)",
			)
			.run(NOW, PROJECT).lastInsertRowid,
	);
	store.db
		.prepare(
			`INSERT INTO memory_items(
			 session_id, kind, title, body_text, active, created_at, updated_at,
			 visibility, project, scope_id
			 ) VALUES (?, 'discovery', 'Terminal Project', 'body', 1, ?, ?, 'shared',
			 'terminal-project', ?)`,
		)
		.run(sessionId, NOW, NOW, SCOPE_ID);
	store.db
		.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, 1000, 'reviewed_team_setup', ?, ?)`,
		)
		.run(PROJECT, PROJECT, SCOPE_ID, NOW, NOW);
}

/** Every device included, each with its own person, then the setup recipient revoked. */
async function completedThreeDeviceTeam(store: MemoryStore): Promise<string> {
	seedSetupProject(store);
	const setup = teamSetupRoutes({
		getStore: () => store,
		loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
		completionDependencies: null,
		registerReconciliation: (check) => {
			void check.refresh();
		},
	});
	await setup.request("/api/sync/team-setup/v1");
	for (let tries = 0; tries < 50 && !getLegacyTeamSetupDraft(store.db, CANDIDATE_REF); tries++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	let draft = getLegacyTeamSetupDraft(store.db, CANDIDATE_REF);
	if (!draft) throw new Error("Team setup draft missing");
	for (const { deviceId, identityId } of DEVICES) {
		store.db
			.prepare(
				`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
				 VALUES (?, ?, 0, 'active', ?, ?)`,
			)
			.run(identityId, identityId, NOW, NOW);
		// The draft view exposes only an opaque reference; the draft table maps it.
		const deviceRef = store.db
			.prepare(
				"SELECT device_ref FROM legacy_team_setup_draft_devices WHERE attempt_id = ? AND device_id = ?",
			)
			.pluck()
			.get(draft.attemptId, deviceId);
		const device = draft.devices.find((item) => item.deviceRef === deviceRef);
		if (!device) throw new Error(`Team setup device ${deviceId} missing`);
		draft = setLegacyTeamSetupDeviceAssignment(store.db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			targetIdentityId: identityId,
			expectation: device.expectation,
			now: NOW,
		});
		draft = setLegacyTeamSetupDeviceDecision(store.db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			decision: "included",
			now: NOW,
		});
	}
	const review = inspectLegacyTeamSetupActivation(store.db, {
		candidateRef: CANDIDATE_REF,
		attemptId: draft.attemptId,
	});
	const { teamId } = await finishLegacyTeamSetupActivation(store.db, {
		candidateRef: CANDIDATE_REF,
		attemptId: draft.attemptId,
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
	// Every device holds the coordinator's membership of the setup scope.
	for (const { deviceId } of DEVICES) {
		store.db
			.prepare(
				`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
				 VALUES (?, ?, 'member', 'active', 1, ?)`,
			)
			.run(SCOPE_ID, deviceId, NOW);
	}
	await refreshTestScopeRows(store.db);
	// With the setup recipient active, every device is admitted to the scope.
	for (const { deviceId } of DEVICES) expect(admittedToSetupScope(store, deviceId)).toBe(true);
	store.db
		.prepare(
			`UPDATE project_recipients SET status = 'revoked'
			 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`,
		)
		.run(PROJECT, teamId);
	return teamId;
}

function admittedToSetupScope(store: MemoryStore, deviceId: string): boolean {
	return listCachedScopesForDevice(store.db, deviceId).memberships.some(
		(membership) => membership.scope_id === SCOPE_ID,
	);
}

/**
 * Whether the check's repair shares the setup Project with this device: the
 * setup recipient is active again and the device is admitted to the Project's
 * scope. While the recipient is revoked the scope is not the Team's, and only
 * the coordinator's own scope membership decides.
 */
function sharedThroughRestoredRecipient(
	store: MemoryStore,
	teamId: string,
	deviceId: string,
): boolean {
	return setupRecipientStatus(store, teamId) === "active" && admittedToSetupScope(store, deviceId);
}

function deviceBinding(store: MemoryStore, deviceId: string): unknown {
	return store.db
		.prepare("SELECT status FROM identity_devices WHERE device_id = ?")
		.pluck()
		.get(deviceId);
}

function teamMembership(store: MemoryStore, teamId: string, identityId: string): unknown {
	return store.db
		.prepare("SELECT status FROM policy_team_memberships WHERE team_id = ? AND identity_id = ?")
		.pluck()
		.get(teamId, identityId);
}

function setupRecipientStatus(store: MemoryStore, teamId: string): unknown {
	return store.db
		.prepare(
			`SELECT status FROM project_recipients
			 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`,
		)
		.pluck()
		.get(PROJECT, teamId);
}

const [PERSON_REMOVED, DEVICE_REMOVED, KEPT] = DEVICES as [
	(typeof DEVICES)[number],
	(typeof DEVICES)[number],
	(typeof DEVICES)[number],
];

/** The coordinator removed this device from the group. */
const DEVICE_REMOVAL = {
	group_id: GROUP_ID,
	device_id: DEVICE_REMOVED.deviceId,
	fingerprint: DEVICE_REMOVED.fingerprint,
	removal_id: "removal-1",
	removal_seq: 1,
	key_id: null,
	display_name: null,
	identity_id: null,
	removed_at: NOW,
};

/** The coordinator removed this person from the setup Team. */
function memberRemoval(teamId: string) {
	return {
		removal_seq: 1,
		group_id: GROUP_ID,
		team_id: teamId,
		identity_id: PERSON_REMOVED.identityId,
		removed_by_device_id: null,
		removed_at: NOW,
	};
}

/** Runs one background check against a coordinator that returns these removals. */
async function runBackgroundCheck(
	store: MemoryStore,
	removals: { devices: (typeof DEVICE_REMOVAL)[]; members: ReturnType<typeof memberRemoval>[] },
): Promise<void> {
	let check: TeamSetupReconciliation<unknown> | null = null;
	teamSetupRoutes({
		getStore: () => store,
		loadLegacyTeamConfiguredGroupSnapshots: async () => SNAPSHOTS,
		readCoordinatorConfig: adminConfig,
		completionDependencies: {
			// No coordinator completion: reconciliation publishes the local one.
			create: vi.fn(async ({ manifest }) => ({ status: "created" as const, manifest })),
			list: async () => [],
			listRemovals: async () => removals.devices,
			listTeamMemberRemovals: async () => removals.members,
		},
		registerReconciliation: (registered) => {
			check = registered as TeamSetupReconciliation<unknown>;
		},
	});
	if (!check) throw new Error("background check not registered");
	await (check as TeamSetupReconciliation<unknown>).refresh();
}

describe("Team setup repair after reading removals", () => {
	it("keeps a removed person's device and a removed device out of the setup Project scope", async () => {
		const store = new MemoryStore(":memory:");
		try {
			const teamId = await completedThreeDeviceTeam(store);

			await runBackgroundCheck(store, {
				devices: [DEVICE_REMOVAL],
				members: [memberRemoval(teamId)],
			});

			expect(sharedThroughRestoredRecipient(store, teamId, PERSON_REMOVED.deviceId)).toBe(false);
			expect(sharedThroughRestoredRecipient(store, teamId, DEVICE_REMOVED.deviceId)).toBe(false);
			// The person's removal is recorded. The removed device is still bound here,
			// so the repair waits for the sync daemon's removal check instead of ending
			// device-wide access on one group's record.
			expect(teamMembership(store, teamId, PERSON_REMOVED.identityId)).toBe("revoked");
			expect(deviceBinding(store, DEVICE_REMOVED.deviceId)).toBe("active");
			expect(setupRecipientStatus(store, teamId)).toBe("revoked");
		} finally {
			store.close();
		}
	});

	it("restores the setup recipient for the rest of the Team but not for a removed person's device", async () => {
		const store = new MemoryStore(":memory:");
		try {
			const teamId = await completedThreeDeviceTeam(store);

			await runBackgroundCheck(store, { devices: [], members: [memberRemoval(teamId)] });

			expect(sharedThroughRestoredRecipient(store, teamId, KEPT.deviceId)).toBe(true);
			expect(sharedThroughRestoredRecipient(store, teamId, DEVICE_REMOVED.deviceId)).toBe(true);
			expect(sharedThroughRestoredRecipient(store, teamId, PERSON_REMOVED.deviceId)).toBe(false);
		} finally {
			store.close();
		}
	});
});
