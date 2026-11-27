import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	ensureDeviceIdentity,
	initTestSchema,
	MemoryStore,
	readCoordinatorSyncConfig,
	serializeRecipientPolicyTeamMutation,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";

const teamQueue = vi.hoisted(() => ({ joined: (_teamId: string) => {} }));

// Passes through, and reports each request that joins a Team queue.
vi.mock("@codemem/core", async (importOriginal) => {
	const core = await importOriginal<typeof import("@codemem/core")>();
	return {
		...core,
		serializeRecipientPolicyTeamMutation: <T>(
			db: Parameters<typeof core.serializeRecipientPolicyTeamMutation>[0],
			teamId: string,
			operation: () => Promise<T>,
		) => {
			const queued = core.serializeRecipientPolicyTeamMutation(db, teamId, operation);
			teamQueue.joined(teamId);
			return queued;
		},
	};
});

const NOW = "2026-11-27T12:00:00.000Z";
const REFUSAL = { error: "access_change_needs_admin_device" };

let directory: string;
let keysDir: string;
let store: MemoryStore;
let adminSecret: string;
let app: ReturnType<typeof createApp>;

/**
 * Opens a store for this test. Without a device identity the store runs as the
 * placeholder device, and its next identity write would create keys, a device row
 * and adopt captures, so a refusal must not reach one.
 */
function openStore(options: { withDeviceIdentity: boolean }) {
	directory = mkdtempSync(join(tmpdir(), "access-decision-recheck-"));
	keysDir = join(directory, "keys");
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_DEVICE_ID", undefined);
	const dbPath = join(directory, "mem.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	if (options.withDeviceIdentity) ensureDeviceIdentity(db, { keysDir });
	db.close();
	store = new MemoryStore(dbPath);
	adminSecret = "fixture-admin-secret";
	// The config reader the gate and the writes share; a request body removes the secret.
	app = createApp({
		storeFactory: () => store,
		readCoordinatorConfig: () =>
			readCoordinatorSyncConfig({
				sync_coordinator_url: "https://coord.example.test",
				sync_coordinator_groups: ["group-admin"],
				sync_coordinator_admin_secret: adminSecret,
			}),
	});
}

beforeEach(() => openStore({ withDeviceIdentity: true }));

afterEach(() => {
	store.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

/**
 * Sends a request the gate admits, and removes the admin secret only when the
 * route reads the body, so the write is the only place left to notice.
 */
function sendWhileSecretIsRemoved(method: string, path: string, body: unknown) {
	const encoded = new TextEncoder().encode(JSON.stringify(body));
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			adminSecret = "";
			controller.enqueue(encoded);
			controller.close();
		},
	});
	return app.request(path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: stream,
		duplex: "half",
	} as RequestInit);
}

/** Everything these routes can change, including this device's own identity. */
function accessState() {
	return {
		recipients: store.db.prepare("SELECT * FROM project_recipients").all(),
		resolutions: store.db.prepare("SELECT * FROM recipient_policy_review_resolutions").all(),
		mappings: store.db.prepare("SELECT * FROM project_scope_mappings ORDER BY id").all(),
		memories: store.db
			.prepare("SELECT id, scope_id, origin_device_id, actor_id FROM memory_items ORDER BY id")
			.all(),
		actors: store.db.prepare("SELECT * FROM actors ORDER BY actor_id").all(),
		devices: store.db.prepare("SELECT * FROM sync_device").all(),
		keys: existsSync(keysDir) ? readdirSync(keysDir).sort() : [],
	};
}

function insertLocalMapping(identity: string): number {
	return Number(
		store.db
			.prepare(`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 'local-default', 10, 'user', ?, ?)`)
			.run(identity, identity, NOW, NOW).lastInsertRowid,
	);
}

