import {
	applyLegacyTeamSetupCompletionManifest,
	deriveLegacyTeamSetupCompletionManifest,
	discoverLegacyTeamCandidates,
	getLegacyTeamSetupDraft,
	legacyTeamCandidateId,
	legacyTeamDeviceRef,
	MemoryStore,
	readCoordinatorSyncConfig,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deterministicPolicyTeamId } from "../../../core/src/recipient-policy-identifiers.js";
import { teamSetupRoutesReconcilingOnRead as teamSetupRoutes } from "./team-setup-test-fixtures.js";

const NOW = "2026-09-01T12:00:00.000Z";
const COORDINATOR = "https://coordinator.example.invalid";
const GROUP = "group-member-removal";
const CANDIDATE = legacyTeamCandidateId(COORDINATOR, GROUP);
const TEAM = deterministicPolicyTeamId(CANDIDATE);
const SNAPSHOTS = [
	{
		coordinatorId: COORDINATOR,
		groupId: GROUP,
		displayName: "Removal Team",
		devices: ["a", "b"].map((suffix) => ({
			deviceId: `device-${suffix}`,
			fingerprint: suffix.repeat(64),
			displayName: `Laptop ${suffix}`,
			enabled: true,
		})),
	},
];

function addActor(store: MemoryStore, id: string, local = 0) {
	store.db
		.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
	 VALUES (?, ?, ?, 'active', ?, ?)`)
		.run(id, `Person ${id}`, local, NOW, NOW);
}

function discover(store: MemoryStore) {
	discoverLegacyTeamCandidates(store.db, {
		projection: { localActorId: "identity-a", localDeviceId: "device-a" },
		groups: SNAPSHOTS,
		now: NOW,
	});
}

/** Another admin device completes the Team with both people. */
async function completedElsewhere(store: MemoryStore) {
	addActor(store, "identity-b");
	discover(store);
	let draft = getLegacyTeamSetupDraft(store.db, CANDIDATE);
	if (!draft) throw new Error("Missing source draft");
	for (const device of draft.devices) {
		const rosterDevice = SNAPSHOTS[0].devices.find(
			(row) => legacyTeamDeviceRef(CANDIDATE, row.deviceId) === device.deviceRef,
		);
		if (!rosterDevice) throw new Error("Missing source roster device");
		draft = setLegacyTeamSetupDeviceAssignment(store.db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			targetIdentityId: rosterDevice.deviceId.replace("device-", "identity-"),
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
	const manifest = deriveLegacyTeamSetupCompletionManifest(store.db, {
		candidateRef: CANDIDATE,
		attemptId: draft.attemptId,
		completedAt: NOW,
	});
	await applyLegacyTeamSetupCompletionManifest(store.db, {
		coordinatorId: COORDINATOR,
		groupId: GROUP,
		manifest,
		freshRoster: SNAPSHOTS[0].devices,
	});
	return manifest;
}

const REMOVAL = {
	removal_seq: 1,
	group_id: GROUP,
	team_id: TEAM,
	identity_id: "identity-b",
	removed_by_device_id: null,
	removed_at: NOW,
};

function app(
	store: MemoryStore,
	manifest: Awaited<ReturnType<typeof completedElsewhere>>,
	listTeamMemberRemovals: () => Promise<(typeof REMOVAL)[]>,
) {
	return teamSetupRoutes({
		getStore: () => store,
		loadLegacyTeamConfiguredGroupSnapshots: vi.fn(async () => SNAPSHOTS),
		snapshotLoaderDependencies: {
			readConfig: () => ({
				...readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: COORDINATOR,
				syncCoordinatorGroups: [GROUP],
				syncCoordinatorAdminSecret: "test-only-secret",
			}),
			listGroups: vi.fn(async () => []),
			listDevices: vi.fn(async () => []),
		},
		completionDependencies: {
			create: vi.fn(),
			list: vi.fn(async () => [{ group_id: GROUP, manifest }]),
			listTeamMemberRemovals: vi.fn(listTeamMemberRemovals),
		},
	});
}

function memberships(store: MemoryStore) {
	return store.db
		.prepare(
			"SELECT identity_id, status FROM policy_team_memberships WHERE team_id = ? ORDER BY identity_id",
		)
		.all(TEAM);
}

describe("applying a coordinator Team setup on a fresh admin machine", () => {
	let source: MemoryStore;
	let target: MemoryStore;
	let manifest: Awaited<ReturnType<typeof completedElsewhere>>;
	beforeEach(async () => {
		source = new MemoryStore(":memory:");
		target = new MemoryStore(":memory:");
		addActor(source, "identity-a", 1);
		addActor(target, "identity-a", 1);
		manifest = await completedElsewhere(source);
		discover(target);
	});
	afterEach(() => {
		source.close();
		target.close();
	});

	it("reads the group's removals first, so the setup does not make a removed person a member", async () => {
		await app(target, manifest, async () => [REMOVAL]).request(
			`/api/sync/team-setup/v1/${CANDIDATE}`,
		);

		expect(getLegacyTeamSetupDraft(target.db, CANDIDATE)?.state).toBe("completed");
		expect(memberships(target)).toEqual([{ identity_id: "identity-a", status: "reviewed_active" }]);
	});

	it("applies nothing and disables nothing when the removals cannot be read", async () => {
		const routes = app(target, manifest, async () => {
			throw new Error("Remote coordinator request failed (503): team_member_removal_unavailable");
		});

		const detail = await routes.request(`/api/sync/team-setup/v1/${CANDIDATE}`);
		const summary = await routes.request("/api/sync/team-setup/v1");

		// The reads name the cause, so the Viewer can explain it.
		expect(await detail.json()).toEqual({
			error: "team_setup_completion_unavailable",
			reason: "team_member_removals_unavailable",
		});
		expect(await summary.json()).toMatchObject({
			candidates: [
				{
					candidateRef: CANDIDATE,
					blockingError: "team_setup_completion_unavailable",
					blockingReason: "team_member_removals_unavailable",
				},
			],
		});

		expect(getLegacyTeamSetupDraft(target.db, CANDIDATE)?.state).not.toBe("completed");
		expect(memberships(target)).toEqual([]);
		expect(target.db.prepare("SELECT status FROM policy_teams WHERE team_id = ?").get(TEAM)).toBe(
			undefined,
		);
	});
});
