import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BoundaryReadinessObservation,
	buildBoundaryReadinessInventory,
} from "./boundary-readiness-inventory.js";
import { managedProjectScopeId } from "./managed-project-scope.js";
import { initTestSchema } from "./test-utils.js";

vi.mock("./project.js", async (original) => ({
	...(await original<typeof import("./project.js")>()),
	resolveGitRepositoryIdentity: vi.fn(() => {
		throw new Error("inventory must not inspect a checkout");
	}),
}));

const NOW = "2026-11-18T00:00:00Z";
const COORDINATOR = "http://127.0.0.1:1";
const GROUP = "group-a";
const LOCAL = "device-local";
const SOURCE = "team:group-a:default";
const SECOND = "older-client-setup";
const PROJECT = "repository:org/alpha";
const BOUNDARY = managedProjectScopeId(GROUP, PROJECT);
let db: InstanceType<typeof Database>;

function scope(
	id: string,
	options: {
		kind?: string;
		authority?: string;
		group?: string;
		coordinator?: string;
		status?: string;
	} = {},
) {
	db.prepare(
		`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id,
		 group_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		id,
		options.kind ?? "team_default",
		options.authority ?? "coordinator",
		options.coordinator ?? COORDINATOR,
		options.group ?? GROUP,
		options.status ?? "active",
		NOW,
		NOW,
	);
}

function mapping(
	identity: string | null,
	scopeId = SOURCE,
	pattern = identity ?? "*",
	priority = 0,
) {
	db.prepare(
		`INSERT INTO project_scope_mappings(workspace_identity, project_pattern, scope_id,
		 priority, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', ?, ?)`,
	).run(identity, pattern, scopeId, priority, NOW, NOW);
}

function session(
	options: { identity?: string | null; cwd?: string | null; user?: string; tool?: string } = {},
): number {
	const identity = options.identity === undefined ? PROJECT : options.identity;
	return Number(
		db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, user, tool_version, metadata_json)
		 VALUES (?, ?, 'alpha', ?, ?, ?)`,
			)
			.run(
				NOW,
				options.cwd === undefined ? "/workspaces/alpha" : options.cwd,
				options.user ?? "test-user",
				options.tool ?? "test",
				JSON.stringify({ codemem_repository_identity: identity }),
			).lastInsertRowid,
	);
}

function memory(
	sessionId: number,
	scopeId: string | null = SOURCE,
	options: {
		origin?: string | null;
		workspaceId?: string | null;
		visibility?: string;
		active?: number;
		deletedAt?: string | null;
	} = {},
) {
	db.prepare(
		`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
		 scope_id, origin_device_id, visibility, active, deleted_at, workspace_id)
		 VALUES (?, 'discovery', 'local title', 'local body', ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		sessionId,
		NOW,
		NOW,
		scopeId,
		options.origin === undefined ? LOCAL : options.origin,
		options.visibility ?? "shared",
		options.active ?? 1,
		options.deletedAt ?? null,
		options.workspaceId ?? null,
	);
}

function inventory(observations: BoundaryReadinessObservation[] = []) {
	return buildBoundaryReadinessInventory(db, {
		coordinatorId: COORDINATOR,
		groupId: GROUP,
		deviceId: LOCAL,
		observations,
	});
}

const waiting = {
	source_scope_id: SOURCE,
	boundary_scope_id: BOUNDARY,
	state: "waiting",
	own_rows_in_source: 0,
	own_rows_in_boundary: 0,
};

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	scope(SOURCE);
	scope(SECOND, { kind: "client" });
	scope(BOUNDARY, { kind: "managed_project" });
});
afterEach(() => db.close());

