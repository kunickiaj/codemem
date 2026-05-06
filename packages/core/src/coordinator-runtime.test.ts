import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readCoordinatorSyncConfig,
	refreshStoredCoordinatorPeerAddresses,
} from "./coordinator-runtime.js";
import { initTestSchema } from "./test-utils.js";

describe("readCoordinatorSyncConfig.syncOpsLimit", () => {
	afterEach(() => {
		delete process.env.CODEMEM_SYNC_OPS_LIMIT;
	});

	it("defaults to 500 when neither config nor env supplies a value", () => {
		const config = readCoordinatorSyncConfig({});
		expect(config.syncOpsLimit).toBe(500);
	});

	it("reads the value from the sync_ops_limit config key", () => {
		const config = readCoordinatorSyncConfig({ sync_ops_limit: "250" });
		expect(config.syncOpsLimit).toBe(250);
	});

	it("honors the CODEMEM_SYNC_OPS_LIMIT env var over config", () => {
		process.env.CODEMEM_SYNC_OPS_LIMIT = "750";
		const config = readCoordinatorSyncConfig({ sync_ops_limit: "250" });
		expect(config.syncOpsLimit).toBe(750);
	});

	it("clamps values above the server cap of 1000", () => {
		const config = readCoordinatorSyncConfig({ sync_ops_limit: "10000" });
		expect(config.syncOpsLimit).toBe(1000);
	});

	it("clamps values below 1 up to 1", () => {
		const config = readCoordinatorSyncConfig({ sync_ops_limit: "0" });
		expect(config.syncOpsLimit).toBe(1);
	});

	it("falls back to the default when the config value is not an integer", () => {
		const config = readCoordinatorSyncConfig({ sync_ops_limit: "not-a-number" });
		expect(config.syncOpsLimit).toBe(500);
	});
});

describe("refreshStoredCoordinatorPeerAddresses", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("merges fresh multi-group coordinator addresses into an existing pinned peer", () => {
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, public_key, addresses_json, projects_include_json, projects_exclude_json, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"peer-1",
			"Peer One",
			"fp-1",
			"peer-public-key",
			JSON.stringify(["http://old.example:7337"]),
			JSON.stringify(["work/*"]),
			JSON.stringify(["personal/*"]),
			"offline",
			new Date().toISOString(),
		);

		const updated = refreshStoredCoordinatorPeerAddresses(db, [
			{
				device_id: "peer-1",
				fingerprint: "fp-1",
				addresses: ["http://10.0.0.5:7337"],
				groups: ["team-a"],
			},
			{
				device_id: "peer-1",
				fingerprint: "fp-1",
				addresses: ["10.0.0.6:7337"],
				groups: ["team-b"],
			},
		]);

		expect(updated).toBe(1);
		const row = db
			.prepare(
				"SELECT name, pinned_fingerprint, public_key, addresses_json, projects_include_json, projects_exclude_json, last_error FROM sync_peers WHERE peer_device_id = ?",
			)
			.get("peer-1") as {
			name: string | null;
			pinned_fingerprint: string | null;
			public_key: string | null;
			addresses_json: string;
			projects_include_json: string | null;
			projects_exclude_json: string | null;
			last_error: string | null;
		};
		expect(row.name).toBe("Peer One");
		expect(row.pinned_fingerprint).toBe("fp-1");
		expect(row.public_key).toBe("peer-public-key");
		expect(JSON.parse(row.projects_include_json ?? "[]")).toEqual(["work/*"]);
		expect(JSON.parse(row.projects_exclude_json ?? "[]")).toEqual(["personal/*"]);
		expect(JSON.parse(row.addresses_json)).toEqual([
			"http://old.example:7337",
			"http://10.0.0.5:7337",
			"http://10.0.0.6:7337",
		]);
		expect(row.last_error).toBe("offline");
	});

	it("does not refresh when the discovered fingerprint differs from the pinned peer", () => {
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, addresses_json, created_at) VALUES (?, ?, ?, ?, ?)",
		).run(
			"peer-1",
			"Peer One",
			"fp-pinned",
			JSON.stringify(["http://old.example:7337"]),
			new Date().toISOString(),
		);

		const updated = refreshStoredCoordinatorPeerAddresses(db, [
			{
				device_id: "peer-1",
				fingerprint: "fp-other",
				addresses: ["http://10.0.0.5:7337"],
				groups: ["team-a"],
			},
		]);

		expect(updated).toBe(0);
		const row = db
			.prepare("SELECT addresses_json FROM sync_peers WHERE peer_device_id = ?")
			.get("peer-1") as { addresses_json: string };
		expect(JSON.parse(row.addresses_json)).toEqual(["http://old.example:7337"]);
	});

	it("does not create peers for coordinator-only discovered devices", () => {
		const updated = refreshStoredCoordinatorPeerAddresses(db, [
			{
				device_id: "peer-new",
				fingerprint: "fp-new",
				addresses: ["http://10.0.0.5:7337"],
				groups: ["team-a"],
			},
		]);

		expect(updated).toBe(0);
		const count = db.prepare("SELECT COUNT(1) AS total FROM sync_peers").get() as {
			total: number;
		};
		expect(count.total).toBe(0);
	});
});
