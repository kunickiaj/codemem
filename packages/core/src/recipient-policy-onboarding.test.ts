import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRecipientPolicyIntent } from "./recipient-policy-intent.js";
import {
	commitDirectProjectSharePolicyInTransaction,
	commitRecipientPolicyOnboarding,
	commitRecipientPolicyOnboardingFromReviewedIntent,
	previewRecipientPolicyOnboarding,
	previewRecipientPolicyOnboardingFromReviewedIntent,
	type RecipientPolicyOnboardingPreviewRequestV1,
	type RecipientPolicyReviewedIntentPreviewRequestV1,
} from "./recipient-policy-onboarding.js";
import type { RecipientReviewedIntentV1 } from "./recipient-reviewed-intent.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-07-21T12:00:00.000Z";
const PROJECT_A = "https://git.example.invalid/acme/alpha.git";
const PROJECT_B = "https://git.example.invalid/acme/beta.git";
const PROJECT_C = "https://git.example.invalid/acme/gamma.git";

function insertActor(
	db: InstanceType<typeof Database>,
	identityId: string,
	displayName: string,
	isLocal = false,
): void {
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'active', ?, ?)`,
	).run(identityId, displayName, isLocal ? 1 : 0, NOW, NOW);
}

function insertProject(
	db: InstanceType<typeof Database>,
	projectId: string,
	displayName: string,
	memoryCount: number,
): void {
	const sessionId = Number(
		db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, git_remote, git_branch)
				 VALUES (?, ?, ?, ?, 'main')`,
			)
			.run(NOW, `/workspace/${displayName}`, displayName, projectId).lastInsertRowid,
	);
	for (let index = 0; index < memoryCount; index += 1) {
		db.prepare(
			`INSERT INTO memory_items(
			 session_id, kind, title, body_text, active, created_at, updated_at,
			 visibility, project, scope_id
			 ) VALUES (?, 'discovery', ?, 'body', 1, ?, ?, 'shared', ?, 'local-default')`,
		).run(sessionId, `${displayName}-${index}`, NOW, NOW, displayName);
	}
}

function insertTeam(db: InstanceType<typeof Database>, teamId: string, displayName: string): void {
	db.prepare(
		`INSERT INTO policy_teams(
		 team_id, display_name, status, provenance, revision, migration_state,
		 source_fingerprint, idempotency_key, created_at, updated_at
		 ) VALUES (?, ?, 'active', 'user', ?, 'user_managed', NULL, ?, ?, ?)`,
	).run(teamId, displayName, `revision-${teamId}`, `idempotency-${teamId}`, NOW, NOW);
}

function insertMembership(
	db: InstanceType<typeof Database>,
	teamId: string,
	identityId: string,
): void {
	db.prepare(
		`INSERT INTO policy_team_memberships(
		 team_id, identity_id, role, status, provenance, revision, migration_state,
		 source_fingerprint, idempotency_key, created_at, updated_at
		 ) VALUES (?, ?, 'member', 'active', 'user', ?, 'user_managed', NULL, ?, ?, ?)`,
	).run(
		teamId,
		identityId,
		`revision-${teamId}-${identityId}`,
		`idempotency-${teamId}-${identityId}`,
		NOW,
		NOW,
	);
}

function insertRecipient(
	db: InstanceType<typeof Database>,
	projectId: string,
	recipientKind: "identity" | "team",
	recipientId: string,
): void {
	db.prepare(
		`INSERT INTO project_recipients(
		 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
		 policy_revision, migration_state, source_fingerprint, idempotency_key,
		 created_at, updated_at
		 ) VALUES (?, ?, ?, 'active', 'user', ?, 'user_managed', NULL, ?, ?, ?)`,
	).run(
		projectId,
		recipientKind,
		recipientId,
		`revision-${projectId}-${recipientKind}-${recipientId}`,
		`idempotency-${projectId}-${recipientKind}-${recipientId}`,
		NOW,
		NOW,
	);
}

function baseRequest(
	overrides: Partial<RecipientPolicyOnboardingPreviewRequestV1> = {},
): RecipientPolicyOnboardingPreviewRequestV1 {
	return {
		version: 1,
		journey: "add_device",
		invitationId: "invite-device",
		identityId: "identity-a",
		deviceId: "device-new",
		devicePublicKey: "public-key-a",
		deviceDisplayName: "  Ada’s   Laptop  ",
		...overrides,
	} as RecipientPolicyOnboardingPreviewRequestV1;
}

function reviewedIntentRequest(
	overrides: Partial<RecipientPolicyOnboardingPreviewRequestV1> = {},
): RecipientPolicyReviewedIntentPreviewRequestV1 {
	return baseRequest(overrides) as RecipientPolicyReviewedIntentPreviewRequestV1;
}

function protectedSnapshot(db: InstanceType<typeof Database>): string {
	const tables = [
		"replication_scopes",
		"project_scope_mappings",
		"scope_memberships",
		"scope_membership_cache_state",
		"sync_peers",
		"replication_ops",
		"replication_cursors",
		"replication_cursors_v2",
		"sync_reset_state",
		"sync_reset_state_v2",
		"sync_scope_rejections",
	];
	return JSON.stringify(
		Object.fromEntries(
			tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
		),
	);
}

function teamReviewedIntent(): Extract<RecipientReviewedIntentV1, { journey: "team" }> {
	return {
		version: 1,
		journey: "team",
		team: { teamId: "team-fresh", displayName: "Fresh Team", futureProjectsInherit: true },
		projects: [
			{
				canonicalProjectIdentity: PROJECT_A,
				displayName: "alpha",
				existingMemoryCount: 2,
				futureMemoriesShared: true,
				sources: [{ kind: "team", teamId: "team-fresh", displayName: "Fresh Team" }],
			},
		],
		excludedProjects: [
			{ canonicalProjectIdentity: PROJECT_B, displayName: "beta", existingMemoryCount: 1 },
		],
	};
}

