import {
	commitRecipientPolicyOnboarding,
	deriveRecipientPolicyEffectiveDevicesFromDatabase,
	getRecipientPolicyAuthorityState,
	initDatabase,
	listRecipientPolicyDenyOverlays,
	listRecipientPolicyReview,
	MemoryStore,
	migrateRecipientPolicyIntent,
	previewRecipientPolicyOnboarding,
	reconcileRecipientPolicyProject,
	recordReplicationOp,
	resolveRecipientPolicyReview,
	type RecipientPolicyReconcilerEffects,
} from "../../packages/core/src/index.ts";

const DB_PATH = "/data/mem.sqlite";
const NOW = "2026-07-21T12:00:00.000Z";
const SOURCE_SCOPE = "project-sharing-source";
const SELECTED_REMOTE = "https://example.invalid/acme/selected.git";
const UNRELATED_REMOTE = "https://example.invalid/acme/unrelated.git";
const POLICY_SELECTED_REMOTE = "https://example.invalid/acme/policy-selected.git";
const POLICY_UNRELATED_REMOTE = "https://example.invalid/acme/policy-unrelated.git";
const DIRECT_IDENTITY = "identity-direct-personal";
const TEAM_IDENTITY = "identity-team-existing";
const FUTURE_TEAM_IDENTITY = "identity-team-future";
const WORK_IDENTITY = "identity-work";
const TEAM_ID = "team-project-sharing";

type Action =
	| "init"
	| "seed-a"
	| "add-future"
	| "summary"
	| "seed-policy"
	| "inherit-policy"
	| "revoke-policy"
	| "add-stale-memory"
	| "keep-current"
	| "reconciliation-proof";

const ACTIONS: Action[] = [
	"init",
	"seed-a",
	"add-future",
	"summary",
	"seed-policy",
	"inherit-policy",
	"revoke-policy",
	"add-stale-memory",
	"keep-current",
	"reconciliation-proof",
];

function action(): Action {
	const index = process.argv.indexOf("--action");
	const value = process.argv[index + 1];
	if (!value || !ACTIONS.includes(value as Action)) {
		throw new Error(`--action must be one of: ${ACTIONS.join(", ")}`);
	}
	return value as Action;
}

function insertActor(store: MemoryStore, actorId: string, displayName: string): void {
	store.db
		.prepare(
			`INSERT OR IGNORE INTO actors(
			 actor_id, display_name, is_local, status, created_at, updated_at
			 ) VALUES (?, ?, 0, 'active', ?, ?)`,
		)
		.run(actorId, displayName, NOW, NOW);
}

function insertDevice(store: MemoryStore, identityId: string, deviceId: string, displayName: string): void {
	store.db
		.prepare(
			`INSERT OR IGNORE INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, ?, 'active', 'e2e', '1', 'native', ?, ?, ?)`,
		)
		.run(deviceId, identityId, displayName, `device:${deviceId}`, NOW, NOW);
}

function insertTeamMembership(store: MemoryStore, identityId: string): void {
	store.db
		.prepare(
			`INSERT OR IGNORE INTO policy_team_memberships(
			 team_id, identity_id, role, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, 'member', 'active', 'e2e', '1', 'native', ?, ?, ?)`,
		)
		.run(TEAM_ID, identityId, `membership:${TEAM_ID}:${identityId}`, NOW, NOW);
}

function insertProjectRecipient(
	store: MemoryStore,
	projectId: string,
	recipientKind: "identity" | "team",
	recipientId: string,
): void {
	store.db
		.prepare(
			`INSERT OR IGNORE INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, ?, 'active', 'e2e', '1', 'native', ?, ?, ?)`,
		)
		.run(
			projectId,
			recipientKind,
			recipientId,
			`recipient:${projectId}:${recipientKind}:${recipientId}`,
			NOW,
			NOW,
		);
}

