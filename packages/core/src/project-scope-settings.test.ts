import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toJson } from "./db.js";
import {
	analyzeProjectScopeMappingChangeGuardrails,
	listProjectScopeCandidates,
	listProjectScopeInventory,
	listProjectScopeSettingsMappings,
	listSharingDomainSettingsScopes,
	reassignProjectScopeInventoryProject,
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
			input.cwd === undefined ? "/workspace/work/exampleco/api" : input.cwd,
			input.project === undefined ? "api" : input.project,
			input.gitRemote === undefined
				? "https://git.example.invalid/exampleco/api.git"
				: input.gitRemote,
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

function insertScope(
	db: InstanceType<typeof Database>,
	input: {
		scopeId: string;
		label: string;
		kind?: string;
		authorityType?: string;
	},
) {
	db.prepare(
		`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)`,
	).run(
		input.scopeId,
		input.label,
		input.kind ?? "team",
		input.authorityType ?? "coordinator",
		"2026-05-06T00:00:00Z",
		"2026-05-06T00:00:00Z",
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
				guardrail_warnings: [
					expect.objectContaining({
						code: "unknown_project_local_only",
						requires_confirmation: false,
					}),
				],
			}),
		]);
	});

	it("warns when same-basename projects need review before assignment", () => {
		const workSession = insertSession(db, {
			cwd: "/workspace/work/exampleco/api",
			gitRemote: "https://git.example.invalid/exampleco/api.git",
			project: "api",
		});
		insertMemory(db, workSession);
		const ossSession = insertSession(db, {
			cwd: "/workspace/oss/api",
			gitRemote: "https://git.example.invalid/oss/api.git",
			project: "api",
		});
		insertMemory(db, ossSession, { workspaceId: "shared:oss-api" });

		const projects = listProjectScopeCandidates(db);

		expect(projects).toHaveLength(2);
		expect(projects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					workspace_identity: "https://git.example.invalid/exampleco/api.git",
					guardrail_warnings: expect.arrayContaining([
						expect.objectContaining({
							code: "basename_collision_review",
							requires_confirmation: true,
							severity: "info",
							related_workspace_identities: ["https://git.example.invalid/oss/api.git"],
						}),
					]),
				}),
				expect.objectContaining({
					workspace_identity: "https://git.example.invalid/oss/api.git",
					guardrail_warnings: expect.arrayContaining([
						expect.objectContaining({
							code: "basename_collision_review",
							requires_confirmation: true,
							severity: "info",
							related_workspace_identities: ["https://git.example.invalid/exampleco/api.git"],
						}),
					]),
				}),
			]),
		);
	});

	it("does not mark same-basename worktrees as persistent needs-attention inventory", () => {
		insertScope(db, { scopeId: "exampleco-work", label: "ExampleCo Work" });
		const workSession = insertSession(db, {
			cwd: "/workspace/work/exampleco/api",
			gitRemote: "https://git.example.invalid/exampleco/api.git",
			project: "api",
		});
		insertMemory(db, workSession);
		const ossSession = insertSession(db, {
			cwd: "/workspace/oss/api",
			gitRemote: "https://git.example.invalid/oss/api.git",
			project: "api",
		});
		insertMemory(db, ossSession, { workspaceId: "shared:oss-api" });

		const inventory = listProjectScopeInventory(db);
		const work = inventory.projects.find(
			(project) => project.workspace_identity === "https://git.example.invalid/exampleco/api.git",
		);
		if (!work) throw new Error("work project missing");

		expect(work.statuses).not.toContain("needs_attention");
		expect(work.guardrail_warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "basename_collision_review",
					requires_confirmation: true,
					severity: "info",
				}),
			]),
		);

		const analysis = analyzeProjectScopeMappingChangeGuardrails(db, {
			workspace_identity: work.workspace_identity,
			project_pattern: work.display_project,
			scope_id: "exampleco-work",
		});
		expect(analysis.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "basename_collision_review",
					requires_confirmation: true,
				}),
			]),
		);
	});

	it("checks basename collisions beyond the default candidate list when confirming assignments", () => {
		insertScope(db, { scopeId: "exampleco-work", label: "ExampleCo Work" });
		const targetSession = insertSession(db, {
			cwd: "/workspace/work/exampleco/api",
			gitRemote: "https://git.example.invalid/exampleco/api.git",
			project: "api",
		});
		insertMemory(db, targetSession);
		const siblingSession = insertSession(db, {
			cwd: "/workspace/oss/api",
			gitRemote: "https://git.example.invalid/oss/api.git",
			project: "api",
		});
		insertMemory(db, siblingSession, { workspaceId: "shared:oss-api" });
		for (let i = 0; i < 260; i++) {
			const sessionId = insertSession(db, {
				cwd: `/workspace/noise/project-${i}`,
				gitRemote: `https://git.example.invalid/noise/project-${i}.git`,
				project: `project-${i}`,
			});
			insertMemory(db, sessionId, { workspaceId: `shared:noise-${i}` });
		}

		const analysis = analyzeProjectScopeMappingChangeGuardrails(db, {
			workspace_identity: "https://git.example.invalid/exampleco/api.git",
			project_pattern: "api",
			scope_id: "exampleco-work",
		});

		expect(analysis.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "basename_collision_review",
					requires_confirmation: true,
					related_workspace_identities: ["https://git.example.invalid/oss/api.git"],
				}),
			]),
		);
	});

	it("reassigns sessions for a stable workspace identity to the corrected project", () => {
		const sessionId = insertSession(db, {
			cwd: "/Users/adam/workspace/codemem/.claude/worktrees/injection",
			gitBranch: null,
			gitRemote: null,
			project: "injection",
		});
		insertMemory(db, sessionId);

		const result = reassignProjectScopeInventoryProject(db, {
			project: "codemem",
			workspaceIdentity: "/Users/adam/workspace/codemem/.claude/worktrees/injection",
		});

		expect(result).toMatchObject({
			moved_memory_count: 1,
			moved_session_count: 1,
			previous_projects: ["injection"],
			project: "codemem",
		});
		const row = db.prepare("SELECT project FROM sessions WHERE id = ?").get(sessionId) as {
			project: string;
		};
		expect(row.project).toBe("codemem");
		expect(listProjectScopeInventory(db, { query: "codemem" }).projects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					project: "codemem",
					workspace_identity: "/Users/adam/workspace/codemem/.claude/worktrees/injection",
				}),
			]),
		);
	});

	it("suggests mappings from canonical signals without saving them", () => {
		insertScope(db, { scopeId: "exampleco-work", label: "ExampleCo Work" });
		insertScope(db, {
			scopeId: "personal-devices",
			label: "Personal Devices",
			kind: "personal",
			authorityType: "local",
		});
		const workSession = insertSession(db, {
			cwd: "/workspace/work/exampleco/api",
			gitRemote: "https://git.example.invalid/exampleco/api.git",
			project: "api",
		});
		insertMemory(db, workSession);
		const personalSession = insertSession(db, {
			cwd: "/workspace/personal/api",
			gitRemote: null,
			project: "api",
		});
		insertMemory(db, personalSession, { workspaceId: "personal:api" });

		const projects = listProjectScopeCandidates(db);
		const work = projects.find(
			(project) => project.workspace_identity === "https://git.example.invalid/exampleco/api.git",
		);
		const personal = projects.find(
			(project) => project.workspace_identity === "/workspace/personal/api",
		);
		const mappingCount = db.prepare("SELECT COUNT(*) AS n FROM project_scope_mappings").get() as {
			n: number;
		};

		expect(work).toMatchObject({
			identity_source: "git_remote",
			resolved_scope_id: LOCAL_DEFAULT_SCOPE_ID,
			resolution_reason: "local_default",
			suggested_scope_id: "exampleco-work",
			suggestion_signal: "git_remote",
		});
		expect(work?.suggestion_reason).toContain("git remote");
		expect(personal).toMatchObject({
			identity_source: "cwd",
			resolved_scope_id: LOCAL_DEFAULT_SCOPE_ID,
			suggested_scope_id: "personal-devices",
			suggestion_signal: "cwd",
		});
		expect(projects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					workspace_identity: "https://git.example.invalid/exampleco/api.git",
					guardrail_warnings: expect.arrayContaining([
						expect.objectContaining({ code: "basename_collision_review" }),
					]),
				}),
				expect.objectContaining({
					workspace_identity: "/workspace/personal/api",
					guardrail_warnings: expect.arrayContaining([
						expect.objectContaining({ code: "basename_collision_review" }),
					]),
				}),
			]),
		);
		expect(mappingCount.n).toBe(0);
	});

	it("lists searchable project inventory after identity dedupe", () => {
		insertScope(db, { scopeId: "exampleco-work", label: "ExampleCo Work" });
		const olderSession = insertSession(db, {
			cwd: "/workspace/work/exampleco/api-old",
			gitRemote: "https://git.example.invalid/exampleco/api.git",
			project: "api",
		});
		insertMemory(db, olderSession);
		const newerSession = insertSession(db, {
			cwd: "/workspace/work/exampleco/api",
			gitRemote: "https://git.example.invalid/exampleco/api.git",
			project: "api",
		});
		insertMemory(db, newerSession);
		upsertProjectScopeSettingsMapping(db, {
			workspace_identity: "https://git.example.invalid/exampleco/api.git",
			project_pattern: "api",
			scope_id: "exampleco-work",
		});

		const inventory = listProjectScopeInventory(db, {
			query: "exampleco",
			status: "explicitly_mapped",
		});

		expect(inventory).toMatchObject({ total: 1, limit: 50, offset: 0, has_more: false });
		expect(inventory.projects).toEqual([
			expect.objectContaining({
				memory_count: 2,
				resolved_scope_id: "exampleco-work",
				session_count: 2,
				statuses: expect.arrayContaining(["explicitly_mapped"]),
				workspace_identity: "https://git.example.invalid/exampleco/api.git",
			}),
		]);
	});

	it("includes explicitly mapped projects with no recent sessions", () => {
		insertScope(db, { scopeId: "exampleco-work", label: "ExampleCo Work" });
		upsertProjectScopeSettingsMapping(db, {
			workspace_identity: "workspace:retired-api",
			project_pattern: "retired-api",
			scope_id: "exampleco-work",
		});

		const inventory = listProjectScopeInventory(db, { query: "retired" });

		expect(inventory.projects).toEqual([
			expect.objectContaining({
				display_project: "retired-api",
				memory_count: 0,
				resolved_scope_id: "exampleco-work",
				session_count: 0,
				workspace_identity: "workspace:retired-api",
			}),
		]);
	});

	it("rejects inert unmapped and legacy-review assignments", () => {
		expect(() =>
			upsertProjectScopeSettingsMapping(db, {
				workspace_identity: "unmapped:abc123",
				project_pattern: "unknown",
				scope_id: LOCAL_DEFAULT_SCOPE_ID,
			}),
		).toThrow(/unmapped projects cannot be assigned/);
		expect(() =>
			upsertProjectScopeSettingsMapping(db, {
				workspace_identity: "workspace:legacy-target",
				project_pattern: "legacy-target",
				scope_id: "legacy-shared-review",
			}),
		).toThrow(/not an assignable Sharing domain/);
	});

	it("does not guess when multiple scopes match a project signal equally", () => {
		insertScope(db, { scopeId: "exampleco-work", label: "ExampleCo Work" });
		insertScope(db, { scopeId: "exampleco-client", label: "ExampleCo Client", kind: "client" });
		const sessionId = insertSession(db, {
			cwd: "/workspace/work/exampleco/api",
			gitRemote: "https://git.example.invalid/exampleco/api.git",
			project: "api",
		});
		insertMemory(db, sessionId);

		const [project] = listProjectScopeCandidates(db);

		expect(project).toMatchObject({
			resolved_scope_id: LOCAL_DEFAULT_SCOPE_ID,
			suggested_scope_id: null,
			suggestion_reason: null,
		});
	});

	it("falls back from git remote to cwd when suggesting mappings", () => {
		insertScope(db, { scopeId: "exampleco-work", label: "ExampleCo Work" });
		const sessionId = insertSession(db, {
			cwd: "/workspace/work/exampleco/api",
			gitRemote: "https://git.example.invalid/vendor/api.git",
			project: "api",
		});
		insertMemory(db, sessionId);

		const [project] = listProjectScopeCandidates(db);

		expect(project).toMatchObject({
			resolved_scope_id: LOCAL_DEFAULT_SCOPE_ID,
			suggested_scope_id: "exampleco-work",
			suggestion_signal: "cwd",
		});
	});

	it("does not suggest org domains from generic category tokens only", () => {
		insertScope(db, { scopeId: "exampleco-client", label: "ExampleCo Client", kind: "client" });
		const sessionId = insertSession(db, {
			cwd: "/workspace/client/api",
			gitRemote: null,
			project: "api",
		});
		insertMemory(db, sessionId);

		const [project] = listProjectScopeCandidates(db);

		expect(project).toMatchObject({
			resolved_scope_id: LOCAL_DEFAULT_SCOPE_ID,
			suggested_scope_id: null,
			suggestion_reason: null,
		});
	});

	it("does not require basename collision confirmation for local-only assignments", () => {
		const workSession = insertSession(db, {
			cwd: "/workspace/work/exampleco/api",
			gitRemote: "https://git.example.invalid/exampleco/api.git",
			project: "api",
		});
		insertMemory(db, workSession);
		const ossSession = insertSession(db, {
			cwd: "/workspace/oss/api",
			gitRemote: "https://git.example.invalid/oss/api.git",
			project: "api",
		});
		insertMemory(db, ossSession, { workspaceId: "shared:oss-api" });
		const [project] = listProjectScopeCandidates(db);
		if (!project) throw new Error("project missing");

		const analysis = analyzeProjectScopeMappingChangeGuardrails(db, {
			workspace_identity: project.workspace_identity,
			project_pattern: project.display_project,
			scope_id: LOCAL_DEFAULT_SCOPE_ID,
		});

		expect(analysis.warnings).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "basename_collision_review" })]),
		);
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

	it("normalizes incoming workspace identities before matching existing mappings", () => {
		insertScope(db, { scopeId: "acme-work", label: "Acme Work" });
		insertScope(db, { scopeId: "acme-oss", label: "Acme OSS" });

		const first = upsertProjectScopeSettingsMapping(db, {
			workspace_identity: "C:\\workspace\\work\\exampleco\\api\\",
			project_pattern: "api",
			scope_id: "acme-work",
		});
		const second = upsertProjectScopeSettingsMapping(db, {
			workspace_identity: "C:/workspace/work/exampleco/api",
			project_pattern: "api",
			scope_id: "acme-oss",
		});
		const rows = db.prepare("SELECT COUNT(*) AS n FROM project_scope_mappings").get() as {
			n: number;
		};

		expect(second.id).toBe(first.id);
		expect(second).toMatchObject({
			scope_id: "acme-oss",
			workspace_identity: "C:/workspace/work/exampleco/api",
		});
		expect(rows.n).toBe(1);
	});

	it("warns before saving broad home-directory patterns to org domains", () => {
		insertScope(db, { scopeId: "acme-work", label: "Acme Work" });

		const analysis = analyzeProjectScopeMappingChangeGuardrails(db, {
			project_pattern: "/home/fixture-user/*",
			scope_id: "acme-work",
		});
		const mapping = upsertProjectScopeSettingsMapping(db, {
			project_pattern: "/home/fixture-user/*",
			scope_id: "acme-work",
		});
		const [listed] = listProjectScopeSettingsMappings(db);

		expect(analysis.warnings.map((warning) => warning.code)).toEqual([
			"broad_org_domain_pattern",
			"home_directory_org_domain_pattern",
		]);
		expect(
			analysis.warnings.every((warning) => warning.confirmation_token?.startsWith("psg_")),
		).toBe(true);
		expect(new Set(analysis.warnings.map((warning) => warning.confirmation_token)).size).toBe(2);
		expect(mapping.scope_id).toBe("acme-work");
		expect(listed?.guardrail_warnings.map((warning) => warning.code)).toEqual([
			"broad_org_domain_pattern",
			"home_directory_org_domain_pattern",
		]);
	});

	it("warns that scope reassignment may leave old copies behind", () => {
		const sessionId = insertSession(db);
		insertMemory(db, sessionId);
		insertScope(db, { scopeId: "acme-work", label: "Acme Work" });
		insertScope(db, { scopeId: "personal-devices", label: "Personal Devices" });
		const [project] = listProjectScopeCandidates(db);
		if (!project) throw new Error("project missing");
		const existing = upsertProjectScopeSettingsMapping(db, {
			workspace_identity: project.workspace_identity,
			project_pattern: project.display_project,
			scope_id: "acme-work",
		});

		const analysis = analyzeProjectScopeMappingChangeGuardrails(db, {
			id: existing.id,
			scope_id: "personal-devices",
		});

		expect(analysis).toMatchObject({
			existing_mapping: expect.objectContaining({ id: existing.id, scope_id: "acme-work" }),
			requested_scope_id: "personal-devices",
			requested_workspace_identity: project.workspace_identity,
		});
		expect(analysis.warnings).toEqual([
			expect.objectContaining({
				code: "scope_reassignment_old_copies",
				mapping_id: existing.id,
				previous_scope_id: "acme-work",
				requires_confirmation: true,
			}),
		]);
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
				workspace_identity: "https://git.example.invalid/exampleco/api.git",
				project_pattern: "api",
				scope_id: "missing-domain",
			}),
		).toThrow(/not an active Sharing domain/);
		expect(() =>
			upsertProjectScopeSettingsMapping(db, {
				workspace_identity: "https://git.example.invalid/exampleco/api.git",
				project_pattern: "api",
				scope_id: "inactive-work",
			}),
		).toThrow(/not an active Sharing domain/);
	});

	it("excludes synthetic sync-bootstrap sessions from the project inventory", () => {
		// Real session — should appear in the inventory.
		const realSession = insertSession(db, {
			cwd: "/workspace/work/exampleco/api",
			gitRemote: "https://git.example.invalid/exampleco/api.git",
			project: "api",
		});
		insertMemory(db, realSession);

		// Synthetic placeholder session created by sync-bootstrap.ts when
		// inbound memories arrive from a peer. Must be hidden from the
		// Projects tab read model.
		const bootstrapSession = insertSession(db, {
			cwd: "__sync_bootstrap__:codemem",
			gitRemote: null,
			project: "codemem",
		});
		insertMemory(db, bootstrapSession, { workspaceId: "shared:default" });

		const bareBootstrapSession = insertSession(db, {
			cwd: "__sync_bootstrap__",
			gitRemote: null,
			project: null,
		});
		insertMemory(db, bareBootstrapSession, { workspaceId: "shared:default" });

		const inventory = listProjectScopeInventory(db);
		const cwds = inventory.projects.map((project) => project.cwd ?? "");
		expect(cwds).not.toContain("__sync_bootstrap__:codemem");
		expect(cwds).not.toContain("__sync_bootstrap__");
		// Real session is still surfaced.
		expect(
			inventory.projects.some(
				(project) => project.workspace_identity === "https://git.example.invalid/exampleco/api.git",
			),
		).toBe(true);
	});
});