describe("workspace-only mapped Projects", () => {
	const workspaceId = "shared:workspace-only";
	const boundaryId = managedProjectScopeId(GROUP, workspaceId);
	const mapped = { ...waiting, source_scope_id: SECOND, boundary_scope_id: boundaryId };

	beforeEach(() => mapping(null, SECOND, "shared:*"));

	it("includes the mapped scope while the own row remains in local-default", () => {
		memory(session({ identity: null, cwd: null }), "local-default", { workspaceId });

		expect(inventory()).toEqual({ projects: [mapped], omittedProjects: 0 });
	});

	it("discovers an unstamped workspace-only Project without counting or stamping its row", () => {
		memory(session({ identity: null, cwd: null }), null, { workspaceId });

		expect(inventory()).toEqual({ projects: [mapped], omittedProjects: 0 });
		expect(db.prepare("SELECT scope_id FROM memory_items").pluck().get()).toBeNull();
	});

	it("includes the mapped scope and the older stamped scope", () => {
		memory(session({ identity: null, cwd: null }), SOURCE, { workspaceId });

		const result = inventory();

		expect(result.projects).toEqual(
			expect.arrayContaining([
				mapped,
				{ ...waiting, boundary_scope_id: boundaryId, own_rows_in_source: 1 },
			]),
		);
		expect(result.projects).toHaveLength(2);
		expect(result.omittedProjects).toBe(0);
	});

	it.each([
		{ name: "peer-authored", options: { origin: "peer-other" } },
		{ name: "inactive", options: { active: 0 } },
		{ name: "deleted", options: { deletedAt: NOW } },
	])("does not discover a Project from $name workspace evidence", ({ options }) => {
		memory(session({ identity: null, cwd: null }), "local-default", { workspaceId, ...options });

		expect(inventory().projects).toEqual([]);
	});

	it("does not discover a Project from a received session's workspace", () => {
		const received = session({ identity: null, cwd: null, tool: "sync_replication" });
		memory(received, "local-default", { workspaceId });

		expect(inventory().projects).toEqual([]);
	});

	it("keeps repository identity ahead of the memory's workspace fallback", () => {
		mapping(PROJECT);
		memory(session(), SOURCE, { workspaceId });

		expect(inventory().projects).toEqual([{ ...waiting, own_rows_in_source: 1 }]);
	});
});

describe("Projects mapped to older setups", () => {
	it("lists an exact mapping even when the device has no memories or sessions", () => {
		mapping(PROJECT);

		expect(inventory()).toEqual({ projects: [waiting], omittedProjects: 0 });
	});

	it("resolves pattern mappings against locally recorded Projects", () => {
		session();
		mapping(null, SOURCE, "/workspaces/*");

		expect(inventory().projects).toEqual([waiting]);
	});

	it("uses the winning mapping rather than every lower-priority match", () => {
		session();
		mapping(null, SOURCE, "/workspaces/*");
		mapping(PROJECT, SECOND, PROJECT, 100);

		expect(inventory().projects).toEqual([{ ...waiting, source_scope_id: SECOND }]);
	});

	it("does not invent Projects from a pattern with no matching local Project", () => {
		mapping(null, SOURCE, "/workspaces/*");

		expect(inventory().projects).toEqual([]);
	});

	it("deduplicates linked worktrees using their recorded repository identity", () => {
		const first = session({ cwd: "/worktrees/first" });
		const second = session({ cwd: "/worktrees/second" });
		mapping("/worktrees/first");
		memory(first);
		memory(second);

		expect(inventory().projects).toEqual([{ ...waiting, own_rows_in_source: 2 }]);
	});

	it("uses a recorded checkout mapping without probing its filesystem", () => {
		const id = session({ identity: null });
		mapping("/workspaces/alpha");
		memory(id);

		expect(inventory().projects).toEqual([
			{
				...waiting,
				boundary_scope_id: managedProjectScopeId(GROUP, "/workspaces/alpha"),
				own_rows_in_source: 1,
			},
		]);
	});

	it("does not truncate the Project list at a Viewer inventory page limit", () => {
		for (let index = 0; index < 300; index++) mapping(`repository:org/project-${index}`);

		expect(inventory().projects).toHaveLength(300);
		expect(inventory().omittedProjects).toBe(0);
	});
});