function seedRecipientPolicy(store: MemoryStore): void {
	for (const [project, remote] of [
		["policy-selected", POLICY_SELECTED_REMOTE],
		["policy-unrelated", POLICY_UNRELATED_REMOTE],
	] as const) {
		const sessionId = session(store, project, remote);
		store.endSession(sessionId, { fixture: project });
	}
	for (const [identityId, displayName, deviceId] of [
		[DIRECT_IDENTITY, "Personal Direct Identity", "device-direct-1"],
		[TEAM_IDENTITY, "Existing Team Identity", "device-team-existing"],
		[WORK_IDENTITY, "Work Identity", "device-work"],
	] as const) {
		insertActor(store, identityId, displayName);
		insertDevice(store, identityId, deviceId, `${displayName} device`);
	}
	store.db
		.prepare(
			`INSERT OR IGNORE INTO policy_teams(
			 team_id, display_name, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Project Sharing Team', 'active', 'e2e', '1', 'native', ?, ?, ?)`,
		)
		.run(TEAM_ID, `team:${TEAM_ID}`, NOW, NOW);
	insertTeamMembership(store, TEAM_IDENTITY);
	insertProjectRecipient(store, POLICY_SELECTED_REMOTE, "identity", DIRECT_IDENTITY);
	insertProjectRecipient(store, POLICY_SELECTED_REMOTE, "team", TEAM_ID);
	insertProjectRecipient(store, POLICY_UNRELATED_REMOTE, "identity", WORK_IDENTITY);
}

function inheritRecipientPolicy(store: MemoryStore): Record<string, unknown> {
	insertActor(store, FUTURE_TEAM_IDENTITY, "Future Team Identity");
	insertDevice(store, FUTURE_TEAM_IDENTITY, "device-team-future", "Future Team device");
	insertTeamMembership(store, FUTURE_TEAM_IDENTITY);
	const request = {
		version: 1 as const,
		journey: "add_device" as const,
		invitationId: "invite-add-device-e2e",
		identityId: DIRECT_IDENTITY,
		deviceId: "device-direct-2",
		devicePublicKey: "e2e-device-direct-2-public-key",
		deviceDisplayName: "Personal Direct Identity second device",
	};
	const preview = previewRecipientPolicyOnboarding(store.db, request);
	const committed = commitRecipientPolicyOnboarding(
		store.db,
		{ ...request, reviewedOnboardingDigest: preview.reviewedOnboardingDigest },
		{ now: () => NOW },
	);
	return { add_device_preview: preview, add_device_commit: committed };
}

function revokeDirectRecipient(store: MemoryStore): void {
	store.db
		.prepare(
			`UPDATE project_recipients SET status = 'revoked', updated_at = ?
			 WHERE canonical_project_identity = ? AND recipient_kind = 'identity' AND recipient_id = ?`,
		)
		.run(NOW, POLICY_SELECTED_REMOTE, DIRECT_IDENTITY);
}

function session(store: MemoryStore, project: string, remote: string): number {
	const id = store.startSession({
		cwd: `/workspace/${project}`,
		project,
		user: "e2e",
		toolVersion: "project-sharing-e2e",
	});
	store.db.prepare("UPDATE sessions SET git_remote = ? WHERE id = ?").run(remote, id);
	return id;
}

function remember(
	store: MemoryStore,
	sessionId: number,
	title: string,
	workspaceId: string | null = SOURCE_SCOPE,
): number {
	return store.remember(sessionId, "discovery", title, `${title} body`, 0.9, ["project-sharing-e2e"], {
		visibility: "shared",
		...(workspaceId ? { workspace_id: workspaceId, workspace_kind: "shared" } : {}),
		created_at: NOW,
		updated_at: NOW,
	});
}

