import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import { LOCAL_DEFAULT_SCOPE_ID } from "./scope-resolution.js";
import { planTeamRecoveryProjects } from "./team-recovery-projects.js";
import {
	insertCheckout,
	insertScope,
	NOW,
	PROJECT,
	quarantinedTeam,
	TARGET,
} from "./team-recovery-test-fixtures.js";

let db: InstanceType<typeof Database>;
let manifest: CoordinatorLegacyTeamCompletionManifestV1;

beforeEach(async () => {
	db = new Database(":memory:");
	manifest = await quarantinedTeam(db);
});

afterEach(() => db.close());

const run = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...values);

function plan() {
	const attemptId = db
		.prepare("SELECT attempt_id FROM legacy_team_setup_drafts WHERE state = 'completed'")
		.pluck()
		.get() as string;
	// The setup's own device made the coordinator's copy, so the two manifests are equal.
	return planTeamRecoveryProjects(db, {
		...TARGET,
		teamId: manifest.team_id,
		attemptId,
		localManifest: manifest,
	});
}

function mapProject(scopeId: string) {
	run(
		`INSERT INTO project_scope_mappings(workspace_identity, project_pattern, scope_id, source,
		 created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?)`,
		PROJECT,
		PROJECT,
		scopeId,
		NOW,
		NOW,
	);
}

describe("Team recovery Project plan", () => {
	it("restores the setup's recipient and the mapping quarantine deleted", () => {
		expect(plan()).toEqual([
			{
				projectIdentity: PROJECT,
				displayName: "API",
				outcome: "restored",
				routedScopeIds: [],
				restoredMappings: [{ sourceProjectIdentity: PROJECT, scopeId: "scope-engineering" }],
			},
		]);
	});

	it.each([
		[
			"a recipient a person revoked",
			() =>
				run("UPDATE project_recipients SET provenance = 'user', migration_state = 'user_managed'"),
			"sharing_changed",
		],
		[
			"a recipient a person deleted",
			() => run("DELETE FROM project_recipients"),
			"sharing_changed",
		],
		[
			"a mapping a person pointed at another scope",
			() => mapProject("scope-other"),
			"mapping_changed",
		],
		[
			"a reviewed scope that is no longer active",
			() =>
				run("UPDATE replication_scopes SET status = 'archived' WHERE group_id = ?", TARGET.groupId),
			"scope_unavailable",
		],
	])("skips a Project with %s after the Team was disabled", (_case, arrange, reason) => {
		insertScope(db, "scope-other", "group-other");
		arrange();

		expect(plan()).toMatchObject([{ outcome: "skipped", reason, restoredMappings: [] }]);
	});

	it("re-creates no mapping when a person already mapped the Project to its reviewed scope", () => {
		mapProject("scope-engineering");

		expect(plan()).toMatchObject([
			{ outcome: "restored", routedScopeIds: ["scope-engineering"], restoredMappings: [] },
		]);
	});

	it("lists Projects shared with the Team outside its setup, which resume", () => {
		// Arrange: quarantine revokes only the recipients the setup created.
		run(
			`INSERT INTO project_recipients(canonical_project_identity, recipient_kind, recipient_id,
			 status, provenance, policy_revision, migration_state, idempotency_key, created_at, updated_at)
			 VALUES ('project-extra', 'team', ?, 'active', 'user', 'r1', 'user_managed', 'extra', ?, ?)`,
			manifest.team_id,
			NOW,
			NOW,
		);
		run(
			"UPDATE project_recipients SET status = 'active', provenance = 'user' WHERE canonical_project_identity = ?",
			PROJECT,
		);

		expect(plan().map((project) => [project.projectIdentity, project.outcome])).toEqual([
			[PROJECT, "resumes"],
			["project-extra", "resumes"],
		]);
	});

	it("lists neither another Team's recipients nor a recipient outside the setup that is not active", () => {
		const insert = db.prepare(
			`INSERT INTO project_recipients(canonical_project_identity, recipient_kind, recipient_id,
			 status, provenance, policy_revision, migration_state, idempotency_key, created_at, updated_at)
			 VALUES (?, 'team', ?, ?, 'user', 'r1', 'user_managed', ?, ?, ?)`,
		);
		insert.run("project-extra", "team-other", "active", "extra", NOW, NOW);
		insert.run("project-revoked", manifest.team_id, "revoked", "revoked", NOW, NOW);

		expect(plan().map((project) => project.projectIdentity)).toEqual([PROJECT]);
	});
});

