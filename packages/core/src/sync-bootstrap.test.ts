import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toJson } from "./db.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { applyBootstrapSnapshot, fetchAllSnapshotPages } from "./sync-bootstrap.js";
import { SYNC_CAPABILITY_HEADER } from "./sync-capability.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import { getSyncResetState, setSyncResetState } from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import type { SyncMemorySnapshotItem, SyncResetRequired } from "./types.js";
import { VECTOR_MODEL_MIGRATION_JOB } from "./vector-migration.js";

function makeResetInfo(overrides?: Partial<SyncResetRequired>): SyncResetRequired {
	return {
		reset_required: true,
		reason: "generation_mismatch",
		generation: 2,
		snapshot_id: "snap-2",
		baseline_cursor: "2026-01-01T00:00:05Z|base-op",
		retained_floor_cursor: null,
		...overrides,
	};
}

function makeSnapshotItem(
	entityId: string,
	overrides?: Partial<SyncMemorySnapshotItem> & { payload?: Record<string, unknown> },
): SyncMemorySnapshotItem {
	const payload = overrides?.payload ?? {};
	return {
		entity_id: entityId,
		op_type: overrides?.op_type ?? "upsert",
		payload_json: JSON.stringify({
			kind: "discovery",
			title: `Title ${entityId}`,
			body_text: `Body ${entityId}`,
			visibility: "shared",
			workspace_kind: "shared",
			workspace_id: "shared:default",
			created_at: "2026-01-01T00:00:01Z",
			metadata_json: { clock_device_id: "peer-dev" },
			...payload,
		}),
		clock_rev: overrides?.clock_rev ?? 1,
		clock_updated_at: overrides?.clock_updated_at ?? "2026-01-01T00:00:02Z",
		clock_device_id: overrides?.clock_device_id ?? "peer-dev",
	};
}

