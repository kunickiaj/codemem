import {
	applyLegacyTeamSetupCompletionManifest,
	claimRecipientPolicyActorMutations,
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
import { teamSetupRoutes } from "./team-setup.js";

const NOW = "2026-09-01T12:00:00.000Z";
const COORDINATOR = "https://coordinator.example.invalid";
const GROUP = "group-member-recovery";
const CANDIDATE = legacyTeamCandidateId(COORDINATOR, GROUP);
const SNAPSHOTS = [
	{
		coordinatorId: COORDINATOR,
		groupId: GROUP,
		displayName: "Recovery Team",
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

async function completedSource(store: MemoryStore) {
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

function recoveryApp(store: MemoryStore, manifest: Awaited<ReturnType<typeof completedSource>>) {
	const list = vi.fn(async () => [{ group_id: GROUP, manifest }]);
	const app = teamSetupRoutes({
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
		completionDependencies: { create: vi.fn(), list },
	});
	return { app, list };
}

describe("Team setup member recovery routes", () => {
	let source: MemoryStore;
	let target: MemoryStore;
	let manifest: Awaited<ReturnType<typeof completedSource>>;
	beforeEach(async () => {
		source = new MemoryStore(":memory:");
		target = new MemoryStore(":memory:");
		addActor(source, "identity-a", 1);
		addActor(target, "identity-a", 1);
		manifest = await completedSource(source);
		discover(target);
	});
	afterEach(() => {
		source.close();
		target.close();
	});

	it("recovers an unknown teammate during a cold-cache detail read and replays without actor changes", async () => {
		// Arrange.
		const { app } = recoveryApp(target, manifest);
		const self = target.db.prepare("SELECT * FROM actors WHERE actor_id = 'identity-a'").get();
		// Act.
		const response = await app.request(`/api/sync/team-setup/v1/${CANDIDATE}`);
		const recovered = target.db.prepare("SELECT * FROM actors ORDER BY actor_id").all();
		await app.request("/api/sync/team-setup/v1");
		// Assert: completed candidates no longer have a setup detail page.
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "team_setup_confirmation_stale" });
		expect(getLegacyTeamSetupDraft(target.db, CANDIDATE)?.state).toBe("completed");
		expect(recovered).toContainEqual(self);
		expect(recovered).toContainEqual(
			expect.objectContaining({
				actor_id: "identity-b",
				display_name: "Team member",
				is_local: 0,
				status: "active",
				merged_into_actor_id: null,
			}),
		);
		expect(target.db.prepare("SELECT * FROM actors ORDER BY actor_id").all()).toEqual(recovered);
	});

	it("rejects invalid canonical evidence without creating the missing teammate", async () => {
		// Arrange.
		const { app } = recoveryApp(target, { ...manifest, finish_digest: "0".repeat(64) });
		const before = target.db.prepare("SELECT * FROM actors ORDER BY actor_id").all();
		// Act.
		const response = await app.request(`/api/sync/team-setup/v1/${CANDIDATE}`);
		// Assert.
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "team_setup_completion_invalid" });
		expect(target.db.prepare("SELECT * FROM actors ORDER BY actor_id").all()).toEqual(before);
		expect(target.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
	});

	it("waits for the missing teammate actor lock during canonical route recovery", async () => {
		// Arrange.
		const { app, list } = recoveryApp(target, manifest);
		const release = await claimRecipientPolicyActorMutations(target.db, ["identity-b"]);
		let settled = false;
		// Act.
		const pending = app.request(`/api/sync/team-setup/v1/${CANDIDATE}`).finally(() => {
			settled = true;
		});
		try {
			await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
			for (let turn = 0; turn < 80; turn++) await Promise.resolve();
			// Assert: the viewer must not claim locks held without acquiring actor locks.
			expect(settled).toBe(false);
			expect(
				target.db.prepare("SELECT actor_id FROM actors WHERE actor_id = 'identity-b'").get(),
			).toBeUndefined();
		} finally {
			release();
			await pending;
		}
		expect(getLegacyTeamSetupDraft(target.db, CANDIDATE)?.state).toBe("completed");
	});
});

it("does not recover members when authorization is revoked while waiting for an actor lock", async () => {
	// Arrange: a valid winner is available, but another mutation holds its absent member's lock.
	const source = new MemoryStore(":memory:");
	const target = new MemoryStore(":memory:");
	let release: () => void = () => undefined;
	try {
		addActor(source, "identity-a", 1);
		addActor(target, "identity-a", 1);
		const manifest = await completedSource(source);
		discover(target);
		const before = target.db.prepare("SELECT * FROM actors ORDER BY actor_id").all();
		let authorized = true;
		const readConfig = vi.fn(() => ({
			...readCoordinatorSyncConfig({}),
			syncCoordinatorUrl: COORDINATOR,
			syncCoordinatorGroups: authorized ? [GROUP] : [],
			syncCoordinatorAdminSecret: authorized ? "test-only-secret" : "",
		}));
		const list = vi.fn(async () => [{ group_id: GROUP, manifest }]);
		const app = teamSetupRoutes({
			getStore: () => target,
			loadLegacyTeamConfiguredGroupSnapshots: vi.fn(async () => SNAPSHOTS),
			snapshotLoaderDependencies: {
				readConfig,
				listGroups: vi.fn(async () => []),
				listDevices: vi.fn(async () => []),
			},
			completionDependencies: { create: vi.fn(), list },
		});
		release = await claimRecipientPolicyActorMutations(target.db, ["identity-b"]);
		let settled = false;
		// Act: allow reconciliation to queue, revoke authorization, then release the actor lock.
		const pending = app.request(`/api/sync/team-setup/v1/${CANDIDATE}`).finally(() => {
			settled = true;
		});
		let readsBeforeRelease = 0;
		try {
			await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
			for (let turn = 0; turn < 80; turn++) await Promise.resolve();
			expect(settled).toBe(false);
			readsBeforeRelease = readConfig.mock.calls.length;
			authorized = false;
		} finally {
			release();
			await pending;
		}
		// Assert: the authorization check after locking prevents every canonical activation write.
		expect(readConfig.mock.calls.length).toBeGreaterThan(readsBeforeRelease);
		expect(target.db.prepare("SELECT * FROM actors ORDER BY actor_id").all()).toEqual(before);
		expect(target.db.prepare("SELECT COUNT(*) FROM policy_team_memberships").pluck().get()).toBe(0);
		expect(target.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		expect(
			target.db.prepare("SELECT COUNT(*) FROM legacy_team_setup_completions").pluck().get(),
		).toBe(0);
		expect(getLegacyTeamSetupDraft(target.db, CANDIDATE)?.state).not.toBe("completed");
	} finally {
		release();
		source.close();
		target.close();
	}
});
