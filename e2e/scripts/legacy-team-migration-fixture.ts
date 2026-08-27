import {
	deriveRecipientPolicyEffectiveDevicesFromDatabase,
	fingerprintPublicKey,
	initDatabase,
	MemoryStore,
} from "../../packages/core/src/index.ts";

const DB_PATH = "/data/mem.sqlite";
const NOW = "2026-08-25T12:00:00.000Z";
const COORDINATOR_ID = "http://coordinator:7347";
const GROUP_ALPHA = "legacy-team-alpha";
const GROUP_BETA = "legacy-team-beta";
const ALPHA_PROJECT = "https://example.invalid/e2e/alpha.git";
const BETA_PROJECT = "https://example.invalid/e2e/beta.git";
const WEB_PROJECT = "https://example.invalid/e2e/web.git";
const OFF_ROSTER_DEVICE_ID = "legacy-off-roster-device";

const ROSTER = {
	shared: {
		deviceId: "legacy-shared-device",
		displayName: "Shared Device",
		publicKey: "legacy-team-e2e-shared-public-key",
	},
	optional: {
		deviceId: "legacy-optional-device",
		displayName: "Optional Device",
		publicKey: "legacy-team-e2e-optional-public-key",
	},
	beta: {
		deviceId: "legacy-beta-device",
		displayName: "Beta Device",
		publicKey: "legacy-team-e2e-beta-public-key",
	},
	betaTwo: {
		deviceId: "legacy-beta-two-device",
		displayName: "Beta Two Device",
		publicKey: "legacy-team-e2e-beta-two-public-key",
	},
	betaThree: {
		deviceId: "legacy-beta-three-device",
		displayName: "Beta Three Device",
		publicKey: "legacy-team-e2e-beta-three-public-key",
	},
	betaFour: {
		deviceId: "legacy-beta-four-device",
		displayName: "Beta Four Device",
		publicKey: "legacy-team-e2e-beta-four-public-key",
	},
} as const;

type Action = "seed" | "summary" | "conflict-beta-assignment" | "add-off-roster-device";

