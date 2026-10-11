import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { exportMemories } from "./export-import.js";
import { buildFilterClausesWithContext } from "./filters.js";
import { refreshManagedScopeFixture } from "./managed-scope-test-fixtures.js";
import { reset, scopeId, useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";
import { getVerifiedMemorySource } from "./memory-source-identity.js";
import { buildMemoryPackWithTrace } from "./pack.js";
import { MemoryStore } from "./store.js";
import { applyBootstrapSnapshot, mergeBootstrapSnapshot } from "./sync-bootstrap.js";
import * as syncIdentity from "./sync-identity.js";
import { applyReplicationOps } from "./sync-replication.js";
import type { MemoryResult, ReplicationOp } from "./types.js";

const {
	fixture,
	remember,
	rememberScoped,
	row,
	restrict,
	binding,
	captureOp,
	enroll,
	factRows,
	ledger,
} = useLocalCaptureFixture();

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected test network request"));
});

function reopen() {
	fixture.store.close();
	fixture.store = new MemoryStore(join(fixture.dir, "memory.sqlite"), { keysDir: fixture.keysDir });
}
function readState() {
	return {
		...ledger(),
		snapshots: factRows("memory_local_creation_snapshots"),
		memberships: factRows("scope_memberships"),
		scopes: factRows("replication_scopes"),
		devices: factRows("sync_device"),
		memories: factRows("memory_items"),
		sessions: factRows("sessions"),
		operations: factRows("replication_ops"),
		revisions: factRows("memory_foreign_revisions"),
		schema: fixture.store.db
			.prepare("SELECT name, type, sql FROM sqlite_master ORDER BY name")
			.all(),
	};
}
function assertReadOnly(before: ReturnType<typeof readState>, ensure: ReturnType<typeof vi.spyOn>) {
	expect(readState()).toEqual(before);
	expect(ensure).not.toHaveBeenCalled();
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(fixture.store.isScopeWritable(scopeId)).toBe(false);
}
function exportKeys() {
	return exportMemories({
		dbPath: fixture.store.dbPath,
		keysDir: fixture.keysDir,
		allProjects: true,
	}).memory_items.map((item) => item.import_key);
}
function foreignRevision(
	id: number,
	options: { preserveContent?: boolean } = {},
): ReplicationOp & { payload_json: string } {
	const op = captureOp(id);
	if (op.payload_json === null) throw new Error("capture upsert requires a JSON payload");
	const incoming = {
		...op,
		payload_json: op.payload_json,
		op_id: `foreign-${op.op_id}`,
		device_id: "peer",
		scope_id: scopeId,
		clock_rev: op.clock_rev + 100,
		clock_device_id: fixture.store.deviceId,
	};
	if (options.preserveContent) return incoming;
	const payload = JSON.parse(op.payload_json ?? "{}");
	payload.title = "Foreign replacement";
	payload.body_text = "Peer-authored replacement body";
	return {
		...incoming,
		payload_json: JSON.stringify({
			...payload,
			scope_id: scopeId,
			actor_id: "peer-actor",
			origin_device_id: "local",
			metadata_json: { clock_device_id: fixture.store.deviceId, local_creation: true },
		}),
	};
}