describe("Team recovery Project plan with checkout routing", () => {
	const CHECKOUT = "/nonexistent/acme/api";
	const mapCheckout = (workspace: string | null, pattern: string, scopeId: string) =>
		run(
			`INSERT INTO project_scope_mappings(workspace_identity, project_pattern, scope_id, source,
			 created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?)`,
			workspace,
			pattern,
			scopeId,
			NOW,
			NOW,
		);

	beforeEach(() => {
		insertScope(db, "scope-other", "group-other");
		insertCheckout(db, CHECKOUT, PROJECT);
	});

	it.each([
		["a pattern that matches its checkout", null, "/nonexistent/acme/*"],
		["a mapping of its checkout path", CHECKOUT, "api"],
	])("skips a Project that %s now routes to another scope", (_case, workspace, pattern) => {
		// Arrange: the mapping never names the Project, only where it is checked out.
		mapCheckout(workspace, pattern, "scope-other");

		expect(plan()).toMatchObject([
			{
				outcome: "skipped",
				reason: "mapping_changed",
				routedScopeIds: ["scope-other"],
				restoredMappings: [],
			},
		]);
	});

	it("skips a Project that a pattern matching its checkout keeps on this machine", () => {
		// Arrange: a mapping to local-only storage is a route. Restoring would override it.
		mapCheckout(null, "/nonexistent/acme/*", LOCAL_DEFAULT_SCOPE_ID);

		expect(plan()).toMatchObject([
			{
				outcome: "skipped",
				reason: "mapping_changed",
				routedScopeIds: [LOCAL_DEFAULT_SCOPE_ID],
				restoredMappings: [],
			},
		]);
	});

	it("shows that a Project that resumes is kept on this machine", () => {
		run("UPDATE project_recipients SET status = 'active', provenance = 'user'");
		mapCheckout(null, "/nonexistent/acme/*", LOCAL_DEFAULT_SCOPE_ID);

		expect(plan()).toMatchObject([
			{ outcome: "resumes", routedScopeIds: [LOCAL_DEFAULT_SCOPE_ID] },
		]);
	});

	it("skips a Project whose checkouts are mapped to scopes that disagree", () => {
		// Arrange: stamping sets conflicting mappings aside and falls back to local
		// storage. That fallback is not an untouched Project.
		insertCheckout(db, `${CHECKOUT}-second`, PROJECT);
		mapCheckout(CHECKOUT, "api", "scope-other");
		mapCheckout(`${CHECKOUT}-second`, "api", "scope-engineering");

		expect(plan()).toMatchObject([
			{ outcome: "skipped", reason: "mapping_changed", restoredMappings: [] },
		]);
	});

	it("restores a Project past a catch-all pattern that stamping never applies", () => {
		// Arrange: stamping ignores a pattern with no path or host in it.
		mapCheckout(null, "*", "scope-other");

		expect(plan()).toMatchObject([
			{
				outcome: "restored",
				routedScopeIds: [],
				restoredMappings: [{ sourceProjectIdentity: PROJECT, scopeId: "scope-engineering" }],
			},
		]);
	});

	it("restores a Project whose checkout nothing routes", () => {
		mapCheckout(null, "/nonexistent/other/*", "scope-other");

		expect(plan()).toMatchObject([{ outcome: "restored", routedScopeIds: [] }]);
	});

	it("re-creates no mapping when the checkout already routes to the reviewed scope", () => {
		mapCheckout(CHECKOUT, "api", "scope-engineering");

		expect(plan()).toMatchObject([
			{ outcome: "restored", routedScopeIds: ["scope-engineering"], restoredMappings: [] },
		]);
	});

	it("shows where a Project that resumes is routed now", () => {
		// Arrange: a person shared the Project with the Team again and routed its checkout elsewhere.
		run("UPDATE project_recipients SET status = 'active', provenance = 'user'");
		mapCheckout(null, "/nonexistent/acme/*", "scope-other");

		expect(plan()).toMatchObject([{ outcome: "resumes", routedScopeIds: ["scope-other"] }]);
	});

	it("ignores a checkout that recorded another repository under the Project's remote", () => {
		// Arrange: stamping reads this session as the other repository's checkout,
		// and the other repository is routed elsewhere.
		const other = "https://git.example.invalid/acme/other.git";
		run(
			`INSERT INTO sessions(started_at, cwd, project, git_remote, tool_version, metadata_json)
			 VALUES (?, '/nonexistent/acme/other', 'other', ?, 'test', ?)`,
			NOW,
			PROJECT,
			JSON.stringify({ codemem_repository_identity: other }),
		);
		mapCheckout(other, "other", "scope-other");

		expect(plan()).toMatchObject([
			{
				outcome: "restored",
				routedScopeIds: [],
				restoredMappings: [{ sourceProjectIdentity: PROJECT, scopeId: "scope-engineering" }],
			},
		]);
	});

	it("reads the route of a checkout that recorded the Project under another remote", () => {
		const fork = "/nonexistent/fork/api";
		run(
			`INSERT INTO sessions(started_at, cwd, project, git_remote, tool_version, metadata_json)
			 VALUES (?, ?, 'api', 'https://git.example.invalid/fork/api.git', 'test', ?)`,
			NOW,
			fork,
			JSON.stringify({ codemem_repository_identity: PROJECT }),
		);
		mapCheckout(fork, "api", "scope-other");

		expect(plan()).toMatchObject([
			{ outcome: "skipped", reason: "mapping_changed", routedScopeIds: ["scope-other"] },
		]);
	});

	it("ignores memories of the Project that arrived from a peer", () => {
		run("UPDATE sessions SET tool_version = 'sync_replication'");
		mapCheckout(null, "/nonexistent/acme/*", "scope-other");

		expect(plan()).toMatchObject([{ outcome: "restored", routedScopeIds: [] }]);
	});
});