function selectedAction(): Action {
	const value = process.argv[process.argv.indexOf("--action") + 1];
	if (
		value !== "seed" &&
		value !== "summary" &&
		value !== "conflict-beta-assignment" &&
		value !== "add-off-roster-device"
	) {
		throw new Error(
			"--action must be seed, summary, conflict-beta-assignment, or add-off-roster-device",
		);
	}
	return value;
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

function insertScope(store: MemoryStore, scopeId: string, label: string, groupId: string): void {
	store.db
		.prepare(
			`INSERT OR REPLACE INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id,
			 membership_epoch, status, created_at, updated_at
			 ) VALUES (?, ?, 'team', 'coordinator', ?, ?, 1, 'active', ?, ?)`,
		)
		.run(scopeId, label, COORDINATOR_ID, groupId, NOW, NOW);
}

function insertProjectMapping(
	store: MemoryStore,
	workspaceIdentity: string,
	scopeId: string,
): void {
	store.db
		.prepare(
			`INSERT OR REPLACE INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, 500, 'legacy_team_e2e', ?, ?)`,
		)
		.run(workspaceIdentity, workspaceIdentity, scopeId, NOW, NOW);
}

function seedProject(
	store: MemoryStore,
	project: string,
	cwd: string | null,
	gitRemote: string | null,
	scopeId: string | null,
): void {
	const sessionId = store.startSession({
		cwd: cwd ?? `/workspace/${project}`,
		project,
		user: "e2e",
		toolVersion: "legacy-team-migration-e2e",
	});
	if (cwd === null) {
		store.db.prepare("UPDATE sessions SET cwd = NULL WHERE id = ?").run(sessionId);
	}
	if (gitRemote) {
		store.db.prepare("UPDATE sessions SET git_remote = ? WHERE id = ?").run(gitRemote, sessionId);
	}
	const memoryId = store.remember(sessionId, "discovery", `${project} fixture`, "Synthetic migration fixture", 0.9, [], {
		visibility: "shared",
		created_at: NOW,
		updated_at: NOW,
	});
	if (scopeId) {
		store.db
			.prepare("UPDATE memory_items SET workspace_id = NULL, scope_id = ? WHERE id = ?")
			.run(scopeId, memoryId);
	}
	store.endSession(sessionId, { fixture: project });
}

function seed(store: MemoryStore): void {
	for (const [actorId, displayName] of [
		["identity-shared", "Shared Person"],
		["identity-optional", "Optional Person"],
		["identity-beta", "Beta Person"],
		["identity-beta-two", "Beta Two Person"],
		["identity-beta-three", "Beta Three Person"],
		["identity-beta-four", "Beta Four Person"],
		["identity-conflict", "Conflict Person"],
	] as const) {
		insertActor(store, actorId, displayName);
	}
	insertScope(store, "scope-legacy-alpha", "Legacy Alpha", GROUP_ALPHA);
	insertScope(store, "scope-legacy-beta", "Legacy Beta", GROUP_BETA);
	insertProjectMapping(store, ALPHA_PROJECT, "scope-legacy-alpha");
	insertProjectMapping(store, BETA_PROJECT, "scope-legacy-beta");
	seedProject(store, "legacy-alpha", "/workspace/legacy-alpha", ALPHA_PROJECT, "scope-legacy-alpha");
	seedProject(store, "legacy-web", null, null, "scope-legacy-alpha");
	seedProject(store, "legacy-beta", "/workspace/legacy-beta", BETA_PROJECT, "scope-legacy-beta");
	seedProject(store, "web-canonical", "/workspace/web-canonical", WEB_PROJECT, null);

	for (const [scopeId, deviceId] of [
		["scope-legacy-alpha", ROSTER.shared.deviceId],
		["scope-legacy-alpha", ROSTER.optional.deviceId],
		["scope-legacy-beta", ROSTER.shared.deviceId],
		["scope-legacy-beta", ROSTER.optional.deviceId],
		["scope-legacy-beta", ROSTER.beta.deviceId],
		["scope-legacy-beta", ROSTER.betaTwo.deviceId],
		["scope-legacy-beta", ROSTER.betaThree.deviceId],
	] as const) {
		store.db
			.prepare(
				`INSERT OR REPLACE INTO scope_memberships(
				 scope_id, device_id, role, status, membership_epoch, updated_at
				 ) VALUES (?, ?, 'member', 'active', 1, ?)`,
			)
			.run(scopeId, deviceId, NOW);
	}
}

function addOffRosterDevice(store: MemoryStore): void {
	store.db
		.prepare(
			`INSERT OR IGNORE INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-shared', 'Off Roster Device',
			 'active', 'e2e', '1', 'native', 1, 'legacy-off-roster-device', ?, ?)`,
		)
		.run(OFF_ROSTER_DEVICE_ID, NOW, NOW);
}

function conflictBetaAssignment(store: MemoryStore): void {
	// Preserve assignment_version so the scenario proves the rejected finish keeps this exact conflict.
	store.db
		.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-conflict', 'Beta Device', 'active', 'e2e-conflict', '1',
			 'native', 1, 'legacy-beta-conflict', ?, ?)
			 ON CONFLICT(device_id) DO UPDATE SET
			 identity_id = excluded.identity_id,
			 updated_at = excluded.updated_at`,
		)
		.run(ROSTER.beta.deviceId, NOW, NOW);
}

function rosterSummary() {
	return Object.fromEntries(
		Object.entries(ROSTER).map(([name, device]) => [
			name,
			{ ...device, fingerprint: fingerprintPublicKey(device.publicKey) },
		]),
	);
}

function summary(store: MemoryStore): Record<string, unknown> {
	const policies = {
		teams: store.db
			.prepare(
				"SELECT team_id, display_name, status, device_eligibility_mode FROM policy_teams ORDER BY display_name LIMIT 1000",
			)
			.all(),
		memberships: store.db
			.prepare(
				"SELECT team_id, identity_id, status FROM policy_team_memberships ORDER BY team_id, identity_id LIMIT 1000",
			)
			.all(),
		devices: store.db
			.prepare(
				"SELECT device_id, identity_id, status, assignment_version FROM identity_devices ORDER BY device_id LIMIT 1000",
			)
			.all(),
		decisions: store.db
			.prepare(
				"SELECT team_id, device_id, decision, assignment_version FROM policy_team_device_decisions ORDER BY team_id, device_id LIMIT 1000",
			)
			.all(),
		recipients: store.db
			.prepare(
				`SELECT canonical_project_identity, recipient_kind, recipient_id, status
				 FROM project_recipients ORDER BY canonical_project_identity, recipient_id LIMIT 1000`,
			)
			.all(),
		reviewedMappings: store.db
			.prepare(
				`SELECT workspace_identity, project_pattern, scope_id
				 FROM project_scope_mappings WHERE source = 'reviewed_team_setup'
				 ORDER BY workspace_identity, project_pattern LIMIT 1000`,
			)
			.all(),
	};
	return {
		roster: rosterSummary(),
		offRosterDeviceId: OFF_ROSTER_DEVICE_ID,
		legacyScopeMemberships: store.db
			.prepare(
				`SELECT scope_id, device_id, status FROM scope_memberships
				 WHERE scope_id IN ('scope-legacy-alpha', 'scope-legacy-beta')
				 ORDER BY scope_id, device_id LIMIT 1000`,
			)
			.all(),
		policies,
		effective: [ALPHA_PROJECT, BETA_PROJECT, WEB_PROJECT].map((project) =>
			deriveRecipientPolicyEffectiveDevicesFromDatabase(store.db, project),
		),
		completions: store.db
			.prepare(
				`SELECT candidate_ref, attempt_id, finish_digest, confirmed_access_delta_digest, response_json
				 FROM legacy_team_setup_completions ORDER BY candidate_ref LIMIT 1000`,
			)
			.all(),
	};
}

async function main(): Promise<void> {
	initDatabase(DB_PATH);
	const store = new MemoryStore(DB_PATH);
	try {
		const action = selectedAction();
		if (action === "seed") seed(store);
		if (action === "conflict-beta-assignment") conflictBetaAssignment(store);
		if (action === "add-off-roster-device") addOffRosterDevice(store);
		await store.flushPendingVectorWrites();
		console.log(JSON.stringify({ ok: true, action, ...summary(store) }));
	} finally {
		store.close();
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
