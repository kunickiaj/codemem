import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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
import { storeVectors } from "./vectors.js";

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
	vi.mocked(storeVectors).mockImplementation(async () => {});
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
	["revoked"].flatMap((failure) => actions.map((action) => ({ scope, failure, action }))),
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

it.each(["active", "revoked"])(
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

it.each(["revocation", "mapping"])("locks user creation against competing %s", async (change) => {
	// Arrange: preflight succeeds, then another connection changes the authority before persistence.
	await mapScope(store);
	store.assertSessionScopeWritable(sessionId);
	const competing = new Database(join(directory, "test.sqlite"));
	competing.pragma("busy_timeout = 0");
	const update =
		change === "revocation"
			? "UPDATE scope_memberships SET status = 'revoked'"
			: "UPDATE project_scope_mappings SET scope_id = 'local-default'";
	const check = store.assertSessionScopeWritable.bind(store);
	let competingError: unknown;
	vi.spyOn(store, "assertSessionScopeWritable").mockImplementation((id, metadata) => {
		check(id, metadata);
		try {
			competing.prepare(update).run();
		} catch (error) {
			competingError = error;
		}
	});
	try {
		// Act: try to change authority in the old check-to-remember gap.
		const createdId = store.rememberForUser(sessionId, "discovery", "Locked creation", "New body");
		// Assert: the second SQLite writer cannot change the authorized assignment.
		expect(competingError).toMatchObject({ code: "SQLITE_BUSY" });
		expect(
			competing.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(createdId),
		).toBe("scope-a");
		competing.prepare(update).run();
		if (change === "mapping") {
			competing.prepare("UPDATE scope_memberships SET status = 'revoked'").run();
			check(sessionId);
			competing.prepare("UPDATE project_scope_mappings SET scope_id = 'scope-a'").run();
		}
		const remember = vi.spyOn(store, "remember");
		const before = store.db.serialize();
		// Act: a committed competing change invalidates the earlier preflight, even for a duplicate.
		expect(() =>
			store.rememberForUser(sessionId, "discovery", "Locked creation", "New body"),
		).toThrow("unauthorized_scope");
		// Assert: denial happens before deduplication or insertion.
		expect(remember).not.toHaveBeenCalled();
		expect(store.db.serialize().equals(before)).toBe(true);
	} finally {
		competing.close();
	}
});

it.each([false, true])(
	"queues user vectors only after a successful commit (rollback=%s)",
	async (rollback) => {
		// Arrange: vectors are mocked; a second connection verifies committed visibility at enqueue time.
		await store.flushPendingVectorWrites();
		vi.mocked(storeVectors).mockClear();
		const competing = new Database(join(directory, "test.sqlite"));
		const visibleIds: unknown[] = [];
		vi.mocked(storeVectors).mockImplementation(async (_db, id) => {
			visibleIds.push(
				competing.prepare("SELECT id FROM memory_items WHERE id = ?").pluck().get(id),
			);
		});
		const remember = store.remember.bind(store);
		if (rollback)
			vi.spyOn(store, "remember").mockImplementationOnce((...args) => {
				remember(...args);
				throw new Error("rollback creation");
			});
		try {
			// Act
			const create = () =>
				store.rememberForUser(sessionId, "discovery", "Vector creation", "Vector body");
			if (rollback) expect(create).toThrow("rollback creation");
			else {
				const id = create();
				// Assert: new creation enqueues once, deduplication does not enqueue again.
				expect(visibleIds).toEqual([id]);
				expect(create()).toBe(id);
			}
			await store.flushPendingVectorWrites();
			// Assert: rolled-back rows never reach external vector work.
			expect(storeVectors).toHaveBeenCalledTimes(rollback ? 0 : 1);
			expect(
				competing
					.prepare("SELECT COUNT(*) FROM memory_items WHERE title = 'Vector creation'")
					.pluck()
					.get(),
			).toBe(rollback ? 0 : 1);
		} finally {
			competing.close();
		}
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

it.each(["active", "revoked"])(
	"checks session authority before user creation (%s)",
	async (state) => {
		// Arrange: creation and admission use the staged membership-only authority contract.
		await mapScope(store);
		denyAuthority(state);
		const remember = vi.spyOn(store, "remember");
		const countBefore = store.db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get();
		const admit = () => store.assertSessionScopeWritable(sessionId);
		const create = () =>
			store.rememberForUser(sessionId, "discovery", "Authorized creation", "New body");
		// Act + Assert: a rejected admission must never reach deduplication or insertion.
		if (state === "revoked") {
			expect(admit).toThrow("unauthorized_scope");
			expect(create).toThrow("unauthorized_scope");
			expect(remember).not.toHaveBeenCalled();
			expect(store.db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(countBefore);
			return;
		}
		expect(admit).not.toThrow();
		const createdId = create();
		expect(remember).toHaveBeenCalledOnce();
		expect(createdId).toBeGreaterThan(memoryId);
		expect(
			store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(createdId),
		).toBe("scope-a");
	},
);

it.each(["self", "foreign peer", "claimed peer", "same-actor peer", "unclaimed peer"])(
	"requires ownership as well as shared scope authority to forget (%s)",
	async (owner) => {
		// Arrange: readable shared history is not necessarily owned by this actor.
		await mapScope(store);
		if (owner !== "self") {
			const claimed = owner === "claimed peer";
			store.db
				.prepare(
					"INSERT INTO sync_peers(peer_device_id, actor_id, claimed_local_actor, created_at) VALUES (?, ?, ?, ?)",
				)
				.run(
					"fixture-peer",
					owner === "same-actor peer" ? store.actorId : "foreign-actor",
					claimed ? 1 : 0,
					cacheTime,
				);
			store.db
				.prepare(
					"UPDATE memory_items SET actor_id = ?, origin_device_id = 'fixture-peer', visibility = 'shared', scope_id = 'scope-a' WHERE id = ?",
				)
				.run(owner === "foreign peer" ? "foreign-actor" : "legacy-sync:fixture-peer", memoryId);
		} else
			store.db.prepare("UPDATE memory_items SET scope_id = 'scope-a' WHERE id = ?").run(memoryId);
		const before = store.db.serialize();
		const changes = store.db.prepare("SELECT total_changes()").pluck().get();
		const memory = store.get(memoryId);
		expect(store.getForMutation(memoryId)).not.toBeNull();
		const allowed = ["self", "claimed peer", "same-actor peer"].includes(owner);
		// Act
		const forgotten = store.forgetForUser(memoryId);
		// Assert: denying ownership must not create a tombstone or replication operation.
		expect(memory).not.toBeNull();
		expect(store.isScopeWritable("scope-a")).toBe(true);
		expect(forgotten).toBe(allowed);
		if (allowed) {
			expect(
				store.db.prepare("SELECT active FROM memory_items WHERE id = ?").pluck().get(memoryId),
			).toBe(0);
			expect(store.db.serialize().equals(before)).toBe(false);
		} else {
			expect(store.db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
			expect(store.db.serialize().equals(before)).toBe(true);
			expect(store.get(memoryId)).toEqual(memory);
		}
	},
);

it.each(["active", "revoked"])(
	"checks stale repository evidence without repairing admission (%s)",
	async (state) => {
		// Arrange: repository metadata changes after the discovery index was stamped.
		await mapScope(store);
		store.db
			.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?")
			.run(
				JSON.stringify({ codemem_repository_identity: "https://example.test/admission.git" }),
				sessionId,
			);
		store.db
			.prepare(
				"UPDATE project_scope_mappings SET workspace_identity = 'https://example.test/admission.git', project_pattern = 'https://example.test/admission.git'",
			)
			.run();
		denyAuthority(state);
		const evidence = store.db.prepare("SELECT * FROM repository_discovery_state").all();
		expect(evidence).toEqual([
			expect.objectContaining({
				source_revision: expect.any(Number),
				indexed_revision: expect.any(Number),
			}),
		]);
		const revisions = evidence[0] as { source_revision: number; indexed_revision: number };
		expect(revisions.source_revision).not.toBe(revisions.indexed_revision);
		const before = store.db.serialize();
		const changes = store.db.prepare("SELECT total_changes()").pluck().get();
		// Act: direct admission runs outside a transaction and cannot depend on rollback.
		const attempt = () => store.assertSessionScopeWritable(sessionId);
		if (state === "active") expect(attempt).not.toThrow();
		else expect(attempt).toThrow("unauthorized_scope");
		// Assert: neither successful nor denied admission repairs discovery evidence.
		expect(store.db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
		expect(store.db.serialize().equals(before)).toBe(true);
		expect(store.db.prepare("SELECT * FROM repository_discovery_state").all()).toEqual(evidence);
		if (state === "active") {
			const remember = store.remember.bind(store);
			vi.spyOn(store, "remember").mockImplementationOnce((...args) => {
				expect(store.db.inTransaction).toBe(true);
				return remember(...args);
			});
			const id = store.rememberForUser(
				sessionId,
				"discovery",
				"Repository admission",
				"Committed repository body",
			);
			expect(store.get(id)?.scope_id).toBe("scope-a");
			const refreshed = store.db.prepare("SELECT * FROM repository_discovery_state").get() as {
				source_revision: number;
				indexed_revision: number;
			};
			expect(refreshed.indexed_revision).toBe(refreshed.source_revision);
		} else
			expect(() =>
				store.rememberForUser(sessionId, "discovery", "Repository admission", "Denied body"),
			).toThrow("unauthorized_scope");
	},
);

it("holds the write lock while checking forget ownership and rechecks changed ownership", async () => {
	// Arrange: another connection tries to replace ownership during authorization.
	await mapScope(store);
	store.db.prepare("UPDATE memory_items SET scope_id = 'scope-a' WHERE id = ?").run(memoryId);
	const competing = new Database(join(directory, "test.sqlite"));
	competing.pragma("busy_timeout = 0");
	const check = store.memoryOwnedBySelf.bind(store);
	let competingError: unknown;
	vi.spyOn(store, "memoryOwnedBySelf").mockImplementationOnce((memory) => {
		try {
			competing
				.prepare(
					"UPDATE memory_items SET actor_id = 'foreign-actor', origin_device_id = 'foreign-peer' WHERE id = ?",
				)
				.run(memoryId);
		} catch (error) {
			competingError = error;
		}
		return check(memory);
	});
	try {
		// Act
		const forgotten = store.forgetForUser(memoryId);
		// Assert: the ownership check and delete share an immediate write transaction.
		expect(forgotten).toBe(true);
		expect(competingError).toMatchObject({ code: "SQLITE_BUSY" });
		const otherId = store.remember(
			sessionId,
			"discovery",
			"Ownership changed",
			"Readable shared body",
		);
		competing
			.prepare(
				"UPDATE memory_items SET actor_id = 'foreign-actor', origin_device_id = 'foreign-peer', visibility = 'shared' WHERE id = ?",
			)
			.run(otherId);
		const before = store.db.serialize();
		// Act: a completed competing change must affect the next ownership check.
		const denied = store.forgetForUser(otherId);
		// Assert
		expect(denied).toBe(false);
		expect(store.db.serialize().equals(before)).toBe(true);
	} finally {
		competing.close();
	}
});