// Moving held-back memories is covered with its scope fixtures in managed-user-mutations.test.ts.
describe("access decisions when the admin secret goes while the body arrives", () => {
	it.each([
		[
			"a recipient edge commit",
			"/api/sync/recipient-policy/v1/edges/commit",
			{
				version: 1,
				changes: [
					{
						canonicalProjectIdentity: "project",
						recipient: { recipientKind: "identity", identityId: "identity" },
						action: "add",
					},
				],
				reviewedPolicyDigest: `edge-preview-v1:${"0".repeat(64)}`,
			},
		],
		[
			"a review decision",
			"/api/sync/recipient-policy/v1/review/resolve",
			{ reviewItemId: "review", sourceFingerprint: "fingerprint", decision: "keep_project_local" },
		],
		[
			"several review decisions",
			"/api/sync/recipient-policy/v1/review/resolve-bulk",
			{
				requests: [
					{
						reviewItemId: "review",
						sourceFingerprint: "fingerprint",
						decision: "keep_project_local",
					},
				],
			},
		],
	])("refuses %s and changes nothing", async (_label, path, body) => {
		const before = accessState();

		const response = await sendWhileSecretIsRemoved("POST", path, body);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual(REFUSAL);
		expect(accessState()).toEqual(before);
	});

	it.each([
		["one mapping", "/api/sync/sharing-domains/project-mappings", false],
		["several mappings", "/api/sync/sharing-domains/project-mappings/bulk", true],
	])("refuses a save of %s that no longer only narrows access", async (_label, path, bulk) => {
		const id = insertLocalMapping("git:x");
		// Re-pointing a local mapping's pattern can expose another Project.
		const mapping = {
			id,
			workspace_identity: "git:x",
			project_pattern: "git:other",
			scope_id: "local-default",
			priority: 10,
		};
		const before = accessState();

		const response = await sendWhileSecretIsRemoved(
			"PUT",
			path,
			bulk ? { mappings: [mapping] } : mapping,
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual(REFUSAL);
		expect(accessState()).toEqual(before);
	});

	it("still saves a mapping that only narrows access", async () => {
		const response = await sendWhileSecretIsRemoved(
			"PUT",
			"/api/sync/sharing-domains/project-mappings",
			{ workspace_identity: "git:new", project_pattern: "git:new", scope_id: "local-default" },
		);

		expect(response.status).toBe(200);
	});

	it("refuses removing a mapping and keeps it", async () => {
		const id = insertLocalMapping("git:x");
		const before = accessState();

		const response = await sendWhileSecretIsRemoved(
			"DELETE",
			`/api/sync/sharing-domains/project-mappings/${id}`,
			{},
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual(REFUSAL);
		expect(accessState()).toEqual(before);
	});
});

const EDGE_TO_TEAM = {
	version: 1,
	changes: [
		{
			canonicalProjectIdentity: "project",
			recipient: { recipientKind: "team", teamId: "team-a" },
			action: "add",
		},
	],
	reviewedPolicyDigest: `edge-preview-v1:${"0".repeat(64)}`,
};

it("refuses an edge commit for a Team when the admin secret goes while it waits on the Team queue", async () => {
	const before = accessState();
	let release = () => {};
	let entered = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const queue = serializeRecipientPolicyTeamMutation(store.db, "team-a", async () => {
		entered();
		await held;
	});
	await started;
	const requestQueued = new Promise<void>((resolve) => {
		teamQueue.joined = (teamId) => {
			if (teamId === "team-a") resolve();
		};
	});
	// The body is read at once; only the Team queue stands between the gate and the write.
	const pending = app.request("/api/sync/recipient-policy/v1/edges/commit", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(EDGE_TO_TEAM),
	});
	await requestQueued;
	teamQueue.joined = () => {};
	adminSecret = "";
	release();
	await queue;

	const response = await pending;

	expect(response.status).toBe(403);
	expect(await response.json()).toEqual(REFUSAL);
	expect(accessState()).toEqual(before);
});

let mappingId: number;
let before: ReturnType<typeof accessState>;

/** A widening save, removal or preview of the mapping `mappingId`. */
function mappingRequest(method: string, path: string) {
	const repoint = {
		id: mappingId,
		workspace_identity: "git:x",
		project_pattern: "git:other",
		scope_id: "local-default",
		priority: 10,
	};
	if (method === "DELETE") return app.request(path.replace("ID", String(mappingId)), { method });
	const body =
		path.endsWith("/bulk") || path.endsWith("/check") ? { mappings: [repoint] } : repoint;
	return app.request(path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("on a store whose device identity and local person do not exist yet", () => {
	beforeEach(() => {
		store.close();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
		openStore({ withDeviceIdentity: false });
		store.db.prepare("DELETE FROM actors").run();
		// A memory captured before this device had an identity, which adoption would restamp.
		const session = Number(
			store.db
				.prepare(
					"INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, '/tmp/p', 'p', 'u', 't')",
				)
				.run(NOW).lastInsertRowid,
		);
		store.db
			.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
			 scope_id, visibility, active, origin_device_id, actor_id)
			 VALUES (?, 'discovery', 'Pending', 'Pending', ?, ?, 'local-default', 'shared', 1, 'local', 'local:local')`)
			.run(session, NOW, NOW);
		expect(store.deviceId).toBe("local");
		mappingId = insertLocalMapping("git:x");
		before = accessState();
	});

	it.each([
		[
			"a review decision",
			"/api/sync/recipient-policy/v1/review/resolve",
			{ reviewItemId: "review", sourceFingerprint: "fingerprint", decision: "keep_project_local" },
		],
		[
			"several review decisions",
			"/api/sync/recipient-policy/v1/review/resolve-bulk",
			{
				requests: [
					{
						reviewItemId: "review",
						sourceFingerprint: "fingerprint",
						decision: "keep_project_local",
					},
				],
			},
		],
	])("refuses %s without creating the local person", async (_label, path, body) => {
		const before = accessState();

		const response = await sendWhileSecretIsRemoved("POST", path, body);

		expect(response.status).toBe(403);
		expect(accessState()).toEqual(before);
	});

	it.each([
		["a save", "PUT", "/api/sync/sharing-domains/project-mappings"],
		["a bulk save", "PUT", "/api/sync/sharing-domains/project-mappings/bulk"],
		["a removal", "DELETE", "/api/sync/sharing-domains/project-mappings/ID"],
		["a bulk preview", "POST", "/api/sync/sharing-domains/project-mappings/bulk/check"],
	])("refuses %s with the next step and creates no identity", async (_label, method, path) => {
		const response = await mappingRequest(method, path);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "device_identity_missing",
			message:
				"This device's sync identity isn't set up yet. Nothing changed. Open Devices once to finish setting it up, then try again.",
		});
		expect(accessState()).toEqual(before);
	});

	it.each([
		["a save", "PUT", "/api/sync/sharing-domains/project-mappings"],
		["a removal", "DELETE", "/api/sync/sharing-domains/project-mappings/ID"],
	])(
		"writes nothing when authority goes between the checks of %s",
		async (_label, method, path) => {
			// The write's own check is the first to see the secret gone.
			app = createApp({
				storeFactory: () => store,
				readCoordinatorConfig: () =>
					readCoordinatorSyncConfig({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_groups: ["group-admin"],
						sync_coordinator_admin_secret: store.db.inTransaction ? "" : "fixture-admin-secret",
					}),
			});

			const response = await mappingRequest(method, path);

			expect(response.status).not.toBe(200);
			expect(accessState()).toEqual(before);
		},
	);
});

describe("on a store with more than one device identity", () => {
	beforeEach(() => {
		// A second row: a writer that picked one of them could write for another device.
		store.db
			.prepare(`INSERT INTO sync_device(device_id, public_key, fingerprint, created_at)
			 VALUES ('other-device', 'ssh-ed25519 other', ?, ?)`)
			.run("f".repeat(64), NOW);
		mappingId = insertLocalMapping("git:x");
		before = accessState();
	});

	it.each([
		["a save", "PUT", "/api/sync/sharing-domains/project-mappings"],
		["a removal", "DELETE", "/api/sync/sharing-domains/project-mappings/ID"],
	])("refuses %s and writes nothing", async (_label, method, path) => {
		const response = await mappingRequest(method, path);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: "device_identity_ambiguous" });
		expect(accessState()).toEqual(before);
	});

	it("refuses a save confirmed for the device it analyzed when another would be written for", async () => {
		// Nothing needs confirming for the analyzed device, so only the write's device decides.
		const response = await app.request("/api/sync/sharing-domains/project-mappings", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				workspace_identity: "git:new",
				project_pattern: "git:new",
				scope_id: "local-default",
			}),
		});

		expect(response.status).toBe(409);
		expect(accessState()).toEqual(before);
	});
});

it("refuses a save whose guardrails change between the review and the write", async () => {
	const id = insertLocalMapping("git:x");
	const before = accessState();
	let moved = false;
	// Inside the write, the mapping moves to another scope, so keeping it now needs confirming.
	app = createApp({
		storeFactory: () => store,
		readCoordinatorConfig: () => {
			if (store.db.inTransaction && !moved) {
				moved = true;
				store.db
					.prepare("UPDATE project_scope_mappings SET scope_id = 'other-scope' WHERE id = ?")
					.run(id);
			}
			return readCoordinatorSyncConfig({
				sync_coordinator_url: "https://coord.example.test",
				sync_coordinator_groups: ["group-admin"],
				sync_coordinator_admin_secret: "fixture-admin-secret",
			});
		},
	});

	const response = await app.request("/api/sync/sharing-domains/project-mappings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			id,
			workspace_identity: "git:x",
			project_pattern: "git:x",
			scope_id: "local-default",
			priority: 10,
		}),
	});

	expect(moved).toBe(true);
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ error: "guardrail_confirmation_required" });
	expect(accessState()).toEqual(before);
});

describe("on a store opened as a different device than its one identity", () => {
	beforeEach(() => {
		const dbPath = store.dbPath;
		store.close();
		// The store runs as another device than the identity row it holds.
		vi.stubEnv("CODEMEM_DEVICE_ID", "configured-elsewhere");
		store = new MemoryStore(dbPath);
		expect(store.deviceId).toBe("configured-elsewhere");
		mappingId = insertLocalMapping("git:x");
		before = accessState();
	});

	it.each([
		["a save", "PUT", "/api/sync/sharing-domains/project-mappings"],
		["a removal", "DELETE", "/api/sync/sharing-domains/project-mappings/ID"],
	])("refuses %s and writes nothing", async (_label, method, path) => {
		const response = await mappingRequest(method, path);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: "device_identity_ambiguous" });
		expect(accessState()).toEqual(before);
	});
});

describe("on a store that has not adopted the identity it now holds", () => {
	beforeEach(() => {
		store.close();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
		openStore({ withDeviceIdentity: false });
		// Another path created the identity after this store opened; adopting it moves captures.
		const session = Number(
			store.db
				.prepare(
					"INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, '/tmp/p', 'p', 'u', 't')",
				)
				.run(NOW).lastInsertRowid,
		);
		store.db
			.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
			 scope_id, visibility, active, origin_device_id, actor_id)
			 VALUES (?, 'discovery', 'Pending', 'Pending', ?, ?, 'local-default', 'shared', 1, 'local', 'local:local')`)
			.run(session, NOW, NOW);
		ensureDeviceIdentity(store.db, { keysDir });
		expect(store.deviceId).toBe("local");
		mappingId = insertLocalMapping("git:x");
		before = accessState();
	});

	it.each([
		["a save", "PUT", "/api/sync/sharing-domains/project-mappings"],
		["a removal", "DELETE", "/api/sync/sharing-domains/project-mappings/ID"],
		["a bulk preview", "POST", "/api/sync/sharing-domains/project-mappings/bulk/check"],
	])("refuses %s without adopting it", async (_label, method, path) => {
		const response = await mappingRequest(method, path);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: "device_identity_missing" });
		expect(store.deviceId).toBe("local");
		expect(accessState()).toEqual(before);
	});
});
