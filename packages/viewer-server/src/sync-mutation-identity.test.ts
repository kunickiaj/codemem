import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	analyzeProjectScopeMappingChangeGuardrails,
	analyzeProjectScopeMappingDeletionGuardrails,
	connect,
	ensureDeviceIdentity,
	initTestSchema,
	MemoryStore,
} from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshManagedScopeFixture } from "../../core/src/managed-scope-test-fixtures.js";
import { syncRoutes } from "./routes/sync.js";

const projectIdentity = "https://example.test/enrollment/project.git";
const scopeId = "enrollment-scope";
const mutations = ["save", "delete", "reassign"] as const;
type Mutation = (typeof mutations)[number];
let directory: string;
let keysDir: string;
let store: MemoryStore;
let deviceId: string;
let memoryId: number;
let mappingId: number;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-07T00:00:00.000Z"));
	directory = mkdtempSync(join(tmpdir(), "codemem-sync-enrollment-"));
	keysDir = join(directory, "keys");
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	vi.stubEnv("CODEMEM_DEVICE_ID", "");
	vi.stubEnv("CODEMEM_ACTOR_ID", "");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network call");
		}),
	);
	const dbPath = join(directory, "memory.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	// The viewer starts before enrollment; ensure persists identity without refreshing it.
	store = new MemoryStore(dbPath, { keysDir });
	expect(store.deviceId).toBe("local");
	[deviceId] = ensureDeviceIdentity(store.db, { keysDir });
	expect(deviceId).not.toBe("local");
	expect(store.deviceId).toBe("local");
	const sessionId = store.startSession({ cwd: "/workspace/enrollment", project: "old-project" });
	memoryId = store.remember(sessionId, "decision", "Enrolled history", "History body");
	store.endSession(sessionId);
	const now = new Date().toISOString();
	store.db
		.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type,
		coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
		VALUES (?, 'Enrollment', 'managed_project', 'coordinator',
		'test-coordinator', 'test-group', 1, 'active', ?, ?)`)
		.run(scopeId, now, now);
	store.db
		.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status,
		membership_epoch, updated_at) VALUES (?, ?, 'member', 'active', 1, ?)`)
		.run(scopeId, deviceId, now);
	// Imported history already belongs to the enrolled identity, not the fallback actor.
	store.db
		.prepare(`UPDATE memory_items SET scope_id = ?, origin_device_id = ?, actor_id = ?
		WHERE id = ?`)
		.run(scopeId, deviceId, `local:${deviceId}`, memoryId);
	store.db
		.prepare(`UPDATE sessions SET git_remote = ?, metadata_json = ? WHERE id = ?`)
		.run(
			projectIdentity,
			JSON.stringify({ codemem_repository_identity: projectIdentity }),
			sessionId,
		);
	mappingId = Number(
		store.db
			.prepare(`INSERT INTO project_scope_mappings(workspace_identity,
		project_pattern, scope_id, priority, source, created_at, updated_at)
		VALUES (?, ?, ?, 0, 'test', ?, ?)`)
			.run(projectIdentity, projectIdentity, scopeId, now, now).lastInsertRowid,
	);
});

afterEach(() => {
	store?.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});

function snapshot() {
	return Object.fromEntries(
		[
			"sessions",
			"memory_items",
			"project_scope_mappings",
			"replication_ops",
			"sync_device",
			"scope_memberships",
			"recipient_policy_authority_states",
			"share_operations",
		].map((table) => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]),
	);
}