function stampSourceScope(store: MemoryStore, memoryId: number, replicated: boolean): void {
	const importKey = store.db
		.prepare("SELECT import_key FROM memory_items WHERE id = ?")
		.pluck()
		.get(memoryId) as string | null;
	store.db
		.prepare(
			`DELETE FROM replication_ops
			 WHERE entity_type = 'memory_item'
			   AND entity_id IN (CAST(? AS TEXT), ?)`,
		)
		.run(memoryId, importKey ?? "__missing_import_key__");
	store.db.prepare("UPDATE memory_items SET scope_id = ? WHERE id = ?").run(SOURCE_SCOPE, memoryId);
	if (replicated) {
		recordReplicationOp(store.db, {
			memoryId,
			opType: "upsert",
			deviceId: store.deviceId,
			scopeId: SOURCE_SCOPE,
			createdAt: NOW,
		});
		return;
	}
	store.db.prepare("UPDATE memory_items SET import_key = NULL WHERE id = ?").run(memoryId);
}

function seedA(store: MemoryStore): void {
	store.db
		.prepare(
			`INSERT OR REPLACE INTO replication_scopes(
				scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
			 ) VALUES (?, 'Project sharing source', 'team', 'local', 1, 'active', ?, ?)`,
		)
		.run(SOURCE_SCOPE, NOW, NOW);
	for (const deviceId of [store.deviceId, "source-bystander"]) {
		store.db
			.prepare(
				`INSERT OR REPLACE INTO scope_memberships(
					scope_id, device_id, role, status, membership_epoch, updated_at
				 ) VALUES (?, ?, 'member', 'active', 1, ?)`,
			)
			.run(SOURCE_SCOPE, deviceId, NOW);
	}
	const selectedSession = session(store, "selected-project", SELECTED_REMOTE);
	const selectedId = remember(store, selectedSession, "selected existing");
	store.endSession(selectedSession, { fixture: "selected-existing" });
	stampSourceScope(store, selectedId, false);

	const unrelatedSession = session(store, "unrelated-project", UNRELATED_REMOTE);
	const unrelatedId = remember(store, unrelatedSession, "unrelated existing");
	store.endSession(unrelatedSession, { fixture: "unrelated-existing" });
	stampSourceScope(store, unrelatedId, true);
}

function addFuture(store: MemoryStore): void {
	const selectedSession = session(store, "selected-project", SELECTED_REMOTE);
	remember(store, selectedSession, "selected future", null);
	store.endSession(selectedSession, { fixture: "selected-future" });

	const unrelatedSession = session(store, "unrelated-project", UNRELATED_REMOTE);
	const unrelatedId = remember(store, unrelatedSession, "unrelated future");
	store.endSession(unrelatedSession, { fixture: "unrelated-future" });
	stampSourceScope(store, unrelatedId, true);
}

function seedReconciliationProject(
	store: MemoryStore,
	label: string,
): { projectId: string; scopeId: string; identityId: string } {
	const projectId = `https://example.invalid/e2e/${label}.git`;
	const scopeId = `scope-${label}`;
	const identityId = `identity-${label}`;
	insertActor(store, identityId, `${label} Identity`);
	insertDevice(store, identityId, `device-${label}-keep`, `${label} keep device`);
	insertDevice(store, identityId, `device-${label}-new`, `${label} new device`);
	insertProjectRecipient(store, projectId, "identity", identityId);
	store.db
		.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id,
			 membership_epoch, status, created_at, updated_at
			 ) VALUES (?, ?, 'managed_project', 'coordinator', 'e2e-coordinator', ?, 1,
			 'active', ?, ?)`,
		)
		.run(scopeId, label, `group-${label}`, NOW, NOW);
	store.db
		.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, 1000, 'e2e', ?, ?)`,
		)
		.run(projectId, projectId, scopeId, NOW, NOW);
	return { projectId, scopeId, identityId };
}

