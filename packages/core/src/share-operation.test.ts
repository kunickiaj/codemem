import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	inviteTokenDigest,
	parseAcceptedProjectIntent,
	persistShareOperation,
	planShareOperation,
	reconcileShareOperationAcceptance,
	shareProjectSetDigest,
} from "./share-operation.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

const createdAt = "2026-07-20T12:00:00.000Z";
const inviteExpiresAt = "2026-07-27T12:00:00.000Z";
const projects = [
	{
		canonicalIdentity: "git:https://example.invalid/acme/api.git",
		displayName: "api",
		identitySource: "git_remote",
		existingMemoryCount: 12,
	},
	{
		canonicalIdentity: "git:https://example.invalid/acme/web.git",
		displayName: "web",
		identitySource: "git_remote",
		existingMemoryCount: 7,
	},
];

type PlanInput = Parameters<typeof planShareOperation>[0];
type AcceptanceInput = Parameters<typeof reconcileShareOperationAcceptance>[1];

function plan(overrides: Partial<PlanInput> = {}) {
	return planShareOperation({
		inviterActorId: "actor-adam",
		inviterDeviceIds: ["device-b", "device-a", "device-a"],
		person: { kind: "pending", displayName: " Brian " },
		projects: [...projects].reverse(),
		coordinatorGroupId: "team-acme",
		createdAt,
		inviteExpiresAt,
		...overrides,
	});
}

function acceptanceInput(
	operation: ReturnType<typeof planShareOperation>,
	overrides: Partial<AcceptanceInput> = {},
): AcceptanceInput {
	const publicKey = "recipient-key";
	return {
		operationId: operation.operationId,
		coordinatorGroupId: operation.coordinatorGroupId,
		reviewedProjectSetDigest: operation.reviewedProjectSetDigest,
		recipientActorId: "actor-brian",
		recipientDisplayName: "Brian",
		recipientDeviceId: "device-brian",
		recipientDeviceDisplayName: "Brian's MacBook",
		recipientPublicKey: publicKey,
		recipientFingerprint: fingerprintPublicKey(publicKey),
		consumedAt: "2026-07-20T13:00:00.000Z",
		trustState: "bootstrap_grant_created",
		bootstrapGrantId: "grant-1",
		projects: operation.projects.map((project) => ({
			canonical_identity: project.canonicalIdentity,
			display_name: project.displayName,
			existing_memory_count: project.existingMemoryCount,
		})),
		...overrides,
	};
}

function managedBoundaryIds(operation: ReturnType<typeof planShareOperation>): string[] {
	return operation.steps
		.filter((item) => item.stepKey.startsWith("managed_boundary:"))
		.map((item) => item.effectId);
}