it.each(["replication", "snapshot replace", "snapshot merge"])(
	"%s cannot reuse original proof for foreign same-key content",
	async (transport) => {
		// Arrange: proof comes from the maintained writer, not from peer labels.
		const id = remember();
		enroll();
		await refreshManagedScopeFixture(fixture.store.db, {
			keysDir: fixture.keysDir,
			deviceId: fixture.store.deviceId,
			scopeIds: [scopeId],
		});
		const control = rememberScoped("Unchanged genuine control");
		const originalBinding = binding(id);
		const incoming = foreignRevision(id);
		// Act: apply a new revision through the real transport boundary.
		if (transport === "replication")
			expect(
				applyReplicationOps(fixture.store.db, [incoming], fixture.store.deviceId).applied,
			).toBe(1);
		else {
			const apply =
				transport === "snapshot replace" ? applyBootstrapSnapshot : mergeBootstrapSnapshot;
			expect(
				apply(fixture.store.db, "peer", [{ ...incoming, op_type: "upsert" }], reset),
			).toMatchObject({
				ok: true,
				applied: 1,
			});
		}
		const foreignId = fixture.store.db
			.prepare("SELECT id FROM memory_items WHERE import_key = ? AND scope_id = ?")
			.pluck()
			.get(incoming.entity_id, scopeId) as number;
		expect(fixture.store.get(foreignId)?.body_text).toBe("Peer-authored replacement body");
		fixture.store.db
			.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
			.run(scopeId);
		const before = readState();
		const ensure = vi.spyOn(syncIdentity, "ensureDeviceIdentity");
		// Assert: permission loss exposes only unchanged genuine history.
		expect(fixture.store.get(foreignId)).toBeNull();
		expect(fixture.store.search("Foreign replacement", 10).map((item) => item.id)).not.toContain(
			foreignId,
		);
		expect(binding(foreignId)).toEqual(originalBinding);
		if (transport !== "snapshot replace") expect(fixture.store.get(control)?.id).toBe(control);
		assertReadOnly(before, ensure);
		const claimed = rememberScoped("Caller cannot reclaim original", {
			import_key: incoming.entity_id,
			origin_device_id: fixture.store.deviceId,
			clock_device_id: fixture.store.deviceId,
		});
		expect(fixture.store.get(claimed)).toBeNull();
	},
);

it("explicit scope exclusions remove genuine historical capture from pack and trace", () => {
	// Arrange
	const id = rememberScoped("Scope exclusion capture");
	const before = readState();
	const ensure = vi.spyOn(syncIdentity, "ensureDeviceIdentity");
	// Act
	const included = buildMemoryPackWithTrace(fixture.store, "Scope exclusion capture", 10);
	const excluded = buildMemoryPackWithTrace(fixture.store, "Scope exclusion capture", 10, null, {
		exclude_scope_ids: [scopeId],
	});
	// Assert
	expect(included.response.item_ids).toContain(id);
	expect(excluded.response.item_ids).not.toContain(id);
	expect(excluded.trace.retrieval.candidates.map((item) => item.id)).not.toContain(id);
	assertReadOnly(before, ensure);
});

it("unsigned genuine history remains readable without generating keys", () => {
	// Arrange
	const first = rememberScoped();
	const second = remember("Second capture");
	const before = readState();
	const ensure = vi.spyOn(syncIdentity, "ensureDeviceIdentity");
	// Act
	const result = fixture.store.get(first);
	// Assert
	expect(result?.id).toBe(first);
	expect(row(first).import_key).not.toBe(row(second).import_key);
	expect(binding(first)?.evidence).toBe("local_creation");
	expect(ledger().birth).toHaveLength(1);
	expect(ledger().adoption).toEqual([]);
	expect(existsSync(fixture.keysDir)).toBe(false);
	assertReadOnly(before, ensure);
});

it("adopted genuine history survives permission loss, export and reopen without writes", async () => {
	// Arrange
	const id = rememberScoped();
	enroll();
	await refreshManagedScopeFixture(fixture.store.db, {
		keysDir: fixture.keysDir,
		deviceId: fixture.store.deviceId,
		scopeIds: [scopeId],
	});
	expect(fixture.store.isScopeWritable(scopeId)).toBe(true);
	fixture.store.db
		.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
		.run(scopeId);
	const before = readState();
	const keys = readFileSync(join(fixture.keysDir, "device.key"));
	const ensure = vi.spyOn(syncIdentity, "ensureDeviceIdentity");
	// Act
	const result = fixture.store.get(id);
	const hits = fixture.store.search("Genuine capture", 10);
	const exported = exportKeys();
	reopen();
	// Assert
	expect(result?.id).toBe(id);
	expect(hits.map((item) => item.id)).toContain(id);
	expect(exported).toContain(row(id).import_key);
	expect(fixture.store.get(id)?.id).toBe(id);
	expect(fixture.store.forgetForUser(id)).toBe(false);
	expect(() => fixture.store.updateMemoryVisibilityForUser(id, "private")).toThrow(
		"memory not found",
	);
	expect(() => fixture.store.moveMemoryProjectForUser(id, "other-project")).toThrow(
		"memory not found",
	);
	expect(readFileSync(join(fixture.keysDir, "device.key"))).toEqual(keys);
	assertReadOnly(before, ensure);
});