function reconciliationEffects(
	scopeId: string,
	members: Set<string>,
	capability: (deviceId: string) => "supported" | "unsupported" | "undetermined",
	calls: string[],
): RecipientPolicyReconcilerEffects {
	let tick = 0;
	const now = () => new Date(Date.parse(NOW) + tick++ * 1_000).toISOString();
	return {
		now,
		snapshot: async () => ({
			authoritative: true,
			scopeId,
			fingerprint: `snapshot:${[...members].toSorted().join(",")}`,
			observedAt: now(),
			memberships: [...members]
				.toSorted()
				.map((deviceId) => ({ deviceId, status: "active" as const })),
		}),
		probeCapability: async (deviceId) => {
			calls.push(`probe:${deviceId}`);
			return capability(deviceId);
		},
		revoke: async (input) => {
			calls.push(`revoke:${input.deviceId}`);
			members.delete(input.deviceId);
			return { ...input, status: "revoked" as const };
		},
		grant: async (input) => {
			calls.push(`grant:${input.deviceId}`);
			members.add(input.deviceId);
			return { ...input, status: "active" as const };
		},
		refresh: async () => {
			calls.push("refresh");
		},
	};
}

async function reconciliationProof(store: MemoryStore): Promise<Record<string, unknown>> {
	const unsupported = seedReconciliationProject(store, "unsupported-old-peer");
	const unsupportedMembers = new Set([
		"device-unsupported-old-peer-keep",
		"device-unsupported-old-peer-old",
	]);
	const unsupportedCalls: string[] = [];
	const membershipsBefore = JSON.stringify([...unsupportedMembers].toSorted());
	const unsupportedResult = await reconcileRecipientPolicyProject(
		store.db,
		{ canonicalProjectIdentity: unsupported.projectId, leaseOwner: "e2e-unsupported" },
		reconciliationEffects(
			unsupported.scopeId,
			unsupportedMembers,
			(deviceId) => (deviceId.endsWith("-old") ? "unsupported" : "supported"),
			unsupportedCalls,
		),
	);

	const offline = seedReconciliationProject(store, "offline-resume");
	const offlineMembers = new Set(["device-offline-resume-keep"]);
	const offlineCalls: string[] = [];
	let online = false;
	const offlineEffects = reconciliationEffects(
		offline.scopeId,
		offlineMembers,
		() => (online ? "supported" : "undetermined"),
		offlineCalls,
	);
	const waiting = await reconcileRecipientPolicyProject(
		store.db,
		{ canonicalProjectIdentity: offline.projectId, leaseOwner: "e2e-offline" },
		offlineEffects,
	);
	online = true;
	const resumed = await reconcileRecipientPolicyProject(
		store.db,
		{ canonicalProjectIdentity: offline.projectId, leaseOwner: "e2e-resumed" },
		offlineEffects,
	);
	const active = await reconcileRecipientPolicyProject(
		store.db,
		{ canonicalProjectIdentity: offline.projectId, leaseOwner: "e2e-active" },
		offlineEffects,
	);

	const revoked = seedReconciliationProject(store, "revocation");
	store.db
		.prepare("UPDATE identity_devices SET status = 'revoked' WHERE device_id = ?")
		.run("device-revocation-new");
	const revokedMembers = new Set(["device-revocation-keep", "device-revocation-old"]);
	const revokedCalls: string[] = [];
	const revokedEffects = reconciliationEffects(
		revoked.scopeId,
		revokedMembers,
		() => "supported",
		revokedCalls,
	);
	const revoking = await reconcileRecipientPolicyProject(
		store.db,
		{ canonicalProjectIdentity: revoked.projectId, leaseOwner: "e2e-revoking" },
		revokedEffects,
	);
	const revokedActive = await reconcileRecipientPolicyProject(
		store.db,
		{ canonicalProjectIdentity: revoked.projectId, leaseOwner: "e2e-revoked" },
		revokedEffects,
	);

	const rollback = seedReconciliationProject(store, "rollback");
	store.db
		.prepare(
			`INSERT INTO recipient_policy_authority_states(
			 canonical_project_identity, authority_state, generation, desired_devices_digest,
			 state_changed_at, created_at, updated_at
			 ) VALUES (?, 'active', 1, 'previous-desired', ?, ?, ?)`,
		)
		.run(rollback.projectId, NOW, NOW, NOW);
	const rollbackMembers = new Set(["device-rollback-keep", "device-rollback-old"]);
	const rollbackCalls: string[] = [];
	const rolledBack = await reconcileRecipientPolicyProject(
		store.db,
		{ canonicalProjectIdentity: rollback.projectId, leaseOwner: "e2e-rollback" },
		reconciliationEffects(rollback.scopeId, rollbackMembers, () => "unsupported", rollbackCalls),
	);

	return {
		unsupported: {
			result: unsupportedResult,
			membership_unchanged: JSON.stringify([...unsupportedMembers].toSorted()) === membershipsBefore,
			mutation_calls: unsupportedCalls.filter((call) => /^(grant|revoke|refresh)/.test(call)),
		},
		offline_resume: { waiting, resumed, active, calls: offlineCalls },
		revocation: {
			revoking,
			active: revokedActive,
			members: [...revokedMembers].toSorted(),
			deny_overlays: listRecipientPolicyDenyOverlays(store.db, revoked.projectId),
			calls: revokedCalls,
		},
		rollback: {
			result: rolledBack,
			authority: getRecipientPolicyAuthorityState(store.db, rollback.projectId),
			mutation_calls: rollbackCalls.filter((call) => /^(grant|revoke|refresh)/.test(call)),
		},
	};
}

