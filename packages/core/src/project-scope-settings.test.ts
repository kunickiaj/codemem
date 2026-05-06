import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toJson } from "./db.js";
import {
	listProjectScopeCandidates,
	listSharingDomainSettingsScopes,
	upsertProjectScopeSettingsMapping,
} from "./project-scope-settings.js";
import { LOCAL_DEFAULT_SCOPE_ID } from "./scope-resolution.js";
import { initTestSchema } from "./test-utils.js";

function insertSession(
	db: InstanceType<typeof Database>,
	input: {
		cwd?: string | null;
		project?: string | null;
		gitRemote?: string | null;
		gitBranch?: string | null;
	} = {},
) {
	const now = "2026-05-06T00:00:00Z";
	const result = db
		.prepare(
			`INSERT INTO sessions(started_at, cwd, project, git_remote, git_branch, user, tool_version)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			now,
			input.cwd === undefined ? "/Users/adam/work/acme/api" : input.cwd,
			input.project === undefined ? "api" : input.project,
			input.gitRemote === undefined ? "https://example.test/acme/api.git" : input.gitRemote,
			input.gitBranch === undefined ? "main" : input.gitBranch,
			"test-user",
			"test",
		);
	return Number(result.lastInsertRowid);
}

function insertMemory(
	db: InstanceType<typeof Database>,
	sessionId: number,
	input: { workspaceId?: string | null } = {},
) {
	const now = "2026-05-06T00:00:00Z";
	db.prepare(
		`INSERT INTO memory_items(
			session_id, kind, title, body_text, created_at, updated_at,
			visibility, workspace_id, active, metadata_json
		 ) VALUES (?, 'discovery', 'Scoped project', 'Body', ?, ?, 'shared', ?, 1, ?)`,
	).run(
		sessionId,
		now,
		now,
		input.workspaceId === undefined ? "shared:acme" : input.workspaceId,
		toJson({}),
	);
}

describe("project scope settings", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("lists local sharing-domain defaults and unknown projects as local-only", () => {
		const sessionId = insertSession(db);
		insertMemory(db, sessionId);

		const scopes = listSharingDomainSettingsScopes(db);
		const projects = listProjectScopeCandidates(db);

		expect(scopes.map((scope) => scope.scope_id)).toContain(LOCAL_DEFAULT_SCOPE_ID);
		expect(projects).toEqual([
			expect.objectContaining({
				display_project: "api",
				identity_source: "git_remote",
				resolved_scope_id: LOCAL_DEFAULT_SCOPE_ID,
				resolution_reason: "local_default",
			}),
		]);
	});

	it("includes workspace-id-only and unmapped sessions with memories as local-only", () => {
		const workspaceOnlySession = insertSession(db, {
			cwd: null,
			gitBranch: null,
			gitRemote: null,
			project: null,
		});
		insertMemory(db, workspaceOnlySession, { workspaceId: "shared:workspace-only" });
		const unmappedSession = insertSession(db, {
			cwd: null,
			gitBranch: null,
			gitRemote: null,
			project: null,
		});
		insertMemory(db, unmappedSession, { workspaceId: null });

		const projects = listProjectScopeCandidates(db);

		expect(projects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					display_project: "shared:workspace-only",
					identity_source: "workspace_id",
					resolved_scope_id: LOCAL_DEFAULT_SCOPE_ID,
					resolution_reason: "local_default",
				}),
				expect.objectContaining({
					identity_source: "unmapped",
					resolved_scope_id: LOCAL_DEFAULT_SCOPE_ID,
					resolution_reason: "local_default",
				}),
			]),
		);
	});

	it("assigns a canonical project identity without granting membership", () => {
		const sessionId = insertSession(db);
		insertMemory(db, sessionId);
		db.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
			 ) VALUES ('acme-work', 'Acme Work', 'team', 'coordinator', 1, 'active', ?, ?)`,
		).run("2026-05-06T00:00:00Z", "2026-05-06T00:00:00Z");

		const [project] = listProjectScopeCandidates(db);
		if (!project) throw new Error("project missing");
		const mapping = upsertProjectScopeSettingsMapping(db, {
			workspace_identity: project.workspace_identity,
			project_pattern: project.display_project,
			scope_id: "acme-work",
		});
		const [resolved] = listProjectScopeCandidates(db);
		const memberships = db.prepare("SELECT COUNT(*) AS n FROM scope_memberships").get() as {
			n: number;
		};

		expect(mapping).toMatchObject({ scope_id: "acme-work", source: "user" });
		expect(resolved).toMatchObject({
			resolved_scope_id: "acme-work",
			resolution_reason: "exact_mapping",
			mapping_id: mapping.id,
		});
		expect(memberships.n).toBe(0);
	});

	it("rejects basename-only pattern mappings", () => {
		expect(() =>
			upsertProjectScopeSettingsMapping(db, {
				project_pattern: "api",
				scope_id: LOCAL_DEFAULT_SCOPE_ID,
			}),
		).toThrow(/canonical path, remote, or workspace pattern/);
	});

	it("rejects mappings to inactive or unknown Sharing domains", () => {
		db.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
			 ) VALUES ('inactive-work', 'Inactive Work', 'team', 'coordinator', 1, 'archived', ?, ?)`,
		).run("2026-05-06T00:00:00Z", "2026-05-06T00:00:00Z");

		expect(() =>
			upsertProjectScopeSettingsMapping(db, {
				workspace_identity: "https://example.test/acme/api.git",
				project_pattern: "api",
				scope_id: "missing-domain",
			}),
		).toThrow(/not an active Sharing domain/);
		expect(() =>
			upsertProjectScopeSettingsMapping(db, {
				workspace_identity: "https://example.test/acme/api.git",
				project_pattern: "api",
				scope_id: "inactive-work",
			}),
		).toThrow(/not an active Sharing domain/);
	});
});
