import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	advertisedSyncAddresses,
	coordinatorStatusSnapshot,
	fetchCoordinatorStalePeers,
	lookupCoordinatorPeers,
	readCoordinatorSyncConfig,
	refreshStoredCoordinatorPeerAddresses,
} from "./coordinator-runtime.js";
import type { MemoryStore } from "./store.js";
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

describe("advertisedSyncAddresses", () => {
	it("infers the configured sync port for bare advertised hostnames", () => {
		const config = readCoordinatorSyncConfig({
			sync_advertise: "nas.example.test",
			sync_port: "7337",
		});

		expect(advertisedSyncAddresses(config)).toEqual(["http://nas.example.test:7337"]);
	});

	it("preserves explicit ports in advertised URLs", () => {
		const config = readCoordinatorSyncConfig({
			sync_advertise: "http://nas.example.test:7444",
			sync_port: "7337",
		});

		expect(advertisedSyncAddresses(config)).toEqual(["http://nas.example.test:7444"]);
	});

	it("deduplicates bare host and explicit sync port after port inference", () => {
		const config = readCoordinatorSyncConfig({
			sync_advertise: "nas.example.test,http://nas.example.test:7337",
			sync_port: "7337",
		});

		expect(advertisedSyncAddresses(config)).toEqual(["http://nas.example.test:7337"]);
	});
});

describe("lookupCoordinatorPeers", () => {
	it("merges multi-group device groups as plain strings", async () => {
		const db = new Database(":memory:");
		const keysDir = mkdtempSync(join(tmpdir(), "codemem-coordinator-runtime-keys-"));
		const prevFetch = globalThis.fetch;
		try {
			initTestSchema(db);
			globalThis.fetch = (async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				const groupId = url.searchParams.get("group_id") || "";
				return new Response(
					JSON.stringify({
						items: [
							{
								device_id: "peer-1",
								fingerprint: "fp-1",
								public_key: "pk-1",
								addresses: [`${groupId}.example.test:7337`],
								stale: false,
							},
						],
					}),
					{ status: 200 },
				);
			}) as typeof fetch;

			const peers = await lookupCoordinatorPeers(
				{ db, dbPath: ":memory:" },
				readCoordinatorSyncConfig({
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_groups: ["team-a", "team-b"],
				}),
				{ keysDir },
			);

			expect(peers).toHaveLength(1);
			expect(peers[0]?.groups).toEqual(["team-a", "team-b"]);
			expect(peers[0]?.fresh_groups).toEqual(["team-a", "team-b"]);
		} finally {
			globalThis.fetch = prevFetch;
			db.close();
			rmSync(keysDir, { recursive: true, force: true });
		}
	});

	it("tracks freshness per group when merged device sightings disagree", async () => {
		const db = new Database(":memory:");
		const keysDir = mkdtempSync(join(tmpdir(), "codemem-coordinator-runtime-keys-"));
		const prevFetch = globalThis.fetch;
		try {
			initTestSchema(db);
			globalThis.fetch = (async (input: RequestInfo | URL) => {
				const groupId = new URL(String(input)).searchParams.get("group_id") || "";
				const stale = groupId === "team-b";
				const now = Date.now();
				return new Response(
					JSON.stringify({
						items: [
							{
								device_id: "peer-1",
								fingerprint: "fp-1",
								public_key: "pk-1",
								addresses: [`${groupId}.example.test:7337`],
								last_seen_at: new Date(now + (stale ? 1_000 : 0)).toISOString(),
								expires_at: new Date(now + (stale ? -60_000 : 60_000)).toISOString(),
								stale,
							},
						],
					}),
					{ status: 200 },
				);
			}) as typeof fetch;

			const peers = await lookupCoordinatorPeers(
				{ db, dbPath: ":memory:" },
				readCoordinatorSyncConfig({
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_groups: ["team-a", "team-b"],
				}),
				{ keysDir },
			);

			expect(peers[0]?.groups).toEqual(["team-a", "team-b"]);
			expect(peers[0]?.fresh_groups).toEqual(["team-a"]);
			expect(peers[0]?.addresses).toEqual(["http://team-a.example.test:7337"]);
			expect(Date.parse(String(peers[0]?.expires_at))).toBeGreaterThan(Date.now());
			expect(peers[0]?.stale).toBe(false);
		} finally {
			globalThis.fetch = prevFetch;
			db.close();
			rmSync(keysDir, { recursive: true, force: true });
		}
	});
});

