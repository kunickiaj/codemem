import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { exportMemories, importMemories } from "./export-import.js";
import { buildFilterClausesWithContext } from "./filters.js";
import {
	enrollFixtureSigningKey,
	refreshManagedScopeFixture,
} from "./managed-scope-test-fixtures.js";
import { adoptLocalCapture, localCreationSourceIds } from "./memory-local-capture.js";
import {
	getVerifiedMemorySource,
	verifyAuthenticatedMemorySource,
} from "./memory-source-identity.js";
import { buildMemoryPackWithTrace } from "./pack.js";
import { MemoryStore } from "./store.js";
import { applyBootstrapSnapshot, mergeBootstrapSnapshot } from "./sync-bootstrap.js";
import { ensureDeviceIdentity, loadRuntimeSigningPublicKey } from "./sync-identity.js";
import {
	applyReplicationOps,
	diagnoseStalePeerReceivedRows,
	pruneReplicationOps,
	reconcileStalePeerReceivedRows,
	recordReplicationOp,
} from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import type { ReplicationOp, SyncMemorySnapshotItem, SyncResetRequired } from "./types.js";

const now = "2026-09-21T12:00:00.000Z";
const scopeId = "capture-revoked";
const reset: SyncResetRequired = {
	reset_required: true,
	reason: "generation_mismatch",
	generation: 2,
	snapshot_id: "capture-snapshot",
	baseline_cursor: null,
	retained_floor_cursor: null,
	scope_id: scopeId,
};

