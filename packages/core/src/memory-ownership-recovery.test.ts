import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { memoryOwnershipRoutes } from "../../viewer-server/src/routes/memory-ownership.js";
import { connect } from "./db.js";
import {
	commitMemoryOwnershipRecovery,
	previewMemoryOwnershipRecovery,
	verifyMemoryOwnership,
} from "./memory-ownership-recovery.js";
import { getVerifiedMemorySource } from "./memory-source-identity.js";
import { listProjectScopeInventory } from "./project-scope-settings.js";
import { MemoryStore } from "./store.js";
import {
	backfillReplicationOps,
	getSyncResetState,
	loadMemorySnapshotPageForPeer,
	loadReplicationOpsForPeer,
} from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import * as vectors from "./vectors.js";

let store: MemoryStore;
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "ownership-recovery-"));
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_ACTOR_ID", "fixture-actor");
	const db = connect(join(directory, "test.sqlite"));
	initTestSchema(db);
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES ('fixture-device', 'fixture-key', 'fixture-fingerprint', '2026-01-01')",
	).run();
	vi.stubEnv("CODEMEM_DEVICE_ID", "fixture-device");
	db.close();
	store = new MemoryStore(join(directory, "test.sqlite"));
	vi.spyOn(vectors, "storeVectors").mockResolvedValue(undefined);
});
afterEach(async () => {
	await store.flushPendingVectorWrites();
	store.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function memory(visibility = "shared", actor = store.actorId) {
	const session = store.db
		.prepare("INSERT INTO sessions(started_at, project) VALUES ('2026-01-01', 'fixture')")
		.run();
	return Number(
		store.db
			.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, import_key, origin_device_id, actor_id, visibility, scope_id)
		VALUES (?, 'discovery', 'Fixture title', 'Fixture body', 0.5, '', 1, '2026-01-01', '2026-01-01', '{}', ?, 'unavailable-source', ?, ?, 'local-default')`)
			.run(session.lastInsertRowid, `legacy-${session.lastInsertRowid}`, actor, visibility)
			.lastInsertRowid,
	);
}
function confirmed(ids: number[]) {
	const preview = previewMemoryOwnershipRecovery(store, { version: 1, memoryIds: ids });
	return {
		...preview.request,
		reviewedDigest: preview.reviewedDigest,
		operationId: "fixture_operation_01",
		acknowledgeOriginalsRetained: true,
	};
}
function count(table: string) {
	return store.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
}

it.each([
	{ rowProject: null, sessionProject: "fixture", expected: "fixture" },
	{ rowProject: "row-project", sessionProject: "fixture", expected: "row-project" },
	{ rowProject: null, sessionProject: null, expected: null },
])(
	"preserves effective project and private local policy: $expected",
	({ rowProject, sessionProject, expected }) => {
		const id = memory("private");
		store.db.prepare("UPDATE memory_items SET project = ? WHERE id = ?").run(rowProject, id);
		store.db.prepare("UPDATE sessions SET project = ?").run(sessionProject);
		expect(
			previewMemoryOwnershipRecovery(store, { version: 1, memoryIds: [id] }).records[0]?.project,
		).toBe(expected);
		const result = commitMemoryOwnershipRecovery(store, confirmed([id]));
		const copyId = result.copies[0]?.recoveredMemoryId;
		expect(
			store.db
				.prepare(`SELECT m.project, s.project AS session_project, m.scope_id, m.visibility
		FROM memory_items m JOIN sessions s ON s.id = m.session_id WHERE m.id = ?`)
				.get(copyId),
		).toEqual({
			project: expected,
			session_project: expected,
			scope_id: "local-default",
			visibility: "private",
		});
		if (expected !== null) {
			expect(store.recent(10, { project: expected }).map((row) => row.id)).toContain(copyId);
			expect(listProjectScopeInventory(store.db).projects).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						project: expected,
						read_only: false,
						resolved_scope_id: "local-default",
					}),
				]),
			);
		}
		expect(count("replication_ops")).toBe(0);
	},
);

it.each(["session", "row"])("rejects changed %s project after preview without writes", (source) => {
	const id = memory();
	const input = confirmed([id]);
	if (source === "session") store.db.prepare("UPDATE sessions SET project = 'changed'").run();
	else store.db.prepare("UPDATE memory_items SET project = 'changed' WHERE id = ?").run(id);
	expect(() => commitMemoryOwnershipRecovery(store, input)).toThrow("ownership_preview_stale");
	expect(count("memory_items")).toBe(1);
	expect(count("sessions")).toBe(1);
	expect(count("memory_source_bindings")).toBe(0);
	expect(count("memory_ownership_recoveries")).toBe(0);
});

it("redacts the fallback project consistently on the copied memory and session", () => {
	const id = memory();
	const redact = store.scanner.redactValue.bind(store.scanner);
	vi.spyOn(store.scanner, "redactValue").mockImplementation((value) => {
		const result = redact(value);
		if (result.value && typeof result.value === "object" && "project" in result.value) {
			Object.assign(result.value, { project: "redacted-project" });
		}
		return result;
	});
	const result = commitMemoryOwnershipRecovery(store, confirmed([id]));
	expect(
		store.db
			.prepare(`SELECT m.project, s.project AS session_project
		FROM memory_items m JOIN sessions s ON s.id = m.session_id WHERE m.id = ?`)
			.get(result.copies[0]?.recoveredMemoryId),
	).toEqual({
		project: "redacted-project",
		session_project: "redacted-project",
	});
});

it("recovers unavailable-source peer content as new local copies while retaining originals", () => {
	const id = memory("shared", "peer-actor");
	const original = store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id);
	const input = confirmed([id]);
	expect(verifyMemoryOwnership(store, input).records[0]?.verification).toBe("unverified");
	const result = commitMemoryOwnershipRecovery(store, input);
	const copy = result.copies[0];
	expect(copy).toBeDefined();
	if (!copy) throw new Error("missing copy");
	expect(getVerifiedMemorySource(store.db, copy.recoveredIdentity)?.sourceDeviceId).toBe(
		store.deviceId,
	);
	expect(store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id)).toEqual(original);
	expect(count("replication_ops")).toBe(0);
	expect(backfillReplicationOps(store.db)).toBeGreaterThan(0);
	expect(count("replication_ops")).toBeGreaterThan(0);
	const boundary = getSyncResetState(store.db, "local-default");
	const exported = loadReplicationOpsForPeer(store.db, {
		since: null,
		deviceId: store.deviceId,
		scopeId: "local-default",
		generation: boundary.generation,
		snapshotId: boundary.snapshot_id,
		baselineCursor: boundary.baseline_cursor,
	});
	expect(exported.reset_required).toBe(false);
	if (exported.reset_required) throw new Error("unexpected reset");
	expect(exported.ops).toEqual([]);
	expect(
		loadMemorySnapshotPageForPeer(store.db, {
			generation: boundary.generation,
			snapshotId: boundary.snapshot_id,
			baselineCursor: boundary.baseline_cursor,
			peerDeviceId: "old-recipient",
			scopeId: "local-default",
		}).items,
	).toEqual([]);
	expect(count("memory_items")).toBe(2);
	expect(getVerifiedMemorySource(store.db, `legacy-1`)).toBeNull();
	expect(commitMemoryOwnershipRecovery(store, input)).toEqual({ ...result, idempotent: true });
	expect(count("memory_items")).toBe(2);
});

it("rejects private peer records and preserves local private visibility", () => {
	expect(() => confirmed([memory("private", "peer")])).toThrow(
		"ownership_private_record_not_owned",
	);
	const result = commitMemoryOwnershipRecovery(store, confirmed([memory("private")]));
	expect(
		store.db
			.prepare("SELECT visibility FROM memory_items WHERE id = ?")
			.pluck()
			.get(result.copies[0]?.recoveredMemoryId),
	).toBe("private");
});

it("never verifies legacy ownership from a forged reported source", () => {
	const id = memory();
	store.db
		.prepare("UPDATE memory_items SET origin_device_id = ? WHERE id = ?")
		.run(store.deviceId, id);
	expect(
		verifyMemoryOwnership(store, { version: 1, memoryIds: [id], sourceDeviceId: store.deviceId })
			.records[0]?.verification,
	).toBe("unverified");
	expect(count("memory_source_bindings")).toBe(0);
});

it("keeps personal constraints and historical claims separate from recovered authority", () => {
	const id = memory();
	store.db.prepare("UPDATE memory_items SET metadata_json = ? WHERE id = ?").run(
		JSON.stringify({
			visibility: "private",
			signature: "historical-claim",
			origin_device_id: "claimed-source",
		}),
		id,
	);
	const preview = previewMemoryOwnershipRecovery(store, { version: 1, memoryIds: [id] });
	expect(preview.records[0]?.recoveredVisibility).toBe("private");
	const result = commitMemoryOwnershipRecovery(store, confirmed([id]));
	const row = store.db
		.prepare("SELECT visibility, metadata_json FROM memory_items WHERE id = ?")
		.get(result.copies[0]?.recoveredMemoryId) as { visibility: string; metadata_json: string };
	expect(row.visibility).toBe("private");
	const metadata = JSON.parse(row.metadata_json);
	expect(metadata.signature).toBeUndefined();
	expect(metadata.recovery.original_metadata.signature).toBe("historical-claim");
	expect(metadata.origin_device_id).toBe(store.deviceId);
});

it("rejects stale reviewed content and identity changes", () => {
	const id = memory();
	const input = confirmed([id]);
	store.db.prepare("UPDATE memory_items SET body_text = 'changed' WHERE id = ?").run(id);
	expect(() => commitMemoryOwnershipRecovery(store, input)).toThrow("ownership_preview_stale");
	vi.stubEnv("CODEMEM_ACTOR_ID", "changed");
	expect(() => commitMemoryOwnershipRecovery(store, input)).toThrow("ownership_identity_changed");
	expect(count("memory_source_bindings")).toBe(0);
});

it("rolls back copies, identities, sessions and receipts together after a write failure", () => {
	const ids = [memory(), memory()];
	store.db
		.prepare("UPDATE memory_items SET files_read = ?, concepts = ?")
		.run('["src/rollback.ts"]', '["rollback"]');
	const input = confirmed(ids);
	store.db.exec(
		"CREATE TRIGGER fail_receipt BEFORE INSERT ON memory_ownership_recoveries BEGIN SELECT RAISE(ABORT, 'fixture_crash'); END;",
	);
	expect(() => commitMemoryOwnershipRecovery(store, input)).toThrow("fixture_crash");
	expect(count("memory_items")).toBe(2);
	expect(count("sessions")).toBe(2);
	expect(count("memory_source_bindings")).toBe(0);
	expect(count("memory_ownership_recoveries")).toBe(0);
	expect(count("memory_file_refs")).toBe(0);
	expect(count("memory_concept_refs")).toBe(0);
	expect(vectors.storeVectors).not.toHaveBeenCalled();
	store.db.exec("DROP TRIGGER fail_receipt");
	expect(commitMemoryOwnershipRecovery(store, input).copies).toHaveLength(2);
});

it("indexes redacted copied refs for file and concept retrieval", () => {
	const id = memory();
	store.db
		.prepare(
			"UPDATE memory_items SET files_read = ?, files_modified = ?, concepts = ? WHERE id = ?",
		)
		.run('["src/old.ts"]', '["src/modified.ts"]', '["Old Concept"]', id);
	const redact = store.scanner.redactValue.bind(store.scanner);
	vi.spyOn(store.scanner, "redactValue").mockImplementation((value) => {
		const result = redact(value);
		if (result.value && typeof result.value === "object" && "files_read" in result.value) {
			Object.assign(result.value, {
				files_read: '["src/redacted.ts"]',
				concepts: '["Redacted Concept"]',
			});
		}
		return result;
	});
	const result = commitMemoryOwnershipRecovery(store, confirmed([id]));
	const copy = result.copies[0]?.recoveredMemoryId;
	expect(store.findByFile("src/redacted.ts").map((row) => row.id)).toContain(copy);
	expect(store.findByFile("src/modified.ts").map((row) => row.id)).toContain(copy);
	expect(store.findByConcept("redacted concept").map((row) => row.id)).toContain(copy);
	expect(store.findByFile("src/old.ts").map((row) => row.id)).not.toContain(copy);
	expect(store.findByConcept("old concept").map((row) => row.id)).not.toContain(copy);
});

it("queues embeddings after commit using stored text, drains best-effort failures and skips receipt replay", async () => {
	const input = confirmed([memory()]);
	const observations: unknown[] = [];
	const write = vi.mocked(vectors.storeVectors).mockImplementation(async (db, id, title, body) => {
		observations.push({
			inTransaction: db.inTransaction,
			receipts: count("memory_ownership_recoveries"),
			row: db.prepare("SELECT title, body_text FROM memory_items WHERE id = ?").get(id),
			title,
			body,
		});
		throw new Error("embedding runtime unavailable");
	});
	const result = commitMemoryOwnershipRecovery(store, input);
	expect(observations).toEqual([
		{
			inTransaction: false,
			receipts: 1,
			row: { title: "Fixture title", body_text: "Fixture body" },
			title: "Fixture title",
			body: "Fixture body",
		},
	]);
	expect(write).toHaveBeenCalledTimes(1);
	expect(write.mock.calls[0]?.[1]).toBe(result.copies[0]?.recoveredMemoryId);
	await expect(store.flushPendingVectorWrites()).resolves.toBeUndefined();
	expect(commitMemoryOwnershipRecovery(store, input).idempotent).toBe(true);
	expect(write).toHaveBeenCalledTimes(1);
});

it("rejects an outer transaction before creating copies or scheduling embeddings", () => {
	const input = confirmed([memory()]);
	expect(() => store.db.transaction(() => commitMemoryOwnershipRecovery(store, input))()).toThrow(
		"ownership_outer_transaction_not_supported",
	);
	expect(count("memory_items")).toBe(1);
	expect(vectors.storeVectors).not.toHaveBeenCalled();
});

it("rejects operation id reuse with another readable request", () => {
	const id = memory();
	const input = confirmed([id]);
	commitMemoryOwnershipRecovery(store, input);
	expect(() => commitMemoryOwnershipRecovery(store, confirmed([memory()]))).toThrow(
		"ownership_recovery_operation_conflict",
	);
});

function revokeRecoveryAccess(id: number, access: string) {
	if (access === "unreadable") {
		store.db.prepare("UPDATE memory_items SET scope_id = 'inaccessible' WHERE id = ?").run(id);
		return;
	}
	store.db
		.prepare("UPDATE memory_items SET visibility = 'private', actor_id = 'peer' WHERE id = ?")
		.run(id);
}

function recoveryState() {
	return [
		"memory_items",
		"sessions",
		"memory_source_bindings",
		"memory_ownership_recoveries",
		"memory_file_refs",
		"memory_concept_refs",
		"replication_ops",
	].map((table) => store.db.prepare(`SELECT * FROM ${table}`).all());
}

it.each(
	["unreadable", "private"].flatMap((access) =>
		["selection", "digest", "actor", "device"].map((conflict) => ({ access, conflict })),
	),
)(
	"returns only operation conflict for $conflict reuse with $access records",
	async ({ access, conflict }) => {
		const id = memory();
		const input = confirmed([id]);
		commitMemoryOwnershipRecovery(store, input);
		await store.flushPendingVectorWrites();
		vi.mocked(vectors.storeVectors).mockClear();
		const enqueue = vi.spyOn(store, "enqueueVectorWrite");
		const retry = { ...input };
		let deniedId = id;
		if (conflict === "selection") {
			deniedId = memory();
			retry.memoryIds = [deniedId];
		} else if (conflict === "digest") {
			retry.reviewedDigest = `ownership-recovery-v1:${"0".repeat(64)}`;
		} else if (conflict === "actor") {
			store.db.prepare("UPDATE memory_ownership_recoveries SET actor_id = 'other-actor'").run();
		} else {
			store.db.prepare("UPDATE memory_ownership_recoveries SET device_id = 'other-device'").run();
		}
		revokeRecoveryAccess(deniedId, access);
		const before = recoveryState();
		expect(() => commitMemoryOwnershipRecovery(store, retry)).toThrow(
			expect.objectContaining({ code: "ownership_recovery_operation_conflict", status: 409 }),
		);
		const app = memoryOwnershipRoutes(() => store);
		const response = await app.request("/api/memories/ownership/commit", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(retry),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "ownership_recovery_operation_conflict",
			nextAction: "start_new_preview",
		});
		expect(store.db.inTransaction).toBe(false);
		expect(recoveryState()).toEqual(before);
		expect(enqueue).not.toHaveBeenCalled();
		expect(vectors.storeVectors).not.toHaveBeenCalled();
	},
);

it.each([
	{ access: "unreadable", error: "ownership_records_unavailable", status: 404 },
	{ access: "private", error: "ownership_private_record_not_owned", status: 403 },
])(
	"still denies a matching receipt retry after $access access revocation",
	({ access, error, status }) => {
		const id = memory();
		const input = confirmed([id]);
		commitMemoryOwnershipRecovery(store, input);
		vi.mocked(vectors.storeVectors).mockClear();
		revokeRecoveryAccess(id, access);
		const before = recoveryState();
		expect(() => commitMemoryOwnershipRecovery(store, input)).toThrow(
			expect.objectContaining({ message: error, code: error, status }),
		);
		expect(recoveryState()).toEqual(before);
		expect(vectors.storeVectors).not.toHaveBeenCalled();
	},
);

it("validates request structure before comparing an existing receipt", () => {
	const input = confirmed([memory()]);
	commitMemoryOwnershipRecovery(store, input);
	expect(() => commitMemoryOwnershipRecovery(store, { ...input, memoryIds: [] })).toThrow(
		expect.objectContaining({ code: "ownership_request_invalid", status: 400 }),
	);
	expect(() =>
		commitMemoryOwnershipRecovery(store, { ...input, reviewedDigest: "invalid" }),
	).toThrow(expect.objectContaining({ code: "ownership_confirmation_required", status: 400 }));
});

it("rejects a concurrent capture edit observed through a second database connection", () => {
	const id = memory();
	const input = confirmed([id]);
	const other = connect(join(directory, "test.sqlite"));
	try {
		other
			.prepare(
				"UPDATE memory_items SET rev = rev + 1, body_text = 'concurrent capture' WHERE id = ?",
			)
			.run(id);
	} finally {
		other.close();
	}
	expect(() => commitMemoryOwnershipRecovery(store, input)).toThrow("ownership_preview_stale");
});

it("replays a durable receipt after reopening without duplicating copies", () => {
	const input = confirmed([memory()]);
	const result = commitMemoryOwnershipRecovery(store, input);
	store.close();
	store = new MemoryStore(join(directory, "test.sqlite"));
	expect(commitMemoryOwnershipRecovery(store, input)).toEqual({ ...result, idempotent: true });
	expect(count("memory_items")).toBe(2);
});

it("executes the HTTP preview and commit contract through a mounted route factory", async () => {
	const app = memoryOwnershipRoutes(() => store);
	const send = (action: string, value: unknown) =>
		app.request(`/api/memories/ownership/${action}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(value),
		});
	const input = { version: 1, memoryIds: [memory()] };
	const checked = await send("verify", input);
	expect(checked.status).toBe(200);
	const response = await send("preview", input);
	expect(response.status).toBe(200);
	const preview = await response.json();
	expect(preview.records[0].recipientDeviceIds).toEqual([]);
	const committed = await send("commit", {
		...input,
		reviewedDigest: preview.reviewedDigest,
		operationId: "http_fixture_operation",
		acknowledgeOriginalsRetained: true,
	});
	expect(committed.status).toBe(200);
	expect((await committed.json()).copies).toHaveLength(1);
	const invalid = await send("preview", { version: 2, memoryIds: [] });
	expect(invalid.status).toBe(400);
});