describe("coordinatorStatusSnapshot", () => {
	it("reuses a short-lived coordinator snapshot instead of polling remote status on every viewer refresh", async () => {
		const db = new Database(":memory:");
		const keysDir = mkdtempSync(join(tmpdir(), "codemem-coordinator-runtime-keys-"));
		const alternateKeysDir = mkdtempSync(join(tmpdir(), "codemem-coordinator-runtime-keys-"));
		const prevFetch = globalThis.fetch;
		const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
		let fetchCount = 0;
		let presenceFetchCount = 0;
		let lastPresenceAddresses: unknown = null;
		try {
			initTestSchema(db);
			process.env.CODEMEM_KEYS_DIR = keysDir;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				fetchCount += 1;
				const url = new URL(String(input));
				if (url.pathname === "/v1/presence") {
					presenceFetchCount += 1;
					const rawBody = init?.body;
					const body = rawBody
						? JSON.parse(Buffer.from(rawBody as ArrayBuffer).toString("utf8"))
						: {};
					lastPresenceAddresses = body.addresses;
					return new Response(JSON.stringify({ addresses: ["http://local.test:7337"] }), {
						status: 200,
					});
				}
				if (url.pathname === "/v1/peers") {
					return new Response(
						JSON.stringify({
							items: [
								{
									device_id: "peer-1",
									fingerprint: "fp-1",
									addresses: ["http://peer.test:7337"],
									stale: false,
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.pathname === "/v1/reciprocal-approvals") {
					return new Response(JSON.stringify({ items: [] }), { status: 200 });
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
			}) as typeof fetch;

			const config = readCoordinatorSyncConfig({
				sync_enabled: true,
				sync_coordinator_url: "https://coord.example.test",
				sync_coordinator_group: "team-a",
			});
			const store = {
				db,
				dbPath: `:memory:-${randomUUID()}`,
			} as unknown as MemoryStore;

			const first = await coordinatorStatusSnapshot(store, config);
			const firstFetchCount = fetchCount;
			db.prepare("INSERT INTO sync_peers(peer_device_id, created_at) VALUES (?, ?)").run(
				"peer-1",
				new Date().toISOString(),
			);
			const second = await coordinatorStatusSnapshot(store, config);
			const secondFetchCount = fetchCount;
			const secondPresenceFetchCount = presenceFetchCount;
			const disabledSyncConfig = readCoordinatorSyncConfig({
				sync_enabled: false,
				sync_coordinator_url: "https://coord.example.test",
				sync_coordinator_group: "team-a",
			});
			const disabledSync = await coordinatorStatusSnapshot(store, disabledSyncConfig);
			const disabledSyncFetchCount = fetchCount;
			const changedAdvertiseConfig = readCoordinatorSyncConfig({
				sync_enabled: true,
				sync_coordinator_url: "https://coord.example.test",
				sync_coordinator_group: "team-a",
				sync_advertise: "new.example.test",
			});
			await coordinatorStatusSnapshot(store, changedAdvertiseConfig);
			const changedAdvertisePresenceFetchCount = presenceFetchCount;
			process.env.CODEMEM_KEYS_DIR = alternateKeysDir;
			await coordinatorStatusSnapshot(store, changedAdvertiseConfig);

			expect(first.sync_enabled).toBe(true);
			expect(first.discovered_peer_count).toBe(1);
			expect(second.discovered_peer_count).toBe(1);
			expect(second.paired_peer_count).toBe(1);
			expect(disabledSync.sync_enabled).toBe(false);
			expect(firstFetchCount).toBeGreaterThan(0);
			expect(secondFetchCount).toBe(firstFetchCount);
			expect(disabledSyncFetchCount).toBeGreaterThan(secondFetchCount);
			expect(secondPresenceFetchCount).toBe(1);
			expect(changedAdvertisePresenceFetchCount).toBeGreaterThan(secondPresenceFetchCount);
			expect(lastPresenceAddresses).toEqual(["http://new.example.test:7337"]);
			expect(fetchCount).toBeGreaterThan(secondFetchCount);
			expect(presenceFetchCount).toBeGreaterThan(changedAdvertisePresenceFetchCount);
		} finally {
			globalThis.fetch = prevFetch;
			if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
			else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			db.close();
			rmSync(keysDir, { recursive: true, force: true });
			rmSync(alternateKeysDir, { recursive: true, force: true });
		}
	});
});

describe("fetchCoordinatorStalePeers", () => {
	it("returns a stale pinned peer key when the same device has a fresh replacement fingerprint", async () => {
		const db = new Database(":memory:");
		const keysDir = mkdtempSync(join(tmpdir(), "codemem-coordinator-runtime-keys-"));
		const configPath = join(
			mkdtempSync(join(tmpdir(), "codemem-coordinator-runtime-config-")),
			"config.json",
		);
		const prevFetch = globalThis.fetch;
		const prevConfig = process.env.CODEMEM_CONFIG;
		try {
			initTestSchema(db);
			db.prepare(
				"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, addresses_json, created_at) VALUES (?, ?, ?, ?)",
			).run("peer-1", "old-fp", "[]", new Date().toISOString());
			writeFileSync(
				configPath,
				JSON.stringify({
					sync_enabled: true,
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
				}),
			);
			process.env.CODEMEM_CONFIG = configPath;
			globalThis.fetch = (async () =>
				new Response(
					JSON.stringify({
						items: [
							{ device_id: "peer-1", fingerprint: "old-fp", stale: true },
							{ device_id: "peer-1", fingerprint: "new-fp", stale: false },
						],
					}),
					{ status: 200 },
				)) as typeof fetch;

			const stalePeers = await fetchCoordinatorStalePeers(db, ":memory:", keysDir);

			expect(stalePeers.has("peer-1")).toBe(false);
			expect(stalePeers.has("peer-1:old-fp")).toBe(true);
		} finally {
			globalThis.fetch = prevFetch;
			if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
			else process.env.CODEMEM_CONFIG = prevConfig;
			db.close();
			rmSync(keysDir, { recursive: true, force: true });
			rmSync(configPath, { force: true });
		}
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
			"http://10.0.0.5:7337",
			"http://10.0.0.6:7337",
			"http://old.example:7337",
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

	it("does not refresh addresses from stale coordinator input", () => {
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, addresses_json, created_at) VALUES (?, ?, ?, ?, ?)",
		).run(
			"peer-1",
			"Peer One",
			"fp-1",
			JSON.stringify(["http://old.example:7337"]),
			new Date().toISOString(),
		);

		const updated = refreshStoredCoordinatorPeerAddresses(db, [
			{
				device_id: "peer-1",
				fingerprint: "fp-1",
				addresses: ["http://stale.example:7337"],
				stale: true,
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
