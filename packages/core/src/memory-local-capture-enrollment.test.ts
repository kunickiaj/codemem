import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import {
	enrollFixtureSigningKey,
	refreshManagedScopeFixture,
} from "./managed-scope-test-fixtures.js";
import { hasMatchingLocalCreation } from "./memory-creation-provenance.js";
import { adoptLocalCapture, localCreationSourceIds } from "./memory-local-capture.js";
import { now, scopeId, useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";
import { MemoryStore } from "./store.js";
import * as syncIdentity from "./sync-identity.js";
import { ensureDeviceIdentity, loadRuntimeSigningPublicKey } from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

const {
	fixture,
	remember,
	rememberScoped,
	row,
	restrict,
	binding,
	persistUnadoptedIdentity,
	factRows,
	ledger,
} = useLocalCaptureFixture();

function ensure() {
	return ensureDeviceIdentity(fixture.store.db, {
		keysDir: fixture.keysDir,
		deviceId: "capture-device",
	});
}

function reopen(keysDir = fixture.keysDir) {
	fixture.store.close();
	fixture.store = new MemoryStore(join(fixture.dir, "memory.sqlite"), { keysDir });
}

function keyBytes() {
	return readFileSync(join(fixture.keysDir, "device.key"));
}

function actualSources(deviceId = "capture-device") {
	const publicKey = loadRuntimeSigningPublicKey(fixture.store.db, {
		deviceId,
		keysDir: fixture.keysDir,
	});
	return localCreationSourceIds(fixture.store.db, deviceId, {
		expectedPublicKey: publicKey ?? undefined,
	});
}

function createOtherSigningKey(): string {
	const keysDir = join(fixture.dir, "other-keys");
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		enrollFixtureSigningKey(db, keysDir, "other");
		return keysDir;
	} finally {
		db.close();
	}
}

it.each(["fallback actor", "configured actor"])(
	"maintained enrollment writer adopts pending capture for %s before reopen",
	(actorMode) => {
		// Arrange: genuine unsigned creation precedes device enrollment.
		if (actorMode === "configured actor") {
			vi.stubEnv("CODEMEM_ACTOR_ID", "configured-owner");
			reopen();
		}
		const id = rememberScoped();
		const original = row(id);
		const before = ledger();
		expect(fixture.store.get(id)?.id).toBe(id);
		// Act: exercise the maintained API; reopening itself must not create facts.
		const [deviceId] = ensure();
		const keys = keyBytes();
		const adopted = ledger();
		reopen();
		// Assert: only the association is new, not memory/source history or reader authority.
		expect(adopted.adoption).toHaveLength(1);
		expect(adopted.birth).toEqual(before.birth);
		expect(adopted.bindings).toEqual(before.bindings);
		expect(actualSources(deviceId)).toContain(binding(id)?.sourceDeviceId);
		expect(
			hasMatchingLocalCreation(
				fixture.store.db,
				String(row(id).import_key),
				actualSources(deviceId),
			),
		).toBe(true);
		expect(row(id)).toEqual(original);
		expect(ledger()).toEqual(adopted);
		expect(keyBytes().equals(keys)).toBe(true);
		expect(fixture.store.deviceId).toBe(deviceId);
		expect(fixture.store.get(id)?.id).toBe(id);
		if (actorMode === "configured actor") expect(fixture.store.actorId).toBe("configured-owner");
	},
);

it("explicit reensure adopts a pending capture while constructor and reads leave it unadopted", () => {
	// Arrange: preserve a legitimate older tuple and its actual private key.
	const id = rememberScoped();
	persistUnadoptedIdentity();
	const keys = keyBytes();
	const before = ledger();
	const devices = factRows("sync_device");
	reopen();
	expect(fixture.store.get(id)).toBeNull();
	expect(ledger()).toEqual(before);
	// Act
	const first = ensure();
	const adopted = ledger();
	const replay = ensure();
	// Assert: one-time association never rewrites creation facts or keys.
	expect(replay).toEqual(first);
	expect(adopted.adoption).toHaveLength(1);
	expect(adopted.birth).toEqual(before.birth);
	expect(adopted.bindings).toEqual(before.bindings);
	expect(ledger()).toEqual(adopted);
	expect(factRows("sync_device")).toEqual(devices);
	expect(actualSources()).toContain(binding(id)?.sourceDeviceId);
	expect(
		hasMatchingLocalCreation(fixture.store.db, String(row(id).import_key), actualSources()),
	).toBe(true);
	expect(keyBytes().equals(keys)).toBe(true);
	expect(fixture.store.get(id)?.id).toBe(id);
});