it.each(["local", null, "capture-device"])(
	"raw historical origin %s cannot replace genuine proof",
	(origin) => {
		// Arrange: the imported control has no prospective local creation fact.
		const good = rememberScoped();
		const historical = remember("Old ambiguous row", { import_key: "historical-uuid" });
		fixture.store.db
			.prepare("UPDATE memory_items SET origin_device_id = ? WHERE id = ?")
			.run(origin, historical);
		restrict(historical);
		enroll();
		const before = readState();
		const ensure = vi.spyOn(syncIdentity, "ensureDeviceIdentity");
		// Act
		const result = fixture.store.get(historical);
		// Assert
		expect(fixture.store.get(good)?.id).toBe(good);
		expect(result).toBeNull();
		expect(binding(historical)).toBeNull();
		assertReadOnly(before, ensure);
	},
);

it.each(["local", null, "capture-device"])(
	"replica origin %s and caller flags cannot mint local authorship",
	(origin) => {
		// Arrange
		const good = rememberScoped();
		enroll();
		const op = captureOp(good);
		const forged = {
			...op,
			op_id: "copied-op",
			entity_id: "copied-replica",
			device_id: "peer",
			clock_device_id: "peer",
			clock_rev: 10,
			payload_json: JSON.stringify({
				...JSON.parse(op.payload_json ?? "{}"),
				origin_device_id: origin,
				scope_id: scopeId,
				metadata_json: { local_creation: true, source_device_id: fixture.store.deviceId },
			}),
		};
		const facts = ledger();
		// Act
		const applied = applyReplicationOps(fixture.store.db, [forged], fixture.store.deviceId);
		const copiedId = fixture.store.db
			.prepare("SELECT id FROM memory_items WHERE import_key = ?")
			.pluck()
			.get(forged.entity_id) as number;
		const before = readState();
		const ensure = vi.spyOn(syncIdentity, "ensureDeviceIdentity");
		// Assert
		expect(applied.applied).toBe(1);
		expect(fixture.store.get(good)?.id).toBe(good);
		expect(fixture.store.get(copiedId)).toBeNull();
		expect(getVerifiedMemorySource(fixture.store.db, forged.entity_id)).toBeNull();
		expect(ledger()).toEqual(facts);
		assertReadOnly(before, ensure);
	},
);

it.each(["resolved", "fallback"])(
	"%s filters admit matching capture and reject unproven control",
	(mode) => {
		// Arrange
		const good = rememberScoped();
		const foreign = rememberScoped("Foreign filter control", { import_key: "foreign-filter" });
		enroll();
		const before = readState();
		const ensure = vi.spyOn(syncIdentity, "ensureDeviceIdentity");
		const context = fixture.store.ownershipFilterContext();
		if (mode === "fallback") delete context.visibleScopeIds;
		// Act
		const filters = buildFilterClausesWithContext({}, context);
		const ids = fixture.store.db
			.prepare(`SELECT id FROM memory_items WHERE ${filters.clauses.join(" AND ")}`)
			.pluck()
			.all(...filters.params);
		// Assert
		expect(ids).toContain(good);
		expect(ids).not.toContain(foreign);
		assertReadOnly(before, ensure);
	},
);

it("mixed export includes genuine history but redacts foreign memories and foreign-only sessions", () => {
	// Arrange
	const good = rememberScoped("Export genuine history");
	const foreignSession = fixture.store.startSession({
		cwd: "/fixture/foreign-only",
		project: "foreign-only",
	});
	const foreign = fixture.store.remember(
		foreignSession,
		"discovery",
		"Export foreign history",
		"Foreign private body",
		0.8,
		[],
		{ import_key: "foreign-export" },
	);
	restrict(foreign);
	enroll();
	const before = readState();
	const ensure = vi.spyOn(syncIdentity, "ensureDeviceIdentity");
	// Act
	const exported = exportMemories({
		dbPath: fixture.store.dbPath,
		keysDir: fixture.keysDir,
		allProjects: true,
	});
	// Assert
	expect(exported.memory_items.map((item) => item.import_key)).toContain(row(good).import_key);
	expect(exported.memory_items.map((item) => item.import_key)).not.toContain(
		row(foreign).import_key,
	);
	expect(exported.sessions.map((session) => session.id)).not.toContain(foreignSession);
	expect(JSON.stringify(exported)).not.toContain("Foreign private body");
	expect(JSON.stringify(exported)).not.toContain("foreign-only");
	assertReadOnly(before, ensure);
});

