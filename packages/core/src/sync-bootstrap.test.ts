import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toJson } from "./db.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import {
	applyBootstrapSnapshot,
	fetchAllSnapshotPages,
	mergeBootstrapSnapshot,
} from "./sync-bootstrap.js";
import { SYNC_CAPABILITY_HEADER } from "./sync-capability.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import {
	getReplicationCursor,
	getSyncResetState,
	SCOPED_NULL_BASELINE_BOOTSTRAP_CURSOR_MARKER,
	setReplicationCursor,
	setSyncResetState,
} from "./sync-replication.js";
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
		scope_id: "acme-work",
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
			scope_id: "acme-work",
			...payload,
		}),
		clock_rev: overrides?.clock_rev ?? 1,
		clock_updated_at: overrides?.clock_updated_at ?? "2026-01-01T00:00:02Z",
		clock_device_id: overrides?.clock_device_id ?? "peer-dev",
	};
}

function seedBootstrapExposure(
	db: InstanceType<typeof Database>,
	sessionId: number,
	input: {
		memoryImportKey: string;
		exposureImportKey: string | null;
		memoryOriginDeviceId: string;
		exposureOriginDeviceId: string | null;
	},
): number {
	const now = "2026-01-01T00:00:00Z";
	const memory = db
		.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, active, created_at, updated_at,
				import_key, origin_device_id, rev, visibility, scope_id, metadata_json
			 ) VALUES (?, 'discovery', 'old memory', 'old body', 1, ?, ?, ?, ?, 1, 'shared', 'acme-work', ?)`,
		)
		.run(
			sessionId,
			now,
			now,
			input.memoryImportKey,
			input.memoryOriginDeviceId,
			toJson({ clock_device_id: input.memoryOriginDeviceId }),
		);
	const memoryId = Number(memory.lastInsertRowid);
	db.prepare(
		`INSERT INTO retrieval_attempts(
			attempt_id, contract_version, surface, trigger, started_at, retrieval_status,
			delivery_status, candidate_count, selected_count, persisted_candidate_count,
			recorder_version
		 ) VALUES ('bootstrap-exposure', 1, 'prompt_pack', 'explicit', ?, 'succeeded',
			'handed_off', 1, 1, 1, 'sync-bootstrap-test/1')`,
	).run(now);
	db.prepare(
		`INSERT INTO retrieval_exposures(
			attempt_id, memory_id, memory_import_key, origin_device_id, rank,
			disposition, handoff_status, memory_rev, memory_active
		 ) VALUES ('bootstrap-exposure', ?, ?, ?, 1, 'selected', 'handed_off', 1, 1)`,
	).run(memoryId, input.exposureImportKey, input.exposureOriginDeviceId);
	return memoryId;
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
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, visibility, scope_id, metadata_json)
			 VALUES (?, 'discovery', 'old-shared', 'old body', ?, ?, 'old-key', 1, 'shared', 'acme-work', ?)`,
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

	it.each([
		{
			name: "a different import identity",
			memoryImportKey: "old-key",
			exposureImportKey: "old-key",
			memoryOriginDeviceId: "peer-dev",
			exposureOriginDeviceId: "peer-dev",
			snapshotImportKey: "new-key",
			snapshotOriginDeviceId: "peer-dev",
			retainsMemoryId: false,
		},
		{
			name: "a different origin identity",
			memoryImportKey: "stable-key",
			exposureImportKey: "stable-key",
			memoryOriginDeviceId: "old-peer",
			exposureOriginDeviceId: "old-peer",
			snapshotImportKey: "stable-key",
			snapshotOriginDeviceId: "new-peer",
			retainsMemoryId: false,
		},
		{
			name: "the same stable identity",
			memoryImportKey: "stable-key",
			exposureImportKey: "stable-key",
			memoryOriginDeviceId: "peer-dev",
			exposureOriginDeviceId: "peer-dev",
			snapshotImportKey: "stable-key",
			snapshotOriginDeviceId: "peer-dev",
			retainsMemoryId: true,
		},
		{
			name: "an exposure without stable identity",
			memoryImportKey: "stable-key",
			exposureImportKey: null,
			memoryOriginDeviceId: "peer-dev",
			exposureOriginDeviceId: null,
			snapshotImportKey: "stable-key",
			snapshotOriginDeviceId: "peer-dev",
			retainsMemoryId: false,
		},
	])("validates exposure identity when bootstrap reuses a row ID for $name", (fixture) => {
		db.pragma("foreign_keys = OFF");
		const oldMemoryId = seedBootstrapExposure(db, sessionId, fixture);

		const result = applyBootstrapSnapshot(
			db,
			"peer-1",
			[
				makeSnapshotItem(fixture.snapshotImportKey, {
					clock_device_id: fixture.snapshotOriginDeviceId,
					payload: { origin_device_id: fixture.snapshotOriginDeviceId },
				}),
			],
			makeResetInfo(),
		);

		const newMemoryId = db
			.prepare("SELECT id FROM memory_items WHERE import_key = ?")
			.pluck()
			.get(fixture.snapshotImportKey);
		expect(result).toMatchObject({ ok: true, deleted: 1, applied: 1 });
		expect(newMemoryId).toBe(oldMemoryId);
		expect(
			db
				.prepare(
					"SELECT memory_id FROM retrieval_exposures WHERE attempt_id = 'bootstrap-exposure'",
				)
				.pluck()
				.get(),
		).toBe(fixture.retainsMemoryId ? oldMemoryId : null);
	});

	it("relies on ON DELETE SET NULL during normal foreign-key-enforced bootstrap", () => {
		db.pragma("foreign_keys = ON");
		const oldMemoryId = seedBootstrapExposure(db, sessionId, {
			memoryImportKey: "stable-key",
			exposureImportKey: "stable-key",
			memoryOriginDeviceId: "peer-dev",
			exposureOriginDeviceId: "peer-dev",
		});

		const result = applyBootstrapSnapshot(
			db,
			"peer-1",
			[makeSnapshotItem("stable-key")],
			makeResetInfo(),
		);

		expect(result).toMatchObject({ ok: true, deleted: 1, applied: 1 });
		expect(
			db
				.prepare(
					"SELECT memory_id FROM retrieval_exposures WHERE attempt_id = 'bootstrap-exposure'",
				)
				.pluck()
				.get(),
		).toBeNull();
		expect(
			db.prepare("SELECT id FROM memory_items WHERE import_key = 'stable-key'").pluck().get(),
		).toBe(oldMemoryId);
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

	it.each(
		[
			{ name: "apply", bootstrap: applyBootstrapSnapshot },
			{ name: "merge", bootstrap: mergeBootstrapSnapshot },
		].flatMap(({ name, bootstrap }) =>
			[
				{ scopeCase: "managed scope", payloadScopeId: "acme-work" },
				{ scopeCase: "null scope", payloadScopeId: null },
				{ scopeCase: "local-default scope", payloadScopeId: "local-default" },
				{ scopeCase: "non-string scope", payloadScopeId: 123 },
			].map((scope) => ({ name, bootstrap, ...scope })),
		),
	)("$name rejects $scopeCase rows on default bootstrap before mutating local state", ({
		bootstrap,
		payloadScopeId,
	}) => {
		const now = "2026-01-01T00:00:00Z";
		db.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, created_at, updated_at, import_key, rev,
				visibility, scope_id, metadata_json
			 ) VALUES (?, 'discovery', 'existing', 'body', ?, ?, 'existing-key', 1, 'shared', NULL, ?)`,
		).run(sessionId, now, now, toJson({ clock_device_id: "local" }));
		const items = [
			makeSnapshotItem("unauthorized-scoped-row", { payload: { scope_id: payloadScopeId } }),
		];

		expect(() => bootstrap(db, "peer-1", items, makeResetInfo({ scope_id: null }))).toThrow(
			"scope_mismatch",
		);

		expect(
			db.prepare("SELECT title FROM memory_items WHERE import_key = ?").get("existing-key"),
		).toEqual({ title: "existing" });
		expect(
			db
				.prepare("SELECT COUNT(*) FROM memory_items WHERE import_key = ?")
				.pluck()
				.get("unauthorized-scoped-row"),
		).toBe(0);
		expect(getSyncResetState(db).snapshot_id).toBe("snap-1");
		expect(getReplicationCursor(db, "peer-1")).toEqual([null, null]);
	});

	it("uses the requested managed scope when payload scope_id is non-string", () => {
		const items = [makeSnapshotItem("malformed-scope-key", { payload: { scope_id: 123 } })];

		const result = applyBootstrapSnapshot(db, "peer-1", items, makeResetInfo());

		expect(result.ok).toBe(true);
		const scoped = db
			.prepare("SELECT scope_id FROM memory_items WHERE import_key = 'malformed-scope-key'")
			.get() as Record<string, unknown>;
		expect(scoped.scope_id).toBe("acme-work");
	});

	it("replaces only the requested scope during scoped bootstrap", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, visibility, scope_id, metadata_json)
			 VALUES
			 (?, 'discovery', 'old-work', 'body', ?, ?, 'old-work-key', 1, 'shared', 'acme-work', ?),
			 (?, 'discovery', 'private-work', 'body', ?, ?, 'private-work-key', 1, 'private', 'acme-work', ?),
			 (?, 'discovery', 'old-personal', 'body', ?, ?, 'old-personal-key', 1, 'shared', 'personal:actor-1', ?),
			 (?, 'discovery', 'old-default', 'body', ?, ?, 'old-default-key', 1, 'shared', NULL, ?)`,
		).run(
			sessionId,
			now,
			now,
			toJson({ clock_device_id: "local" }),
			sessionId,
			now,
			now,
			toJson({ clock_device_id: "local" }),
			sessionId,
			now,
			now,
			toJson({ clock_device_id: "local" }),
			sessionId,
			now,
			now,
			toJson({ clock_device_id: "local" }),
		);

		const items = [makeSnapshotItem("new-work-key")];
		setReplicationCursor(
			db,
			"peer-1",
			{ lastAcked: SCOPED_NULL_BASELINE_BOOTSTRAP_CURSOR_MARKER },
			"acme-work",
		);
		const result = applyBootstrapSnapshot(
			db,
			"peer-1",
			items,
			makeResetInfo({ scope_id: "acme-work" }),
		);

		expect(result.ok).toBe(true);
		expect(result.deleted).toBe(1);
		const rows = db
			.prepare("SELECT import_key, scope_id FROM memory_items ORDER BY import_key")
			.all() as Array<{ import_key: string; scope_id: string | null }>;
		expect(rows).toEqual([
			{ import_key: "new-work-key", scope_id: "acme-work" },
			{ import_key: "old-default-key", scope_id: null },
			{ import_key: "old-personal-key", scope_id: "personal:actor-1" },
			{ import_key: "private-work-key", scope_id: "acme-work" },
		]);
		expect(getSyncResetState(db).snapshot_id).toBe("snap-1");
		expect(getSyncResetState(db, "acme-work").snapshot_id).toBe("snap-2");
		expect(getReplicationCursor(db, "peer-1")).toEqual([null, null]);
		expect(getReplicationCursor(db, "peer-1", "acme-work")).toEqual([
			"2026-01-01T00:00:05Z|base-op",
			null,
		]);
	});

	it("merge recovery preserves stale rows when a newer snapshot item is malformed", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, visibility, scope_id, metadata_json)
			 VALUES (?, 'discovery', 'stale-work', 'body', ?, ?, 'stale-work-key', 1, 'shared', 'acme-work', ?)`,
		).run(sessionId, now, now, toJson({ clock_device_id: "peer-dev" }));

		const result = mergeBootstrapSnapshot(
			db,
			"peer-1",
			[
				{
					entity_id: "stale-work-key",
					op_type: "upsert",
					payload_json: "{not-json",
					clock_rev: 2,
					clock_updated_at: "2026-01-02T00:00:00Z",
					clock_device_id: "peer-dev",
				},
			],
			makeResetInfo({ scope_id: "acme-work", baseline_cursor: null }),
		);

		expect(result.ok).toBe(true);
		expect(result.applied).toBe(0);
		expect(result.deleted).toBe(0);
		expect(
			db
				.prepare("SELECT title FROM memory_items WHERE import_key = ? AND scope_id = ?")
				.get("stale-work-key", "acme-work"),
		).toMatchObject({ title: "stale-work" });
	});

	it("merge recovery breaks rev/updated_at ties on clock_device_id", () => {
		const tied = "2026-01-01T00:00:02Z";
		const seedRow = (importKey: string, title: string, deviceId: string) => {
			db.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, visibility, scope_id, metadata_json)
				 VALUES (?, 'discovery', ?, 'body', ?, ?, ?, 1, 'shared', 'acme-work', ?)`,
			).run(sessionId, title, tied, tied, importKey, toJson({ clock_device_id: deviceId }));
		};
		// Existing local clock device id sorts lower than the snapshot's, so on an
		// exact rev/updated_at tie the snapshot should win and replace the row.
		seedRow("tie-loser-key", "stale-loser", "dev-a");
		// Existing local clock device id sorts higher than the snapshot's, so the
		// local row should win the tie and be preserved.
		seedRow("tie-winner-key", "local-winner", "dev-z");

		const result = mergeBootstrapSnapshot(
			db,
			"peer-1",
			[
				makeSnapshotItem("tie-loser-key", {
					payload: { title: "snapshot-wins", scope_id: "acme-work" },
					clock_rev: 1,
					clock_updated_at: tied,
					clock_device_id: "dev-m",
				}),
				makeSnapshotItem("tie-winner-key", {
					payload: { title: "snapshot-loses", scope_id: "acme-work" },
					clock_rev: 1,
					clock_updated_at: tied,
					clock_device_id: "dev-m",
				}),
			],
			makeResetInfo({ scope_id: "acme-work", baseline_cursor: null }),
		);

		expect(result.ok).toBe(true);
		expect(result.applied).toBe(1);
		expect(result.deleted).toBe(1);
		expect(
			db
				.prepare("SELECT title FROM memory_items WHERE import_key = ? AND scope_id = ?")
				.get("tie-loser-key", "acme-work"),
		).toMatchObject({ title: "snapshot-wins" });
		expect(
			db
				.prepare("SELECT title FROM memory_items WHERE import_key = ? AND scope_id = ?")
				.get("tie-winner-key", "acme-work"),
		).toMatchObject({ title: "local-winner" });
	});

	it("scoped bootstrap replaces only the requested managed scope", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, visibility, scope_id, metadata_json)
			 VALUES
			 (?, 'discovery', 'old-null', 'body', ?, ?, 'old-null-key', 1, 'shared', NULL, ?),
			 (?, 'discovery', 'old-local-default', 'body', ?, ?, 'old-local-default-key', 1, 'shared', 'local-default', ?),
			 (?, 'discovery', 'old-work', 'body', ?, ?, 'old-work-key', 1, 'shared', 'acme-work', ?)`,
		).run(
			sessionId,
			now,
			now,
			toJson({ clock_device_id: "local" }),
			sessionId,
			now,
			now,
			toJson({ clock_device_id: "local" }),
			sessionId,
			now,
			now,
			toJson({ clock_device_id: "local" }),
		);

		const result = applyBootstrapSnapshot(
			db,
			"peer-1",
			[makeSnapshotItem("new-key")],
			makeResetInfo({ scope_id: "acme-work" }),
		);

		expect(result.ok).toBe(true);
		expect(result.deleted).toBe(1);
		const rows = db
			.prepare("SELECT import_key, scope_id FROM memory_items ORDER BY import_key")
			.all() as Array<{ import_key: string; scope_id: string | null }>;
		expect(rows).toEqual([
			{ import_key: "new-key", scope_id: "acme-work" },
			{ import_key: "old-local-default-key", scope_id: "local-default" },
			{ import_key: "old-null-key", scope_id: null },
		]);
	});

	it("empty unscoped bootstrap preserves locally-originated local-only rows", () => {
		const now = "2026-01-01T00:00:00Z";
		db.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, created_at, updated_at, import_key,
				rev, visibility, origin_device_id, scope_id, metadata_json
			 ) VALUES
			 (?, 'discovery', 'local-null', 'body', ?, ?, 'local-null-key', 1, 'shared', 'dev-local', NULL, ?),
			 (?, 'discovery', 'local-default', 'body', ?, ?, 'local-default-key', 1, 'shared', 'dev-local', 'local-default', ?)`,
		).run(
			sessionId,
			now,
			now,
			toJson({ clock_device_id: "dev-local" }),
			sessionId,
			now,
			now,
			toJson({ clock_device_id: "dev-local" }),
		);

		const result = applyBootstrapSnapshot(db, "peer-1", [], makeResetInfo({ scope_id: null }));

		expect(result).toMatchObject({ ok: true, applied: 0, deleted: 0 });
		expect(
			db.prepare("SELECT import_key, scope_id FROM memory_items ORDER BY import_key").all(),
		).toEqual([
			{ import_key: "local-default-key", scope_id: "local-default" },
			{ import_key: "local-null-key", scope_id: null },
		]);
		expect(getSyncResetState(db).snapshot_id).toBe("snap-2");
		expect(getReplicationCursor(db, "peer-1")[0]).toBe("2026-01-01T00:00:05Z|base-op");
	});

	it("preserves private memories during bootstrap", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, visibility, scope_id, metadata_json)
			 VALUES (?, 'discovery', 'my-private', 'private body', ?, ?, 'private-key', 1, 'private', 'acme-work', ?)`,
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

		const state = getSyncResetState(db, "acme-work");
		expect(state.generation).toBe(2);
		expect(state.snapshot_id).toBe("snap-2");
		expect(state.baseline_cursor).toBe("2026-01-01T00:00:05Z|base-op");
	});

	it("updates replication cursor to baseline_cursor", () => {
		const items = [makeSnapshotItem("key-a")];
		applyBootstrapSnapshot(db, "peer-1", items, makeResetInfo());

		expect(getReplicationCursor(db, "peer-1", "acme-work")[0]).toBe("2026-01-01T00:00:05Z|base-op");
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
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, visibility, scope_id, metadata_json)
			 VALUES (?, 'discovery', 'old-shared', 'body', ?, ?, 'old-key', 1, 'shared', 'acme-work', ?)`,
		).run(sessionId, now, now, toJson({ clock_device_id: "local" }));

		const result = applyBootstrapSnapshot(db, "peer-1", [], makeResetInfo());

		expect(result.ok).toBe(true);
		expect(result.deleted).toBe(1);
		expect(result.applied).toBe(0);
	});
});