describe("the device's own rows", () => {
	it("lists a Project held in a source scope even without a current mapping", () => {
		memory(session());

		expect(inventory().projects).toEqual([{ ...waiting, own_rows_in_source: 1 }]);
	});

	it("counts private rows too because they move without becoming shared", () => {
		const id = session();
		memory(id, SOURCE);
		memory(id, SOURCE, { visibility: "private" });
		memory(id, BOUNDARY, { visibility: "private" });

		expect(inventory().projects).toEqual([
			{ ...waiting, own_rows_in_source: 2, own_rows_in_boundary: 1 },
		]);
	});

	it("recognizes old local-origin forms and excludes peer-authored rows", () => {
		const id = session();
		for (const origin of [LOCAL, null, "", "local", "peer-other"]) memory(id, SOURCE, { origin });

		expect(inventory().projects).toEqual([{ ...waiting, own_rows_in_source: 4 }]);
	});

	it("ignores received sessions even when a payload claims a local origin", () => {
		for (const options of [
			{ user: "sync" },
			{ tool: "sync_replication" },
			{ cwd: "__sync_bootstrap__peer" },
		])
			memory(session(options), SOURCE, { origin: LOCAL });

		expect(inventory().projects).toEqual([]);
	});

	it("excludes tombstones and inactive rows from the counters", () => {
		const id = session();
		mapping(PROJECT);
		memory(id, SOURCE, { active: 0 });
		memory(id, SOURCE, { deletedAt: NOW });

		expect(inventory().projects).toEqual([waiting]);
	});

	it("reports both older scopes when the same Project has own rows in both", () => {
		const id = session();
		memory(id, SOURCE);
		memory(id, SECOND);

		expect(inventory().projects).toEqual(
			expect.arrayContaining([
				{ ...waiting, own_rows_in_source: 1 },
				{ ...waiting, source_scope_id: SECOND, own_rows_in_source: 1 },
			]),
		);
		expect(inventory().projects).toHaveLength(2);
	});

	it("keeps different repository identities separate even with the same display name", () => {
		memory(session());
		memory(session({ identity: "repository:org/other", cwd: "/other/alpha" }));

		expect(inventory().projects).toEqual(
			expect.arrayContaining([
				{ ...waiting, own_rows_in_source: 1 },
				{
					...waiting,
					boundary_scope_id: managedProjectScopeId(GROUP, "repository:org/other"),
					own_rows_in_source: 1,
				},
			]),
		);
		expect(inventory().projects).toHaveLength(2);
	});

	it("refuses an unidentified source Project instead of publishing an apparently complete list", () => {
		memory(session({ identity: null, cwd: null }));

		expect(() => inventory()).toThrow("boundary_readiness_identity_unavailable");
	});

	it("refuses source rows whose checkout has conflicting recorded identities", () => {
		session({ identity: "repository:org/other" });
		session();
		memory(session({ identity: null }));

		expect(() => inventory()).toThrow("boundary_readiness_identity_unavailable");
	});
});

describe("cache authority selection", () => {
	it.each(["local", "coord-a"])("preserves non-URL cache authority %s", (coordinatorId) => {
		db.prepare("UPDATE replication_scopes SET coordinator_id = ?").run(coordinatorId);
		mapping(PROJECT);
		memory(session());

		const result = buildBoundaryReadinessInventory(db, {
			coordinatorId,
			groupId: GROUP,
			deviceId: LOCAL,
		});

		expect(result).toEqual({
			projects: [{ ...waiting, own_rows_in_source: 1 }],
			omittedProjects: 0,
		});
	});

	it("preserves an explicitly recorded URL authority without removing its trailing slash", () => {
		const coordinatorId = `${COORDINATOR}/explicit/`;
		db.prepare("UPDATE replication_scopes SET coordinator_id = ?").run(coordinatorId);
		mapping(PROJECT);
		memory(session());

		expect(
			buildBoundaryReadinessInventory(db, {
				coordinatorId,
				groupId: GROUP,
				deviceId: LOCAL,
			}).projects,
		).toEqual([{ ...waiting, own_rows_in_source: 1 }]);
	});

	it("does not treat a non-URL authority as an address for another cache entry", () => {
		db.prepare("UPDATE replication_scopes SET coordinator_id = 'http://coord-a'").run();
		mapping(PROJECT);
		memory(session());

		expect(
			buildBoundaryReadinessInventory(db, {
				coordinatorId: "coord-a",
				groupId: GROUP,
				deviceId: LOCAL,
			}).projects,
		).toEqual([]);
	});
});