function candidate(id: number): MemoryResult {
	const memory = row(id);
	return {
		id,
		kind: "discovery",
		title: String(memory.title),
		body_text: String(memory.body_text),
		confidence: 0.8,
		tags_text: "",
		metadata: {},
		score: 0.9,
		session_id: Number(memory.session_id),
		created_at: String(memory.created_at),
		updated_at: String(memory.updated_at),
		narrative: null,
		facts: null,
	};
}

it("mixed semantic and file pack candidates revalidate historical proof before output", () => {
	// Arrange: both genuine and imported candidates share the indexed file path.
	const good = rememberScoped("Pack genuine history", { files_read: ["src/history.ts"] });
	const foreign = rememberScoped("Pack foreign history", {
		import_key: "foreign-pack",
		files_read: ["src/history.ts"],
	});
	enroll();
	const before = readState();
	const ensure = vi.spyOn(syncIdentity, "ensureDeviceIdentity");
	// Act
	const semantic = buildMemoryPackWithTrace(fixture.store, "zzz_nomatch_zzz", 10, null, undefined, [
		candidate(foreign),
		candidate(good),
	]);
	const file = buildMemoryPackWithTrace(fixture.store, "src/history.ts", 10);
	// Assert
	for (const pack of [semantic, file]) {
		expect(pack.response.item_ids).toContain(good);
		expect(pack.response.item_ids).not.toContain(foreign);
		expect(pack.trace.retrieval.candidates.map((item) => item.id)).not.toContain(foreign);
		expect(pack.response.pack_text).not.toContain("Pack foreign history");
	}
	assertReadOnly(before, ensure);
});

it("unchanged content in an applied foreign revision loses historical authority", async () => {
	// Arrange
	const good = rememberScoped("Untouched genuine control");
	const id = rememberScoped("Unchanged foreign revision");
	enroll();
	await refreshManagedScopeFixture(fixture.store.db, {
		keysDir: fixture.keysDir,
		deviceId: fixture.store.deviceId,
		scopeIds: [scopeId],
	});
	const body = row(id).body_text;
	const incoming = foreignRevision(id, { preserveContent: true });
	// Act
	const result = applyReplicationOps(fixture.store.db, [incoming], fixture.store.deviceId);
	fixture.store.db
		.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
		.run(scopeId);
	const before = readState();
	const ensure = vi.spyOn(syncIdentity, "ensureDeviceIdentity");
	// Assert: content equality does not erase a foreign write boundary.
	expect(result).toMatchObject({ applied: 1, errors: [] });
	expect(row(id).body_text).toBe(body);
	expect(factRows("memory_foreign_revisions")).toContainEqual(
		expect.objectContaining({ entity_id: incoming.entity_id, write_path: "replication" }),
	);
	expect(fixture.store.get(good)?.id).toBe(good);
	expect(fixture.store.get(id)).toBeNull();
	expect(exportKeys()).not.toContain(row(id).import_key);
	assertReadOnly(before, ensure);
});

it("actual key disappearance after adoption denies history without repairing keys or facts", () => {
	// Arrange
	const id = rememberScoped();
	enroll();
	expect(fixture.store.get(id)?.id).toBe(id);
	const path = join(fixture.keysDir, "device.key");
	renameSync(path, `${path}.fixture-backup`);
	const before = readState();
	const ensure = vi.spyOn(syncIdentity, "ensureDeviceIdentity");
	// Act
	const result = fixture.store.get(id);
	const hits = fixture.store.search("Genuine capture", 10);
	const exported = exportKeys();
	reopen();
	// Assert
	expect(result).toBeNull();
	expect(hits.map((item) => item.id)).not.toContain(id);
	expect(exported).not.toContain(row(id).import_key);
	expect(fixture.store.get(id)).toBeNull();
	expect(existsSync(path)).toBe(false);
	assertReadOnly(before, ensure);
});
