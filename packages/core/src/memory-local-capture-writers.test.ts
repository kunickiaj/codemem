import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { exportMemories, importMemories } from "./export-import.js";
import { buildFilterClausesWithContext } from "./filters.js";
import { localCreationSourceIds } from "./memory-local-capture.js";
import {
	now,
	reset,
	scopeId,
	useLocalCaptureFixture,
} from "./memory-local-capture-test-fixtures.js";
import {
	getVerifiedMemorySource,
	verifyAuthenticatedMemorySource,
} from "./memory-source-identity.js";
import { applyBootstrapSnapshot, mergeBootstrapSnapshot } from "./sync-bootstrap.js";
import { initTestSchema } from "./test-utils.js";
import type { SyncMemorySnapshotItem } from "./types.js";

const { fixture, remember, row, restrict, binding, enroll, ledger } = useLocalCaptureFixture();
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
	expect(fixture.store.get(controlled)).toBeNull();
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
		fixture.store.db
			.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_local_capture'")
			.get(),
	).toBeUndefined();
	expect(fixture.store.db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(1);
});
it("real export/import does not carry author proof into another database", () => {
	// Arrange
	const id = remember();
	const payload = exportMemories({ dbPath: fixture.store.dbPath, allProjects: true });
	const targetPath = join(fixture.dir, "imported.sqlite");
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
				metadata_json: { local_creation: true, source_device_id: fixture.store.deviceId },
			}),
		};
		// Act
		const result = apply(fixture.store.db, "peer", [item], reset);
		// Assert
		expect(result.ok).toBe(true);
		expect(result.applied).toBe(1);
		expect(ledger()).toEqual(before);
		expect(getVerifiedMemorySource(fixture.store.db, item.entity_id)).toBeNull();
		const importedId = fixture.store.db
			.prepare("SELECT id FROM memory_items WHERE import_key = ?")
			.pluck()
			.get(item.entity_id) as number;
		expect(fixture.store.get(importedId)).toBeNull();
		expect(binding(id)?.evidence).toBe("local_creation");
	},
);
it("authenticated namespace proof is not local_creation evidence", () => {
	// Arrange
	remember();
	enroll();
	const entityId = `memory-source-v1:${Buffer.from(fixture.store.deviceId).toString("base64url")}:00000000-0000-4000-8000-000000000001`;
	fixture.store.db.transaction(() =>
		verifyAuthenticatedMemorySource(fixture.store.db, {
			entityId,
			verifiedPeerDeviceId: fixture.store.deviceId,
		}),
	)();
	// Act
	const imported = remember("Authenticated import", {
		import_key: entityId,
		origin_device_id: "local",
	});
	restrict(imported);
	// Assert
	expect(binding(imported)?.evidence).toBe("authenticated_namespace");
	expect(fixture.store.get(imported)).toBeNull();
});
it("failed genuine creation rolls back memory, unsigned birth and source binding together", () => {
	// Arrange
	fixture.store.db.exec(
		"CREATE TRIGGER fail_capture BEFORE INSERT ON memory_items BEGIN SELECT RAISE(ABORT, 'capture_insert_failed'); END",
	);
	// Act
	expect(() => remember()).toThrow("capture_insert_failed");
	// Assert
	expect(fixture.store.db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(0);
	expect(
		fixture.store.db.prepare("SELECT COUNT(*) FROM memory_source_bindings").pluck().get(),
	).toBe(0);
	expect(
		fixture.store.db
			.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_local_capture'")
			.get(),
	).toBeUndefined();
	fixture.store.db.exec("DROP TRIGGER fail_capture");
	const retry = remember();
	expect(binding(retry)?.evidence).toBe("local_creation");
});
it.each(["old", "current"])(
	"readonly %s database lookups perform no DDL, key repair or fact creation",
	(version) => {
		// Arrange
		if (version === "current") remember();
		const trace: string[] = [];
		const db = new Database(fixture.store.dbPath, {
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
			expect(existsSync(fixture.keysDir)).toBe(false);
		} finally {
			db.close();
		}
	},
);