it.each(["other connection enrollment", "environment device mismatch"])(
	"ordinary remember succeeds without proof after %s",
	(mismatch) => {
		// Arrange: the writer still holds its original runtime identity.
		remember("Prior genuine capture");
		const unsigned = ledger();
		const other = new Database(fixture.store.dbPath);
		try {
			ensureDeviceIdentity(other, { keysDir: fixture.keysDir, deviceId: "capture-device" });
		} finally {
			other.close();
		}
		const before = ledger();
		expect(before.adoption).toHaveLength(1);
		expect(before.birth).toEqual(unsigned.birth);
		expect(before.bindings).toEqual(unsigned.bindings);
		const keys = keyBytes();
		if (mismatch === "environment device mismatch") {
			vi.stubEnv("CODEMEM_DEVICE_ID", "different-runtime-device");
			reopen();
		}
		// Act
		const ids = [remember("Ingest first"), remember("Ingest second")];
		// Assert: provenance denial must not drop ordinary ingest.
		for (const id of ids) {
			expect(row(id).active).toBe(1);
			expect(binding(id)).toBeNull();
			expect(fixture.store.get(id)?.id).toBe(id);
		}
		expect(ledger()).toEqual(before);
		expect(keyBytes().equals(keys)).toBe(true);
	},
);