describe("fetchAllSnapshotPages", () => {
	it("fetches and applies every page for an empty authorized scope", async () => {
		const db = new Database(":memory:");
		initTestSchema(db);
		const keysDir = mkdtempSync(join(tmpdir(), "codemem-bootstrap-keys-"));
		const [deviceId] = ensureDeviceIdentity(db, { keysDir });
		const resetInfo = makeResetInfo();
		const snapshotItems = Array.from({ length: 5 }, (_, index) =>
			makeSnapshotItem(`scoped-key-${index + 1}`),
		);
		const requestedPageTokens: Array<string | null> = [];
		const prevFetch = globalThis.fetch;
		try {
			expect(
				db.prepare("SELECT COUNT(*) FROM memory_items WHERE import_key IS NOT NULL").pluck().get(),
			).toBe(0);
			expect(getReplicationCursor(db, "peer-1", "acme-work")).toEqual([null, null]);

			globalThis.fetch = (async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				expect(url.searchParams.get("scope_id")).toBe("acme-work");
				expect(url.searchParams.get("limit")).toBe("2");
				const pageToken = url.searchParams.get("page_token");
				requestedPageTokens.push(pageToken);
				const pageIndex = pageToken === null ? 0 : Number(pageToken.replace("page-", "")) - 1;
				const items = snapshotItems.slice(pageIndex * 2, pageIndex * 2 + 2);
				const hasMore = pageIndex * 2 + items.length < snapshotItems.length;
				return new Response(
					JSON.stringify({
						generation: resetInfo.generation,
						snapshot_id: resetInfo.snapshot_id,
						baseline_cursor: resetInfo.baseline_cursor,
						retained_floor_cursor: null,
						items,
						next_page_token: hasMore ? `page-${pageIndex + 2}` : null,
						has_more: hasMore,
					}),
					{ status: 200 },
				);
			}) as typeof fetch;

			const snapshot = await fetchAllSnapshotPages(
				"http://peer.example.test:47337",
				resetInfo,
				deviceId,
				{ keysDir, pageSize: 2 },
			);
			const result = applyBootstrapSnapshot(db, "peer-1", snapshot.items, resetInfo);

			expect(requestedPageTokens).toEqual([null, "page-2", "page-3"]);
			expect(snapshot.items).toHaveLength(5);
			expect(result).toMatchObject({ ok: true, applied: 5, deleted: 0 });
			expect(
				db
					.prepare("SELECT import_key FROM memory_items WHERE scope_id = ? ORDER BY import_key")
					.all("acme-work"),
			).toEqual(snapshotItems.map((item) => ({ import_key: item.entity_id })));
			expect(getReplicationCursor(db, "peer-1", "acme-work")[0]).toBe(resetInfo.baseline_cursor);
		} finally {
			globalThis.fetch = prevFetch;
			db.close();
			rmSync(keysDir, { recursive: true, force: true });
		}
	});

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
					[SYNC_CAPABILITY_HEADER]: "scoped",
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
