import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import { listAuthorizedScopesForPeer, parseSyncScopeRequest } from "./sync-scope-protocol.js";
import { applyTeamMemberRemovals } from "./team-member-removal-policy.js";
import { linkTeamToCoordinatorGroup } from "./team-member-removal-test-fixtures.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-07-26T00:00:00.000Z";
const COORDINATOR = "https://coord.example.test";
const LOCAL = "device-local";
const REMOVED = "device-removed";
const STAYING = "device-staying";
const TEAM_PROJECT = "https://git.example.invalid/team/project.git";
const OTHER_PROJECT = "https://git.example.invalid/person/own.git";
let db: InstanceType<typeof Database>;
let team: string;

function row(table: string, values: Record<string, unknown>) {
	const columns = Object.keys(values);
	db.prepare(
		`INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
	).run(...Object.values(values));
}

function person(identityId: string, deviceId: string) {
	row("actors", {
		actor_id: identityId,
		display_name: identityId,
		is_local: 0,
		status: "active",
		created_at: NOW,
		updated_at: NOW,
	});
	row("identity_devices", {
		device_id: deviceId,
		identity_id: identityId,
		display_name: deviceId,
		status: "active",
		provenance: "test",
		revision: "r1",
		migration_state: "user_managed",
		idempotency_key: `binding-${deviceId}`,
		created_at: NOW,
		updated_at: NOW,
	});
}

function share(project: string, kind: "team" | "identity", recipientId: string) {
	row("project_recipients", {
		canonical_project_identity: project,
		recipient_kind: kind,
		recipient_id: recipientId,
		status: "active",
		provenance: "test",
		policy_revision: "r1",
		migration_state: "completed",
		idempotency_key: `recipient-${project}-${recipientId}`,
		created_at: NOW,
		updated_at: NOW,
	});
}

/** A coordinator scope with this device and both people's devices in it. */
function scope(scopeId: string, devices = [LOCAL, REMOVED, STAYING]) {
	row("replication_scopes", {
		scope_id: scopeId,
		label: scopeId,
		kind: "team",
		authority_type: "coordinator",
		coordinator_id: COORDINATOR,
		group_id: "group-a",
		membership_epoch: 0,
		status: "active",
		created_at: NOW,
		updated_at: NOW,
	});
	for (const deviceId of devices)
		row("scope_memberships", {
			scope_id: scopeId,
			device_id: deviceId,
			role: "member",
			status: "active",
			membership_epoch: 0,
			coordinator_id: COORDINATOR,
			group_id: "group-a",
			updated_at: NOW,
		});
}

/** A mapping saved through the normal Viewer path. */
function map(project: string, scopeId: string) {
	row("project_scope_mappings", {
		workspace_identity: project,
		project_pattern: project,
		scope_id: scopeId,
		priority: 0,
		source: "user",
		created_at: NOW,
		updated_at: NOW,
	});
}

function admitted(scopeId: string, deviceId: string) {
	return parseSyncScopeRequest(scopeId, true, {
		db,
		localDeviceId: LOCAL,
		localSigningPublicKey: CANONICAL_PUBLIC_KEY,
		authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
		negotiatedCapability: "scoped",
		peerDeviceId: deviceId,
	}).ok;
}

function advertised(deviceId: string) {
	return listAuthorizedScopesForPeer(db, {
		db,
		localDeviceId: LOCAL,
		localSigningPublicKey: CANONICAL_PUBLIC_KEY,
		authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
		negotiatedCapability: "scoped",
		peerDeviceId: deviceId,
	}).map((item) => item.scope_id);
}

function remove(groupId = "group-a") {
	return applyTeamMemberRemovals(db, {
		coordinatorId: COORDINATOR,
		groupId,
		removals: [
			{
				group_id: groupId,
				team_id: team,
				identity_id: "identity-removed",
				removal_seq: 1,
				removed_at: NOW,
				removed_by_device_id: null,
			},
		],
		now: NOW,
	});
}

beforeEach(async () => {
	db = new Database(":memory:");
	initTestSchema(db);
	team = linkTeamToCoordinatorGroup(db, {
		candidateId: "candidate-a",
		coordinatorId: COORDINATOR,
		groupId: "group-a",
	});
	row("policy_teams", {
		team_id: team,
		display_name: "Team",
		status: "active",
		provenance: "test",
		revision: "r1",
		migration_state: "user_managed",
		idempotency_key: "team",
		created_at: NOW,
		updated_at: NOW,
	});
	for (const [identityId, deviceId] of [
		["identity-removed", REMOVED],
		["identity-staying", STAYING],
	] as const) {
		person(identityId, deviceId);
		row("policy_team_memberships", {
			team_id: team,
			identity_id: identityId,
			role: "member",
			status: "active",
			provenance: "test",
			revision: "r1",
			migration_state: "user_managed",
			idempotency_key: `membership-${identityId}`,
			created_at: NOW,
			updated_at: NOW,
		});
	}
	share(TEAM_PROJECT, "team", team);
	scope("team-scope");
	map(TEAM_PROJECT, "team-scope");
	await refreshTestScopeRows(db);
});

afterEach(() => db.close());

describe("sync admission after a Team member removal", () => {
	it("refuses the removed person's device the Team's scope at once and keeps the other member", () => {
		expect(admitted("team-scope", REMOVED)).toBe(true);

		remove();

		expect(admitted("team-scope", REMOVED)).toBe(false);
		expect(advertised(REMOVED)).not.toContain("team-scope");
		expect(admitted("team-scope", STAYING)).toBe(true);
	});

	it("keeps a scope that holds only a Project shared with the person directly", async () => {
		share(OTHER_PROJECT, "identity", "identity-removed");
		scope("own-scope", [LOCAL, REMOVED]);
		map(OTHER_PROJECT, "own-scope");
		await refreshTestScopeRows(db);

		remove();

		expect(admitted("own-scope", REMOVED)).toBe(true);
	});

	it("keeps the Team's scope when the person also has the Team's Project directly", () => {
		share(TEAM_PROJECT, "identity", "identity-removed");

		remove();

		expect(admitted("team-scope", REMOVED)).toBe(true);
	});

	it("refuses a membership that a later refresh installs", async () => {
		remove();
		scope("later-scope");
		map(TEAM_PROJECT, "later-scope");

		await refreshTestScopeRows(db);

		expect(admitted("later-scope", REMOVED)).toBe(false);
	});

	it("refuses a scope that stores the Team Project's memories without a mapping", async () => {
		scope("stored-scope");
		await refreshTestScopeRows(db);
		// Only the memory itself names the Project.
		row("sessions", { id: 9, started_at: NOW, cwd: "/work/elsewhere", project: null });
		row("memory_items", {
			session_id: 9,
			kind: "discovery",
			title: "Stored",
			body_text: "Stored",
			active: 1,
			created_at: NOW,
			updated_at: NOW,
			scope_id: "stored-scope",
			project: TEAM_PROJECT,
		});
		expect(admitted("stored-scope", REMOVED)).toBe(true);

		remove();

		expect(admitted("stored-scope", REMOVED)).toBe(false);
	});

	it("does not refuse anything for a removal from another group", () => {
		const result = remove("group-b");

		expect(result.ignored).toEqual([{ teamId: team, identityId: "identity-removed" }]);
		expect(admitted("team-scope", REMOVED)).toBe(true);
	});
});
