import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	analyzeProjectScopeMappingDeletionGuardrails,
	deleteProjectScopeSettingsMapping,
	reassignProjectScopeInventoryProject,
	upsertProjectScopeSettingsMapping,
	upsertProjectScopeSettingsMappings,
} from "./project-scope-settings.js";
import { refreshScopeMembershipCache } from "./scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheTime,
	cacheWireSnapshot,
} from "./scope-membership-cache-test-fixtures.js";
import { ensureMemoryScopeId, resolveMemoryScopeId } from "./scope-stamping.js";
import { MemoryStore } from "./store.js";

vi.mock("./project.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./project.js")>()),
	resolveGitRepositoryIdentity: () => null,
}));
vi.mock("./vectors.js", () => ({ storeVectors: vi.fn(async () => {}) }));

async function mapScope(store: MemoryStore) {
	const scope = cacheScope({ kind: "managed_project" });
	const snapshot = cacheWireSnapshot(scope, [cacheMember(scope, store.deviceId)]);
	await refreshScopeMembershipCache(store.db, {
		coordinatorId: "server-a",
		groupIds: ["group-a"],
		now: new Date(cacheTime),
		fetchers: {
			listScopes: async () => ({ version: 1, items: [scope] }),
			getScopeSnapshot: async () => snapshot,
		},
	});
	store.db
		.prepare(`INSERT INTO project_scope_mappings(workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at)
		VALUES ('/fixture/project', '/fixture/project', 'scope-a', 100, 'user', ?, ?)`)
		.run(cacheTime, cacheTime);
}

function assertReadOnlyResolution(store: MemoryStore, memoryId: number, expected: string) {
	const before = store.db.serialize();
	const changes = store.db.prepare("SELECT total_changes()").pluck().get();
	expect(resolveMemoryScopeId(store.db, memoryId)).toBe(expected);
	expect(store.db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
	expect(store.db.serialize().equals(before)).toBe(true);
	expect(ensureMemoryScopeId(store.db, memoryId)).toBe(expected);
	expect(
		store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId),
	).toBe(expected);
}