function mutate(mutation: Mutation) {
	const app = syncRoutes(() => store);
	let path = "/api/sync/sharing-domains/project-mappings";
	let method = "PUT";
	let body: Record<string, unknown> = {
		workspace_identity: projectIdentity,
		project_pattern: projectIdentity,
		priority: 5,
		scope_id: scopeId,
	};
	if (mutation === "save") {
		body.confirmed_guardrail_tokens = analyzeProjectScopeMappingChangeGuardrails(store.db, {
			deviceId,
			workspace_identity: projectIdentity,
			project_pattern: projectIdentity,
			scope_id: scopeId,
			priority: 5,
		}).warnings.map((warning) => warning.confirmation_token);
	} else if (mutation === "delete") {
		path += `/${mappingId}`;
		method = "DELETE";
		body = {
			confirmed_guardrail_tokens: analyzeProjectScopeMappingDeletionGuardrails(
				store.db,
				mappingId,
				deviceId,
			).map((warning) => warning.confirmation_token),
		};
	} else if (mutation === "reassign") {
		path = "/api/sync/projects/reassign-project";
		method = "POST";
		body = { workspace_identity: projectIdentity, project: "corrected-project" };
	}
	return app.request(path, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

it.each(mutations)("uses ensured membership for %s after viewer startup", async (mutation) => {
	// Arrange: only the newly persisted device has proof bound to its actual signing key.
	await refreshManagedScopeFixture(store.db, { keysDir, deviceId, scopeIds: [scopeId] });
	if (mutation === "save") {
		store.db
			.prepare("UPDATE memory_items SET scope_id = 'local-default' WHERE id = ?")
			.run(memoryId);
	}
	const before = snapshot();
	// Act.
	const response = await mutate(mutation);
	// Assert: authorization and propagation use the same enrolled device.
	expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
	expect(store.deviceId).toBe(deviceId);
	expect(store.actorId).toBe(`local:${deviceId}`);
	if (mutation === "reassign") {
		expect(await response.json()).toMatchObject({ moved_memory_count: 1, moved_session_count: 1 });
		expect(store.db.prepare("SELECT project FROM memory_items WHERE id = ?").get(memoryId)).toEqual(
			{ project: "corrected-project" },
		);
	} else if (mutation === "delete") {
		expect(await response.json()).toEqual({ ok: true, deleted: true });
		expect(
			store.db.prepare("SELECT id FROM project_scope_mappings WHERE id = ?").get(mappingId),
		).toBeUndefined();
	} else {
		expect(
			store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").get(memoryId),
		).toEqual({ scope_id: scopeId });
	}
	expect(snapshot().sync_device).toEqual(before.sync_device);
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

const denied = mutations.flatMap((mutation) =>
	(["revoked", "missing", "old-local-only", "uncached"] as const).map((membership) => ({
		mutation,
		membership,
	})),
);
it.each(denied)(
	"denies $mutation with $membership enrollment membership",
	async ({ mutation, membership }) => {
		// Arrange: stale or unproven membership must never grant the ensured device access.
		if (mutation === "save") {
			store.db
				.prepare("UPDATE memory_items SET scope_id = 'local-default' WHERE id = ?")
				.run(memoryId);
		}
		if (membership === "revoked") {
			store.db
				.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE device_id = ?")
				.run(deviceId);
		} else if (membership !== "uncached") {
			store.db.prepare("DELETE FROM scope_memberships WHERE device_id = ?").run(deviceId);
		}
		if (membership === "old-local-only") {
			store.db
				.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status,
			membership_epoch, updated_at) VALUES (?, 'local', 'member', 'active', 1, ?)`)
				.run(scopeId, new Date().toISOString());
		}
		const before = snapshot();
		const keyBefore = readFileSync(join(keysDir, "device.key"));
		const publicKeyBefore = readFileSync(join(keysDir, "device.key.pub"));
		// Act.
		const response = await mutate(mutation);
		// Assert: no propagation, policy wake, operation, or identity/key repair follows denial.
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "unauthorized_scope" });
		expect(store.deviceId).toBe(deviceId);
		expect(snapshot()).toEqual(before);
		expect(readFileSync(join(keysDir, "device.key"))).toEqual(keyBefore);
		expect(readFileSync(join(keysDir, "device.key.pub"))).toEqual(publicKeyBefore);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	},
);