it("failed identity persistence rolls back adoption without losing genuine creation evidence", () => {
	// Arrange
	const id = remember();
	const before = ledger();
	const original = row(id);
	persistUnadoptedIdentity();
	fixture.store.db
		.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
	 VALUES ('local:local', 'Local owner', 1, 'active', ?, ?)`)
		.run(now, now);
	const actors = factRows("actors");
	const listener = vi.fn();
	fixture.store.onIdentityChanged(listener);
	const devices = factRows("sync_device");
	const keys = keyBytes();
	fixture.store.db.exec(
		"CREATE TRIGGER fail_adoption BEFORE UPDATE ON memory_items BEGIN SELECT RAISE(ABORT, 'actor_update_failed'); END",
	);
	// Act
	expect(() => fixture.store.adoptEnsuredDeviceIdentity("capture-device")).toThrow(
		"actor_update_failed",
	);
	// Assert: no runtime identity or association escapes the failed transaction.
	expect(fixture.store.deviceId).toBe("local");
	expect(ledger()).toEqual(before);
	expect(row(id)).toEqual(original);
	expect(factRows("actors")).toEqual(actors);
	expect(listener).not.toHaveBeenCalled();
	expect(factRows("sync_device")).toEqual(devices);
	expect(keyBytes().equals(keys)).toBe(true);
	fixture.store.db.exec("DROP TRIGGER fail_adoption");
	fixture.store.adoptEnsuredDeviceIdentity("capture-device");
	expect(ledger().adoption).toHaveLength(1);
	expect(binding(id)?.evidence).toBe("local_creation");
	expect(listener).toHaveBeenCalledTimes(1);
	expect(fixture.store.deviceId).toBe("capture-device");
});

it.each(["wrong-device", "wrong-private-key", "wrong-fingerprint"])(
	"%s cannot adopt or read unsigned capture history",
	(failure) => {
		// Arrange
		const id = rememberScoped();
		restrict(id);
		if (failure === "wrong-private-key") reopen(createOtherSigningKey());
		persistUnadoptedIdentity();
		const before = ledger();
		const keys = keyBytes();
		if (failure === "wrong-fingerprint")
			fixture.store.db.prepare("UPDATE sync_device SET fingerprint = 'mismatch'").run();
		const loadKey = vi.spyOn(syncIdentity, "loadRuntimeSigningPublicKey");
		expect(fixture.store.hasCurrentConfiguredIdentity()).toBe(true);
		const devices = factRows("sync_device");
		// Act
		fixture.store.adoptEnsuredDeviceIdentity(
			failure === "wrong-device" ? "different-device" : "capture-device",
		);
		// Assert
		expect(ledger()).toEqual(before);
		expect(fixture.store.get(id)).toBeNull();
		expect(binding(id)?.evidence).toBe("local_creation");
		expect(factRows("sync_device")).toEqual(devices);
		expect(keyBytes().equals(keys)).toBe(true);
		if (failure === "wrong-private-key") {
			expect(loadKey).toHaveBeenCalledWith(fixture.store.db, {
				deviceId: "capture-device",
				keysDir: join(fixture.dir, "other-keys"),
			});
			expect(loadKey.mock.results[0]?.value).toBeNull();
		}
	},
);

it("the same local runtime setup adopts pending capture with its own actual private key", () => {
	// Arrange: reopen before persisting the tuple, just like the wrong-private-key case.
	const id = rememberScoped();
	reopen();
	persistUnadoptedIdentity();
	const before = ledger();
	const keys = keyBytes();
	const loadKey = vi.spyOn(syncIdentity, "loadRuntimeSigningPublicKey");
	expect(fixture.store.hasCurrentConfiguredIdentity()).toBe(true);
	// Act
	fixture.store.adoptEnsuredDeviceIdentity("capture-device");
	// Assert: a valid actual key, not a runtime identity shortcut, creates one association.
	expect(loadKey).toHaveBeenCalledWith(fixture.store.db, {
		deviceId: "capture-device",
		keysDir: fixture.keysDir,
	});
	const devices = factRows("sync_device") as { public_key: string }[];
	expect(loadKey.mock.results[0]?.value).toBe(devices[0]?.public_key);
	expect(ledger().adoption).toHaveLength(1);
	expect(ledger().birth).toEqual(before.birth);
	expect(ledger().bindings).toEqual(before.bindings);
	expect(keyBytes().equals(keys)).toBe(true);
	expect(fixture.store.get(id)?.id).toBe(id);
});

it.each(["existing enrollment", "fallback store actor", "configured store actor"])(
	"%s holds the WAL writer lock before reading pending adoption facts",
	(boundary) => {
		// Arrange: a second actual connection attempts a commit after the first transaction read.
		if (boundary === "configured store actor") {
			vi.stubEnv("CODEMEM_ACTOR_ID", "configured-owner");
			reopen();
		}
		const id = rememberScoped();
		persistUnadoptedIdentity();
		const db = fixture.store.db;
		db.pragma("journal_mode = WAL");
		db.exec("CREATE TABLE adoption_writer_probe (value TEXT NOT NULL)");
		const before = ledger();
		const original = row(id);
		const snapshots = factRows("memory_local_creation_snapshots");
		const keys = keyBytes();
		const listener = vi.fn();
		fixture.store.onIdentityChanged(listener);
		const other = new Database(fixture.store.dbPath);
		other.pragma("busy_timeout = 0");
		let attempted = false;
		let competingError: unknown;
		const prepare = db.prepare.bind(db);
		const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
			const statement = prepare(sql);
			if (!/^SELECT\b/u.test(sql.trim())) return statement;
			const get = statement.get.bind(statement);
			vi.spyOn(statement, "get").mockImplementation((...args) => {
				const result = get(...args);
				if (!db.inTransaction || attempted) return result;
				attempted = true;
				try {
					other.prepare("INSERT INTO adoption_writer_probe VALUES ('competing')").run();
				} catch (error) {
					competingError = error;
				}
				return result;
			});
			return statement;
		});
		try {
			// Act: no sleeps or worker scheduling; the read hook fixes the interleaving.
			let adoptionError: unknown;
			try {
				if (boundary === "existing enrollment") ensure();
				else fixture.store.adoptEnsuredDeviceIdentity("capture-device");
			} catch (error) {
				adoptionError = error;
			}
			prepareSpy.mockRestore();
			// Assert: the competitor was blocked, then can commit immediately after adoption.
			expect({
				adoptionErrorCode: (adoptionError as { code?: string } | undefined)?.code,
				competingCommits: other.prepare("SELECT COUNT(*) FROM adoption_writer_probe").pluck().get(),
			}).toEqual({ adoptionErrorCode: undefined, competingCommits: 0 });
			expect(attempted).toBe(true);
			expect(competingError).toMatchObject({ code: "SQLITE_BUSY" });
			expect(other.prepare("SELECT * FROM adoption_writer_probe").all()).toEqual([]);
			other.prepare("INSERT INTO adoption_writer_probe VALUES ('retry')").run();
			expect(other.prepare("SELECT * FROM adoption_writer_probe").all()).toEqual([
				{ value: "retry" },
			]);
			expect(ledger().adoption).toHaveLength(1);
			expect(ledger().birth).toEqual(before.birth);
			expect(ledger().bindings).toEqual(before.bindings);
			expect(factRows("memory_local_creation_snapshots")).toEqual(snapshots);
			expect(keyBytes().equals(keys)).toBe(true);
			if (boundary === "existing enrollment") {
				expect(row(id)).toEqual(original);
				expect(listener).not.toHaveBeenCalled();
			} else {
				expect(listener).toHaveBeenCalledTimes(1);
				expect(fixture.store.deviceId).toBe("capture-device");
				expect(row(id)).toMatchObject({
					...original,
					actor_id: fixture.store.actorId,
				});
			}
		} finally {
			prepareSpy.mockRestore();
			other.close();
		}
	},
);

it("copied adoption metadata cannot union another actual device into the capture", () => {
	// Arrange: retain association with the first actual key/device.
	const id = rememberScoped();
	restrict(id);
	ensure();
	fixture.store.adoptEnsuredDeviceIdentity("capture-device");
	const before = ledger();
	const keys = keyBytes();
	fixture.store.db.prepare("DELETE FROM sync_device").run();
	const otherKey = enrollFixtureSigningKey(
		fixture.store.db,
		join(fixture.dir, "other-keys"),
		"other-device",
	);
	// Act
	const sources = localCreationSourceIds(fixture.store.db, "other-device", {
		expectedPublicKey: otherKey,
	});
	// Assert: metadata cannot reassociate the immutable birth.
	expect(sources).not.toContain(binding(id)?.sourceDeviceId);
	expect(() =>
		fixture.store.db.transaction(() =>
			adoptLocalCapture(fixture.store.db, "other-device", { expectedPublicKey: otherKey }),
		)(),
	).toThrow("memory_local_capture_adoption_conflict");
	expect(ledger()).toEqual(before);
	expect(keyBytes().equals(keys)).toBe(true);
});

it("a conflicting existing actor cannot be relabelled or united by capture adoption", () => {
	// Arrange
	const id = rememberScoped();
	persistUnadoptedIdentity();
	fixture.store.db
		.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
 VALUES ('local:capture-device', 'Unrelated actor', 0, 'active', ?, ?)`)
		.run(now, now);
	const actors = factRows("actors");
	const before = ledger();
	const original = row(id);
	const devices = factRows("sync_device");
	const keys = keyBytes();
	// Act
	expect(() => fixture.store.adoptEnsuredDeviceIdentity("capture-device")).toThrow(
		"device_adoption_actor_conflict",
	);
	// Assert
	expect(fixture.store.deviceId).toBe("local");
	expect(ledger()).toEqual(before);
	expect(factRows("sync_device")).toEqual(devices);
	expect(row(id)).toEqual(original);
	expect(fixture.store.get(id)).toBeNull();
	expect(factRows("actors")).toEqual(actors);
	expect(keyBytes().equals(keys)).toBe(true);
});

