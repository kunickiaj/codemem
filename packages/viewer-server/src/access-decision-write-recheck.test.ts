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
	// The body is read at once; only the Team queue stands between the gate and the write.
	const pending = app.request("/api/sync/recipient-policy/v1/edges/commit", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(EDGE_TO_TEAM),
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	adminSecret = "";
	release();
	await queue;

	const response = await pending;

	expect(response.status).toBe(403);
	expect(await response.json()).toEqual(REFUSAL);
	expect(accessState()).toEqual(before);
});

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
		["one mapping", "/api/sync/sharing-domains/project-mappings", false],
		["several mappings", "/api/sync/sharing-domains/project-mappings/bulk", true],
	])(
		"refuses a widening save of %s without creating this device's identity",
		async (_label, path, bulk) => {
			const id = insertLocalMapping("git:x");
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
			expect(accessState()).toEqual(before);
		},
	);

	it("refuses removing a mapping without creating this device's identity", async () => {
		const id = insertLocalMapping("git:x");
		const before = accessState();

		const response = await sendWhileSecretIsRemoved(
			"DELETE",
			`/api/sync/sharing-domains/project-mappings/${id}`,
			{},
		);

		expect(response.status).toBe(403);
		expect(accessState()).toEqual(before);
	});

	it("previews a bulk mapping save without creating this device's identity", async () => {
		const before = accessState();

		const response = await app.request("/api/sync/sharing-domains/project-mappings/bulk/check", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mappings: [
					{ workspace_identity: "git:new", project_pattern: "git:new", scope_id: "local-default" },
				],
			}),
		});

		expect(response.status).toBe(200);
		expect(accessState()).toEqual(before);
	});
});