function addDeviceReviewedIntent(): Extract<RecipientReviewedIntentV1, { journey: "add_device" }> {
	return {
		version: 1,
		journey: "add_device",
		targetIdentity: { identityId: "identity-existing", displayName: "Existing Person" },
		projects: [
			{
				canonicalProjectIdentity: PROJECT_A,
				displayName: "alpha",
				existingMemoryCount: 2,
				futureMemoriesShared: true,
				sources: [{ kind: "direct" }],
			},
		],
		excludedProjects: [],
	};
}

describe("recipient-policy onboarding", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		insertActor(db, "identity-a", "Ada");
		insertActor(db, "identity-b", "Bea");
		insertProject(db, PROJECT_A, "alpha", 2);
		insertProject(db, PROJECT_B, "beta", 1);
		insertProject(db, PROJECT_C, "gamma", 3);
		insertTeam(db, "team-a", "Core Team");
		insertTeam(db, "team-b", "Docs Team");
		insertRecipient(db, PROJECT_A, "team", "team-a");
		insertRecipient(db, PROJECT_B, "team", "team-a");
		insertRecipient(db, PROJECT_B, "identity", "identity-a");
		insertRecipient(db, PROJECT_C, "team", "team-b");
		insertMembership(db, "team-a", "identity-a");
	});

	afterEach(() => db.close());

	it("builds fresh Team and add-device previews only from reviewed intent and local binding", () => {
		const fresh = new Database(":memory:");
		initTestSchema(fresh);
		try {
			const team = previewRecipientPolicyOnboardingFromReviewedIntent(
				teamReviewedIntent(),
				reviewedIntentRequest({
					journey: "team",
					invitationId: "fresh-team",
					identityId: "identity-fresh",
					teamId: "team-fresh",
				}),
			);
			const addDevice = previewRecipientPolicyOnboardingFromReviewedIntent(
				addDeviceReviewedIntent(),
				reviewedIntentRequest({ identityId: "identity-existing" }),
			);

			expect(team).toMatchObject({
				journey: "team",
				team: { teamId: "team-fresh", displayName: "Fresh Team" },
				projects: [{ canonicalProjectIdentity: PROJECT_A, existingMemoryCount: 2 }],
			});
			expect(addDevice).toMatchObject({
				journey: "add_device",
				binding: { identityId: "identity-existing" },
				projects: [{ canonicalProjectIdentity: PROJECT_A, sources: [{ kind: "direct" }] }],
			});
			expect(fresh.prepare("SELECT COUNT(*) FROM actors").pluck().get()).toBe(0);
			expect(fresh.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		} finally {
			fresh.close();
		}
	});

	it("atomically materializes and replays the minimum fresh Team graph", () => {
		const fresh = new Database(":memory:");
		initTestSchema(fresh);
		try {
			const request = reviewedIntentRequest({
				journey: "team",
				invitationId: "fresh-team",
				identityId: "identity-fresh",
				teamId: "team-fresh",
			});
			const intent = teamReviewedIntent();
			const preview = previewRecipientPolicyOnboardingFromReviewedIntent(intent, request);
			const commitRequest = {
				...request,
				identityDisplayName: "Fresh Person",
				reviewedIntent: intent,
				reviewedOnboardingDigest: preview.reviewedOnboardingDigest,
			};

			const first = commitRecipientPolicyOnboardingFromReviewedIntent(fresh, commitRequest, {
				now: () => NOW,
			});
			const replay = commitRecipientPolicyOnboardingFromReviewedIntent(fresh, commitRequest, {
				now: () => "2026-07-21T13:00:00.000Z",
			});

			expect(first).toMatchObject({ status: "applied", writeCount: 4, idempotent: false });
			expect(replay).toMatchObject({ status: "applied", writeCount: 0, idempotent: true });
			expect(fresh.prepare("SELECT actor_id, is_local FROM actors").all()).toEqual([
				{ actor_id: "identity-fresh", is_local: 1 },
			]);
			expect(fresh.prepare("SELECT team_id FROM policy_teams").pluck().all()).toEqual([
				"team-fresh",
			]);
			expect(
				fresh.prepare("SELECT team_id, identity_id FROM policy_team_memberships").all(),
			).toEqual([{ team_id: "team-fresh", identity_id: "identity-fresh" }]);
			expect(fresh.prepare("SELECT identity_id FROM identity_devices").pluck().get()).toBe(
				"identity-fresh",
			);
			expect(fresh.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
		} finally {
			fresh.close();
		}
	});

	it("keeps a zero-reference bootstrap Identity pristine with a human-friendly display name", () => {
		const fresh = new Database(":memory:");
		initTestSchema(fresh);
		insertActor(fresh, "local:device-new", "Ada", true);
		try {
			const request = reviewedIntentRequest({ identityId: "identity-existing" });
			const intent = addDeviceReviewedIntent();
			const preview = previewRecipientPolicyOnboardingFromReviewedIntent(intent, request);

			const result = commitRecipientPolicyOnboardingFromReviewedIntent(
				fresh,
				{
					...request,
					identityDisplayName: "Ignored local name",
					reviewedIntent: intent,
					reviewedOnboardingDigest: preview.reviewedOnboardingDigest,
				},
				{ now: () => NOW },
			);

			expect(result).toMatchObject({ status: "applied", writeCount: 2 });
			expect(
				fresh
					.prepare(
						"SELECT actor_id, is_local, status, merged_into_actor_id FROM actors ORDER BY actor_id",
					)
					.all(),
			).toEqual([
				{
					actor_id: "identity-existing",
					is_local: 1,
					status: "active",
					merged_into_actor_id: null,
				},
				{
					actor_id: "local:device-new",
					is_local: 0,
					status: "merged",
					merged_into_actor_id: "identity-existing",
				},
			]);
		} finally {
			fresh.close();
		}
	});

	it.each([
		["an actor assignment", "local:device-new", 0],
		["a claimed-local assignment", null, 1],
	] as const)("rejects add-device adoption when a sync peer has %s", (_name, peerActorId, claimed) => {
		const fresh = new Database(":memory:");
		initTestSchema(fresh);
		insertActor(fresh, "local:device-new", "Ada", true);
		fresh
			.prepare(
				`INSERT INTO sync_peers(peer_device_id, actor_id, claimed_local_actor, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.run("peer-device", peerActorId, claimed, NOW);
		try {
			const request = reviewedIntentRequest({ identityId: "identity-existing" });
			const intent = addDeviceReviewedIntent();
			const preview = previewRecipientPolicyOnboardingFromReviewedIntent(intent, request);

			expect(
				commitRecipientPolicyOnboardingFromReviewedIntent(fresh, {
					...request,
					identityDisplayName: "Ada",
					reviewedIntent: intent,
					reviewedOnboardingDigest: preview.reviewedOnboardingDigest,
				}),
			).toMatchObject({ status: "conflict", errorCode: "invite_identity_conflict", writeCount: 0 });
			expect(
				fresh
					.prepare("SELECT is_local, status, merged_into_actor_id FROM actors WHERE actor_id = ?")
					.get("local:device-new"),
			).toEqual({ is_local: 1, status: "active", merged_into_actor_id: null });
		} finally {
			fresh.close();
		}
	});

	it("rejects established-profile adoption without writes", () => {
		const fresh = new Database(":memory:");
		initTestSchema(fresh);
		insertActor(fresh, "local:device-new", "Established Person", true);
		insertTeam(fresh, "team-established", "Established Team");
		insertMembership(fresh, "team-established", "local:device-new");
		try {
			const request = reviewedIntentRequest({ identityId: "identity-existing" });
			const intent = addDeviceReviewedIntent();
			const preview = previewRecipientPolicyOnboardingFromReviewedIntent(intent, request);

			expect(
				commitRecipientPolicyOnboardingFromReviewedIntent(fresh, {
					...request,
					identityDisplayName: "Established Person",
					reviewedIntent: intent,
					reviewedOnboardingDigest: preview.reviewedOnboardingDigest,
				}),
			).toMatchObject({ status: "conflict", errorCode: "invite_identity_conflict", writeCount: 0 });
			expect(fresh.prepare("SELECT actor_id FROM actors").pluck().all()).toEqual([
				"local:device-new",
			]);
			expect(fresh.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
		} finally {
			fresh.close();
		}
	});

	it("rolls back add-device adoption when identity-device insertion fails", () => {
		const fresh = new Database(":memory:");
		initTestSchema(fresh);
		insertActor(fresh, "local:device-new", "Ada", true);
		try {
			const request = reviewedIntentRequest({ identityId: "identity-existing" });
			const intent = addDeviceReviewedIntent();
			const preview = previewRecipientPolicyOnboardingFromReviewedIntent(intent, request);
			const commitRequest = {
				...request,
				identityDisplayName: "Ada",
				reviewedIntent: intent,
				reviewedOnboardingDigest: preview.reviewedOnboardingDigest,
			};
			fresh.exec(`CREATE TRIGGER fail_add_device_binding BEFORE INSERT ON identity_devices
				BEGIN SELECT RAISE(ABORT, 'test identity-device failure'); END`);

			expect(commitRecipientPolicyOnboardingFromReviewedIntent(fresh, commitRequest)).toMatchObject(
				{
					status: "conflict",
					writeCount: 0,
				},
			);
			expect(
				fresh.prepare("SELECT actor_id, is_local, status, merged_into_actor_id FROM actors").all(),
			).toEqual([
				{
					actor_id: "local:device-new",
					is_local: 1,
					status: "active",
					merged_into_actor_id: null,
				},
			]);
			expect(fresh.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);

			fresh.exec("DROP TRIGGER fail_add_device_binding");
			expect(commitRecipientPolicyOnboardingFromReviewedIntent(fresh, commitRequest)).toMatchObject(
				{
					status: "applied",
					writeCount: 2,
				},
			);
			expect(
				fresh
					.prepare("SELECT identity_id FROM identity_devices WHERE device_id = ?")
					.pluck()
					.get("device-new"),
			).toBe("identity-existing");
		} finally {
			fresh.close();
		}
	});

	it("rejects snapshot digest and device-key conflicts atomically", () => {
		const fresh = new Database(":memory:");
		initTestSchema(fresh);
		try {
			const request = reviewedIntentRequest({
				journey: "team",
				invitationId: "fresh-team",
				identityId: "identity-fresh",
				teamId: "team-fresh",
			});
			const intent = teamReviewedIntent();
			const preview = previewRecipientPolicyOnboardingFromReviewedIntent(intent, request);
			const invalid = commitRecipientPolicyOnboardingFromReviewedIntent(fresh, {
				...request,
				identityDisplayName: "Fresh Person",
				reviewedIntent: { ...intent, team: { ...intent.team, displayName: "Tampered" } },
				reviewedOnboardingDigest: preview.reviewedOnboardingDigest,
			});
			expect(invalid).toMatchObject({
				status: "stale",
				errorCode: "reviewed_onboarding_stale",
			});
			expect(fresh.prepare("SELECT COUNT(*) FROM actors").pluck().get()).toBe(0);

			commitRecipientPolicyOnboardingFromReviewedIntent(fresh, {
				...request,
				identityDisplayName: "Fresh Person",
				reviewedIntent: intent,
				reviewedOnboardingDigest: preview.reviewedOnboardingDigest,
			});
			const changedKey = {
				...request,
				invitationId: "fresh-team-two",
				devicePublicKey: "other-key",
			};
			const changedPreview = previewRecipientPolicyOnboardingFromReviewedIntent(intent, changedKey);
			expect(
				commitRecipientPolicyOnboardingFromReviewedIntent(fresh, {
					...changedKey,
					identityDisplayName: "Fresh Person",
					reviewedIntent: intent,
					reviewedOnboardingDigest: changedPreview.reviewedOnboardingDigest,
				}),
			).toMatchObject({
				status: "conflict",
				errorCode: "device_binding_conflict",
				writeCount: 0,
			});
			expect(fresh.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(1);
		} finally {
			fresh.close();
		}
	});

	it("rolls back snapshot materialization when a later row fails", () => {
		const fresh = new Database(":memory:");
		initTestSchema(fresh);
		try {
			const request = reviewedIntentRequest({
				journey: "team",
				identityId: "identity-fresh",
				teamId: "team-fresh",
			});
			const intent = teamReviewedIntent();
			const preview = previewRecipientPolicyOnboardingFromReviewedIntent(intent, request);
			fresh.exec(`CREATE TRIGGER fail_fresh_membership BEFORE INSERT ON policy_team_memberships
				BEGIN SELECT RAISE(ABORT, 'test conflict'); END`);

			expect(
				commitRecipientPolicyOnboardingFromReviewedIntent(fresh, {
					...request,
					identityDisplayName: "Fresh Person",
					reviewedIntent: intent,
					reviewedOnboardingDigest: preview.reviewedOnboardingDigest,
				}),
			).toMatchObject({ status: "conflict", writeCount: 0 });
			expect(fresh.prepare("SELECT COUNT(*) FROM actors").pluck().get()).toBe(0);
			expect(fresh.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
			expect(fresh.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
		} finally {
			fresh.close();
		}
	});

	it("previews Team Projects, memory counts, exclusions, and future inheritance without writes", () => {
		const request = baseRequest({
			journey: "team",
			invitationId: "invite-team",
			teamId: "team-a",
		});
		const before = Number(db.prepare("SELECT total_changes()").pluck().get());

		const preview = previewRecipientPolicyOnboarding(db, request);

		expect(preview.binding).toMatchObject({
			identityId: "identity-a",
			deviceId: "device-new",
			deviceDisplayName: "Ada’s Laptop",
		});
		expect(preview.team).toEqual({
			teamId: "team-a",
			displayName: "Core Team",
			futureProjectsInherit: true,
		});
		expect(preview.projects).toEqual([
			expect.objectContaining({
				canonicalProjectIdentity: PROJECT_A,
				displayName: "alpha",
				existingMemoryCount: 2,
				futureMemoriesShared: true,
			}),
			expect.objectContaining({
				canonicalProjectIdentity: PROJECT_B,
				displayName: "beta",
				existingMemoryCount: 1,
				futureMemoriesShared: true,
			}),
		]);
		expect(preview.excludedProjects).toEqual([
			expect.objectContaining({ canonicalProjectIdentity: PROJECT_C, existingMemoryCount: 3 }),
		]);
		expect(Number(db.prepare("SELECT total_changes()").pluck().get())).toBe(before);
	});

	it("previews direct Projects exactly and add-device direct plus Team inheritance", () => {
		const direct = previewRecipientPolicyOnboarding(
			db,
			baseRequest({
				journey: "direct_project",
				invitationId: "invite-direct",
				canonicalProjectIdentities: [PROJECT_C, PROJECT_A],
			}),
		);
		expect(direct.projects.map((project) => project.canonicalProjectIdentity)).toEqual([
			PROJECT_A,
			PROJECT_C,
		]);
		expect(direct.projects.every((project) => project.sources[0]?.kind === "direct")).toBe(true);
		expect(direct.excludedProjects.map((project) => project.canonicalProjectIdentity)).toEqual([
			PROJECT_B,
		]);

		const addDevice = previewRecipientPolicyOnboarding(db, baseRequest());
		expect(addDevice.projects).toEqual([
			expect.objectContaining({
				canonicalProjectIdentity: PROJECT_A,
				sources: [{ kind: "team", teamId: "team-a", displayName: "Core Team" }],
			}),
			expect.objectContaining({
				canonicalProjectIdentity: PROJECT_B,
				sources: [{ kind: "direct" }, { kind: "team", teamId: "team-a", displayName: "Core Team" }],
			}),
		]);
		expect(addDevice.excludedProjects.map((project) => project.canonicalProjectIdentity)).toEqual([
			PROJECT_C,
		]);
	});

	it("does not stale a reviewed decision when only an excluded Project count changes", () => {
		const request = baseRequest({
			journey: "direct_project",
			invitationId: "invite-unrelated-churn",
			canonicalProjectIdentities: [PROJECT_A],
		});
		const first = previewRecipientPolicyOnboarding(db, request);
		const excludedSessionId = db
			.prepare("SELECT id FROM sessions WHERE git_remote = ?")
			.pluck()
			.get(PROJECT_C);
		db.prepare(
			`INSERT INTO memory_items(
			 session_id, kind, title, body_text, active, created_at, updated_at,
			 visibility, project, scope_id
			 ) VALUES (?, 'discovery', 'unrelated', 'body', 1, ?, ?, 'shared', 'gamma', 'local-default')`,
		).run(excludedSessionId, NOW, NOW);

		const refreshed = previewRecipientPolicyOnboarding(db, request);

		const firstExcluded = first.excludedProjects.find(
			(project) => project.canonicalProjectIdentity === PROJECT_C,
		);
		const refreshedExcluded = refreshed.excludedProjects.find(
			(project) => project.canonicalProjectIdentity === PROJECT_C,
		);
		expect(refreshedExcluded?.existingMemoryCount).toBeGreaterThan(
			firstExcluded?.existingMemoryCount ?? 0,
		);
		expect(refreshed.reviewedOnboardingDigest).toBe(first.reviewedOnboardingDigest);
	});

	it("commits Team membership plus device atomically and exactly retries idempotently", () => {
		const request = baseRequest({
			journey: "team",
			invitationId: "invite-team-new",
			identityId: "identity-b",
			teamId: "team-a",
		});
		const preview = previewRecipientPolicyOnboarding(db, request);
		const protectedBefore = protectedSnapshot(db);

		const first = commitRecipientPolicyOnboarding(
			db,
			{ ...request, reviewedOnboardingDigest: preview.reviewedOnboardingDigest },
			{ now: () => NOW },
		);
		const second = commitRecipientPolicyOnboarding(
			db,
			{ ...request, reviewedOnboardingDigest: preview.reviewedOnboardingDigest },
			{ now: () => "2026-07-21T13:00:00.000Z" },
		);

		expect(first).toMatchObject({ status: "applied", writeCount: 2, idempotent: false });
		expect(second).toMatchObject({ status: "applied", writeCount: 0, idempotent: true });
		const intent = listRecipientPolicyIntent(db);
		expect(intent.teamMemberships).toContainEqual(
			expect.objectContaining({ teamId: "team-a", identityId: "identity-b" }),
		);
		expect(intent.identityDevices).toContainEqual(
			expect.objectContaining({ deviceId: "device-new", identityId: "identity-b" }),
		);
		expect(protectedSnapshot(db)).toBe(protectedBefore);
	});

	it("commits exact direct recipients plus device without Team membership", () => {
		const request = baseRequest({
			journey: "direct_project",
			invitationId: "invite-direct",
			identityId: "identity-b",
			canonicalProjectIdentities: [PROJECT_C, PROJECT_A],
		});
		const preview = previewRecipientPolicyOnboarding(db, request);
		const membershipsBefore = db
			.prepare("SELECT * FROM policy_team_memberships ORDER BY rowid")
			.all();

		const result = commitRecipientPolicyOnboarding(
			db,
			{ ...request, reviewedOnboardingDigest: preview.reviewedOnboardingDigest },
			{ now: () => NOW },
		);

		expect(result).toMatchObject({ status: "applied", writeCount: 3 });
		const rows = db
			.prepare(
				`SELECT canonical_project_identity, recipient_kind, recipient_id
				 FROM project_recipients WHERE recipient_id = 'identity-b'
				 ORDER BY canonical_project_identity`,
			)
			.all();
		expect(rows).toEqual([
			{
				canonical_project_identity: PROJECT_A,
				recipient_kind: "identity",
				recipient_id: "identity-b",
			},
			{
				canonical_project_identity: PROJECT_C,
				recipient_kind: "identity",
				recipient_id: "identity-b",
			},
		]);
		expect(db.prepare("SELECT * FROM policy_team_memberships ORDER BY rowid").all()).toEqual(
			membershipsBefore,
		);
	});

	it("atomically commits the complete direct-share owner and recipient graph", () => {
		insertActor(db, "identity-owner", "Owner", true);
		const membershipsBefore = db
			.prepare("SELECT * FROM policy_team_memberships ORDER BY rowid")
			.all();
		const input = {
			operationId: "share-complete-graph",
			inviterIdentityId: "identity-owner",
			inviterDevices: [
				{ deviceId: "device-owner", displayName: "Owner laptop" },
				{ deviceId: "device-owner-proven", displayName: "Owner server" },
			],
			recipientIdentityId: "identity-b",
			recipientDeviceId: "device-recipient",
			recipientDevicePublicKey: "recipient-public-key",
			recipientDeviceDisplayName: "Recipient laptop",
			canonicalProjectIdentities: [PROJECT_C, PROJECT_A],
			now: NOW,
		};
		const commit = db.transaction(() => commitDirectProjectSharePolicyInTransaction(db, input));

		expect(commit()).toBe(7);
		expect(
			db.prepare("SELECT identity_id, device_id FROM identity_devices ORDER BY device_id").all(),
		).toEqual([
			{ identity_id: "identity-owner", device_id: "device-owner" },
			{ identity_id: "identity-owner", device_id: "device-owner-proven" },
			{ identity_id: "identity-b", device_id: "device-recipient" },
		]);
		expect(
			db
				.prepare(`SELECT canonical_project_identity, recipient_id
				FROM project_recipients
				WHERE recipient_id IN ('identity-owner', 'identity-b')
				ORDER BY canonical_project_identity, recipient_id`)
				.all(),
		).toEqual([
			{ canonical_project_identity: PROJECT_A, recipient_id: "identity-b" },
			{ canonical_project_identity: PROJECT_A, recipient_id: "identity-owner" },
			{ canonical_project_identity: PROJECT_C, recipient_id: "identity-b" },
			{ canonical_project_identity: PROJECT_C, recipient_id: "identity-owner" },
		]);
		expect(
			db.prepare("SELECT 1 FROM identity_devices WHERE device_id = 'source-bystander'").get(),
		).toBeUndefined();
		expect(db.prepare("SELECT * FROM policy_team_memberships ORDER BY rowid").all()).toEqual(
			membershipsBefore,
		);
		expect(commit()).toBe(0);
	});

	it("preserves compatible migration rows and writes only new recipient intent", () => {
		insertActor(db, "identity-owner", "Owner", true);
		db.prepare(
			`INSERT INTO identity_devices(
			 identity_id, device_id, display_name, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES ('identity-owner', 'device-owner', 'Migrated owner device', 'active',
			 'migration', 'migration-device-revision', 'projected', 'migration-device-source',
			 'migration-device-idempotency', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, source_fingerprint, idempotency_key,
			 created_at, updated_at
			 ) VALUES (?, 'identity', 'identity-owner', 'active', 'migration',
			 'migration-project-revision', 'projected', 'migration-source-fingerprint',
			 'migration-project-idempotency', ?, ?)`,
		).run(PROJECT_A, NOW, NOW);
		const existingDevice = db
			.prepare("SELECT * FROM identity_devices WHERE device_id = 'device-owner'")
			.get();
		const existingProject = db
			.prepare(`SELECT * FROM project_recipients
				WHERE canonical_project_identity = ? AND recipient_kind = 'identity'
				AND recipient_id = 'identity-owner'`)
			.get(PROJECT_A);
		const input = {
			operationId: "share-migrated-owner",
			inviterIdentityId: "identity-owner",
			inviterDevices: [{ deviceId: "device-owner", displayName: "Ignored new label" }],
			recipientIdentityId: "identity-b",
			recipientDeviceId: "device-recipient",
			recipientDevicePublicKey: "recipient-public-key",
			recipientDeviceDisplayName: "Recipient laptop",
			canonicalProjectIdentities: [PROJECT_A],
			now: NOW,
		};
		const commit = db.transaction(() => commitDirectProjectSharePolicyInTransaction(db, input));

		expect(commit()).toBe(2);
		expect(
			db.prepare("SELECT * FROM identity_devices WHERE device_id = 'device-owner'").get(),
		).toEqual(existingDevice);
		expect(
			db
				.prepare(`SELECT * FROM project_recipients
				WHERE canonical_project_identity = ? AND recipient_kind = 'identity'
				AND recipient_id = 'identity-owner'`)
				.get(PROJECT_A),
		).toEqual(existingProject);
		expect(
			db
				.prepare("SELECT identity_id, device_id FROM identity_devices WHERE device_id = ?")
				.get("device-recipient"),
		).toEqual({ identity_id: "identity-b", device_id: "device-recipient" });
		expect(commit()).toBe(0);
	});

	it("rejects a revoked inviter Project edge without partial recipient intent", () => {
		insertActor(db, "identity-owner", "Owner", true);
		db.prepare(
			`INSERT INTO identity_devices(
			 identity_id, device_id, display_name, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES ('identity-owner', 'device-owner', 'Migrated owner device', 'active',
			 'migration', 'migration-device-revision', 'projected', NULL,
			 'migration-device-idempotency', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, source_fingerprint, idempotency_key,
			 created_at, updated_at
			 ) VALUES (?, 'identity', 'identity-owner', 'revoked', 'migration',
			 'migration-project-revision', 'projected', NULL,
			 'migration-project-idempotency', ?, ?)`,
		).run(PROJECT_A, NOW, NOW);
		const commit = db.transaction(() =>
			commitDirectProjectSharePolicyInTransaction(db, {
				operationId: "share-revoked-owner",
				inviterIdentityId: "identity-owner",
				inviterDevices: [{ deviceId: "device-owner", displayName: "Owner device" }],
				recipientIdentityId: "identity-b",
				recipientDeviceId: "device-recipient",
				recipientDevicePublicKey: "recipient-public-key",
				recipientDeviceDisplayName: "Recipient laptop",
				canonicalProjectIdentities: [PROJECT_A],
				now: NOW,
			}),
		);

		expect(() => commit()).toThrow("intent_conflict");
		expect(
			db
				.prepare("SELECT status FROM project_recipients WHERE recipient_id = 'identity-owner'")
				.pluck()
				.get(),
		).toBe("revoked");
		expect(
			db.prepare("SELECT 1 FROM identity_devices WHERE device_id = 'device-recipient'").get(),
		).toBeUndefined();
		expect(
			db.prepare("SELECT 1 FROM project_recipients WHERE recipient_id = 'identity-b'").get(),
		).toBeUndefined();
	});

	it("rolls back recipient intent when a reviewed inviter device belongs to another Identity", () => {
		insertActor(db, "identity-owner", "Owner", true);
		db.prepare(
			`INSERT INTO identity_devices(
			 identity_id, device_id, display_name, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES ('identity-a', 'device-owner', 'Wrong owner', 'active', 'user',
			 'existing-revision', 'user_managed', 'existing-source', 'existing-key', ?, ?)`,
		).run(NOW, NOW);
		const intentBefore = JSON.stringify({
			devices: db.prepare("SELECT * FROM identity_devices ORDER BY rowid").all(),
			recipients: db.prepare("SELECT * FROM project_recipients ORDER BY rowid").all(),
		});
		const commit = db.transaction(() =>
			commitDirectProjectSharePolicyInTransaction(db, {
				operationId: "share-conflicting-owner",
				inviterIdentityId: "identity-owner",
				inviterDevices: [{ deviceId: "device-owner", displayName: "Owner laptop" }],
				recipientIdentityId: "identity-b",
				recipientDeviceId: "device-recipient",
				recipientDevicePublicKey: "recipient-public-key",
				recipientDeviceDisplayName: "Recipient laptop",
				canonicalProjectIdentities: [PROJECT_A],
				now: NOW,
			}),
		);

		expect(() => commit()).toThrow("device_binding_conflict");
		expect(
			JSON.stringify({
				devices: db.prepare("SELECT * FROM identity_devices ORDER BY rowid").all(),
				recipients: db.prepare("SELECT * FROM project_recipients ORDER BY rowid").all(),
			}),
		).toBe(intentBefore);
	});

	it("rejects a non-active inviter device binding", () => {
		insertActor(db, "identity-owner", "Owner", true);
		db.prepare(
			`INSERT INTO identity_devices(
			 identity_id, device_id, display_name, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES ('identity-owner', 'device-owner', 'Revoked owner device', 'revoked',
			 'migration', 'migration-device-revision', 'projected', NULL,
			 'migration-device-idempotency', ?, ?)`,
		).run(NOW, NOW);
		const commit = db.transaction(() =>
			commitDirectProjectSharePolicyInTransaction(db, {
				operationId: "share-revoked-device",
				inviterIdentityId: "identity-owner",
				inviterDevices: [{ deviceId: "device-owner", displayName: "Owner device" }],
				recipientIdentityId: "identity-b",
				recipientDeviceId: "device-recipient",
				recipientDevicePublicKey: "recipient-public-key",
				recipientDeviceDisplayName: "Recipient laptop",
				canonicalProjectIdentities: [PROJECT_A],
				now: NOW,
			}),
		);

		expect(() => commit()).toThrow("device_binding_conflict");
		expect(
			db.prepare("SELECT 1 FROM identity_devices WHERE device_id = 'device-recipient'").get(),
		).toBeUndefined();
		expect(
			db.prepare("SELECT 1 FROM project_recipients WHERE recipient_id = 'identity-b'").get(),
		).toBeUndefined();
	});

	it("reuses an identical device binding across direct and Team invitations", () => {
		const direct = baseRequest({
			journey: "direct_project",
			invitationId: "invite-direct-first",
			identityId: "identity-b",
			canonicalProjectIdentities: [PROJECT_A],
		});
		const directPreview = previewRecipientPolicyOnboarding(db, direct);
		commitRecipientPolicyOnboarding(
			db,
			{ ...direct, reviewedOnboardingDigest: directPreview.reviewedOnboardingDigest },
			{ now: () => NOW },
		);
		const team = baseRequest({
			journey: "team",
			invitationId: "invite-team-second",
			identityId: "identity-b",
			teamId: "team-a",
		});
		const teamPreview = previewRecipientPolicyOnboarding(db, team);

		const result = commitRecipientPolicyOnboarding(
			db,
			{ ...team, reviewedOnboardingDigest: teamPreview.reviewedOnboardingDigest },
			{ now: () => NOW },
		);

		expect(result).toMatchObject({ status: "applied", writeCount: 1 });
		expect(db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(1);
		expect(
			db.prepare("SELECT team_id, identity_id FROM policy_team_memberships").all(),
		).toContainEqual({ team_id: "team-a", identity_id: "identity-b" });
	});

	it("rejects a changed device key across distinct invitations", () => {
		const first = baseRequest({ invitationId: "invite-first" });
		const firstPreview = previewRecipientPolicyOnboarding(db, first);
		commitRecipientPolicyOnboarding(
			db,
			{ ...first, reviewedOnboardingDigest: firstPreview.reviewedOnboardingDigest },
			{ now: () => NOW },
		);
		const originalBinding = db
			.prepare("SELECT * FROM identity_devices WHERE device_id = ?")
			.get(first.deviceId);
		const second = baseRequest({
			invitationId: "invite-second",
			devicePublicKey: "public-key-b",
		});
		const secondPreview = previewRecipientPolicyOnboarding(db, second);

		expect(
			commitRecipientPolicyOnboarding(
				db,
				{ ...second, reviewedOnboardingDigest: secondPreview.reviewedOnboardingDigest },
				{ now: () => NOW },
			),
		).toMatchObject({ status: "conflict", errorCode: "device_binding_conflict", writeCount: 0 });
		expect(
			db.prepare("SELECT * FROM identity_devices WHERE device_id = ?").get(first.deviceId),
		).toEqual(originalBinding);
	});

	it("key-binds a compatible exact-Project inviter device on recipient onboarding", () => {
		db.prepare(
			`INSERT INTO sync_device(device_id, public_key, fingerprint, created_at)
			 VALUES ('device-new', 'public-key-a', ?, ?)`,
		).run(fingerprintPublicKey("public-key-a"), NOW);
		db.prepare(
			`INSERT INTO identity_devices(
			 identity_id, device_id, display_name, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES ('identity-a', 'device-new', 'Original device', 'active',
			 'exact_project_invite', 'exact-project-revision', 'user_managed',
			 'exact-project-source', 'exact-project-idempotency', ?, ?)`,
		).run(NOW, NOW);
		const request = baseRequest({ invitationId: "invite-key-binding-transition" });
		const preview = previewRecipientPolicyOnboarding(db, request);

		const result = commitRecipientPolicyOnboarding(
			db,
			{ ...request, reviewedOnboardingDigest: preview.reviewedOnboardingDigest },
			{ now: () => "2026-07-21T12:01:00.000Z" },
		);

		expect(result).toMatchObject({ status: "applied", writeCount: 1, idempotent: false });
		expect(
			db
				.prepare(
					`SELECT identity_id, device_id, display_name, status, provenance,
					 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
					 FROM identity_devices WHERE device_id = 'device-new'`,
				)
				.get(),
		).toMatchObject({
			identity_id: "identity-a",
			device_id: "device-new",
			display_name: "Ada’s Laptop",
			status: "active",
			provenance: "recipient_invite",
			migration_state: "user_managed",
			created_at: NOW,
			updated_at: "2026-07-21T12:01:00.000Z",
		});

		const changed = baseRequest({
			invitationId: "invite-after-key-binding-transition",
			devicePublicKey: "public-key-b",
		});
		const changedPreview = previewRecipientPolicyOnboarding(db, changed);
		const bindingAfterTransition = db
			.prepare("SELECT * FROM identity_devices WHERE device_id = 'device-new'")
			.get();

		expect(
			commitRecipientPolicyOnboarding(db, {
				...changed,
				reviewedOnboardingDigest: changedPreview.reviewedOnboardingDigest,
			}),
		).toMatchObject({ status: "conflict", errorCode: "device_binding_conflict", writeCount: 0 });
		expect(
			db.prepare("SELECT * FROM identity_devices WHERE device_id = 'device-new'").get(),
		).toEqual(bindingAfterTransition);
	});

	it.each([
		null,
		"different-public-key",
	])("rejects an exact-Project device transition without matching local key %s", (localPublicKey) => {
		if (localPublicKey) {
			db.prepare(
				`INSERT INTO sync_device(device_id, public_key, fingerprint, created_at)
					 VALUES ('device-new', ?, ?, ?)`,
			).run(localPublicKey, fingerprintPublicKey(localPublicKey), NOW);
		}
		db.prepare(
			`INSERT INTO identity_devices(
				 identity_id, device_id, display_name, status, provenance, revision, migration_state,
				 source_fingerprint, idempotency_key, created_at, updated_at
				 ) VALUES ('identity-a', 'device-new', 'Original device', 'active',
				 'exact_project_invite', 'exact-project-revision', 'user_managed',
				 'exact-project-source', 'exact-project-idempotency', ?, ?)`,
		).run(NOW, NOW);
		const originalBinding = db
			.prepare("SELECT * FROM identity_devices WHERE device_id = 'device-new'")
			.get();
		const request = baseRequest({ invitationId: "invite-rejected-key-transition" });
		const preview = previewRecipientPolicyOnboarding(db, request);

		expect(
			commitRecipientPolicyOnboarding(db, {
				...request,
				reviewedOnboardingDigest: preview.reviewedOnboardingDigest,
			}),
		).toMatchObject({ status: "conflict", errorCode: "device_binding_conflict", writeCount: 0 });
		expect(
			db.prepare("SELECT * FROM identity_devices WHERE device_id = 'device-new'").get(),
		).toEqual(originalBinding);
	});

	it("commits add-device as the only intent write", () => {
		const request = baseRequest();
		const preview = previewRecipientPolicyOnboarding(db, request);
		const recipientsBefore = db.prepare("SELECT * FROM project_recipients ORDER BY rowid").all();
		const membershipsBefore = db
			.prepare("SELECT * FROM policy_team_memberships ORDER BY rowid")
			.all();

		const result = commitRecipientPolicyOnboarding(
			db,
			{ ...request, reviewedOnboardingDigest: preview.reviewedOnboardingDigest },
			{ now: () => NOW },
		);

		expect(result).toMatchObject({ status: "applied", writeCount: 1 });
		expect(db.prepare("SELECT device_id, identity_id FROM identity_devices").all()).toEqual([
			{ device_id: "device-new", identity_id: "identity-a" },
		]);
		expect(db.prepare("SELECT * FROM project_recipients ORDER BY rowid").all()).toEqual(
			recipientsBefore,
		);
		expect(db.prepare("SELECT * FROM policy_team_memberships ORDER BY rowid").all()).toEqual(
			membershipsBefore,
		);
	});

	it("rejects changed key, device, or Identity on invitation retry", () => {
		const request = baseRequest();
		const preview = previewRecipientPolicyOnboarding(db, request);
		expect(
			commitRecipientPolicyOnboarding(
				db,
				{ ...request, reviewedOnboardingDigest: preview.reviewedOnboardingDigest },
				{ now: () => NOW },
			),
		).toMatchObject({ status: "applied" });

		for (const changed of [
			baseRequest({ devicePublicKey: "public-key-b" }),
			baseRequest({ deviceId: "device-other" }),
			baseRequest({ identityId: "identity-b" }),
		]) {
			const changedPreview = previewRecipientPolicyOnboarding(db, changed);
			expect(
				commitRecipientPolicyOnboarding(
					db,
					{ ...changed, reviewedOnboardingDigest: changedPreview.reviewedOnboardingDigest },
					{ now: () => NOW },
				),
			).toMatchObject({ status: "conflict", writeCount: 0 });
		}
		expect(db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(1);
	});

	it("rejects one device mapped to another Identity", () => {
		const first = baseRequest({ invitationId: "invite-first" });
		const firstPreview = previewRecipientPolicyOnboarding(db, first);
		commitRecipientPolicyOnboarding(
			db,
			{ ...first, reviewedOnboardingDigest: firstPreview.reviewedOnboardingDigest },
			{ now: () => NOW },
		);
		const second = baseRequest({ invitationId: "invite-second", identityId: "identity-b" });
		const secondPreview = previewRecipientPolicyOnboarding(db, second);

		expect(
			commitRecipientPolicyOnboarding(
				db,
				{ ...second, reviewedOnboardingDigest: secondPreview.reviewedOnboardingDigest },
				{ now: () => NOW },
			),
		).toMatchObject({ status: "conflict", errorCode: "device_binding_conflict" });
	});

	it("rolls back every intent row when a later write fails", () => {
		const request = baseRequest({
			journey: "direct_project",
			invitationId: "invite-rollback",
			identityId: "identity-b",
			canonicalProjectIdentities: [PROJECT_A, PROJECT_C],
		});
		const preview = previewRecipientPolicyOnboarding(db, request);
		const intentBefore = JSON.stringify({
			devices: db.prepare("SELECT * FROM identity_devices").all(),
			recipients: db.prepare("SELECT * FROM project_recipients ORDER BY rowid").all(),
		});
		const protectedBefore = protectedSnapshot(db);
		db.exec(
			`CREATE TRIGGER fail_onboarding_edge BEFORE INSERT ON project_recipients
			 WHEN NEW.canonical_project_identity = '${PROJECT_C}'
			 BEGIN SELECT RAISE(ABORT, 'test conflict'); END`,
		);

		expect(
			commitRecipientPolicyOnboarding(db, {
				...request,
				reviewedOnboardingDigest: preview.reviewedOnboardingDigest,
			}),
		).toMatchObject({ status: "conflict", writeCount: 0 });
		expect(
			JSON.stringify({
				devices: db.prepare("SELECT * FROM identity_devices").all(),
				recipients: db.prepare("SELECT * FROM project_recipients ORDER BY rowid").all(),
			}),
		).toBe(intentBefore);
		expect(protectedSnapshot(db)).toBe(protectedBefore);
	});
});