it.each(["merged fallback actor", "inactive fallback actor", "configured foreign actor"])(
	"actual enrollment skips only association for %s and remains usable on retry",
	async (conflict) => {
		// Arrange
		if (conflict === "configured foreign actor") {
			vi.stubEnv("CODEMEM_ACTOR_ID", "configured-foreign");
			reopen();
		}
		const id = rememberScoped();
		const actorId = conflict === "configured foreign actor" ? "configured-foreign" : "local:local";
		let status = "inactive";
		if (conflict === "merged fallback actor") status = "merged";
		if (conflict === "configured foreign actor") status = "active";
		fixture.store.db
			.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at)
  VALUES (?, 'Conflicting actor', ?, ?, ?, ?, ?)`)
			.run(
				actorId,
				conflict === "configured foreign actor" ? 0 : 1,
				status,
				conflict === "merged fallback actor" ? "different-owner" : null,
				now,
				now,
			);
		const original = row(id);
		const before = ledger();
		const actors = factRows("actors");
		const snapshots = factRows("memory_local_creation_snapshots");
		// Act: actual ensure and retry must still persist a usable signing identity.
		const first = ensure();
		const keys = keyBytes();
		const retry = ensure();
		// Assert: only the plain actor-conflict error is nonfatal for enrollment.
		expect(retry).toEqual(first);
		const devices = factRows("sync_device") as { public_key: string }[];
		expect(devices).toHaveLength(1);
		expect(devices[0]).toMatchObject({ device_id: first[0], fingerprint: first[1] });
		expect(
			loadRuntimeSigningPublicKey(fixture.store.db, {
				deviceId: first[0],
				keysDir: fixture.keysDir,
			}),
		).toBe(devices[0]?.public_key);
		expect(ledger()).toEqual(before);
		expect(row(id)).toEqual(original);
		expect(factRows("actors")).toEqual(actors);
		expect(() => fixture.store.adoptEnsuredDeviceIdentity(first[0])).toThrow(
			"device_adoption_actor_conflict",
		);
		expect(fixture.store.deviceId).toBe("local");
		expect(ledger()).toEqual(before);
		expect(row(id)).toEqual(original);
		expect(factRows("actors")).toEqual(actors);
		const fresh = remember("New local capture after actor conflict");
		expect(fixture.store.get(fresh)?.id).toBe(fresh);
		expect(binding(fresh)).toBeNull();
		expect(ledger()).toEqual(before);
		expect(actualSources()).not.toContain(binding(id)?.sourceDeviceId);
		expect(
			hasMatchingLocalCreation(fixture.store.db, String(row(id).import_key), actualSources()),
		).toBe(false);
		expect(fixture.store.get(id)).toBeNull();
		await refreshManagedScopeFixture(fixture.store.db, {
			keysDir: fixture.keysDir,
			deviceId: first[0],
			scopeIds: [scopeId],
		});
		reopen();
		expect(fixture.store.get(id)?.id).toBe(id);
		fixture.store.db
			.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
			.run(scopeId);
		expect(fixture.store.get(id)).toBeNull();
		expect(row(id)).toEqual(original);
		expect(ledger()).toEqual(before);
		expect(factRows("memory_local_creation_snapshots")).toEqual(snapshots);
		expect(keyBytes().equals(keys)).toBe(true);
	},
);

it.each([
	"unexpected_enrollment_sql",
	"device_adoption_actor_conflict_extra",
	"device_adoption_actor_conflict",
])("actual enrollment does not swallow SQL failure %s or leave partial authority", (failure) => {
	// Arrange: a real SQLite error, including text identical to the plain actor error.
	const id = rememberScoped();
	const original = row(id);
	const before = ledger();
	fixture.store.db.exec(`CREATE TRIGGER fail_enrollment_adoption BEFORE INSERT ON memory_local_capture_adoption
  BEGIN SELECT RAISE(ABORT, '${failure}'); END`);
	// Act
	expect(() => ensure()).toThrow(failure);
	// Assert: enrollment tuple and association roll back together; retry reuses keys.
	const keys = keyBytes();
	expect(factRows("sync_device")).toEqual([]);
	expect(ledger()).toEqual(before);
	expect(row(id)).toEqual(original);
	fixture.store.db.exec("DROP TRIGGER fail_enrollment_adoption");
	ensure();
	expect(ledger().adoption).toHaveLength(1);
	expect(ledger().birth).toEqual(before.birth);
	expect(ledger().bindings).toEqual(before.bindings);
	expect(keyBytes().equals(keys)).toBe(true);
});

it.each(["wrong-device", "wrong-key", "wrong-fingerprint", "missing-device"])(
	"retained adoption rejects %s without rewriting facts",
	(failure) => {
		// Arrange
		const id = rememberScoped();
		restrict(id);
		ensure();
		fixture.store.adoptEnsuredDeviceIdentity("capture-device");
		const before = ledger();
		const keys = keyBytes();
		let deviceId = fixture.store.deviceId;
		let expectedPublicKey =
			loadRuntimeSigningPublicKey(fixture.store.db, { deviceId, keysDir: fixture.keysDir }) ??
			undefined;
		expect(localCreationSourceIds(fixture.store.db, deviceId, { expectedPublicKey })).toContain(
			binding(id)?.sourceDeviceId,
		);
		if (failure === "wrong-device") deviceId = "other-device";
		if (failure === "wrong-key") {
			const other = new Database(":memory:");
			try {
				initTestSchema(other);
				expectedPublicKey = enrollFixtureSigningKey(other, join(fixture.dir, "other"), "other");
			} finally {
				other.close();
			}
		}
		if (failure === "wrong-fingerprint")
			fixture.store.db.prepare("UPDATE sync_device SET fingerprint = 'mismatch'").run();
		if (failure === "missing-device") {
			fixture.store.db.prepare("DELETE FROM sync_device").run();
			deviceId = "local";
		}
		// Act
		const sources = localCreationSourceIds(fixture.store.db, deviceId, { expectedPublicKey });
		// Assert
		expect(sources).toEqual([]);
		expect(ledger()).toEqual(before);
		expect(binding(id)?.evidence).toBe("local_creation");
		expect(keyBytes().equals(keys)).toBe(true);
	},
);

it.each(["absent capture schema", "empty capture schema", "absent actor table"])(
	"enrollment preserves %s without inventing a birth or requiring actor DDL",
	(legacy) => {
		// Arrange: legacy schemas must remain eligible for the maintained ensure boundary.
		if (legacy === "empty capture schema")
			fixture.store.db.exec(`CREATE TABLE memory_local_capture (id INTEGER PRIMARY KEY, capture_id TEXT, created_at TEXT);
   CREATE TABLE memory_local_capture_adoption (capture_id TEXT, device_id TEXT, public_key TEXT, fingerprint TEXT, created_at TEXT);`);
		if (legacy === "absent actor table") {
			remember();
			fixture.store.db.exec("DROP TABLE actors");
		}
		const before = ledger();
		// Act
		const first = ensure();
		const keys = keyBytes();
		const retry = ensure();
		// Assert: only an existing genuine birth can be associated.
		expect(retry).toEqual(first);
		expect(ledger().birth).toEqual(before.birth);
		expect(ledger().bindings).toEqual(before.bindings);
		expect(ledger().adoption).toHaveLength(legacy === "absent actor table" ? 1 : 0);
		expect(keyBytes().equals(keys)).toBe(true);
		if (legacy === "absent actor table")
			expect(
				fixture.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'actors'").get(),
			).toBeUndefined();
	},
);

it("configured device mismatch skips pending adoption while enrollment still succeeds", () => {
	// Arrange
	remember();
	const before = ledger();
	vi.stubEnv("CODEMEM_DEVICE_ID", "different-device");
	// Act
	const first = ensure();
	const keys = keyBytes();
	const retry = ensure();
	// Assert
	expect(retry).toEqual(first);
	expect(ledger()).toEqual(before);
	expect(keyBytes().equals(keys)).toBe(true);
});

it.each(["config actor", "empty environment override"])(
	"enrollment honors %s when checking actor conflicts",
	(mode) => {
		// Arrange
		remember();
		writeFileSync(join(fixture.dir, "config.json"), JSON.stringify({ actor_id: "foreign-config" }));
		fixture.store.db
			.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
   VALUES ('foreign-config', 'Foreign', 0, 'active', ?, ?)`)
			.run(now, now);
		if (mode === "config actor") vi.stubEnv("CODEMEM_ACTOR_ID", undefined);
		const before = ledger();
		const actors = factRows("actors");
		// Act
		ensure();
		// Assert: explicit empty env clears the configured actor; absence uses it.
		expect(ledger().adoption).toHaveLength(mode === "config actor" ? 0 : 1);
		expect(ledger().birth).toEqual(before.birth);
		expect(ledger().bindings).toEqual(before.bindings);
		expect(factRows("actors")).toEqual(actors);
	},
);