describe("share-operation planner", () => {
	it("plans deterministic exact-project intent and idempotency metadata", () => {
		const first = plan();
		const second = plan();

		expect(first).toEqual(second);
		expect(first).toMatchObject({
			state: "waiting_for_acceptance",
			historyPolicy: "existing_and_future",
			inviterDeviceIds: ["device-a", "device-b"],
			teammateName: "Brian",
		});
		expect(first.projects.map((project) => project.displayName)).toEqual(["api", "web"]);
		expect(first.steps.every((item) => item.effectId.length > 20)).toBe(true);
		expect(new Set(first.steps.map((item) => item.effectId)).size).toBe(first.steps.length);
		expect(
			first.steps.find((item) => item.stepKey.startsWith("managed_boundary:"))?.effectId,
		).toMatch(/^managed-project:/u);
	});

	it("canonicalizes project/device permutations and binds only authorization-relevant identity", () => {
		const baseline = plan({
			inviterDeviceIds: ["device-a", "device-b"],
			projects,
		});
		const permuted = plan({
			inviterDeviceIds: ["device-b", "device-a", "device-b", "device-a"],
			projects: [...projects].reverse(),
		});
		expect(permuted).toEqual(baseline);

		const relabeled = plan({
			inviterDeviceIds: ["device-a", "device-b"],
			projects: projects.map((project) => ({
				...project,
				displayName: `renamed-${project.displayName}`,
			})),
		});
		expect(relabeled.operationId).toBe(baseline.operationId);
		expect(managedBoundaryIds(relabeled)).toEqual(managedBoundaryIds(baseline));

		const changedCanonicalIdentity = plan({
			inviterDeviceIds: ["device-a", "device-b"],
			projects: projects.map((project, index) =>
				index === 0
					? { ...project, canonicalIdentity: "git:https://example.invalid/acme/v2.git" }
					: project,
			),
		});
		expect(changedCanonicalIdentity.operationId).not.toBe(baseline.operationId);
		expect(managedBoundaryIds(changedCanonicalIdentity)).not.toEqual(managedBoundaryIds(baseline));

		const changedGroup = plan({
			inviterDeviceIds: ["device-a", "device-b"],
			projects,
			coordinatorGroupId: "team-other",
		});
		expect(changedGroup.operationId).not.toBe(baseline.operationId);
		expect(managedBoundaryIds(changedGroup)).not.toEqual(managedBoundaryIds(baseline));

		const changedReviewedCount = plan({
			inviterDeviceIds: ["device-a", "device-b"],
			projects: projects.map((project, index) =>
				index === 0
					? { ...project, existingMemoryCount: project.existingMemoryCount + 1 }
					: project,
			),
		});
		expect(changedReviewedCount.operationId).not.toBe(baseline.operationId);
		expect(managedBoundaryIds(changedReviewedCount)).toEqual(managedBoundaryIds(baseline));
	});

	it("digests canonical identities and active-memory counts but excludes labels", () => {
		const changedLabels = projects.map((project) => ({
			...project,
			displayName: `label-${project.displayName}`,
		}));
		const changedCount = projects.map((project, index) =>
			index === 0 ? { ...project, existingMemoryCount: project.existingMemoryCount + 1 } : project,
		);

		expect(shareProjectSetDigest(changedLabels)).toBe(shareProjectSetDigest(projects));
		expect(shareProjectSetDigest(changedCount)).not.toBe(shareProjectSetDigest(projects));
	});

	it("links an existing Person without replacing its identity", () => {
		const operation = planShareOperation({
			inviterActorId: "actor-adam",
			inviterDeviceIds: ["device-a"],
			person: { kind: "existing", personId: "person-brian", displayName: "Brian" },
			projects,
			coordinatorGroupId: "team-acme",
			createdAt,
			inviteExpiresAt,
		});

		expect(operation).toMatchObject({ personId: "person-brian", personKind: "existing" });
	});

	it("reuses an explicitly matched pending Person across new share operations", () => {
		const first = planShareOperation({
			inviterActorId: "actor-adam",
			inviterDeviceIds: ["device-a"],
			person: { kind: "pending", displayName: "Brian" },
			projects,
			coordinatorGroupId: "team-acme",
			createdAt,
			inviteExpiresAt,
		});
		const operation = planShareOperation({
			inviterActorId: "actor-adam",
			inviterDeviceIds: ["device-a"],
			person: { kind: "pending", personId: "pending-brian", displayName: "Brian" },
			projects,
			coordinatorGroupId: "team-acme",
			createdAt,
			inviteExpiresAt,
		});

		expect(operation).toMatchObject({ personId: "pending-brian", personKind: "pending" });
		expect(operation.operationId).toBe(first.operationId);
	});

	it("rejects empty and duplicate project selections", () => {
		expect(() =>
			planShareOperation({
				inviterActorId: "actor-adam",
				inviterDeviceIds: ["device-a"],
				person: { kind: "pending", displayName: "Brian" },
				projects: [],
				coordinatorGroupId: "team-acme",
				createdAt,
				inviteExpiresAt,
			}),
		).toThrow("project_selection_empty");
		expect(() =>
			planShareOperation({
				inviterActorId: "actor-adam",
				inviterDeviceIds: ["device-a"],
				person: { kind: "pending", displayName: "Brian" },
				projects: [projects[0], projects[0]],
				coordinatorGroupId: "team-acme",
				createdAt,
				inviteExpiresAt,
			}),
		).toThrow("project_selection_duplicate");
	});
});