describe("applyBootstrapSnapshot", () => {
	let db: InstanceType<typeof Database>;
	let sessionId: number;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		sessionId = insertTestSession(db);
		// Set initial sync state so the function can bump it
		setSyncResetState(db, {
			generation: 1,
			snapshot_id: "snap-1",
			baseline_cursor: null,
		});
	});

	afterEach(() => {
		db.close();
	});

	it("replaces shared memories with snapshot items", () => {
		// Insert existing shared memory
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, visibility, metadata_json)
			 VALUES (?, 'discovery', 'old-shared', 'old body', ?, ?, 'old-key', 1, 'shared', ?)`,
		).run(sessionId, now, now, toJson({ clock_device_id: "local" }));

		const items = [makeSnapshotItem("new-key-a"), makeSnapshotItem("new-key-b")];
		const result = applyBootstrapSnapshot(db, "peer-1", items, makeResetInfo());

		expect(result.ok).toBe(true);
		expect(result.deleted).toBe(1); // old-key deleted
		expect(result.applied).toBe(2); // new-key-a, new-key-b inserted

		// Verify old memory is gone
		const old = db.prepare("SELECT * FROM memory_items WHERE import_key = 'old-key'").get();
		expect(old).toBeUndefined();

		// Verify new memories exist
		const newA = db
			.prepare("SELECT * FROM memory_items WHERE import_key = 'new-key-a'")
			.get() as Record<string, unknown>;
		expect(newA).toBeTruthy();
		expect(newA.title).toBe("Title new-key-a");
		expect(newA.visibility).toBe("shared");
	});

	it("preserves snapshot payload scope_id on inserted memories", () => {
		const items = [makeSnapshotItem("scoped-key", { payload: { scope_id: "acme-work" } })];

		const result = applyBootstrapSnapshot(db, "peer-1", items, makeResetInfo());

		expect(result.ok).toBe(true);
		const scoped = db
			.prepare("SELECT scope_id FROM memory_items WHERE import_key = 'scoped-key'")
			.get() as Record<string, unknown>;
		expect(scoped.scope_id).toBe("acme-work");
	});

	it("preserves private memories during bootstrap", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, visibility, metadata_json)
			 VALUES (?, 'discovery', 'my-private', 'private body', ?, ?, 'private-key', 1, 'private', ?)`,
		).run(sessionId, now, now, toJson({ clock_device_id: "local" }));

		const items = [makeSnapshotItem("new-key")];
		const result = applyBootstrapSnapshot(db, "peer-1", items, makeResetInfo());

		expect(result.ok).toBe(true);
		expect(result.deleted).toBe(0); // private not deleted

		const priv = db
			.prepare("SELECT * FROM memory_items WHERE import_key = 'private-key'")
			.get() as Record<string, unknown>;
		expect(priv).toBeTruthy();
		expect(priv.title).toBe("my-private");
	});

	it("handles tombstoned snapshot items correctly", () => {
		const items = [
			makeSnapshotItem("alive-key"),
			makeSnapshotItem("dead-key", { op_type: "delete" }),
		];
		const result = applyBootstrapSnapshot(db, "peer-1", items, makeResetInfo());

		expect(result.ok).toBe(true);
		expect(result.applied).toBe(2);

		const alive = db
			.prepare("SELECT active, deleted_at FROM memory_items WHERE import_key = 'alive-key'")
			.get() as Record<string, unknown>;
		expect(alive.active).toBe(1);
		expect(alive.deleted_at).toBeNull();

		const dead = db
			.prepare("SELECT active, deleted_at FROM memory_items WHERE import_key = 'dead-key'")
			.get() as Record<string, unknown>;
		expect(dead.active).toBe(0);
		expect(dead.deleted_at).toBeTruthy();
	});

	it("bumps generation and snapshot_id to match peer", () => {
		const items = [makeSnapshotItem("key-a")];
		applyBootstrapSnapshot(db, "peer-1", items, makeResetInfo());

		const state = getSyncResetState(db);
		expect(state.generation).toBe(2);
		expect(state.snapshot_id).toBe("snap-2");
		expect(state.baseline_cursor).toBe("2026-01-01T00:00:05Z|base-op");
	});

	it("updates replication cursor to baseline_cursor", () => {
		const items = [makeSnapshotItem("key-a")];
		applyBootstrapSnapshot(db, "peer-1", items, makeResetInfo());

		const cursor = db
			.prepare("SELECT last_applied_cursor FROM replication_cursors WHERE peer_device_id = ?")
			.get("peer-1") as { last_applied_cursor: string } | undefined;
		expect(cursor?.last_applied_cursor).toBe("2026-01-01T00:00:05Z|base-op");
	});

	it("queues a persisted vector backfill job for bootstrap catch-up", () => {
		const items = [
			makeSnapshotItem("embeddable-key"),
			makeSnapshotItem("blank-key", { payload: { title: "", body_text: "" } }),
			makeSnapshotItem("deleted-key", { op_type: "delete" }),
		];

		applyBootstrapSnapshot(db, "peer-1", items, makeResetInfo());

		const job = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(job).toMatchObject({
			status: "pending",
			title: "Re-indexing memories",
			message: "Queued vector catch-up for synced bootstrap data",
			progress: { current: 0, total: 1, unit: "items" },
		});
		expect(job?.metadata).toMatchObject({
			last_cursor_id: 0,
			processed_embeddable: 0,
			embeddable_total: 1,
			trigger: "sync_bootstrap",
		});
	});

	it("redacts secrets in inbound bootstrap snapshot items", () => {
		const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		const awsId = "AKIAIOSFODNN7EXAMPLE";
		const items = [
			makeSnapshotItem("secret-key", {
				payload: {
					title: `peer title ${pat}`,
					body_text: `peer body ${awsId}`,
					narrative: `peer narrative ${pat}`,
					tags_text: pat,
					metadata_json: { clock_device_id: "peer-dev", password: "supersecretvalue123" },
				},
			}),
		];
		const result = applyBootstrapSnapshot(db, "peer-1", items, makeResetInfo());
		expect(result.ok).toBe(true);
		expect(result.applied).toBe(1);
		const mem = db
			.prepare(
				"SELECT title, body_text, narrative, tags_text, metadata_json FROM memory_items WHERE import_key = 'secret-key'",
			)
			.get() as {
			title: string;
			body_text: string;
			narrative: string | null;
			tags_text: string | null;
			metadata_json: string | null;
		};
		expect(mem.title).not.toContain(pat);
		expect(mem.title).toContain("[REDACTED:github_pat_classic]");
		expect(mem.body_text).not.toContain(awsId);
		expect(mem.body_text).toContain("[REDACTED:aws_access_key_id]");
		expect(mem.narrative).not.toContain(pat);
		expect(mem.tags_text ?? "").not.toContain(pat);
		const meta = JSON.parse(mem.metadata_json ?? "{}");
		expect(meta.password).toBe("[REDACTED:context_secret]");
	});

	it("applies empty snapshot (wipes shared, inserts nothing)", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, visibility, metadata_json)
			 VALUES (?, 'discovery', 'old-shared', 'body', ?, ?, 'old-key', 1, 'shared', ?)`,
		).run(sessionId, now, now, toJson({ clock_device_id: "local" }));

		const result = applyBootstrapSnapshot(db, "peer-1", [], makeResetInfo());

		expect(result.ok).toBe(true);
		expect(result.deleted).toBe(1);
		expect(result.applied).toBe(0);
	});
});

describe("fetchAllSnapshotPages", () => {
	it("forwards bootstrap grant id as an auth header", async () => {
		const db = new Database(":memory:");
		initTestSchema(db);
		const keysDir = mkdtempSync(join(tmpdir(), "codemem-bootstrap-keys-"));
		const [deviceId] = ensureDeviceIdentity(db, { keysDir });
		const prevFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(_input)).toContain("scope_id=acme-work");
				expect(init?.headers).toMatchObject({
					"X-Codemem-Bootstrap-Grant": "grant-1",
					[SYNC_CAPABILITY_HEADER]: "aware",
					"X-Opencode-Device": deviceId,
				});
				return new Response(
					JSON.stringify({
						generation: 2,
						snapshot_id: "snap-2",
						baseline_cursor: null,
						retained_floor_cursor: null,
						items: [],
						next_page_token: null,
						has_more: false,
					}),
					{ status: 200 },
				);
			}) as typeof fetch;

			const result = await fetchAllSnapshotPages(
				"http://peer.example.test:47337",
				makeResetInfo({ scope_id: "acme-work" }),
				deviceId,
				{ keysDir, bootstrapGrantId: "grant-1" },
			);
			expect(result.snapshot_id).toBe("snap-2");
		} finally {
			globalThis.fetch = prevFetch;
			db.close();
			rmSync(keysDir, { recursive: true, force: true });
		}
	});
});