function keepCurrentProof(store: MemoryStore): Record<string, unknown> {
	const keepCurrentProject = "https://example.invalid/e2e/migration-keep-current.git";
	const keepCurrentScope = "scope-migration-keep-current";
	const keepCurrentSession = session(store, "migration-keep-current", keepCurrentProject);
	const keepCurrentMemory = remember(store, keepCurrentSession, "migration keep-current fixture", null);
	store.db
		.prepare("UPDATE memory_items SET scope_id = ? WHERE id = ?")
		.run(keepCurrentScope, keepCurrentMemory);
	store.endSession(keepCurrentSession, { fixture: "migration-keep-current" });
	store.db
		.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
			 ) VALUES (?, 'Ambiguous migration fixture', 'managed_project', 'local', 1, 'active', ?, ?)`,
		)
		.run(keepCurrentScope, NOW, NOW);
	store.db
		.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, 1000, 'e2e', ?, ?)`,
		)
		.run(keepCurrentProject, keepCurrentProject, keepCurrentScope, NOW, NOW);
	store.db
		.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
			 VALUES ('device-migration-ambiguous', 'Unassigned migration device', NULL, ?)`,
		)
		.run(NOW);
	store.db
		.prepare(
			`INSERT INTO scope_memberships(
			 scope_id, device_id, role, status, membership_epoch, updated_at
			 ) VALUES (?, 'device-migration-ambiguous', 'member', 'active', 1, ?)`,
		)
		.run(keepCurrentScope, NOW);
	const context = { localActorId: store.actorId, localDeviceId: store.deviceId, now: () => NOW };
	const review = listRecipientPolicyReview(store.db, context);
	const item = review.reviewItems.find(
		(candidate) =>
			candidate.options.some((option) => option.decision === "keep_current_setup") &&
			candidate.options.some((option) =>
				option.preview?.projects.some(
					(project) => project.canonicalIdentity === keepCurrentProject,
				),
			),
	);
	if (!item) throw new Error("keep-current review fixture missing");
	const countKeepCurrentRecipients = () =>
		Number(
			store.db
				.prepare(
					"SELECT COUNT(*) FROM project_recipients WHERE canonical_project_identity = ?",
				)
				.pluck()
				.get(keepCurrentProject),
		);
	const recipientsBefore = countKeepCurrentRecipients();
	const resolved = resolveRecipientPolicyReview(store.db, context, {
		reviewItemId: item.reviewItemId,
		sourceFingerprint: item.sourceFingerprint,
		decision: "keep_current_setup",
	});
	const firstMigration = migrateRecipientPolicyIntent(store.db, context);
	const secondMigration = migrateRecipientPolicyIntent(store.db, context);
	const recipientsAfter = countKeepCurrentRecipients();
	const remaining = listRecipientPolicyReview(store.db, context);
	return {
		resolved,
		first_migration: firstMigration,
		second_migration: secondMigration,
		recipient_count_unchanged: recipientsBefore === recipientsAfter,
		resolution_durable: !remaining.reviewItems.some(
			(candidate) => candidate.reviewItemId === item.reviewItemId,
		),
	};
}

function summary(store: MemoryStore): Record<string, unknown> {
	return {
		device_id: store.deviceId,
		actor_id: store.actorId,
		actor_display_name: store.actorDisplayName,
		memories: store.db
			.prepare("SELECT title, project, scope_id, active FROM memory_items ORDER BY title")
			.all(),
		actors: store.db
			.prepare("SELECT actor_id, display_name, status FROM actors ORDER BY actor_id")
			.all(),
		peers: store.db
			.prepare("SELECT peer_device_id, name, actor_id FROM sync_peers ORDER BY peer_device_id")
			.all(),
		managed_memberships: store.db
			.prepare(
				`SELECT sm.scope_id, sm.device_id, sm.status
				 FROM scope_memberships sm
				 JOIN replication_scopes rs ON rs.scope_id = sm.scope_id
				 WHERE rs.kind = 'managed_project'
				 ORDER BY sm.scope_id, sm.device_id`,
			)
			.all(),
		source_memberships: store.db
			.prepare("SELECT device_id, status FROM scope_memberships WHERE scope_id = ? ORDER BY device_id")
			.all(SOURCE_SCOPE),
		operations: store.db
			.prepare(
				`SELECT operation_id, state, teammate_name, recipient_device_id,
					recipient_device_display_name
				 FROM share_operations ORDER BY created_at`,
			)
			.all(),
		policy: {
			teams: store.db.prepare("SELECT team_id, display_name, status FROM policy_teams ORDER BY team_id").all(),
			team_memberships: store.db
				.prepare(
					"SELECT team_id, identity_id, status FROM policy_team_memberships ORDER BY team_id, identity_id",
				)
				.all(),
			identity_devices: store.db
				.prepare(
					"SELECT identity_id, device_id, display_name, status FROM identity_devices ORDER BY identity_id, device_id",
				)
				.all(),
			project_recipients: store.db
				.prepare(
					`SELECT canonical_project_identity, recipient_kind, recipient_id, status
					 FROM project_recipients ORDER BY canonical_project_identity, recipient_kind, recipient_id`,
				)
				.all(),
			effective_projects: [POLICY_SELECTED_REMOTE, POLICY_UNRELATED_REMOTE].map((projectId) =>
				deriveRecipientPolicyEffectiveDevicesFromDatabase(store.db, projectId),
			),
		},
	};
}

async function main(): Promise<void> {
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
	initDatabase(DB_PATH);
	const store = new MemoryStore(DB_PATH);
	try {
		const selectedAction = action();
		if (selectedAction === "seed-a") seedA(store);
		if (selectedAction === "add-future") addFuture(store);
		if (selectedAction === "seed-policy") seedRecipientPolicy(store);
		const actionResult =
			selectedAction === "inherit-policy"
				? inheritRecipientPolicy(store)
				: selectedAction === "reconciliation-proof"
					? await reconciliationProof(store)
					: selectedAction === "keep-current"
						? keepCurrentProof(store)
						: null;
		if (selectedAction === "revoke-policy") revokeDirectRecipient(store);
		if (selectedAction === "add-stale-memory") {
			const staleSession = session(store, "policy-selected", POLICY_SELECTED_REMOTE);
			remember(store, staleSession, "policy selected stale-preview change", null);
			store.endSession(staleSession, { fixture: "policy-selected-stale-preview" });
		}
		await store.flushPendingVectorWrites();
		console.log(
			JSON.stringify({ ok: true, action: selectedAction, action_result: actionResult, ...summary(store) }, null, 2),
		);
	} finally {
		store.close();
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