describe("scope boundaries and recorded adoption", () => {
	it.each([
		{ name: "another group", options: { group: "other-group" } },
		{ name: "another coordinator", options: { coordinator: "http://127.0.0.1:2" } },
		{ name: "manual authority", options: { authority: "manual" } },
		{ name: "invite authority", options: { authority: "invite" } },
		{ name: "an existing boundary", options: { kind: "managed_project" } },
	])("does not treat $name as this group's source", ({ options }) => {
		scope("not-a-source", options);
		mapping(PROJECT, "not-a-source");
		memory(session(), "not-a-source");

		expect(inventory().projects).toEqual([]);
	});

	it("leaves personal and local-only scopes alone", () => {
		scope("personal:actor", { kind: "personal" });
		const id = session();
		for (const scopeId of ["personal:actor", "local-default", "legacy-shared-review"]) {
			memory(id, scopeId);
		}

		expect(inventory().projects).toEqual([]);
	});

	it("retains archived source evidence for the coordinator to evaluate", () => {
		db.prepare("UPDATE replication_scopes SET status = 'archived' WHERE scope_id = ?").run(SOURCE);
		memory(session());

		expect(inventory().projects).toEqual([{ ...waiting, own_rows_in_source: 1 }]);
	});

	it.each(["adopted", "rolled_back"] as const)("uses the recorded local state %s", (state) => {
		mapping(PROJECT, state === "adopted" ? BOUNDARY : SOURCE);

		const result = inventory([{ sourceScopeId: SOURCE, boundaryScopeId: BOUNDARY, state }]);

		expect(result.projects).toEqual([{ ...waiting, state }]);
	});

	it("does not infer adoption merely because rows reached the boundary", () => {
		const id = session();
		memory(id, SOURCE);
		memory(id, BOUNDARY);

		expect(inventory().projects).toEqual([
			{ ...waiting, own_rows_in_source: 1, own_rows_in_boundary: 1 },
		]);
	});

	it("refuses conflicting local adoption observations", () => {
		expect(() =>
			inventory([
				{ sourceScopeId: SOURCE, boundaryScopeId: BOUNDARY, state: "adopted" },
				{ sourceScopeId: SOURCE, boundaryScopeId: BOUNDARY, state: "rolled_back" },
			]),
		).toThrow("boundary_readiness_observation_conflict");
	});

	it("does not invent a local Project from an observation alone", () => {
		expect(
			inventory([
				{
					sourceScopeId: SOURCE,
					boundaryScopeId: BOUNDARY,
					state: "adopted",
				},
			]).projects,
		).toEqual([]);
	});
});

describe("the record built for transmission", () => {
	it("applies the store's source-scope cap and reports the left-out count", () => {
		for (let index = 0; index < 70; index++) {
			const scopeId = `source-${index}`;
			scope(scopeId);
			mapping(`repository:org/project-${index}`, scopeId);
		}

		expect(inventory().projects).toHaveLength(64);
		expect(inventory().omittedProjects).toBe(6);
	});

	it("is deterministic and contains no repository names or memory content", () => {
		mapping(PROJECT);
		memory(session());

		const first = inventory();

		expect(inventory()).toEqual(first);
		expect(JSON.stringify(first)).not.toContain(PROJECT);
		expect(JSON.stringify(first)).not.toContain("/workspaces/alpha");
		expect(JSON.stringify(first)).not.toContain("local body");
	});

	it("does not mutate mappings, memories or schema", () => {
		mapping(PROJECT);
		memory(session());
		const changes = db.prepare("SELECT total_changes()").pluck().get();
		const version = db.pragma("user_version", { simple: true });

		inventory();

		expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
		expect(db.pragma("user_version", { simple: true })).toBe(version);
	});
});