let directory: string;
let store: MemoryStore;
let memoryId: number;
let sessionId: number;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-pending-authority-"));
	const dbPath = join(directory, "test.sqlite");
	store = new MemoryStore(dbPath);
	const deviceId = store.deviceId;
	store.close();
	store = new MemoryStore(dbPath, {
		runtimeSigningKey: { deviceId, publicKey: CANONICAL_PUBLIC_KEY },
	});
	sessionId = store.startSession({ cwd: "/fixture/project", project: "fixture-project" });
	memoryId = store.remember(sessionId, "discovery", "Pending", "Pending body");
});
afterEach(() => {
	store.close();
	rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function denyAuthority(failure: string) {
	if (failure === "missing proof")
		store.db.prepare("DELETE FROM scope_membership_authorization_evidence").run();
	if (failure === "revoked")
		store.db.prepare("UPDATE scope_memberships SET status = 'revoked'").run();
	if (failure === "wrong key")
		vi.spyOn(store, "scopeResolutionDeviceContext").mockReturnValue({
			expectedPublicKey: "ssh-ed25519 invalid",
		});
}

function mutate(action: string) {
	if (action === "forget") return store.forgetForUser(memoryId);
	if (action === "visibility") return store.updateMemoryVisibilityForUser(memoryId, "private");
	if (action === "project") return store.moveMemoryProjectForUser(memoryId, "renamed");
	if (action === "inventory")
		return reassignProjectScopeInventoryProject(store.db, {
			deviceId: store.deviceId,
			workspaceIdentity: "/fixture/project",
			project: "renamed",
			canWriteScope: (scopeId) => store.isScopeWritable(scopeId),
		});
	if (action === "mapping delete") {
		return store.db
			.transaction(() => {
				const id = store.db
					.prepare("SELECT id FROM project_scope_mappings LIMIT 1")
					.pluck()
					.get() as number | undefined;
				if (!id) return true;
				const warnings = analyzeProjectScopeMappingDeletionGuardrails(store.db, id, store.deviceId);
				return deleteProjectScopeSettingsMapping(store.db, id, {
					deviceId: store.deviceId,
					confirmedGuardrailTokens: warnings.flatMap((warning) =>
						warning.confirmation_token ? [warning.confirmation_token] : [],
					),
					canWriteScope: (scopeId) => store.isScopeWritable(scopeId),
				});
			})
			.immediate();
	}
	if (action === "mapping batch")
		return upsertProjectScopeSettingsMappings(
			store.db,
			[{ workspace_identity: "/fixture/project", scope_id: "local-default" }],
			{
				deviceId: store.deviceId,
				canWriteScope: (scopeId) => store.isScopeWritable(scopeId),
			},
		);
	return upsertProjectScopeSettingsMapping(store.db, {
		workspace_identity: "/fixture/project",
		scope_id: "local-default",
		deviceId: store.deviceId,
		canWriteScope: (scopeId) => store.isScopeWritable(scopeId),
	});
}

const actions = [
	"forget",
	"visibility",
	"project",
	"inventory",
	"mapping",
	"mapping batch",
	"mapping delete",
];
const deniedCases = [null, "", "  "].flatMap((scope) =>
	["missing proof", "revoked", "wrong key"].flatMap((failure) =>
		actions.map((action) => ({ scope, failure, action })),
	),
);
it.each(deniedCases)(
	"denies $action with pending '$scope' scope and $failure without writes",
	async ({ scope, failure, action }) => {
		// Arrange: owned history remains readable, but the pending assignment is managed.
		await mapScope(store);
		store.db.prepare("UPDATE memory_items SET scope_id = ? WHERE id = ?").run(scope, memoryId);
		denyAuthority(failure);
		const before = store.db.serialize();
		// Act
		const attempt = () => mutate(action);
		if (action === "forget") expect(attempt()).toBe(false);
		else expect(attempt).toThrow();
		// Assert: no scope stamp, key repair, replication operation, or project change survives.
		expect(store.db.serialize().equals(before)).toBe(true);
		const changes = store.db.prepare("SELECT total_changes()").pluck().get();
		expect(store.canMutateMemory(memoryId)).toBe(false);
		expect(store.db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
		expect(store.db.serialize().equals(before)).toBe(true);
	},
);

it.each(
	[null, ""].flatMap((scope) =>
		["managed", "local", "manual"].flatMap((mode) =>
			actions.map((action) => ({ scope, mode, action })),
		),
	),
)("allows $action for pending '$scope' $mode scope", async ({ scope, mode, action }) => {
	// Arrange
	if (mode !== "local") await mapScope(store);
	if (mode === "manual") {
		store.db
			.prepare("UPDATE replication_scopes SET authority_type = 'manual' WHERE scope_id = 'scope-a'")
			.run();
		denyAuthority("missing proof");
		denyAuthority("wrong key");
	}
	store.db.prepare("UPDATE memory_items SET scope_id = ? WHERE id = ?").run(scope, memoryId);
	// Act
	expect(store.canMutateMemory(memoryId)).toBe(true);
	const result = mutate(action);
	// Assert
	expect(result).toBeTruthy();
	if (action === "forget")
		expect(
			store.db.prepare("SELECT active FROM memory_items WHERE id = ?").pluck().get(memoryId),
		).toBe(0);
	if (action === "visibility")
		expect(
			store.db.prepare("SELECT visibility FROM memory_items WHERE id = ?").pluck().get(memoryId),
		).toBe("private");
	if (action === "project" || action === "inventory")
		expect(
			store.db.prepare("SELECT project FROM sessions WHERE id = ?").pluck().get(sessionId),
		).toBe("renamed");
});

it("does not infer a scope from an explicit local assignment or origin", async () => {
	// Arrange
	await mapScope(store);
	denyAuthority("revoked");
	store.db
		.prepare(
			"UPDATE memory_items SET scope_id = 'local-default', origin_device_id = 'untrusted-origin' WHERE id = ?",
		)
		.run(memoryId);
	// Act
	const allowed = store.canMutateMemory(memoryId);
	// Assert
	expect(allowed).toBe(true);
	expect(store.canMutateMemory(-1)).toBe(false);
});

it.each(["session", "workspace", "repository", "unmapped", "explicit"])(
	"resolves $0 scope without writes and matches the eventual stamp",
	async (identity) => {
		// Arrange: the discovery index is stale from the new session and must not be repaired.
		await mapScope(store);
		store.db.prepare("UPDATE memory_items SET scope_id = NULL WHERE id = ?").run(memoryId);
		if (identity === "workspace") {
			store.db.prepare("UPDATE sessions SET cwd = NULL WHERE id = ?").run(sessionId);
			store.db
				.prepare("UPDATE memory_items SET workspace_id = 'fixture-workspace' WHERE id = ?")
				.run(memoryId);
			store.db
				.prepare(
					"UPDATE project_scope_mappings SET workspace_identity = 'fixture-workspace', project_pattern = 'fixture-workspace'",
				)
				.run();
		}
		if (identity === "repository") {
			store.db
				.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?")
				.run(
					JSON.stringify({ codemem_repository_identity: "https://example.test/repository.git" }),
					sessionId,
				);
			store.db
				.prepare(
					"UPDATE project_scope_mappings SET workspace_identity = 'https://example.test/repository.git', project_pattern = 'https://example.test/repository.git'",
				)
				.run();
		}
		if (identity === "unmapped") store.db.prepare("DELETE FROM project_scope_mappings").run();
		if (identity === "explicit")
			store.db
				.prepare("UPDATE memory_items SET scope_id = 'local-default' WHERE id = ?")
				.run(memoryId);
		// Act + Assert: only ensureMemoryScopeId may stamp; neither resolver repairs the index.
		assertReadOnlyResolution(
			store,
			memoryId,
			["unmapped", "explicit"].includes(identity) ? "local-default" : "scope-a",
		);
	},
);

it.each(["active", "revoked", "missing proof", "wrong key"])(
	"keeps the authorized workspace-only assignment stable across visibility changes (%s)",
	async (state) => {
		// Arrange: switching to private changes workspace_id and would otherwise resolve Local.
		await mapScope(store);
		store.db.prepare("UPDATE sessions SET cwd = NULL WHERE id = ?").run(sessionId);
		store.db
			.prepare(
				"UPDATE memory_items SET scope_id = NULL, workspace_id = 'shared:fixture' WHERE id = ?",
			)
			.run(memoryId);
		store.db
			.prepare(
				"UPDATE project_scope_mappings SET workspace_identity = 'shared:fixture', project_pattern = 'shared:fixture'",
			)
			.run();
		denyAuthority(state);
		const before = store.db.serialize();
		// Act
		const attempt = () => store.updateMemoryVisibilityForUser(memoryId, "private");
		if (state !== "active") {
			expect(attempt).toThrow("memory not found");
			// Assert: denied writes do not stamp the scope or change the workspace.
			expect(store.db.serialize().equals(before)).toBe(true);
			return;
		}
		const result = attempt();
		// Assert: replication uses the same managed assignment that passed authorization.
		expect(result.scope_id).toBe("scope-a");
		expect(result.workspace_id).toBe(`personal:${store.actorId}`);
		expect(
			store.db
				.prepare("SELECT scope_id FROM replication_ops WHERE entity_id = ? AND clock_rev = ?")
				.pluck()
				.get(result.import_key, result.rev),
		).toBe("scope-a");
	},
);

it.each(["project", "inventory"])(
	"denies %s attribution when a pending sibling resolves to revoked managed scope",
	async (action) => {
		// Arrange: the requested memory is Local; only its sibling has a pending managed assignment.
		const siblingId = store.remember(sessionId, "discovery", "Sibling", "Sibling body");
		await mapScope(store);
		store.db.prepare("UPDATE memory_items SET scope_id = NULL WHERE id = ?").run(siblingId);
		denyAuthority("revoked");
		const before = store.db.serialize();
		// Act
		expect(() => mutate(action)).toThrow();
		// Assert: the Local root cannot authorize changes to its managed sibling or session.
		expect(store.db.serialize().equals(before)).toBe(true);
	},
);