let dir: string;
let keysDir: string;
let store: MemoryStore;
let sessionId: number;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-local-capture-"));
	keysDir = join(dir, "keys");
	vi.stubEnv("CODEMEM_CONFIG", join(dir, "config.json"));
	vi.stubEnv("CODEMEM_DEVICE_ID", "");
	vi.stubEnv("CODEMEM_ACTOR_ID", "");
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.spyOn(MemoryStore.prototype, "enqueueVectorWrite").mockImplementation(() => {});
	const path = join(dir, "memory.sqlite");
	const db = new Database(path);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(path, { keysDir });
	sessionId = insertTestSession(store.db);
	store.db
		.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type,
			coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
			VALUES (?, 'Capture scope', 'team', 'coordinator', 'capture-coordinator', 'capture-group', 1, 'active', ?, ?)`)
		.run(scopeId, now, now);
});

afterEach(() => {
	store.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

function remember(title = "Genuine capture", metadata?: Record<string, unknown>): number {
	return store.remember(sessionId, "discovery", title, `${title} body`, 0.8, [], metadata);
}

function rememberScoped(title = "Genuine capture", metadata?: Record<string, unknown>): number {
	const mapping = store.db
		.prepare(`INSERT INTO project_scope_mappings(workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at)
		VALUES ('/tmp/test', '/tmp/test', ?, 100, 'user', ?, ?)`)
		.run(scopeId, now, now);
	try {
		const id = remember(title, metadata);
		expect(row(id).scope_id).toBe(scopeId);
		return id;
	} finally {
		store.db
			.prepare("DELETE FROM project_scope_mappings WHERE id = ?")
			.run(mapping.lastInsertRowid);
	}
}

function row(id: number): Record<string, unknown> {
	return store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as Record<
		string,
		unknown
	>;
}

function restrict(id: number): void {
	store.db.prepare("UPDATE memory_items SET scope_id = ? WHERE id = ?").run(scopeId, id);
}

function binding(id: number) {
	return getVerifiedMemorySource(store.db, String(row(id).import_key));
}

function captureOp(id: number): ReplicationOp {
	recordReplicationOp(store.db, {
		memoryId: id,
		deviceId: store.deviceId,
		opType: "upsert",
		createdAt: now,
	});
	return store.db
		.prepare("SELECT * FROM replication_ops WHERE entity_id = ? ORDER BY clock_rev DESC LIMIT 1")
		.get(row(id).import_key) as ReplicationOp;
}

it.each(["replication", "snapshot replace", "snapshot merge"])(
	"%s cannot use an original key to vouch for foreign content or caller clock labels",
	async (transport) => {
		// Arrange: original proof comes exclusively from ordinary remember.
		const originalId = remember();
		enroll();
		await refreshManagedScopeFixture(store.db, {
			keysDir,
			deviceId: store.deviceId,
			scopeIds: [scopeId],
		});
		const unchangedId = rememberScoped("Unchanged genuine control");
		const op = captureOp(originalId);
		const originalBinding = binding(originalId);
		const payload = {
			...JSON.parse(op.payload_json ?? "{}"),
			title: "Foreign replacement",
			body_text: "Peer-authored replacement body",
			scope_id: scopeId,
			actor_id: "peer-actor",
			origin_device_id: "local",
			metadata_json: { clock_device_id: store.deviceId, local_creation: true },
		};
		const incoming = {
			...op,
			op_id: `foreign-${transport}`,
			device_id: "peer",
			scope_id: scopeId,
			clock_rev: op.clock_rev + 100,
			clock_device_id: store.deviceId,
			payload_json: JSON.stringify(payload),
		};
		// Act: exercise the actual mutation APIs with the SAME existing import key.
		if (transport === "replication")
			expect(applyReplicationOps(store.db, [incoming], store.deviceId).applied).toBe(1);
		else {
			const apply =
				transport === "snapshot replace" ? applyBootstrapSnapshot : mergeBootstrapSnapshot;
			expect(
				apply(
					store.db,
					"peer",
					[
						{
							entity_id: op.entity_id,
							op_type: "upsert",
							payload_json: incoming.payload_json,
							clock_rev: incoming.clock_rev,
							clock_updated_at: incoming.clock_updated_at,
							clock_device_id: incoming.clock_device_id,
						},
					],
					reset,
				),
			).toMatchObject({ ok: true, applied: 1 });
		}
		const foreignId = store.db
			.prepare("SELECT id FROM memory_items WHERE import_key = ? AND scope_id = ?")
			.pluck()
			.get(op.entity_id, scopeId) as number;
		expect(store.get(foreignId)?.body_text).toBe(payload.body_text);
		const rawForeign = row(foreignId);
		store.db
			.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
			.run(scopeId);
		// Assert: current permission worked, but old creator proof does not authorize peer revision.
		expect(store.get(foreignId)).toBeNull();
		expect(row(foreignId)).toEqual(rawForeign);
		expect(getVerifiedMemorySource(store.db, op.entity_id)).toEqual(originalBinding);
		if (transport !== "snapshot replace") expect(store.get(unchangedId)?.id).toBe(unchangedId);
		const controlled = rememberScoped("Caller cannot reclaim original", {
			import_key: op.entity_id,
			origin_device_id: store.deviceId,
			clock_device_id: store.deviceId,
		});
		expect(store.get(controlled)).toBeNull();
	},
);

it.each(["other connection enrollment", "environment device mismatch"])(
	"ordinary remember succeeds without proof after %s",
	(mismatch) => {
		// Arrange: the long-running writer retains its initial runtime identity.
		remember("Prior genuine capture");
		const unsigned = ledger();
		const other = new Database(store.dbPath);
		try {
			ensureDeviceIdentity(other, { keysDir, deviceId: "enrolled-other-connection" });
		} finally {
			other.close();
		}
		const before = ledger();
		expect(before.adoption).toHaveLength(1);
		expect(before.birth).toEqual(unsigned.birth);
		expect(before.bindings).toEqual(unsigned.bindings);
		if (mismatch === "environment device mismatch") {
			store.close();
			vi.stubEnv("CODEMEM_DEVICE_ID", "different-runtime-device");
			store = new MemoryStore(join(dir, "memory.sqlite"), { keysDir });
		}
		// Act: a failed provenance check must not drop an ingest batch.
		const ids = [remember("Ingest first"), remember("Ingest second")];
		// Assert: local/default data persists, without creating or unioning authority.
		for (const id of ids) {
			expect(row(id).active).toBe(1);
			expect(binding(id)).toBeNull();
			expect(store.get(id)?.id).toBe(id);
		}
		expect(ledger()).toEqual(before);
	},
);

it.each(["fallback actor", "configured actor"])(
	"maintained enrollment writer adopts pending capture for %s before reopen",
	(actorMode) => {
		// Arrange: no device exists when the original memory is written.
		if (actorMode === "configured actor") {
			store.close();
			vi.stubEnv("CODEMEM_ACTOR_ID", "configured-owner");
			store = new MemoryStore(join(dir, "memory.sqlite"), { keysDir });
		}
		const id = rememberScoped();
		const originalBinding = binding(id);
		// Act: use the maintained non-viewer enrollment API, not the new adoption helper.
		const [deviceId] = ensureDeviceIdentity(store.db, { keysDir, deviceId: "enrollment-writer" });
		store.close();
		store = new MemoryStore(join(dir, "memory.sqlite"), { keysDir });
		// Assert: reopening reads existing facts and never needs a key-generating repair.
		expect(ledger().adoption).toHaveLength(1);
		expect(binding(id)).toEqual(originalBinding);
		expect(store.deviceId).toBe(deviceId);
		expect(store.get(id)?.id).toBe(id);
		expect(store.isScopeWritable(scopeId)).toBe(false);
		if (actorMode === "configured actor") expect(store.actorId).toBe("configured-owner");
	},
);

it("caller scope exclusions still exclude genuine authored history from pack output", () => {
	// Arrange
	const id = rememberScoped("Scope exclusion capture");
	const originalBinding = binding(id);
	// Act
	const included = buildMemoryPackWithTrace(store, "Scope exclusion capture", 10);
	const excluded = buildMemoryPackWithTrace(store, "Scope exclusion capture", 10, null, {
		exclude_scope_ids: [scopeId],
	});
	// Assert: the historical exception is not a bypass for caller filters.
	expect(originalBinding?.evidence).toBe("local_creation");
	expect(included.response.item_ids).toContain(id);
	expect(excluded.response.item_ids).not.toContain(id);
	expect(excluded.trace.retrieval.candidates.map((item) => item.id)).not.toContain(id);
	expect(binding(id)).toEqual(originalBinding);
});

function enroll(deviceId = "capture-device"): string {
	const key = enrollFixtureSigningKey(store.db, keysDir, deviceId);
	store.adoptEnsuredDeviceIdentity(deviceId);
	return key;
}

function persistUnadoptedIdentity(): void {
	// Model a genuinely ensured device from before capture association was introduced.
	// Only the device tuple is staged; the real writer remains the sole issuer of capture proof.
	const identityDb = new Database(":memory:");
	try {
		initTestSchema(identityDb);
		ensureDeviceIdentity(identityDb, { keysDir, deviceId: "capture-device" });
		const tuple = identityDb.prepare("SELECT * FROM sync_device").get() as {
			device_id: string;
			public_key: string;
			fingerprint: string;
			created_at: string;
		};
		store.db
			.prepare(
				"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
			)
			.run(tuple.device_id, tuple.public_key, tuple.fingerprint, tuple.created_at);
	} finally {
		identityDb.close();
	}
	expect(ledger().adoption).toEqual([]);
}

it("explicit reensure adopts a pending capture while constructor and reads leave it unadopted", () => {
	// Arrange: real capture plus a legitimate old unadopted signing tuple/private key.
	const id = rememberScoped();
	persistUnadoptedIdentity();
	const before = ledger();
	store.close();
	store = new MemoryStore(join(dir, "memory.sqlite"), { keysDir });
	expect(store.get(id)).toBeNull();
	expect(ledger()).toEqual(before);
	// Act: only the explicit maintained enrollment write can publish an association.
	const first = ensureDeviceIdentity(store.db, { keysDir });
	const adopted = ledger();
	const replay = ensureDeviceIdentity(store.db, { keysDir });
	// Assert: association is one-time and does not rename or replace creation facts.
	expect(replay).toEqual(first);
	expect(adopted.adoption).toHaveLength(1);
	expect(adopted.birth).toEqual(before.birth);
	expect(adopted.bindings).toEqual(before.bindings);
	expect(ledger()).toEqual(adopted);
	expect(store.get(id)?.id).toBe(id);
});

function factRows(table: string) {
	if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table)) return [];
	return store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
}

it.each(["adopted capture", "enrolled device"])(
	"cleanup with mismatched actual key preserves %s as restricted ambiguity",
	(creator) => {
		// Arrange: obtain genuine creator evidence, never issue a synthetic binding.
		if (creator === "enrolled device") enroll();
		const id = rememberScoped();
		if (creator === "adopted capture") enroll();
		restrict(id);
		const original = row(id);
		const before = ledger();
		const other = new Database(":memory:");
		let wrongKey: string;
		try {
			initTestSchema(other);
			wrongKey = enrollFixtureSigningKey(other, join(dir, "wrong-key"), "other-device");
		} finally {
			other.close();
		}
		// Act
		const result = reconcileStalePeerReceivedRows(store.db, {
			localDeviceId: store.deviceId,
			expectedPublicKey: wrongKey,
		});
		const filters = buildFilterClausesWithContext(
			{},
			store.ownershipFilterContext({ expectedPublicKey: wrongKey }),
		);
		const ids = store.db
			.prepare(`SELECT id FROM memory_items WHERE ${filters.clauses.join(" AND ")}`)
			.pluck()
			.all(...filters.params);
		// Assert: failed key proof neither deletes originals nor grants historical reads.
		expect(result).toMatchObject({ deleted: 0, retained: 0 });
		expect(result.ambiguous).toContainEqual(
			expect.objectContaining({ memory_id: id, reason: "unverified_local_creation" }),
		);
		expect(ids).not.toContain(id);
		expect(row(id)).toEqual(original);
		expect(ledger()).toEqual(before);
	},
);

function ledger() {
	return {
		birth: factRows("memory_local_capture"),
		adoption: factRows("memory_local_capture_adoption"),
		bindings: factRows("memory_source_bindings"),
	};
}

it("ordinary remember creates unique unsigned proof without generating signing keys", () => {
	// Arrange: no signing identity or capture birth exists.
	expect(store.deviceId).toBe("local");
	// Act: use the ordinary writer, not a fabricated binding.
	const first = rememberScoped();
	const second = remember("Second capture");
	restrict(first);
	// Assert: one birth, unique identities, immutable local_creation evidence.
	expect(row(first).origin_device_id).toBe("local");
	expect(String(row(first).import_key)).not.toBe("");
	expect(row(first).import_key).not.toBe(row(second).import_key);
	expect(binding(first)?.evidence).toBe("local_creation");
	expect(binding(first)?.sourceDeviceId).toBe(binding(second)?.sourceDeviceId);
	expect(ledger().birth).toHaveLength(1);
	expect(ledger().adoption).toEqual([]);
	expect(store.db.prepare("SELECT COUNT(*) FROM sync_device").pluck().get()).toBe(0);
	expect(existsSync(keysDir)).toBe(false);
	expect(store.get(first)?.id).toBe(first);
});

it.each([
	{ creator: "unsigned capture then adoption", replace: true },
	{ creator: "unsigned capture then adoption", replace: false },
	{ creator: "enrolled actual device", replace: true },
	{ creator: "enrolled actual device", replace: false },
])(
	"$creator preserves proof facts but cannot authorize bootstrap revisions replace=$replace",
	async ({ creator, replace }) => {
		// Arrange: the writer is the sole issuer of creation facts.
		if (creator === "enrolled actual device") enroll();
		const id = rememberScoped();
		const unchangedControl = remember("Unchanged local control");
		if (creator !== "enrolled actual device") enroll();
		await refreshManagedScopeFixture(store.db, {
			keysDir,
			deviceId: store.deviceId,
			scopeIds: [scopeId],
		});
		restrict(id);
		recordReplicationOp(store.db, {
			memoryId: id,
			deviceId: store.deviceId,
			opType: "upsert",
			scopeId,
			createdAt: now,
		});
		const entityId = String(row(id).import_key);
		const op = store.db
			.prepare("SELECT * FROM replication_ops WHERE entity_id = ? AND scope_id = ? LIMIT 1")
			.get(entityId, scopeId) as ReplicationOp;
		const item: SyncMemorySnapshotItem = {
			entity_id: entityId,
			op_type: "upsert",
			payload_json: op.payload_json,
			clock_rev: op.clock_rev,
			clock_updated_at: op.clock_updated_at,
			clock_device_id: op.clock_device_id,
		};
		const before = ledger();
		store.db
			.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
			.run(scopeId);
		// Act: use maintained bootstrap and cleanup, not direct fact/table deletion.
		const bootstrap = replace ? applyBootstrapSnapshot : mergeBootstrapSnapshot;
		expect(bootstrap(store.db, "peer", [item], reset)).toMatchObject({
			ok: true,
			applied: replace ? 1 : 0,
		});
		const restoredId = store.db
			.prepare("SELECT id FROM memory_items WHERE import_key = ?")
			.pluck()
			.get(entityId) as number;
		const ambiguous = remember("Unverified local origin", {
			origin_device_id: store.deviceId,
			import_key: "unverified-local",
		});
		restrict(ambiguous);
		const originalAmbiguous = row(ambiguous);
		const foreign = remember("Foreign imported control", {
			origin_device_id: "peer",
			import_key: "foreign-control",
		});
		restrict(foreign);
		const diagnosis = diagnoseStalePeerReceivedRows(store.db, {
			localDeviceId: store.deviceId,
			keysDir,
		});
		const result = reconcileStalePeerReceivedRows(store.db, {
			localDeviceId: store.deviceId,
			keysDir,
		});
		vi.spyOn(Date, "now").mockReturnValue(new Date("2026-10-20T00:00:00Z").getTime());
		const retention = pruneReplicationOps(store.db, { maxAgeDays: 1 });
		// Assert: unchanged merge preserves the original; applied peer replacement cannot inherit proof.
		expect(diagnosis.would_delete_memory_ids).toContain(foreign);
		expect(result.deleted_memory_ids).toContain(foreign);
		expect(result.retained).toBeGreaterThanOrEqual(1);
		expect(result.ambiguous).toContainEqual(
			expect.objectContaining({ memory_id: ambiguous, reason: "unverified_local_creation" }),
		);
		expect(row(ambiguous)).toEqual(originalAmbiguous);
		expect(store.get(ambiguous)).toBeNull();
		expect(store.get(restoredId)?.id ?? null).toBe(replace ? null : restoredId);
		expect(store.get(unchangedControl)?.id).toBe(unchangedControl);
		expect(store.isScopeWritable(scopeId)).toBe(false);
		expect(ledger()).toEqual(before);
		expect(retention.deleted).toBeGreaterThan(0);
		store.close();
		store = new MemoryStore(join(dir, "memory.sqlite"), { keysDir });
		expect(store.get(restoredId)?.id ?? null).toBe(replace ? null : restoredId);
		expect(store.get(unchangedControl)?.id).toBe(unchangedControl);
		expect(ledger()).toEqual(before);
	},
);

it("real enrollment adopts once and preserves reads after actual scope permission loss, not mutations", async () => {
	// Arrange
	const id = rememberScoped();
	const original = binding(id);
	restrict(id);
	// Act
	const publicKey = enroll();
	await refreshManagedScopeFixture(store.db, {
		keysDir,
		deviceId: store.deviceId,
		scopeIds: [scopeId],
	});
	expect(store.isScopeWritable(scopeId)).toBe(true);
	store.db
		.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
		.run(scopeId);
	const after = ledger();
	store.db.transaction(() =>
		adoptLocalCapture(store.db, store.deviceId, { expectedPublicKey: publicKey }),
	)();
	// Assert
	expect(ledger()).toEqual(after);
	expect(after.adoption).toHaveLength(1);
	expect(binding(id)).toEqual(original);
	expect(row(id).origin_device_id).toBe("local");
	expect(store.get(id)?.id).toBe(id);
	expect(store.search("Genuine capture", 10).map((item) => item.id)).toContain(id);
	expect(store.isScopeWritable(scopeId)).toBe(false);
	expect(
		exportMemories({ dbPath: store.dbPath, keysDir, allProjects: true }).memory_items.map(
			(item) => item.import_key,
		),
	).toContain(row(id).import_key);
	store.close();
	store = new MemoryStore(join(dir, "memory.sqlite"), { keysDir });
	expect(store.get(id)?.id).toBe(id);
	expect(ledger()).toEqual(after);
});

it.each([
	{ import_key: "caller-key" },
	{ import_key: "" },
	{ import_key: null },
	{ origin_device_id: "local" },
	{ origin_device_id: "" },
	{ origin_device_id: null },
	{ clock_device_id: "local" },
	{ clock_device_id: "" },
	{ clock_device_id: null },
])("caller-supplied identity controls cannot issue creation proof: %j", (metadata) => {
	// Arrange
	const good = remember();
	// Act
	const controlled = remember("Controlled capture", metadata);
	restrict(controlled);
	// Assert: ordinary capture succeeds while caller-controlled history stays restricted.
	expect(binding(good)?.evidence).toBe("local_creation");
	expect(binding(controlled)).toBeNull();
	expect(store.get(controlled)).toBeNull();
	expect(row(controlled).active).toBe(1);
});

it("dedup returns an existing foreign row without minting proof or a birth", () => {
	// Arrange
	const foreign = remember("Duplicate title", {
		import_key: "foreign-duplicate",
		origin_device_id: "peer",
	});
	// Act
	const duplicate = remember("Duplicate title");
	// Assert
	expect(duplicate).toBe(foreign);
	expect(binding(foreign)).toBeNull();
	expect(
		store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_local_capture'").get(),
	).toBeUndefined();
	expect(store.db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(1);
});

it.each(["local", null, "capture-device"])(
	"raw historical origin %s cannot replace proof",
	(origin) => {
		// Arrange: explicit old-data fixture, with no prospective ledger entry.
		const good = rememberScoped();
		const historical = remember("Old ambiguous row", { import_key: "historical-uuid" });
		store.db
			.prepare("UPDATE memory_items SET origin_device_id = ? WHERE id = ?")
			.run(origin, historical);
		restrict(good);
		restrict(historical);
		const before = row(historical);
		// Act
		enroll();
		// Assert
		expect(store.get(good)?.id).toBe(good);
		expect(store.get(historical)).toBeNull();
		expect(binding(historical)).toBeNull();
		expect(row(historical).import_key).toBe(before.import_key);
		expect(row(historical).active).toBe(1);
	},
);

it("real export/import does not carry author proof into another database", () => {
	// Arrange
	const id = remember();
	const payload = exportMemories({ dbPath: store.dbPath, allProjects: true });
	const targetPath = join(dir, "imported.sqlite");
	const setup = new Database(targetPath);
	initTestSchema(setup);
	setup.close();
	// Act
	const result = importMemories(payload, { dbPath: targetPath });
	const target = new Database(targetPath);
	// Assert
	try {
		expect(result.memory_items).toBe(1);
		expect(target.prepare("SELECT import_key FROM memory_items").pluck().get()).toBe(
			row(id).import_key,
		);
		expect(target.prepare("SELECT COUNT(*) FROM memory_source_bindings").pluck().get()).toBe(0);
		expect(localCreationSourceIds(target, "local")).toEqual([]);
	} finally {
		target.close();
	}
});

it.each([applyBootstrapSnapshot, mergeBootstrapSnapshot])(
	"%s preserves facts and cannot mint proof for copied local metadata",
	(apply) => {
		// Arrange
		const id = remember();
		enroll();
		const before = ledger();
		const item: SyncMemorySnapshotItem = {
			entity_id: "copied-bootstrap",
			op_type: "upsert",
			clock_rev: 10,
			clock_updated_at: now,
			clock_device_id: "peer",
			payload_json: JSON.stringify({
				kind: "discovery",
				title: "Copied bootstrap",
				body_text: "copy",
				created_at: now,
				scope_id: scopeId,
				origin_device_id: "local",
				visibility: "shared",
				metadata_json: { local_creation: true, source_device_id: store.deviceId },
			}),
		};
		// Act
		const result = apply(store.db, "peer", [item], reset);
		// Assert
		expect(result.ok).toBe(true);
		expect(result.applied).toBe(1);
		expect(ledger()).toEqual(before);
		expect(getVerifiedMemorySource(store.db, item.entity_id)).toBeNull();
		const importedId = store.db
			.prepare("SELECT id FROM memory_items WHERE import_key = ?")
			.pluck()
			.get(item.entity_id) as number;
		expect(store.get(importedId)).toBeNull();
		expect(binding(id)?.evidence).toBe("local_creation");
	},
);

it.each(["local", null, "capture-device"])(
	"replication origin %s and caller source flags cannot mint authorship",
	(origin) => {
		// Arrange
		const id = remember();
		enroll();
		recordReplicationOp(store.db, {
			memoryId: id,
			deviceId: store.deviceId,
			opType: "upsert",
			createdAt: now,
		});
		const op = store.db
			.prepare("SELECT * FROM replication_ops WHERE entity_id = ? LIMIT 1")
			.get(row(id).import_key) as ReplicationOp;
		const payload = JSON.parse(op.payload_json ?? "{}");
		const forged: ReplicationOp = {
			...op,
			scope_id: scopeId,
			op_id: "copied-op",
			entity_id: "copied-replica",
			device_id: "peer",
			clock_device_id: "peer",
			clock_rev: 10,
			payload_json: JSON.stringify({
				...payload,
				origin_device_id: origin,
				scope_id: scopeId,
				metadata_json: { local_creation: true, source_device_id: store.deviceId },
			}),
		};
		const before = ledger();
		// Act
		const result = applyReplicationOps(store.db, [forged], store.deviceId);
		// Assert
		expect(result.applied).toBe(1);
		expect(ledger()).toEqual(before);
		expect(getVerifiedMemorySource(store.db, forged.entity_id)).toBeNull();
		const copiedId = store.db
			.prepare("SELECT id FROM memory_items WHERE import_key = ?")
			.pluck()
			.get(forged.entity_id) as number;
		expect(store.get(copiedId)).toBeNull();
	},
);

it("authenticated namespace proof is not local_creation evidence", () => {
	// Arrange
	remember();
	enroll();
	const entityId = `memory-source-v1:${Buffer.from(store.deviceId).toString("base64url")}:00000000-0000-4000-8000-000000000001`;
	store.db.transaction(() =>
		verifyAuthenticatedMemorySource(store.db, { entityId, verifiedPeerDeviceId: store.deviceId }),
	)();
	// Act
	const imported = remember("Authenticated import", {
		import_key: entityId,
		origin_device_id: "local",
	});
	restrict(imported);
	// Assert
	expect(binding(imported)?.evidence).toBe("authenticated_namespace");
	expect(store.get(imported)).toBeNull();
});

it.each(["memory_local_capture", "memory_local_capture_adoption"])(
	"%s rejects update, delete, replace and additional rows",
	(table) => {
		// Arrange: facts originate from real capture and adoption.
		remember();
		enroll();
		const before = ledger();
		const columns = store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
		const names = columns.map((column) => column.name).join(", ");
		// Act / Assert: explicit SQL corruption attempts are the only direct fact writers.
		for (const query of [
			`UPDATE ${table} SET created_at = 'corrupted'`,
			`DELETE FROM ${table}`,
			`INSERT OR REPLACE INTO ${table} (${names}) SELECT ${names} FROM ${table}`,
			`INSERT INTO ${table} (${names}) SELECT ${columns.map((column) => (column.name === "capture_id" ? "'additional-capture'" : column.name)).join(", ")} FROM ${table}`,
		])
			expect(() => store.db.exec(query)).toThrow("memory_local_capture_immutable");
		expect(ledger()).toEqual(before);
	},
);

it("failed genuine creation rolls back memory, unsigned birth and source binding together", () => {
	// Arrange
	store.db.exec(
		"CREATE TRIGGER fail_capture BEFORE INSERT ON memory_items BEGIN SELECT RAISE(ABORT, 'capture_insert_failed'); END",
	);
	// Act
	expect(() => remember()).toThrow("capture_insert_failed");
	// Assert
	expect(store.db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(0);
	expect(store.db.prepare("SELECT COUNT(*) FROM memory_source_bindings").pluck().get()).toBe(0);
	expect(
		store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_local_capture'").get(),
	).toBeUndefined();
	store.db.exec("DROP TRIGGER fail_capture");
	const retry = remember();
	expect(binding(retry)?.evidence).toBe("local_creation");
});

it("failed identity persistence rolls back adoption without losing genuine creation evidence", () => {
	// Arrange
	const id = remember();
	const before = ledger();
	persistUnadoptedIdentity();
	store.db.exec(
		"CREATE TRIGGER fail_adoption BEFORE UPDATE ON memory_items BEGIN SELECT RAISE(ABORT, 'actor_update_failed'); END",
	);
	// Act
	expect(() => store.adoptEnsuredDeviceIdentity("capture-device")).toThrow("actor_update_failed");
	// Assert
	expect(store.deviceId).toBe("local");
	expect(ledger()).toEqual(before);
	store.db.exec("DROP TRIGGER fail_adoption");
	store.adoptEnsuredDeviceIdentity("capture-device");
	expect(ledger().adoption).toHaveLength(1);
	expect(binding(id)?.evidence).toBe("local_creation");
});

it.each(["wrong-device", "wrong-private-key", "wrong-fingerprint"])(
	"%s cannot adopt or read unsigned capture history",
	(failure) => {
		// Arrange
		const id = rememberScoped();
		restrict(id);
		persistUnadoptedIdentity();
		if (failure === "wrong-fingerprint")
			store.db.prepare("UPDATE sync_device SET fingerprint = 'mismatch'").run();
		if (failure === "wrong-private-key") {
			const other = new Database(":memory:");
			try {
				initTestSchema(other);
				enrollFixtureSigningKey(other, join(dir, "other-keys"), "other");
			} finally {
				other.close();
			}
			store.close();
			store = new MemoryStore(join(dir, "memory.sqlite"), { keysDir: join(dir, "other-keys") });
			store.deviceId = "local";
		}
		// Act
		store.adoptEnsuredDeviceIdentity(
			failure === "wrong-device" ? "different-device" : "capture-device",
		);
		// Assert
		expect(ledger().adoption).toEqual([]);
		expect(store.get(id)).toBeNull();
		expect(binding(id)?.evidence).toBe("local_creation");
	},
);

it("copied adoption metadata cannot union another actual device into the capture", () => {
	// Arrange: preserved adoption remains tied to the first actual key/device.
	const id = rememberScoped();
	restrict(id);
	enroll();
	const before = ledger();
	store.db.prepare("DELETE FROM sync_device").run();
	const otherKey = enrollFixtureSigningKey(store.db, join(dir, "other-keys"), "other-device");
	// Act
	const sources = localCreationSourceIds(store.db, "other-device", {
		expectedPublicKey: otherKey,
	});
	// Assert
	expect(sources).not.toContain(binding(id)?.sourceDeviceId);
	expect(() =>
		store.db.transaction(() =>
			adoptLocalCapture(store.db, "other-device", { expectedPublicKey: otherKey }),
		)(),
	).toThrow("memory_local_capture_adoption_conflict");
	expect(ledger()).toEqual(before);
});

it.each(["old", "current"])(
	"readonly %s database lookups perform no DDL, key repair or fact creation",
	(version) => {
		// Arrange
		if (version === "current") remember();
		const trace: string[] = [];
		const db = new Database(store.dbPath, {
			readonly: true,
			verbose: (sql) => trace.push(String(sql)),
		});
		const loadKey = vi.fn(() => undefined);
		const before = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
		// Act
		try {
			const sources = localCreationSourceIds(db, "local", { loadExpectedPublicKey: loadKey });
			const filters = buildFilterClausesWithContext(
				{},
				{
					actorId: "local:local",
					deviceId: "local",
					enforceScopeVisibility: true,
					scopeVisibilityDb: db,
					loadExpectedPublicKey: loadKey,
				},
			);
			db.prepare(`SELECT id FROM memory_items WHERE ${filters.clauses.join(" AND ")}`).all(
				...filters.params,
			);
			// Assert
			expect(sources.length).toBe(version === "current" ? 1 : 0);
			expect(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
			expect(
				trace.filter((sql) => /^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql)),
			).toEqual([]);
			expect(loadKey).not.toHaveBeenCalled();
			expect(existsSync(keysDir)).toBe(false);
		} finally {
			db.close();
		}
	},
);

it("retention and operation compaction preserve creation and adoption facts", () => {
	// Arrange
	remember();
	enroll();
	const before = ledger();
	// Act
	store.db.prepare("DELETE FROM memory_items").run();
	store.db.prepare("DELETE FROM replication_ops").run();
	// Assert
	expect(ledger()).toEqual(before);
	expect(store.db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(0);
});

it.each(["resolved", "fallback"])(
	"%s SQL filters include proven capture and reject unproven controls",
	(mode) => {
		// Arrange
		const good = rememberScoped();
		const foreign = remember("Foreign filter control", { import_key: "foreign-filter" });
		restrict(good);
		restrict(foreign);
		enroll();
		const context = store.ownershipFilterContext();
		if (mode === "fallback") delete context.visibleScopeIds;
		// Act
		const filters = buildFilterClausesWithContext({}, context);
		const ids = store.db
			.prepare(`SELECT id FROM memory_items WHERE ${filters.clauses.join(" AND ")}`)
			.pluck()
			.all(...filters.params);
		// Assert
		expect(ids).toContain(good);
		expect(ids).not.toContain(foreign);
	},
);

it("a conflicting existing actor cannot be relabelled or united by capture adoption", () => {
	// Arrange: a real capture plus an unrelated persisted actor at the target identity.
	const id = rememberScoped();
	persistUnadoptedIdentity();
	store.db
		.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		VALUES ('local:capture-device', 'Unrelated actor', 0, 'active', ?, ?)`)
		.run(now, now);
	const actor = store.db
		.prepare("SELECT * FROM actors WHERE actor_id = 'local:capture-device'")
		.get();
	const before = ledger();
	const originalMemory = row(id);
	const originalDevice = store.db.prepare("SELECT * FROM sync_device").all();
	// Act / Assert: denial must roll back the association as well as identity relabelling.
	expect(() => store.adoptEnsuredDeviceIdentity("capture-device")).toThrow(
		"device_adoption_actor_conflict",
	);
	expect(store.deviceId).toBe("local");
	expect(ledger()).toEqual(before);
	expect(store.db.prepare("SELECT * FROM sync_device").all()).toEqual(originalDevice);
	expect(row(id)).toEqual(originalMemory);
	expect(store.get(id)).toBeNull();
	expect(
		store.db.prepare("SELECT * FROM actors WHERE actor_id = 'local:capture-device'").get(),
	).toEqual(actor);
});