it("configured actor adoption rolls back its association before runtime publication on SQL failure", () => {
	// Arrange: exercise the explicit no-fallback-actor path with a genuine pending birth.
	vi.stubEnv("CODEMEM_ACTOR_ID", "configured-owner");
	reopen();
	const id = rememberScoped();
	persistUnadoptedIdentity();
	const before = ledger();
	const original = row(id);
	const devices = factRows("sync_device");
	const keys = keyBytes();
	const listener = vi.fn();
	fixture.store.onIdentityChanged(listener);
	fixture.store.db.exec(`CREATE TRIGGER fail_configured_adoption BEFORE INSERT ON memory_local_capture_adoption
	 BEGIN SELECT RAISE(ABORT, 'configured_adoption_failed'); END`);
	// Act
	expect(() => fixture.store.adoptEnsuredDeviceIdentity("capture-device")).toThrow(
		"configured_adoption_failed",
	);
	// Assert: retry succeeds without rewriting memory ownership or private key bytes.
	expect(fixture.store.deviceId).toBe("local");
	expect(fixture.store.actorId).toBe("configured-owner");
	expect(listener).not.toHaveBeenCalled();
	expect(ledger()).toEqual(before);
	expect(row(id)).toEqual(original);
	expect(factRows("sync_device")).toEqual(devices);
	fixture.store.db.exec("DROP TRIGGER fail_configured_adoption");
	fixture.store.adoptEnsuredDeviceIdentity("capture-device");
	expect(ledger().adoption).toHaveLength(1);
	expect(fixture.store.deviceId).toBe("capture-device");
	expect(listener).toHaveBeenCalledTimes(1);
	expect(row(id)).toEqual(original);
	expect(keyBytes().equals(keys)).toBe(true);
});

