import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readCoordinatorDeviceLocalEvidence as read } from "./coordinator-device-local.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { generateKeypair, loadPublicKey } from "./sync-identity.js";

let fixtureDirectory: string;
let publicKey: string;
let fingerprint: string;
let db: Database.Database;

beforeAll(() => {
	fixtureDirectory = mkdtempSync(join(tmpdir(), "device-local-test-"));
	const keysDirectory = join(fixtureDirectory, "fixture-keys");
	generateKeypair(join(keysDirectory, "device.key"), join(keysDirectory, "device.key.pub"));
	const generatedPublicKey = loadPublicKey(keysDirectory);
	if (!generatedPublicKey) throw new Error("fixture public key missing");
	publicKey = generatedPublicKey;
	fingerprint = fingerprintPublicKey(publicKey);
});
afterAll(() => {
	rmSync(fixtureDirectory, { recursive: true, force: true });
});
beforeEach(() => {
	db = new Database(":memory:");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	if (db.open) db.close();
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

function createDeviceTable(connection: Database.Database) {
	// No affinities: malformed values must reach the reader without SQLite coercing them.
	connection.exec("CREATE TABLE sync_device(device_id, public_key, fingerprint)");
}
function insertDevice(connection: Database.Database) {
	connection
		.prepare("INSERT INTO sync_device(device_id, public_key, fingerprint) VALUES (?, ?, ?)")
		.run("device-a", publicKey, fingerprint);
}
function snapshot(connection: Database.Database) {
	return {
		connection: {
			name: connection.name,
			open: connection.open,
			readonly: connection.readonly,
			inTransaction: connection.inTransaction,
			memory: connection.memory,
		},
		schema: connection.prepare("SELECT * FROM sqlite_master ORDER BY name").all(),
		pragmas: [
			"journal_mode",
			"user_version",
			"application_id",
			"schema_version",
			"freelist_count",
			"query_only",
			"foreign_keys",
		].map((name) => [name, connection.pragma(name)]),
	};
}

it("reads the sole valid row from a minimal in-memory database without owning the connection", () => {
	// Arrange
	createDeviceTable(db);
	insertDevice(db);
	const before = snapshot(db);
	const rows = db.prepare("SELECT * FROM sync_device").all();
	// Act
	const evidence = read(db);
	// Assert: no MemoryStore schema initialization or connection closure is needed.
	expect(evidence).toEqual({ deviceId: "device-a", publicKey, fingerprint });
	expect(snapshot(db)).toEqual(before);
	expect(db.prepare("SELECT * FROM sync_device").all()).toEqual(rows);
});

it("returns null for a missing table without creating or repairing schema", () => {
	// Arrange
	const before = snapshot(db);
	// Act
	const evidence = read(db);
	// Assert
	expect(evidence).toBeNull();
	expect(snapshot(db)).toEqual(before);
});

it.each(["device_id", "public_key", "fingerprint"])(
	"returns null when the required %s column is missing",
	(missingColumn) => {
		// Arrange
		const columns = ["device_id", "public_key", "fingerprint"].filter(
			(column) => column !== missingColumn,
		);
		db.exec(`CREATE TABLE sync_device(${columns.join(", ")})`);
		const before = snapshot(db);
		// Act
		const evidence = read(db);
		// Assert
		expect(evidence).toBeNull();
		expect(snapshot(db)).toEqual(before);
	},
);

it("returns null for an empty device table without inserting an identity", () => {
	// Arrange
	createDeviceTable(db);
	// Act
	const evidence = read(db);
	// Assert
	expect(evidence).toBeNull();
	expect(db.prepare("SELECT * FROM sync_device").all()).toEqual([]);
});

it.each(["valid", "invalid"])("rejects two rows even when the second is %s", (secondRow) => {
	// Arrange
	createDeviceTable(db);
	insertDevice(db);
	if (secondRow === "valid") insertDevice(db);
	else db.prepare("INSERT INTO sync_device VALUES (?, ?, ?)").run(null, null, null);
	const rows = db.prepare("SELECT * FROM sync_device").all();
	// Act
	const evidence = read(db);
	// Assert
	expect(evidence).toBeNull();
	expect(db.prepare("SELECT * FROM sync_device").all()).toEqual(rows);
});

it.each([
	["device_id", null],
	["device_id", 42],
	["device_id", ""],
	["device_id", " device-a "],
	["device_id", "a".repeat(257)],
	["device_id", "device\na"],
	["device_id", "device\u200ba"],
	["public_key", null],
	["public_key", 42],
	["public_key", Buffer.from("ssh-ed25519 fixture")],
	["public_key", ""],
	["public_key", "ssh-rsa fixture"],
	["public_key", "ssh-ed25519\tfixture"],
	["public_key", " ssh-ed25519 fixture"],
	["fingerprint", null],
	["fingerprint", 42],
	["fingerprint", Buffer.from("a".repeat(64))],
	["fingerprint", ""],
	["fingerprint", "a".repeat(63)],
	["fingerprint", "a".repeat(65)],
	["fingerprint", "A".repeat(64)],
	["fingerprint", "g".repeat(64)],
	["fingerprint", "0".repeat(64)],
])("rejects invalid %s value %j without repairing the row", (column, value) => {
	// Arrange
	createDeviceTable(db);
	insertDevice(db);
	db.prepare(`UPDATE sync_device SET ${column} = ?`).run(value);
	if (column === "public_key" && typeof value === "string") {
		db.prepare("UPDATE sync_device SET fingerprint = ?").run(fingerprintPublicKey(value));
	}
	const rows = db.prepare("SELECT * FROM sync_device").all();
	// Act
	const evidence = read(db);
	// Assert
	expect(evidence).toBeNull();
	expect(db.prepare("SELECT * FROM sync_device").all()).toEqual(rows);
});

it("returns only public evidence, ignoring private and label columns", () => {
	// Arrange
	createDeviceTable(db);
	db.exec(
		"ALTER TABLE sync_device ADD COLUMN private_key; ALTER TABLE sync_device ADD COLUMN label",
	);
	insertDevice(db);
	db.prepare("UPDATE sync_device SET private_key = ?, label = ?").run(
		"not-a-real-private-key",
		"Ignored label",
	);
	// Act
	const evidence = read(db);
	// Assert
	expect(evidence).toEqual({ deviceId: "device-a", publicKey, fingerprint });
});

it("preserves SSH spacing and comments when their exact string fingerprint matches", () => {
	// Arrange
	createDeviceTable(db);
	const formattedKey = `${publicKey.replace("ssh-ed25519 ", "ssh-ed25519   ")} fixture comment  \n`;
	const formattedFingerprint = fingerprintPublicKey(formattedKey);
	db.prepare("INSERT INTO sync_device VALUES (?, ?, ?)").run(
		"device-a",
		formattedKey,
		formattedFingerprint,
	);
	// Act
	const evidence = read(db);
	// Assert: fingerprinting hashes the original string, not a normalized SSH key.
	expect(evidence).toEqual({
		deviceId: "device-a",
		publicKey: formattedKey,
		fingerprint: formattedFingerprint,
	});
});

it("rejects a comment change with a fingerprint from the original key", () => {
	// Arrange
	createDeviceTable(db);
	insertDevice(db);
	db.prepare("UPDATE sync_device SET public_key = ?").run(`${publicKey} changed comment`);
	// Act
	const evidence = read(db);
	// Assert
	expect(evidence).toBeNull();
});

it.each(["valid", "missing table", "invalid fingerprint"])(
	"leaves a readonly database's bytes, rows, schema, pragmas, and connection unchanged for %s evidence",
	(state) => {
		// Arrange: this file belongs only to this test, not a user store.
		const dbPath = join(fixtureDirectory, `${state}.sqlite`);
		const writer = new Database(dbPath);
		try {
			writer.pragma("user_version = 17");
			writer.pragma("application_id = 23");
			if (state !== "missing table") {
				createDeviceTable(writer);
				insertDevice(writer);
			}
			if (state === "invalid fingerprint") {
				writer.exec("UPDATE sync_device SET fingerprint = 'invalid'");
			}
		} finally {
			writer.close();
		}
		db.close();
		db = new Database(dbPath, { readonly: true, fileMustExist: true });
		const before = snapshot(db);
		const bytes = readFileSync(dbPath);
		const files = readdirSync(fixtureDirectory).sort();
		const rows = () => {
			if (state === "missing table") return [];
			return db.prepare("SELECT * FROM sync_device").all();
		};
		const beforeRows = rows();
		// Act
		const evidence = read(db);
		// Assert: the caller still owns a usable connection, including failed reads.
		if (state === "valid") {
			expect(evidence).toEqual({ deviceId: "device-a", publicKey, fingerprint });
		} else {
			expect(evidence).toBeNull();
		}
		expect(snapshot(db)).toEqual(before);
		expect(rows()).toEqual(beforeRows);
		expect(readFileSync(dbPath)).toEqual(bytes);
		expect(readdirSync(fixtureDirectory).sort()).toEqual(files);
	},
);