it.each(["merged fallback actor", "inactive fallback actor", "configured foreign actor"])(
	"actual enrollment skips only association for %s and remains usable on retry",
	async (conflict) => {
		// Arrange: ordinary capture precedes a persisted actor conflict.
		if (conflict === "configured foreign actor") {
			store.close();
			vi.stubEnv("CODEMEM_ACTOR_ID", "configured-foreign");
			store = new MemoryStore(join(dir, "memory.sqlite"), { keysDir });
		}
		const id = rememberScoped();
		const actorId = conflict === "configured foreign actor" ? "configured-foreign" : "local:local";
		const status = conflict === "merged fallback actor" ? "merged" : "inactive";
		store.db
			.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at)
			VALUES (?, 'Conflicting actor', ?, ?, ?, ?, ?)`)
			.run(
				actorId,
				conflict === "configured foreign actor" ? 0 : 1,
				conflict === "configured foreign actor" ? "active" : status,
				conflict === "merged fallback actor" ? "different-owner" : null,
				now,
				now,
			);
		const original = row(id);
		const before = ledger();
		const actors = store.db.prepare("SELECT * FROM actors ORDER BY actor_id").all();
		const creationSnapshots = factRows("memory_local_creation_snapshots");
		// Act: use the actual enrollment and reensure boundary, never a mocked adoption helper.
		const first = ensureDeviceIdentity(store.db, { keysDir, deviceId: "capture-device" });
		const retry = ensureDeviceIdentity(store.db, { keysDir });
		// Assert: keys/device persist; association and actor authority do not change.
		expect(retry).toEqual(first);
		const devices = store.db.prepare("SELECT * FROM sync_device").all() as {
			device_id: string;
			public_key: string;
			fingerprint: string;
		}[];
		expect(devices).toHaveLength(1);
		expect(devices[0]).toMatchObject({ device_id: first[0], fingerprint: first[1] });
		expect(loadRuntimeSigningPublicKey(store.db, { deviceId: first[0], keysDir })).toBe(
			devices[0]?.public_key,
		);
		expect(ledger()).toEqual(before);
		expect(row(id)).toEqual(original);
		expect(store.db.prepare("SELECT * FROM actors ORDER BY actor_id").all()).toEqual(actors);
		expect(() => store.adoptEnsuredDeviceIdentity(first[0])).toThrow(
			"device_adoption_actor_conflict",
		);
		expect(store.deviceId).toBe("local");
		expect(ledger()).toEqual(before);
		expect(row(id)).toEqual(original);
		expect(store.db.prepare("SELECT * FROM actors ORDER BY actor_id").all()).toEqual(actors);
		const fresh = remember("New local capture after actor conflict");
		expect(store.get(fresh)?.id).toBe(fresh);
		expect(binding(fresh)).toBeNull();
		expect(ledger()).toEqual(before);
		await refreshManagedScopeFixture(store.db, {
			keysDir,
			deviceId: first[0],
			scopeIds: [scopeId],
		});
		store.close();
		store = new MemoryStore(join(dir, "memory.sqlite"), { keysDir });
		expect(store.get(id)?.id).toBe(id);
		store.db
			.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
			.run(scopeId);
		expect(store.get(id)).toBeNull();
		expect(row(id)).toEqual(original);
		expect(ledger()).toEqual(before);
		expect(factRows("memory_local_creation_snapshots")).toEqual(creationSnapshots);
	},
);

it.each([
	"unexpected_enrollment_sql",
	"device_adoption_actor_conflict_extra",
	"device_adoption_actor_conflict",
])("actual enrollment does not swallow SQL failure %s or leave partial authority", (failure) => {
	// Arrange: inject a real SQLite failure before the first association write.
	const id = rememberScoped();
	const original = row(id);
	const before = ledger();
	store.db.exec(`CREATE TRIGGER fail_enrollment_adoption BEFORE INSERT ON memory_local_capture_adoption
			BEGIN SELECT RAISE(ABORT, '${failure}'); END`);
	// Act
	expect(() => ensureDeviceIdentity(store.db, { keysDir, deviceId: "capture-device" })).toThrow(
		failure,
	);
	// Assert: only the exact actor-conflict classification is nonfatal at enrollment.
	expect(store.db.prepare("SELECT COUNT(*) FROM sync_device").pluck().get()).toBe(0);
	expect(ledger()).toEqual(before);
	expect(row(id)).toEqual(original);
	store.db.exec("DROP TRIGGER fail_enrollment_adoption");
	ensureDeviceIdentity(store.db, { keysDir, deviceId: "capture-device" });
	expect(ledger().adoption).toHaveLength(1);
	expect(ledger().birth).toEqual(before.birth);
	expect(ledger().bindings).toEqual(before.bindings);
});

it.each(["wrong-device", "wrong-key", "wrong-fingerprint", "missing-device"])(
	"retained adoption rejects %s without rewriting facts",
	(failure) => {
		// Arrange
		const id = rememberScoped();
		restrict(id);
		const publicKey = enroll();
		const before = ledger();
		let deviceId = store.deviceId;
		let expectedPublicKey = publicKey;
		if (failure === "wrong-device") deviceId = "other-device";
		if (failure === "wrong-key") {
			const other = new Database(":memory:");
			try {
				initTestSchema(other);
				expectedPublicKey = enrollFixtureSigningKey(other, join(dir, "other"), "other");
			} finally {
				other.close();
			}
		}
		if (failure === "wrong-fingerprint")
			store.db.prepare("UPDATE sync_device SET fingerprint = 'mismatch'").run();
		if (failure === "missing-device") {
			store.db.prepare("DELETE FROM sync_device").run();
			deviceId = "local";
		}
		// Act
		const sources = localCreationSourceIds(store.db, deviceId, { expectedPublicKey });
		// Assert
		expect(sources).toEqual([]);
		expect(ledger()).toEqual(before);
		expect(binding(id)?.evidence).toBe("local_creation");
	},
);
