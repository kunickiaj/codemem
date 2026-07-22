import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRecipientPolicyIntent } from "./recipient-policy-intent.js";
import {
	commitRecipientPolicyOnboarding,
	previewRecipientPolicyOnboarding,
	type RecipientPolicyOnboardingPreviewRequestV1,
} from "./recipient-policy-onboarding.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-07-21T12:00:00.000Z";
const PROJECT_A = "https://git.example.invalid/acme/alpha.git";
const PROJECT_B = "https://git.example.invalid/acme/beta.git";
const PROJECT_C = "https://git.example.invalid/acme/gamma.git";

function insertActor(
	db: InstanceType<typeof Database>,
	identityId: string,
	displayName: string,
): void {
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES (?, ?, 0, 'active', ?, ?)`,
	).run(identityId, displayName, NOW, NOW);
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
