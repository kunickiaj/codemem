import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import {
	exportedSessionKey,
	isCanonicalSessionKey,
	remappedSessionKey,
} from "./session-export-identity.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

vi.mock("./project.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./project.js")>()),
	resolveGitRepositoryIdentity: () => null,
}));

const marker = `export-session:v1:${"a".repeat(64)}`;
const remapped = `${marker}:remap:${"b".repeat(64)}`;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("private session export identity", () => {
	let db: Database.Database;
	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(`CREATE TABLE memory_items (
			id INTEGER PRIMARY KEY, session_id INTEGER, import_key TEXT,
			active INTEGER, project TEXT, device_id TEXT, scope_id TEXT);
			CREATE TABLE sessions (id INTEGER PRIMARY KEY, import_key TEXT);`);
	});
	afterEach(() => {
		db.close();
		vi.unstubAllEnvs();
	});

	it.each([
		null,
		"",
		marker.replace("v1", "v2"),
		marker.toUpperCase(),
		marker.slice(0, -1),
		`${marker}a`,
		`${marker}:remap:short`,
		`${remapped}:remap:${"c".repeat(64)}`,
		` ${marker}`,
		`${marker}\n`,
	])("rejects malformed canonical shapes: %s", (candidate) => {
		// Arrange: malformed input must not qualify as a canonical key.
		const key = candidate;
		// Act
		const valid = isCanonicalSessionKey(key);
		// Assert
		expect(valid).toBe(false);
	});

	it.each([marker, remapped])("preserves canonical bytes without enrollment: %s", (key) => {
		// Arrange: the fixture has no device/enrollment tables or memory anchor.
		const row = { id: 1, import_key: key, project: "before" };
		vi.stubEnv("CODEMEM_DEVICE_ID", "device-before");
		const before = db.serialize();
		const changes = db.prepare("SELECT total_changes()").pluck().get();
		// Act
		const valid = isCanonicalSessionKey(key);
		const original = exportedSessionKey(db, row);
		vi.stubEnv("CODEMEM_DEVICE_ID", "device-after");
		const changed = exportedSessionKey(db, { ...row, project: "after" });
		// Assert
		expect(valid).toBe(true);
		expect(original).toBe(key);
		expect(changed).toBe(key);
		expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
		expect(db.serialize().equals(before)).toBe(true);
	});

	it("hashes an original import key stably rather than trusting a malformed marker", () => {
		// Arrange
		const source = `${marker}:remap:invalid`;
		const expected = `export-session:v1:${digest(["import_key", source])}`;
		// Act
		const first = exportedSessionKey(db, { id: 1, import_key: source });
		const second = exportedSessionKey(db, { id: 99, import_key: source, project: "renamed" });
		// Assert
		expect(first).toBe(expected);
		expect(second).toBe(first);
		expect(first).not.toBe(source);
	});

	it("uses the first nonblank memory key across all history without repairing source rows", () => {
		// Arrange: the oldest anchor is inactive and outside the caller's visible subset.
		db.exec(`INSERT INTO sessions VALUES (1, NULL);
			INSERT INTO memory_items VALUES
			(1, 2, 'other-session', 1, 'current', 'current', 'visible'),
			(2, 1, NULL, 1, 'current', 'current', 'visible'),
			(3, 1, '   ', 1, 'current', 'current', 'visible'),
			(4, 1, 'historical-anchor', 0, 'old', 'old-device', 'hidden'),
			(5, 1, 'visible-later', 1, 'current', 'current', 'visible');`);
		const before = db.serialize();
		const changes = db.prepare("SELECT total_changes()").pluck().get();
		// Act
		const original = exportedSessionKey(db, { id: 1, import_key: null, project: "current" });
		const renamed = exportedSessionKey(db, {
			id: 1,
			import_key: " ",
			project: "renamed",
			device_id: "new",
		});
		// Assert: neither DDL nor key repair may occur on this read path.
		expect(original).toBe(`export-session:v1:${digest(["memory_key", "historical-anchor"])}`);
		expect(renamed).toBe(original);
		expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
		expect(db.serialize().equals(before)).toBe(true);
	});

	it("fails without an immutable anchor and leaves the database unchanged", () => {
		// Arrange
		db.exec(
			"INSERT INTO sessions VALUES (1, NULL); INSERT INTO memory_items VALUES (1, 1, ' ', 1, NULL, NULL, NULL)",
		);
		const before = db.serialize();
		const changes = db.prepare("SELECT total_changes()").pluck().get();
		// Act
		const resolve = () => exportedSessionKey(db, { id: 1, import_key: null });
		// Assert
		expect(resolve).toThrow("session_identity_unavailable: session has no immutable source key");
		expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
		expect(db.serialize().equals(before)).toBe(true);
	});

	it("replaces an existing remap and repeats idempotently rather than stacking suffixes", () => {
		// Arrange
		const project = "destination";
		const expected = `${marker}:remap:${digest(project)}`;
		// Act
		const fresh = remappedSessionKey(marker, project);
		const replaced = remappedSessionKey(remapped, project);
		const repeated = remappedSessionKey(replaced, project);
		// Assert
		expect(fresh).toBe(expected);
		expect(replaced).toBe(fresh);
		expect(repeated).toBe(fresh);
		expect(replaced).not.toBe(remapped);
		expect(isCanonicalSessionKey(repeated)).toBe(true);
	});
});

describe("MemoryStore new-session bookkeeping", () => {
	let directory: string;
	let store: MemoryStore;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "codemem-session-export-"));
		vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
		vi.stubEnv("CODEMEM_ACTOR_ID", "fixture-actor");
		vi.stubEnv("CODEMEM_DEVICE_ID", "fixture-device");
		const path = join(directory, "memory.sqlite");
		const db = connect(path);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(path);
	});
	afterEach(() => {
		store.close();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	it("assigns distinct UUIDs to genuinely new sessions without backfilling historical rows", () => {
		// Arrange: identical caller context does not mean the same new session.
		store.db
			.prepare(
				"INSERT INTO sessions(started_at, import_key) VALUES ('2026-01-01', NULL), ('2026-01-02', 'legacy-key')",
			)
			.run();
		const historical = store.db.prepare("SELECT * FROM sessions ORDER BY id").all();
		const options = { cwd: "/fixture/project", project: "fixture" };
		// Act
		const ids = [store.startSession(options), store.startSession(options)];
		const keys = ids.map((id) =>
			store.db.prepare("SELECT import_key FROM sessions WHERE id = ?").pluck().get(id),
		);
		// Assert
		for (const key of keys)
			expect(key).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
		expect(new Set(keys).size).toBe(2);
		expect(store.db.prepare("SELECT * FROM sessions WHERE id < ? ORDER BY id").all(ids[0])).toEqual(
			historical,
		);
	});
});
