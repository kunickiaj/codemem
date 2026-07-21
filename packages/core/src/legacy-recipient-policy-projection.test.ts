import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listLegacyRecipientPolicyProjections } from "./legacy-recipient-policy-projection.js";
import { shareProjectSetDigest } from "./share-operation.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-07-21T12:00:00.000Z";
const LOCAL_ACTOR_ID = "actor-local";
const LOCAL_DEVICE_ID = "device-local";

function insertScope(
	db: InstanceType<typeof Database>,
	input: {
		scopeId: string;
		label: string;
		kind: string;
		coordinatorId?: string | null;
		groupId?: string | null;
		authorityType?: string;
		membershipEpoch?: number;
	},
): void {
	db.prepare(
		`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id,
			membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
	).run(
		input.scopeId,
		input.label,
		input.kind,
		input.authorityType ?? "coordinator",
		input.coordinatorId ?? null,
		input.groupId ?? null,
		input.membershipEpoch ?? 1,
		NOW,
		NOW,
	);
}

function insertProject(
	db: InstanceType<typeof Database>,
	input: { remote?: string | null; cwd?: string | null; project: string; scopeId?: string | null },
): string {
	const remote =
		input.remote === undefined
			? `https://git.example.invalid/acme/${input.project}.git`
			: input.remote;
	const sessionId = Number(
		db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, git_remote, git_branch)
				 VALUES (?, ?, ?, ?, 'main')`,
			)
			.run(NOW, input.cwd ?? null, input.project, remote).lastInsertRowid,
	);
	db.prepare(
		`INSERT INTO memory_items(
			session_id, kind, title, body_text, active, created_at, updated_at,
			visibility, project, scope_id
		 ) VALUES (?, 'discovery', ?, 'body', 1, ?, ?, 'shared', ?, ?)`,
	).run(sessionId, input.project, NOW, NOW, input.project, input.scopeId ?? "local-default");
	return remote ?? input.cwd ?? "";
}

function mapProject(
	db: InstanceType<typeof Database>,
	canonicalIdentity: string,
	scopeId: string,
	projectPattern = canonicalIdentity,
): void {
	db.prepare(
		`INSERT INTO project_scope_mappings(
			workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
		 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`,
	).run(canonicalIdentity, projectPattern, scopeId, NOW, NOW);
}

function addMembership(
	db: InstanceType<typeof Database>,
	scopeId: string,
	deviceId: string,
	membershipEpoch = 1,
): void {
	db.prepare(
		`INSERT INTO scope_memberships(
			scope_id, device_id, role, status, membership_epoch, updated_at
		 ) VALUES (?, ?, 'member', 'active', ?, ?)`,
	).run(scopeId, deviceId, membershipEpoch, NOW);
}

function addPeer(
	db: InstanceType<typeof Database>,
	input: { deviceId: string; displayName: string; actorId?: string | null },
): void {
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, name, actor_id, addresses_json, created_at)
		 VALUES (?, ?, ?, '["sensitive-address"]', ?)`,
	).run(input.deviceId, input.displayName, input.actorId ?? null, NOW);
}

function addShareOperation(
	db: InstanceType<typeof Database>,
	input: {
		actorId: string;
		projectId: string;
		projectName: string;
		state?: string;
		bound?: boolean;
	},
): void {
	const reviewedProjectSetDigest = shareProjectSetDigest([
		{
			canonicalIdentity: input.projectId,
			displayName: input.projectName,
			identitySource: "git_remote",
			existingMemoryCount: 1,
		},
	]);
	db.prepare(
		`INSERT INTO actors(
			actor_id, display_name, is_local, status, created_at, updated_at
		 ) VALUES (?, 'Recipient Person', 0, 'active', ?, ?)`,
	).run(input.actorId, NOW, NOW);
	db.prepare(
		`INSERT INTO share_operations(
			operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
			person_kind, teammate_name, history_policy, reviewed_project_set_digest,
			coordinator_group_id, invite_token_digest, invite_expires_at,
			recipient_actor_id, recipient_device_id, acceptance_consumed_at, created_at, updated_at
		 ) VALUES ('share-projection', ?, ?, '[]', ?, 'existing', 'Recipient Person',
			'existing_and_future', ?, 'group-a', 'invite-digest', ?, ?, ?, ?, ?, ?)`,
	).run(
		input.state ?? "active",
		LOCAL_ACTOR_ID,
		input.actorId,
		reviewedProjectSetDigest,
		"2099-01-01T00:00:00.000Z",
		input.bound === false ? null : input.actorId,
		input.bound === false ? null : "device-recipient",
		input.bound === false ? null : NOW,
		NOW,
		NOW,
	);
	db.prepare(
		`INSERT INTO share_operation_projects(
			operation_id, canonical_project_identity, display_name, identity_source,
			existing_memory_count, ordinal
		 ) VALUES ('share-projection', ?, ?, 'git_remote', 1, 0)`,
	).run(input.projectId, input.projectName);
}

function projections(db: InstanceType<typeof Database>) {
	return listLegacyRecipientPolicyProjections(db, {
		localActorId: LOCAL_ACTOR_ID,
		localDeviceId: LOCAL_DEVICE_ID,
	});
}

describe("legacy recipient-policy projection", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		db.prepare(
			`INSERT INTO actors(
				actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
			 ) VALUES (?, 'Local Person', 1, 'active', NULL, ?, ?)`,
		).run(LOCAL_ACTOR_ID, NOW, NOW);
	});

	afterEach(() => db.close());

	it("projects one exact canonical Project from one active managed scope", () => {
		const scopeId = "managed-project-one";
		const projectId = insertProject(db, { project: "api", scopeId });
		insertScope(db, {
			scopeId,
			label: "api",
			kind: "managed_project",
			coordinatorId: "coordinator-a",
			groupId: "group-a",
		});
		mapProject(db, projectId, scopeId);
		addMembership(db, scopeId, LOCAL_DEVICE_ID);
		addShareOperation(db, {
			actorId: "actor-recipient",
			projectId,
			projectName: "api",
		});

		const [projection] = projections(db);

		expect(projection).toMatchObject({
			project: { canonicalIdentity: projectId, displayName: "api" },
			intent: [],
			enforcement: {
				state: "managed_exact_project",
				currentDeviceIds: [LOCAL_DEVICE_ID],
				safeErrorCode: null,
			},
		});
		expect(projection?.identityCandidates).toContainEqual(
			expect.objectContaining({
				identityId: "actor-recipient",
				confidence: "high",
				provenance: expect.arrayContaining(["exact_project_invite"]),
			}),
		);
	});

	it("offers local and personal evidence only as an actionable suggestion", () => {
		const projectId = insertProject(db, {
			remote: null,
			cwd: "/Users/test/personal/notes",
			project: "notes",
		});

		const projection = projections(db).find((item) => item.project.canonicalIdentity === projectId);

		expect(projection).toMatchObject({
			intent: [],
			identityCandidates: [
				expect.objectContaining({
					identityId: LOCAL_ACTOR_ID,
					suggestedKind: "personal",
					confidence: "high",
				}),
			],
			enforcement: { state: "local_only" },
			conditions: [expect.objectContaining({ code: "suggest_local_identity", kind: "actionable" })],
		});
	});

	it("includes the local runtime for an active custom local-authority scope", () => {
		const scopeId = "personal-custom-local";
		const projectId = insertProject(db, { project: "journal", scopeId });
		insertScope(db, {
			scopeId,
			label: "Journal",
			kind: "personal",
			authorityType: "local",
		});
		mapProject(db, projectId, scopeId);

		const [projection] = projections(db);

		expect(projection?.effectiveDevices).toEqual([
			expect.objectContaining({
				deviceId: LOCAL_DEVICE_ID,
				identityId: LOCAL_ACTOR_ID,
				provenance: "local_runtime",
			}),
		]);
		expect(projection?.enforcement.currentDeviceIds).toEqual([LOCAL_DEVICE_ID]);
	});

	it("exposes a coordinator group only as a non-authoritative Team candidate", () => {
		const scopeId = "legacy-team-space";
		const projectId = insertProject(db, { project: "docs", scopeId });
		insertScope(db, {
			scopeId,
			label: "Docs Team",
			kind: "team",
			coordinatorId: "coordinator-a",
			groupId: "group-docs",
		});
		mapProject(db, projectId, scopeId);

		const [projection] = projections(db);

		expect(projection.intent).toEqual([]);
		expect(projection.teamCandidates).toEqual([
			expect.objectContaining({
				displayName: "Docs Team",
				confidence: "medium",
				provenance: ["coordinator_group_enrollment"],
			}),
		]);
		expect(projection.conditions).toContainEqual(
			expect.objectContaining({ code: "suggest_team_candidate", kind: "actionable" }),
		);
	});

	it("keeps an unassigned member device visible as current effective access", () => {
		const scopeId = "managed-project-unassigned";
		const projectId = insertProject(db, { project: "worker", scopeId });
		insertScope(db, { scopeId, label: "worker", kind: "managed_project" });
		mapProject(db, projectId, scopeId);
		addMembership(db, scopeId, "device-unassigned");
		addPeer(db, { deviceId: "device-unassigned", displayName: "Spare laptop" });

		const [projection] = projections(db);

		expect(projection.effectiveDevices).toContainEqual(
			expect.objectContaining({
				deviceId: "device-unassigned",
				displayName: "Spare laptop",
				identityId: null,
				assignment: "unassigned",
				access: "current_effective",
			}),
		);
		expect(projection.conditions).toContainEqual(
			expect.objectContaining({ code: "unassigned_effective_device", kind: "actionable" }),
		);
	});

	it("excludes an active membership whose epoch is stale for its active scope", () => {
		const scopeId = "managed-project-new-epoch";
		const projectId = insertProject(db, { project: "epoch", scopeId });
		insertScope(db, {
			scopeId,
			label: "epoch",
			kind: "managed_project",
			membershipEpoch: 2,
		});
		mapProject(db, projectId, scopeId);
		addMembership(db, scopeId, "device-stale", 1);
		addPeer(db, { deviceId: "device-stale", displayName: "Stale laptop" });

		const [projection] = projections(db);

		expect(projection?.effectiveDevices).not.toContainEqual(
			expect.objectContaining({ deviceId: "device-stale" }),
		);
		expect(projection?.enforcement.currentDeviceIds).not.toContain("device-stale");
	});

	it("does not use a waiting-for-acceptance invite as exact-project evidence", () => {
		const scopeId = "managed-project-waiting";
		const projectId = insertProject(db, { project: "waiting", scopeId });
		insertScope(db, { scopeId, label: "waiting", kind: "managed_project" });
		mapProject(db, projectId, scopeId);
		addShareOperation(db, {
			actorId: "actor-waiting",
			projectId,
			projectName: "waiting",
			state: "waiting_for_acceptance",
			bound: false,
		});

		const [projection] = projections(db);

		expect(projection?.identityCandidates).not.toContainEqual(
			expect.objectContaining({
				identityId: "actor-waiting",
				provenance: expect.arrayContaining(["exact_project_invite"]),
			}),
		);
		expect(projection?.teamCandidates).toEqual([]);
	});

	it("does not use exact-project invite evidence after its reviewed digest becomes stale", () => {
		const scopeId = "managed-project-stale-invite";
		const projectId = insertProject(db, { project: "stale-invite", scopeId });
		insertScope(db, { scopeId, label: "stale-invite", kind: "managed_project" });
		mapProject(db, projectId, scopeId);
		addShareOperation(db, {
			actorId: "actor-stale-invite",
			projectId,
			projectName: "stale-invite",
		});
		db.prepare(
			"UPDATE share_operation_projects SET existing_memory_count = 2 WHERE operation_id = 'share-projection'",
		).run();

		const [projection] = projections(db);

		expect(projection?.enforcement.state).toBe("managed_exact_project");
		expect(projection?.identityCandidates).not.toContainEqual(
			expect.objectContaining({
				identityId: "actor-stale-invite",
				provenance: expect.arrayContaining(["exact_project_invite"]),
			}),
		);
		expect(projection?.teamCandidates).toEqual([]);
	});

	it("under-shares an ambiguous scope containing multiple canonical Projects", () => {
		const scopeId = "legacy-mixed-space";
		insertScope(db, {
			scopeId,
			label: "Mixed",
			kind: "team",
			coordinatorId: "coordinator-a",
			groupId: "group-mixed",
		});
		const first = insertProject(db, { project: "first", scopeId });
		const second = insertProject(db, { project: "second", scopeId });
		mapProject(db, first, scopeId);
		mapProject(db, second, scopeId);
		addMembership(db, scopeId, "device-unassigned");
		db.prepare(
			`INSERT INTO actors(
				actor_id, display_name, is_local, status, created_at, updated_at
			 ) VALUES ('actor-shared', 'Shared Person', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		addPeer(db, {
			actorId: "actor-shared",
			deviceId: "device-assigned",
			displayName: "Shared laptop",
		});
		addMembership(db, scopeId, "device-assigned");

		const result = projections(db);

		expect(result).toHaveLength(2);
		for (const projection of result) {
			expect(projection.intent).toEqual([]);
			expect(projection.enforcement).toMatchObject({
				state: "ambiguous",
				safeErrorCode: "ambiguous_multi_project_scope",
			});
			expect(projection.conditions).toContainEqual(
				expect.objectContaining({
					code: "ambiguous_multi_project_scope",
					kind: "diagnostic",
				}),
			);
			expect(projection.conditions).not.toContainEqual(
				expect.objectContaining({ code: "suggest_team_candidate" }),
			);
			expect(projection.identityCandidates).toEqual([]);
			expect(projection.teamCandidates).toEqual([]);
		}
	});

	it("treats a catch-all legacy mapping as ambiguous instead of inferring recipients", () => {
		const scopeId = "legacy-catch-all";
		insertProject(db, { project: "catch-all" });
		insertScope(db, { scopeId, label: "Catch all", kind: "team" });
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (NULL, '*', ?, 10, 'legacy', ?, ?)`,
		).run(scopeId, NOW, NOW);

		const [projection] = projections(db);

		expect(projection?.enforcement).toMatchObject({
			state: "ambiguous",
			safeErrorCode: "wildcard_scope_mapping",
		});
		expect(projection?.identityCandidates).toEqual([]);
		expect(projection?.teamCandidates).toEqual([]);
	});

	it("lets the selected exact workspace mapping override an older matching wildcard", () => {
		const exactScopeId = "managed-project-exact";
		const wildcardScopeId = "legacy-wildcard";
		const projectId = insertProject(db, { project: "selected", scopeId: exactScopeId });
		insertScope(db, { scopeId: exactScopeId, label: "selected", kind: "managed_project" });
		insertScope(db, { scopeId: wildcardScopeId, label: "Legacy wildcard", kind: "team" });
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (NULL, '*', ?, 10, 'legacy', ?, ?)`,
		).run(wildcardScopeId, "2026-07-20T12:00:00.000Z", "2026-07-20T12:00:00.000Z");
		mapProject(db, projectId, exactScopeId);

		const [projection] = projections(db);

		expect(projection?.enforcement).toMatchObject({
			state: "managed_exact_project",
			safeErrorCode: null,
		});
		expect(projection?.conditions).not.toContainEqual(
			expect.objectContaining({ code: "wildcard_scope_mapping" }),
		);
	});

	it("prefers a more specific pattern over a newer broad pattern at the same priority", () => {
		const exactScopeId = "managed-project-specific-pattern";
		const wildcardScopeId = "legacy-newer-wildcard";
		const projectId = insertProject(db, { project: "specific", scopeId: exactScopeId });
		insertScope(db, { scopeId: exactScopeId, label: "specific", kind: "managed_project" });
		insertScope(db, { scopeId: wildcardScopeId, label: "Newer wildcard", kind: "team" });
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (NULL, ?, ?, 10, 'legacy', ?, ?)`,
		).run(
			"https://git.example.invalid/acme/*.git",
			wildcardScopeId,
			"2026-07-21T12:00:00.000Z",
			"2026-07-21T12:00:00.000Z",
		);
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (NULL, ?, ?, 10, 'legacy', ?, ?)`,
		).run(projectId, exactScopeId, "2026-07-20T12:00:00.000Z", "2026-07-20T12:00:00.000Z");

		const [projection] = projections(db);

		expect(projection?.enforcement).toMatchObject({
			state: "managed_exact_project",
			safeErrorCode: null,
		});
		expect(projection?.conditions).not.toContainEqual(
			expect.objectContaining({ code: "wildcard_scope_mapping" }),
		);
	});

	it("isolates canonical Projects that share the same display name", () => {
		const first = insertProject(db, {
			project: "api",
			remote: "https://git.example.invalid/one/api.git",
		});
		const second = insertProject(db, {
			project: "api",
			remote: "https://git.example.invalid/two/api.git",
		});

		const result = projections(db);

		expect(result.map((item) => item.project.canonicalIdentity)).toEqual([first, second]);
		expect(result.map((item) => item.project.displayName)).toEqual(["api", "api"]);
	});

	it("uses only read operations under query_only without changing total_changes", () => {
		insertProject(db, { project: "read-only" });
		db.prepare(
			`INSERT INTO sync_device(device_id, public_key, fingerprint, created_at)
			 VALUES ('device-real', 'public-key', 'fingerprint', ?)`,
		).run(NOW);
		db.prepare(
			`INSERT INTO actors(
				actor_id, display_name, is_local, status, created_at, updated_at
			 ) VALUES ('local:device-real', 'Real Local Person', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
		const before = Number(db.prepare("SELECT total_changes() AS total").pluck().get());
		db.pragma("query_only = ON");

		const project = () =>
			listLegacyRecipientPolicyProjections(db, {
				localActorId: "local:local",
				localDeviceId: "local",
			});
		const first = project();
		const second = project();
		const after = Number(db.prepare("SELECT total_changes() AS total").pluck().get());

		expect(second).toEqual(first);
		expect(first[0]?.effectiveDevices).toEqual([
			expect.objectContaining({
				deviceId: "device-real",
				identityId: "local:device-real",
			}),
		]);
		expect(after).toBe(before);
	});
});
