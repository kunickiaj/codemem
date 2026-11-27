import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	ensureDeviceIdentity,
	initTestSchema,
	MemoryStore,
	readCoordinatorSyncConfig,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";

const NOW = "2026-11-27T12:00:00.000Z";
const REFUSAL = { error: "access_change_needs_admin_device" };

let directory: string;
let store: MemoryStore;
let adminSecret: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "access-decision-recheck-"));
	const keysDir = join(directory, "keys");
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	const dbPath = join(directory, "mem.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	ensureDeviceIdentity(db, { keysDir });
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
});

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

/** Everything these routes can change. */
function accessState() {
	return {
		recipients: store.db.prepare("SELECT * FROM project_recipients").all(),
		resolutions: store.db.prepare("SELECT * FROM recipient_policy_review_resolutions").all(),
		mappings: store.db.prepare("SELECT * FROM project_scope_mappings ORDER BY id").all(),
		memories: store.db.prepare("SELECT id, scope_id FROM memory_items ORDER BY id").all(),
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