it.each(["matching device", "wrong device"])(
	"explicit store adoption checks injected runtime signing key for %s",
	(mode) => {
		// Arrange: injected keys must still agree with the exact persisted device tuple.
		vi.stubEnv("CODEMEM_ACTOR_ID", "configured-owner");
		reopen();
		const id = rememberScoped();
		persistUnadoptedIdentity();
		const before = ledger();
		const keys = keyBytes();
		const publicKey = loadRuntimeSigningPublicKey(fixture.store.db, {
			deviceId: "capture-device",
			keysDir: fixture.keysDir,
		}) as string;
		fixture.store.close();
		fixture.store = new MemoryStore(join(fixture.dir, "memory.sqlite"), {
			keysDir: fixture.keysDir,
			runtimeSigningKey: {
				deviceId: mode === "matching device" ? "capture-device" : "other-device",
				publicKey,
			},
		});
		fixture.store.deviceId = "local";
		// Act
		fixture.store.adoptEnsuredDeviceIdentity("capture-device");
		// Assert
		expect(ledger().adoption).toHaveLength(mode === "matching device" ? 1 : 0);
		expect(ledger().birth).toEqual(before.birth);
		expect(ledger().bindings).toEqual(before.bindings);
		expect(keyBytes().equals(keys)).toBe(true);
		if (mode === "matching device") expect(fixture.store.get(id)?.id).toBe(id);
		else expect(fixture.store.get(id)).toBeNull();
	},
);
