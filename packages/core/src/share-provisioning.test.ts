import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedScopeAuthorization } from "./scope-membership-cache.js";
import {
	inviteTokenDigest,
	persistShareOperation,
	planShareOperation,
	reconcileShareOperationAcceptance,
} from "./share-operation.js";
import {
	countShareableProjectMemories,
	executeShareProvisioning,
	planShareProvisioning,
	type ShareProvisioningDependencies,
} from "./share-provisioning.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

const createdAt = "2026-07-20T12:00:00.000Z";
const remote = "https://example.invalid/acme/api.git";

describe("exact project share provisioning", () => {
	let db: InstanceType<typeof Database>;
	let operationId: string;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		db.prepare(`INSERT INTO actors(
			actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
		) VALUES ('actor-owner', 'Owner', 1, 'active', NULL, ?, ?)`).run(createdAt, createdAt);
		const sourceScope = "source-space";
		db.prepare(`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id,
			membership_epoch, status, created_at, updated_at
		) VALUES (?, 'Source', 'team', 'coordinator', 'coord', 'team', 1, 'active', ?, ?)`).run(
			sourceScope,
			createdAt,
			createdAt,
		);
		for (const deviceId of [
			"owner",
			"owner-proven",
			"owner-filtered",
			"unreviewed-source-member",
		]) {
			db.prepare(`INSERT INTO scope_memberships(
				scope_id, device_id, role, status, membership_epoch, coordinator_id, group_id, updated_at
			) VALUES (?, ?, 'member', 'active', 1, 'coord', 'team', ?)`).run(
				sourceScope,
				deviceId,
				createdAt,
			);
		}
		db.prepare(`INSERT INTO sync_peers(
			peer_device_id, projects_include_json, projects_exclude_json, created_at
		) VALUES ('owner-proven', '["api"]', '[]', ?),
			('owner-filtered', '["other"]', '[]', ?),
			('unreviewed-source-member', '["api"]', '[]', ?)`).run(createdAt, createdAt, createdAt);
		const selectedSession = Number(
			db
				.prepare("INSERT INTO sessions(started_at, project, git_remote) VALUES (?, 'api', ?)")
				.run(createdAt, remote).lastInsertRowid,
		);
		const unrelatedSession = Number(
			db
				.prepare("INSERT INTO sessions(started_at, project, git_remote) VALUES (?, 'other', ?)")
				.run(createdAt, "https://example.invalid/acme/other.git").lastInsertRowid,
		);
		const insertMemory = db.prepare(`INSERT INTO memory_items(
			session_id, kind, title, body_text, confidence, tags_text, active, created_at,
			updated_at, metadata_json, import_key, rev, visibility, scope_id
		) VALUES (?, 'discovery', ?, 'body', 0.8, '', 1, ?, ?, '{}', ?, 1, ?, ?)`);
		insertMemory.run(
			selectedSession,
			"selected-shared",
			createdAt,
			createdAt,
			"selected:shared",
			"shared",
			sourceScope,
		);
		insertMemory.run(
			selectedSession,
			"selected-private",
			createdAt,
			createdAt,
			"selected:private",
			"private",
			sourceScope,
		);
		insertMemory.run(
			selectedSession,
			"selected-local-shared",
			createdAt,
			createdAt,
			null,
			"shared",
			sourceScope,
		);
		insertMemory.run(
			unrelatedSession,
			"unrelated",
			createdAt,
			createdAt,
			"unrelated",
			"shared",
			sourceScope,
		);

		const plan = planShareOperation({
			inviterActorId: "actor-owner",
			inviterDeviceIds: ["owner", "owner-proven"],
			person: { kind: "pending", displayName: "Brian" },
			projects: [
				{
					canonicalIdentity: remote,
					displayName: "api",
					identitySource: "git_remote",
					existingMemoryCount: 2,
				},
			],
			coordinatorGroupId: "team",
			inviteExpiresAt: "2026-07-27T12:00:00.000Z",
			createdAt,
		});
		operationId = plan.operationId;
		persistShareOperation(db, plan, {
			inviteId: "invite",
			tokenDigest: inviteTokenDigest("token"),
		});
		const publicKey = "recipient-key";
		reconcileShareOperationAcceptance(db, {
			operationId,
			localInviterActorId: "actor-owner",
			coordinatorGroupId: "team",
			reviewedProjectSetDigest: plan.reviewedProjectSetDigest,
			recipientActorId: "actor-recipient",
			recipientDisplayName: "Brian",
			recipientDeviceId: "recipient",
			recipientDeviceDisplayName: "Brian's MacBook",
			recipientPublicKey: publicKey,
			recipientFingerprint: fingerprintPublicKey(publicKey),
			consumedAt: "2026-07-20T13:00:00.000Z",
			trustState: "bootstrap_grant_created",
			bootstrapGrantId: "grant",
			projects: [{ canonical_identity: remote, display_name: "api", existing_memory_count: 2 }],
		});
	});

	afterEach(() => db.close());

	it("includes locally authored legacy origins without adopting replicated local sentinels", () => {
		const localSessionId = Number(
			db
				.prepare(`INSERT INTO sessions(started_at, project, git_remote, user, tool_version)
					VALUES (?, 'api', ?, 'adam', 'codemem')`)
				.run(createdAt, remote).lastInsertRowid,
		);
		const replicatedSessionId = Number(
			db
				.prepare(`INSERT INTO sessions(started_at, project, git_remote, user, tool_version)
					VALUES (?, 'api', ?, 'sync', 'sync_replication')`)
				.run(createdAt, remote).lastInsertRowid,
		);
		const insertLegacy = db.prepare(`INSERT INTO memory_items(
				session_id, kind, title, body_text, confidence, tags_text, active, created_at,
				updated_at, metadata_json, import_key, rev, visibility, scope_id, origin_device_id
			) VALUES (?, 'discovery', ?, 'body', 0.8, '', 1, ?, ?, '{}', ?, 1, 'shared',
				'local-default', 'local')`);
		const localMemoryId = Number(
			insertLegacy.run(
				localSessionId,
				"locally authored legacy",
				createdAt,
				createdAt,
				"legacy:local-owned",
			).lastInsertRowid,
		);
		const replicatedMemoryId = Number(
			insertLegacy.run(
				replicatedSessionId,
				"replicated legacy",
				createdAt,
				createdAt,
				"legacy:peer-owned",
			).lastInsertRowid,
		);

		expect(
			countShareableProjectMemories(db, {
				canonicalIdentity: remote,
				initiatingDeviceId: "owner",
			}),
		).toBe(3);
		db.prepare("UPDATE share_operations SET inviter_device_ids_json = '[\"owner\"]'").run();
		const project = planShareProvisioning(db, {
			operationId,
			initiatingDeviceId: "owner",
		}).projects[0];
		expect(project?.memoryIds).toContain(localMemoryId);
		expect(project?.memoryIds).not.toContain(replicatedMemoryId);
	});

	function dependencies(overrides: Partial<ShareProvisioningDependencies> = {}) {
		const plan = planShareProvisioning(db, { operationId, initiatingDeviceId: "owner" });
		const scopeId = plan.projects[0]?.boundaryId ?? "missing";
		const deps: ShareProvisioningDependencies = {
			createOrGetBoundary: vi.fn(async () => ({
				scope_id: scopeId,
				label: "api",
				kind: "managed_project",
				authority_type: "coordinator",
				coordinator_id: "coord",
				group_id: "team",
				manifest_issuer_device_id: null,
				membership_epoch: 1,
				manifest_hash: null,
				status: "active",
				created_at: createdAt,
				updated_at: createdAt,
			})),
			grantMembership: vi.fn(async ({ scopeId: grantedScope, deviceId, role }) => ({
				scope_id: grantedScope,
				device_id: deviceId,
				role,
				status: "active",
				membership_epoch: 1,
				coordinator_id: "coord",
				group_id: "team",
				manifest_issuer_device_id: null,
				manifest_hash: null,
				signed_manifest_json: null,
				updated_at: createdAt,
			})),
			supportsReassignScope: vi.fn(async () => "supported"),
			refreshAuthorization: vi.fn(async () => {
				db.prepare(`INSERT OR REPLACE INTO replication_scopes(
					scope_id, label, kind, authority_type, coordinator_id, group_id,
					membership_epoch, status, created_at, updated_at
				) VALUES (?, 'api', 'managed_project', 'coordinator', 'coord', 'team', 1, 'active', ?, ?)`).run(
					scopeId,
					createdAt,
					createdAt,
				);
				for (const deviceId of ["owner", "owner-proven", "recipient"]) {
					db.prepare(`INSERT OR REPLACE INTO scope_memberships(
						scope_id, device_id, role, status, membership_epoch, coordinator_id, group_id, updated_at
					) VALUES (?, ?, 'member', 'active', 1, 'coord', 'team', ?)`).run(
						scopeId,
						deviceId,
						createdAt,
					);
				}
				db.prepare(`INSERT OR REPLACE INTO scope_membership_cache_state(
					coordinator_id, group_id, last_refresh_at, last_success_at, last_error, updated_at
				) VALUES ('coord', 'team', ?, ?, NULL, ?)`).run(createdAt, createdAt, createdAt);
			}),
			runInitialSync: vi.fn(async () => {
				expect(getCachedScopeAuthorization(db, { deviceId: "recipient", scopeId }).authorized).toBe(
					true,
				);
				return { ok: true, perScopeResults: [{ scope_id: scopeId, ok: true }] };
			}),
			...overrides,
		};
		return { deps, scopeId };
	}

	it("derives bounded membership without inheriting unreviewed source members", () => {
		const plan = planShareProvisioning(db, { operationId, initiatingDeviceId: "owner" });
		expect(plan.projects[0]?.memberDeviceIds).toEqual(["owner", "owner-proven", "recipient"]);
		expect(plan.projects[0]?.memoryIds).toHaveLength(2);
		expect(plan.projects[0]?.localOnlyMemoryIds).toHaveLength(1);
		expect(plan.projects[0]?.reassignedMemoryIds).toHaveLength(1);
		expect(plan.requiredCapabilityDeviceIds).toEqual([
			"owner",
			"owner-filtered",
			"owner-proven",
			"recipient",
			"unreviewed-source-member",
		]);
	});

	it("fails closed when a reviewed inviter device no longer passes current project filters", () => {
		db.prepare(
			"UPDATE sync_peers SET projects_include_json = '[\"other\"]' WHERE peer_device_id = 'owner-proven'",
		).run();
		expect(() => planShareProvisioning(db, { operationId, initiatingDeviceId: "owner" })).toThrow(
			"inviter_project_access_ambiguous",
		);
	});

	it("fails capability preflight before any boundary, migration, or mapping mutation", async () => {
		const supportsReassignScope = vi.fn(async (deviceId: string) =>
			deviceId === "unreviewed-source-member" ? "unsupported" : "supported",
		);
		const { deps } = dependencies({ supportsReassignScope });
		await expect(
			executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps),
		).rejects.toThrow("reassign_capability_required");
		expect(deps.createOrGetBoundary).not.toHaveBeenCalled();
		expect(
			db
				.prepare("SELECT scope_id FROM memory_items WHERE import_key = 'selected:shared'")
				.pluck()
				.get(),
		).toBe("source-space");
		expect(db.prepare("SELECT COUNT(*) FROM project_scope_mappings").pluck().get()).toBe(0);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) FROM share_operation_steps WHERE step_key LIKE 'provisioning_member:%'",
				)
				.pluck()
				.get(),
		).toBe(0);
		expect(supportsReassignScope).toHaveBeenCalledWith("unreviewed-source-member");
	});

	it("revalidates a persisted membership plan before retrying grants", async () => {
		const { deps: baseline } = dependencies();
		const firstAttempt = {
			...baseline,
			createOrGetBoundary: vi.fn(async () => {
				throw new Error("boundary_unavailable");
			}),
		};
		await expect(
			executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, firstAttempt),
		).rejects.toThrow("boundary_unavailable");
		expect(
			db
				.prepare(
					"SELECT COUNT(*) FROM share_operation_steps WHERE step_key LIKE 'provisioning_member:%'",
				)
				.pluck()
				.get(),
		).toBeGreaterThan(0);

		db.prepare(
			"UPDATE sync_peers SET projects_include_json = '[\"other\"]' WHERE peer_device_id = 'owner-proven'",
		).run();
		const grantMembership = vi.fn(baseline.grantMembership);
		const retry = { ...baseline, grantMembership };
		await expect(
			executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, retry),
		).rejects.toThrow("inviter_project_access_ambiguous");
		expect(grantMembership).not.toHaveBeenCalled();
	});

	it("reopens capability preflight when the required device set changes", async () => {
		const supportsReassignScope = vi.fn(async () => "supported" as const);
		const { deps: baseline } = dependencies({ supportsReassignScope });
		await expect(
			executeShareProvisioning(
				db,
				{ operationId, initiatingDeviceId: "owner" },
				{
					...baseline,
					createOrGetBoundary: vi.fn(async () => {
						throw new Error("boundary_unavailable");
					}),
				},
			),
		).rejects.toThrow("boundary_unavailable");
		expect(
			db
				.prepare(`SELECT status FROM share_operation_steps
					WHERE operation_id = ? AND step_key = 'capability_preflight'`)
				.pluck()
				.get(operationId),
		).toBe("completed");

		db.prepare(`INSERT INTO scope_memberships(
			scope_id, device_id, role, status, membership_epoch, coordinator_id, group_id, updated_at
		) VALUES ('source-space', 'late-source-peer', 'member', 'active', 1, 'coord', 'team', ?)`).run(
			createdAt,
		);
		db.prepare(`INSERT INTO sync_peers(
			peer_device_id, projects_include_json, projects_exclude_json, created_at
		) VALUES ('late-source-peer', '["api"]', '[]', ?)`).run(createdAt);
		db.prepare("UPDATE share_operations SET state = 'needs_attention' WHERE operation_id = ?").run(
			operationId,
		);
		supportsReassignScope.mockImplementation(async (deviceId) =>
			deviceId === "late-source-peer" ? "unsupported" : "supported",
		);
		const { deps: retry } = dependencies({ supportsReassignScope });

		await expect(
			executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, retry),
		).rejects.toThrow("reassign_capability_required");
		expect(supportsReassignScope).toHaveBeenCalledWith("late-source-peer");
		expect(retry.createOrGetBoundary).not.toHaveBeenCalled();
		expect(db.prepare("SELECT state FROM share_operations").pluck().get()).toBe("accepted");
	});

	it("preflights legacy project-filtered peers for local-default reassignment", async () => {
		const selectedSessionId = db
			.prepare("SELECT id FROM sessions WHERE project = 'api' LIMIT 1")
			.pluck()
			.get() as number;
		db.prepare(`INSERT INTO memory_items(
				session_id, kind, title, body_text, confidence, tags_text, active, created_at,
				updated_at, metadata_json, import_key, rev, visibility, scope_id
			) VALUES (?, 'discovery', 'legacy default', 'body', 0.8, '', 1, ?, ?, '{}',
				'selected:legacy-default', 1, 'shared', NULL)`).run(
			selectedSessionId,
			createdAt,
			createdAt,
		);
		db.prepare(`INSERT INTO sync_peers(
				peer_device_id, projects_include_json, projects_exclude_json, created_at
			) VALUES ('legacy-default-peer', '["api"]', '[]', ?)`).run(createdAt);
		db.prepare("UPDATE share_operations SET inviter_device_ids_json = '[\"owner\"]'").run();

		const plan = planShareProvisioning(db, { operationId, initiatingDeviceId: "owner" });
		expect(plan.requiredCapabilityDeviceIds).toContain("legacy-default-peer");

		const supportsReassignScope = vi.fn(async (deviceId: string) =>
			deviceId === "legacy-default-peer" ? "unsupported" : "supported",
		);
		const { deps } = dependencies({ supportsReassignScope });
		await expect(
			executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps),
		).rejects.toThrow("reassign_capability_required");
		expect(deps.createOrGetBoundary).not.toHaveBeenCalled();
		expect(supportsReassignScope).toHaveBeenCalledWith("legacy-default-peer");
	});

	it("moves capability preflight to needs-attention after three failed attempts", async () => {
		const { deps } = dependencies({ supportsReassignScope: vi.fn(async () => "unsupported") });
		expect(
			db
				.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
				.pluck()
				.get(operationId),
		).toBe("provisioning");

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			await expect(
				executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps),
			).rejects.toThrow("reassign_capability_required");
			expect(
				db
					.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
					.pluck()
					.get(operationId),
			).toBe(attempt === 3 ? "needs_attention" : "provisioning");
		}

		expect(
			db
				.prepare(`SELECT status, attempt_count, safe_error_code FROM share_operation_steps
					WHERE operation_id = ? AND step_key = 'capability_preflight'`)
				.get(operationId),
		).toEqual({
			status: "failed",
			attempt_count: 3,
			safe_error_code: "reassign_capability_required",
		});
		expect(deps.createOrGetBoundary).not.toHaveBeenCalled();
	});

	it("keeps undetermined capability probes retryable while the device is offline", async () => {
		const { deps } = dependencies({ supportsReassignScope: vi.fn(async () => "undetermined") });

		for (let attempt = 1; attempt <= 4; attempt += 1) {
			await expect(
				executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps),
			).rejects.toThrow("waiting_for_device");
			expect(
				db
					.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
					.pluck()
					.get(operationId),
			).toBe("waiting_for_device");
		}

		expect(
			db
				.prepare(`SELECT status, attempt_count, safe_error_code FROM share_operation_steps
					WHERE operation_id = ? AND step_key = 'capability_preflight'`)
				.get(operationId),
		).toEqual({ status: "failed", attempt_count: 4, safe_error_code: "waiting_for_device" });
		expect(deps.createOrGetBoundary).not.toHaveBeenCalled();
	});

	it("rejects deterministic boundary reuse when authority or group conflicts", async () => {
		const expectedScopeId = planShareProvisioning(db, {
			operationId,
			initiatingDeviceId: "owner",
		}).projects[0]?.boundaryId;
		if (!expectedScopeId) throw new Error("missing boundary fixture");
		const { deps } = dependencies({
			createOrGetBoundary: vi.fn(async () => ({
				scope_id: expectedScopeId,
				label: "api",
				kind: "managed_project",
				authority_type: "local",
				coordinator_id: null,
				group_id: "other-team",
				manifest_issuer_device_id: null,
				membership_epoch: 0,
				manifest_hash: null,
				status: "active",
				created_at: createdAt,
				updated_at: createdAt,
			})),
		});
		await expect(
			executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps),
		).rejects.toThrow("managed_boundary_conflict");
		expect(db.prepare("SELECT COUNT(*) FROM project_scope_mappings").pluck().get()).toBe(0);
	});

	it("migrates only selected memories, persists exact future mapping, refreshes, and observes scoped sync", async () => {
		const { deps, scopeId } = dependencies();
		await executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps);
		expect(
			vi
				.mocked(deps.grantMembership)
				.mock.calls.map(([grant]) => grant.deviceId)
				.sort(),
		).toEqual(["owner", "owner-proven", "recipient"]);
		expect(db.prepare("SELECT title, scope_id FROM memory_items ORDER BY title").all()).toEqual([
			{ title: "selected-local-shared", scope_id: scopeId },
			{ title: "selected-private", scope_id: "source-space" },
			{ title: "selected-shared", scope_id: scopeId },
			{ title: "unrelated", scope_id: "source-space" },
		]);
		expect(
			db.prepare("SELECT op_type FROM replication_ops WHERE entity_id = 'selected:private'").all(),
		).toEqual([]);
		expect(
			db
				.prepare(
					"SELECT op_type, scope_id FROM replication_ops WHERE entity_id = 'selected:shared' ORDER BY scope_id",
				)
				.all(),
		).toEqual([
			{ op_type: "reassign_scope", scope_id: scopeId },
			{ op_type: "reassign_scope", scope_id: "source-space" },
		]);
		expect(
			db
				.prepare(
					"SELECT workspace_identity, project_pattern, scope_id, source FROM project_scope_mappings",
				)
				.get(),
		).toEqual({
			workspace_identity: remote,
			project_pattern: remote,
			scope_id: scopeId,
			source: "share_operation",
		});
		expect(
			db
				.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
				.pluck()
				.get(operationId),
		).toBe("active");
	});

	it("preserves completed effects and resumes from the failed grant", async () => {
		let fail = true;
		const { deps } = dependencies({
			grantMembership: vi.fn(async ({ scopeId, deviceId, role }) => {
				if (fail) {
					fail = false;
					throw new Error("grant_failed");
				}
				return {
					scope_id: scopeId,
					device_id: deviceId,
					role,
					status: "active",
					membership_epoch: 1,
					coordinator_id: "coord",
					group_id: "team",
					manifest_issuer_device_id: null,
					manifest_hash: null,
					signed_manifest_json: null,
					updated_at: createdAt,
				};
			}),
		});
		await expect(
			executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps),
		).rejects.toThrow("grant_failed");
		expect(
			db
				.prepare(`SELECT state FROM share_operations WHERE operation_id = ?`)
				.pluck()
				.get(operationId),
		).toBe("provisioning");
		expect(
			db
				.prepare(`SELECT status, attempt_count FROM share_operation_steps
					WHERE operation_id = ? AND step_key LIKE 'space_grant:%' AND safe_error_code = 'grant_failed'`)
				.get(operationId),
		).toEqual({ status: "pending", attempt_count: 1 });
		await executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps);
		expect(deps.createOrGetBoundary).toHaveBeenCalledTimes(1);
		expect(
			db
				.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
				.pluck()
				.get(operationId),
		).toBe("active");
	});

	it("moves a non-device provisioning step to needs-attention after three failed attempts", async () => {
		const { deps } = dependencies({
			grantMembership: vi.fn(async () => {
				throw new Error("grant_failed");
			}),
		});

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			await expect(
				executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps),
			).rejects.toThrow("grant_failed");
			expect(
				db
					.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
					.pluck()
					.get(operationId),
			).toBe(attempt === 3 ? "needs_attention" : "provisioning");
		}

		expect(
			db
				.prepare(`SELECT status, attempt_count, safe_error_code FROM share_operation_steps
					WHERE operation_id = ? AND step_key LIKE 'space_grant:%' AND safe_error_code = 'grant_failed'`)
				.get(operationId),
		).toEqual({ status: "failed", attempt_count: 3, safe_error_code: "grant_failed" });
	});

	it("waits for an offline device and resumes initial sync without repeating completed work", async () => {
		// Arrange
		let offline = true;
		const { deps } = dependencies({
			runInitialSync: vi.fn(async () => {
				if (offline) {
					offline = false;
					return { ok: false, failureCategory: "connectivity" };
				}
				const scopeId = planShareProvisioning(db, {
					operationId,
					initiatingDeviceId: "owner",
				}).projects[0]?.boundaryId;
				return { ok: true, perScopeResults: [{ scope_id: scopeId ?? "missing", ok: true }] };
			}),
		});

		// Act
		await expect(
			executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps),
		).rejects.toThrow("waiting_for_device");

		// Assert
		expect(
			db
				.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
				.pluck()
				.get(operationId),
		).toBe("waiting_for_device");
		expect(
			db
				.prepare(
					"SELECT status, safe_error_code FROM share_operation_steps WHERE operation_id = ? AND step_key = 'initial_sync'",
				)
				.get(operationId),
		).toEqual({ status: "failed", safe_error_code: "waiting_for_device" });
		const completedCounts = {
			boundaries: vi.mocked(deps.createOrGetBoundary).mock.calls.length,
			grants: vi.mocked(deps.grantMembership).mock.calls.length,
			refreshes: vi.mocked(deps.refreshAuthorization).mock.calls.length,
			reassignments: Number(
				db
					.prepare("SELECT COUNT(*) FROM replication_ops WHERE op_type = 'reassign_scope'")
					.pluck()
					.get(),
			),
		};

		// Act
		await executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps);

		// Assert
		expect(
			db
				.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
				.pluck()
				.get(operationId),
		).toBe("active");
		expect(vi.mocked(deps.runInitialSync)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(deps.createOrGetBoundary)).toHaveBeenCalledTimes(completedCounts.boundaries);
		expect(vi.mocked(deps.grantMembership)).toHaveBeenCalledTimes(completedCounts.grants);
		expect(vi.mocked(deps.refreshAuthorization)).toHaveBeenCalledTimes(completedCounts.refreshes);
		expect(
			Number(
				db
					.prepare("SELECT COUNT(*) FROM replication_ops WHERE op_type = 'reassign_scope'")
					.pluck()
					.get(),
			),
		).toBe(completedCounts.reassignments);
		expect(db.prepare("SELECT COUNT(*) FROM project_scope_mappings").pluck().get()).toBe(1);
	});

	it("preserves a pre-existing step effect_id while executing it", async () => {
		// Arrange
		const preservedEffectId = "persisted-effect-before-resume";
		const preservedGrantEffectId = "persisted-grant-effect-before-resume";
		db.prepare(
			"UPDATE share_operation_steps SET effect_id = ? WHERE operation_id = ? AND step_key = 'authorization_refresh'",
		).run(preservedEffectId, operationId);
		db.prepare(`UPDATE share_operation_steps SET effect_id = ?
			WHERE operation_id = ? AND step_key = (
				SELECT step_key FROM share_operation_steps
				WHERE operation_id = ? AND step_key LIKE 'space_grant:%' ORDER BY step_key LIMIT 1
			)`).run(preservedGrantEffectId, operationId, operationId);
		const { deps } = dependencies();

		// Act
		await executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps);

		// Assert
		expect(
			db
				.prepare(
					"SELECT effect_id, status FROM share_operation_steps WHERE operation_id = ? AND step_key = 'authorization_refresh'",
				)
				.get(operationId),
		).toEqual({ effect_id: preservedEffectId, status: "completed" });
		expect(vi.mocked(deps.grantMembership).mock.calls.map(([input]) => input.effectId)).toContain(
			preservedGrantEffectId,
		);
	});

	it("resumes idempotently across migration, mapping, refresh, and initial-sync failures", async () => {
		const failures = [
			"memory_reassignment:",
			"project_assignment:",
			"authorization_refresh",
			"initial_sync",
		];
		const { deps } = dependencies({
			beforeStep: vi.fn((stepKey) => {
				const next = failures[0];
				if (next && stepKey.startsWith(next)) {
					failures.shift();
					throw new Error(`${next}failed`);
				}
			}),
		});
		for (const expected of [
			"memory_reassignment:failed",
			"project_assignment:failed",
			"authorization_refreshfailed",
			"initial_syncfailed",
		]) {
			await expect(
				executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps),
			).rejects.toThrow(expected);
		}
		await executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps);
		expect(failures).toEqual([]);
		expect(
			db
				.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
				.pluck()
				.get(operationId),
		).toBe("active");
	});

	it("blocks stale legacy grant retries when active recipient policy no longer desires the device", async () => {
		const now = createdAt;
		db.prepare(
			`INSERT INTO recipient_policy_authority_states(
			 canonical_project_identity, authority_state, generation, desired_devices_digest,
			 state_changed_at, created_at, updated_at
			 ) VALUES (?, 'active', 1, 'desired', ?, ?, ?)`,
		).run(remote, now, now, now);
		db.prepare(
			`UPDATE project_recipients SET status = 'revoked', updated_at = ?
			 WHERE canonical_project_identity = ? AND recipient_kind = 'identity'
			 AND recipient_id = 'actor-recipient'`,
		).run(now, remote);
		const { deps } = dependencies();

		await expect(
			executeShareProvisioning(db, { operationId, initiatingDeviceId: "owner" }, deps),
		).rejects.toThrow("recipient_policy_legacy_grant_blocked");

		expect(vi.mocked(deps.grantMembership).mock.calls.map(([input]) => input.deviceId)).toEqual([
			"owner",
			"owner-proven",
		]);
		expect(
			db
				.prepare(
					"SELECT safe_error_code FROM share_operation_steps WHERE operation_id = ? AND step_key = ?",
				)
				.pluck()
				.get(operationId, `space_grant:${remote}:recipient`),
		).toBe("recipient_policy_legacy_grant_blocked");
	});
});