describe("share-operation persistence", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => db.close());

	it("persists reviewed intent, pending Person, counts, expiry, and steps idempotently", () => {
		const operation = plan();
		const tokenDigest = inviteTokenDigest("secret-invite-token");

		persistShareOperation(db, operation, { inviteId: "invite-1", tokenDigest });
		persistShareOperation(db, operation, { inviteId: "invite-1", tokenDigest });

		const saved = db.prepare("SELECT * FROM share_operations").get() as Record<string, unknown>;
		expect(saved).toMatchObject({
			operation_id: operation.operationId,
			state: "waiting_for_acceptance",
			person_kind: "pending",
			pending_person_operation_id: operation.operationId,
			history_policy: "existing_and_future",
			reviewed_project_set_digest: operation.reviewedProjectSetDigest,
			invite_token_digest: tokenDigest,
			invite_expires_at: inviteExpiresAt,
		});
		expect(
			db
				.prepare("SELECT display_name, status FROM actors WHERE actor_id = ?")
				.get(operation.personId),
		).toEqual({
			display_name: "Brian",
			status: "pending",
		});
		expect(db.prepare("SELECT COUNT(*) AS count FROM share_operation_projects").get()).toEqual({
			count: 2,
		});
		expect(db.prepare("SELECT COUNT(*) AS count FROM share_operation_steps").get()).toEqual({
			count: operation.steps.length,
		});
	});

	it("persists separate teammate invites for the same managed projects", () => {
		const brian = plan({ person: { kind: "pending", displayName: "Brian" } });
		const alex = plan({ person: { kind: "pending", displayName: "Alex" } });

		persistShareOperation(db, brian, {
			inviteId: "invite-brian",
			tokenDigest: inviteTokenDigest("token-brian"),
		});
		persistShareOperation(db, alex, {
			inviteId: "invite-alex",
			tokenDigest: inviteTokenDigest("token-alex"),
		});

		expect(db.prepare("SELECT COUNT(*) FROM share_operations").pluck().get()).toBe(2);
		expect(db.prepare("SELECT COUNT(*) FROM share_operation_steps").pluck().get()).toBe(
			brian.steps.length + alex.steps.length,
		);
		expect(managedBoundaryIds(alex)).toEqual(managedBoundaryIds(brian));
	});

	it("updates invite credentials when a waiting operation is reissued", () => {
		const operation = plan();
		persistShareOperation(db, operation, {
			inviteId: "invite-1",
			tokenDigest: inviteTokenDigest("expired-token"),
		});
		const reissued = {
			...operation,
			createdAt: "2026-07-27T12:00:00.000Z",
			inviteExpiresAt: "2026-08-03T12:00:00.000Z",
		};

		persistShareOperation(db, reissued, {
			inviteId: "invite-1",
			tokenDigest: inviteTokenDigest("replacement-token"),
		});

		expect(
			db
				.prepare(
					"SELECT invite_token_digest, invite_expires_at, created_at, updated_at FROM share_operations",
				)
				.get(),
		).toEqual({
			invite_token_digest: inviteTokenDigest("replacement-token"),
			invite_expires_at: reissued.inviteExpiresAt,
			created_at: operation.createdAt,
			updated_at: reissued.createdAt,
		});
	});

	it("rejects retries when any persisted reviewed intent changes", () => {
		const operation = plan();
		const invite = { inviteId: "invite-1", tokenDigest: inviteTokenDigest("token-1") };
		persistShareOperation(db, operation, invite);

		for (const changed of [
			{ ...operation, inviterActorId: "other-actor" },
			{ ...operation, state: "failed" as typeof operation.state },
			{ ...operation, teammateName: "Other Brian" },
			{ ...operation, personId: "other-person" },
			{ ...operation, personKind: "existing" as typeof operation.personKind },
			{ ...operation, inviterDeviceIds: ["other-device"] },
			{ ...operation, coordinatorGroupId: "other-group" },
			{ ...operation, inviteExpiresAt: "2026-08-01T12:00:00.000Z" },
			{ ...operation, reviewedProjectSetDigest: "changed-digest" },
			{ ...operation, historyPolicy: "other-policy" as typeof operation.historyPolicy },
			{
				...operation,
				projects: operation.projects.map((project, index) =>
					index === 0
						? { ...project, existingMemoryCount: project.existingMemoryCount + 1 }
						: project,
				),
			},
			{
				...operation,
				projects: operation.projects.map((project, index) =>
					index === 0 ? { ...project, canonicalIdentity: "git:changed" } : project,
				),
			},
			{
				...operation,
				projects: operation.projects.map((project, index) =>
					index === 0 ? { ...project, displayName: "Renamed API" } : project,
				),
			},
			{
				...operation,
				projects: operation.projects.map((project, index) =>
					index === 0 ? { ...project, identitySource: "workspace_id" } : project,
				),
			},
		]) {
			expect(() => persistShareOperation(db, changed, invite)).toThrow(
				"share_operation_intent_conflict",
			);
		}
		expect(() =>
			persistShareOperation(db, operation, {
				inviteId: "invite-2",
				tokenDigest: invite.tokenDigest,
			}),
		).toThrow("share_operation_intent_conflict");
		expect(() =>
			persistShareOperation(db, operation, {
				inviteId: invite.inviteId,
				tokenDigest: inviteTokenDigest("token-2"),
			}),
		).toThrow("share_operation_intent_conflict");
	});

	it("reconciles authoritative acceptance into the pending Person and device without name matching", () => {
		const operation = plan();
		persistShareOperation(db, operation, {
			inviteId: "invite-1",
			tokenDigest: inviteTokenDigest("token-1"),
		});
		const publicKey = "recipient-key";
		reconcileShareOperationAcceptance(db, {
			operationId: operation.operationId,
			coordinatorGroupId: operation.coordinatorGroupId,
			reviewedProjectSetDigest: operation.reviewedProjectSetDigest,
			recipientActorId: "actor-brian",
			recipientDisplayName: "Brian",
			recipientDeviceId: "device-brian",
			recipientDeviceDisplayName: "Brian's MacBook",
			recipientPublicKey: publicKey,
			recipientFingerprint: fingerprintPublicKey(publicKey),
			consumedAt: "2026-07-20T13:00:00.000Z",
			trustState: "bootstrap_grant_created",
			bootstrapGrantId: "grant-1",
			projects: operation.projects.map((project) => ({
				canonical_identity: project.canonicalIdentity,
				display_name: project.displayName,
				existing_memory_count: project.existingMemoryCount,
			})),
		});

		expect(
			db
				.prepare(`SELECT state, person_id, recipient_actor_id, recipient_device_id,
					recipient_device_display_name, bootstrap_grant_id FROM share_operations`)
				.get(),
		).toEqual({
			state: "accepted",
			person_id: "actor-brian",
			recipient_actor_id: "actor-brian",
			recipient_device_id: "device-brian",
			recipient_device_display_name: "Brian's MacBook",
			bootstrap_grant_id: "grant-1",
		});
		expect(
			db
				.prepare("SELECT status, merged_into_actor_id FROM actors WHERE actor_id = ?")
				.get(operation.personId),
		).toEqual({ status: "merged", merged_into_actor_id: "actor-brian" });
		expect(
			db
				.prepare("SELECT actor_id, name FROM sync_peers WHERE peer_device_id = ?")
				.get("device-brian"),
		).toEqual({ actor_id: "actor-brian", name: "Brian's MacBook" });
	});

	it("rejects pending acceptance that collides with an existing active Person", () => {
		const operation = plan();
		persistShareOperation(db, operation, {
			inviteId: "invite-1",
			tokenDigest: inviteTokenDigest("token-1"),
		});
		db.prepare(`INSERT INTO actors(
				actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
			) VALUES ('actor-alex', 'Alex', 0, 'active', NULL, ?, ?)`).run(createdAt, createdAt);
		const publicKey = "recipient-key";

		expect(() =>
			reconcileShareOperationAcceptance(db, {
				operationId: operation.operationId,
				coordinatorGroupId: operation.coordinatorGroupId,
				reviewedProjectSetDigest: operation.reviewedProjectSetDigest,
				recipientActorId: "actor-alex",
				recipientDisplayName: "Brian",
				recipientDeviceId: "device-brian",
				recipientDeviceDisplayName: "Brian's MacBook",
				recipientPublicKey: publicKey,
				recipientFingerprint: fingerprintPublicKey(publicKey),
				consumedAt: "2026-07-20T13:00:00.000Z",
				trustState: "bootstrap_grant_created",
				bootstrapGrantId: "grant-1",
				projects: operation.projects.map((project) => ({
					canonical_identity: project.canonicalIdentity,
					display_name: project.displayName,
					existing_memory_count: project.existingMemoryCount,
				})),
			}),
		).toThrow("recipient_actor_conflict");
		expect(
			db.prepare("SELECT display_name, status FROM actors WHERE actor_id = 'actor-alex'").get(),
		).toEqual({ display_name: "Alex", status: "active" });
		expect(
			db.prepare("SELECT status FROM actors WHERE actor_id = ?").pluck().get(operation.personId),
		).toBe("pending");
	});

	it.each([
		["locally claimed", "actor-adam", 1],
		["assigned to another Person", "actor-alex", 0],
	] as const)("rejects a recipient device already %s", (_label, actorId, claimedLocalActor) => {
		const operation = plan();
		persistShareOperation(db, operation, {
			inviteId: "invite-1",
			tokenDigest: inviteTokenDigest("token-1"),
		});
		db.prepare(`INSERT INTO sync_peers(
				peer_device_id, actor_id, claimed_local_actor, created_at
			) VALUES ('device-brian', ?, ?, ?)`).run(actorId, claimedLocalActor, createdAt);

		expect(() => reconcileShareOperationAcceptance(db, acceptanceInput(operation))).toThrow(
			"recipient_device_identity_conflict",
		);
		expect(
			db
				.prepare("SELECT actor_id, claimed_local_actor FROM sync_peers WHERE peer_device_id = ?")
				.get("device-brian"),
		).toEqual({ actor_id: actorId, claimed_local_actor: claimedLocalActor });
		expect(
			db.prepare("SELECT status FROM actors WHERE actor_id = ?").pluck().get(operation.personId),
		).toBe("pending");
	});

	it("does not regress a provisioning lifecycle on authoritative acceptance replay", () => {
		const operation = plan();
		persistShareOperation(db, operation, {
			inviteId: "invite-1",
			tokenDigest: inviteTokenDigest("token-1"),
		});
		const input = acceptanceInput(operation);
		reconcileShareOperationAcceptance(db, input);
		db.prepare("UPDATE share_operations SET state = 'initial_sync' WHERE operation_id = ?").run(
			operation.operationId,
		);
		reconcileShareOperationAcceptance(db, input);
		expect(
			db
				.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
				.pluck()
				.get(operation.operationId),
		).toBe("initial_sync");
	});

	it("rejects malformed or mismatched authoritative project intent", () => {
		expect(() => parseAcceptedProjectIntent([{ display_name: "codemem" }])).toThrow(
			"operation_intent_invalid",
		);
		const operation = plan();
		persistShareOperation(db, operation, {
			inviteId: "invite-1",
			tokenDigest: inviteTokenDigest("token-1"),
		});
		const publicKey = "recipient-key";
		expect(() =>
			reconcileShareOperationAcceptance(db, {
				operationId: operation.operationId,
				coordinatorGroupId: operation.coordinatorGroupId,
				reviewedProjectSetDigest: operation.reviewedProjectSetDigest,
				recipientActorId: "actor-brian",
				recipientDisplayName: "Brian",
				recipientDeviceId: "device-brian",
				recipientDeviceDisplayName: "Brian's MacBook",
				recipientPublicKey: publicKey,
				recipientFingerprint: fingerprintPublicKey(publicKey),
				consumedAt: "2026-07-20T13:00:00.000Z",
				trustState: "pending_inviter_device",
				bootstrapGrantId: null,
				projects: [
					{
						canonical_identity: "workspace:other",
						display_name: "other",
						existing_memory_count: 0,
					},
				],
			}),
		).toThrow("operation_intent_mismatch");
	});
});
