import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	refreshAuthorizedCoordinatorPeerTrust,
	refreshStoredCoordinatorPeerAddresses,
	revokeUnauthorizedCoordinatorPeerTrust,
	trustCoordinatorPeersWithSharedManagedScopes,
} from "./coordinator-runtime.js";
import type { MemoryStore } from "./store.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";
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

describe("readCoordinatorSyncConfig raw-events retention", () => {
	afterEach(() => {
		delete process.env.CODEMEM_RAW_EVENTS_RETENTION_ENABLED;
		delete process.env.CODEMEM_RAW_EVENTS_RETENTION_MAX_AGE_DAYS;
	});

	it("defaults to disabled with a 90-day max age when nothing is supplied", () => {
		const config = readCoordinatorSyncConfig({});
		expect(config.rawEventsRetentionEnabled).toBe(false);
		expect(config.rawEventsRetentionMaxAgeDays).toBe(90);
	});

	it("marks retention configured only when the enabled key is explicitly present", () => {
		// Absent → not configured (legacy env may still apply downstream).
		expect(readCoordinatorSyncConfig({}).rawEventsRetentionConfigured).toBe(false);
		// Explicitly present — true OR false — counts as configured, so an explicit
		// disable can be treated as authoritative.
		expect(
			readCoordinatorSyncConfig({ raw_events_retention_enabled: false })
				.rawEventsRetentionConfigured,
		).toBe(true);
		expect(
			readCoordinatorSyncConfig({ raw_events_retention_enabled: true })
				.rawEventsRetentionConfigured,
		).toBe(true);
	});

	it("reads enabled + max-age from the config object", () => {
		const config = readCoordinatorSyncConfig({
			raw_events_retention_enabled: true,
			raw_events_retention_max_age_days: 30,
		});
		expect(config.rawEventsRetentionEnabled).toBe(true);
		expect(config.rawEventsRetentionMaxAgeDays).toBe(30);
	});

	it("honors the env vars over config", () => {
		process.env.CODEMEM_RAW_EVENTS_RETENTION_ENABLED = "1";
		process.env.CODEMEM_RAW_EVENTS_RETENTION_MAX_AGE_DAYS = "45";
		const config = readCoordinatorSyncConfig({
			raw_events_retention_enabled: false,
			raw_events_retention_max_age_days: 10,
		});
		expect(config.rawEventsRetentionEnabled).toBe(true);
		expect(config.rawEventsRetentionMaxAgeDays).toBe(45);
	});

	it("clamps max-age below 1 up to 1", () => {
		const config = readCoordinatorSyncConfig({ raw_events_retention_max_age_days: 0 });
		expect(config.rawEventsRetentionMaxAgeDays).toBe(1);
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
			expect(peers[0]?.coordinator_id).toBe("https://coord.example.test");
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
		let lastPresenceCapabilities: unknown = null;
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
					lastPresenceCapabilities = body.capabilities;
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
			cpSync(join(keysDir, "device.key"), join(alternateKeysDir, "device.key"));
			cpSync(join(keysDir, "device.key.pub"), join(alternateKeysDir, "device.key.pub"));
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
			expect(lastPresenceCapabilities).toEqual({
				sync_capability: "scoped",
				sync_features: ["reassign_scope"],
			});
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

	it("reuses private peer bindings when cached authorization becomes valid", async () => {
		const db = new Database(":memory:");
		const peerDb = new Database(":memory:");
		const keysDir = mkdtempSync(join(tmpdir(), "codemem-coordinator-cache-local-key-"));
		const peerKeysDir = mkdtempSync(join(tmpdir(), "codemem-coordinator-cache-peer-key-"));
		const prevFetch = globalThis.fetch;
		const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
		let fetchCount = 0;
		try {
			initTestSchema(db);
			initTestSchema(peerDb);
			process.env.CODEMEM_KEYS_DIR = keysDir;
			const [localDeviceId] = ensureDeviceIdentity(db, { keysDir });
			const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
			const peerPublicKey = loadPublicKey(peerKeysDir);
			if (!peerPublicKey) throw new Error("expected peer public key");
			globalThis.fetch = (async (input: RequestInfo | URL) => {
				fetchCount += 1;
				const url = new URL(String(input));
				if (url.pathname === "/v1/presence") {
					return new Response(JSON.stringify({ addresses: ["http://local.test:7337"] }), {
						status: 200,
					});
				}
				if (url.pathname === "/v1/peers") {
					return new Response(
						JSON.stringify({
							items: [
								{
									device_id: peerDeviceId,
									display_name: "Project peer",
									public_key: peerPublicKey,
									fingerprint: fingerprintPublicKey(peerPublicKey),
									addresses: ["http://peer.example:7337"],
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
				sync_coordinator_group: "group-1",
			});
			const store = {
				db,
				dbPath: `:memory:-${randomUUID()}`,
			} as unknown as MemoryStore;

			const first = await coordinatorStatusSnapshot(store, config);
			const firstFetchCount = fetchCount;
			expect(db.prepare("SELECT COUNT(1) AS total FROM sync_peers").get()).toEqual({ total: 0 });

			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO replication_scopes(
				 scope_id, label, kind, authority_type, coordinator_id, group_id,
				 membership_epoch, status, created_at, updated_at
				 ) VALUES ('scope-1', 'Project', 'managed_project', 'coordinator',
				 'https://coord.example.test', 'group-1', 1, 'active', ?, ?)`,
			).run(now, now);
			const addMembership = db.prepare(
				`INSERT INTO scope_memberships(
				 scope_id, device_id, role, status, membership_epoch, updated_at
				 ) VALUES ('scope-1', ?, 'member', 'active', 1, ?)`,
			);
			addMembership.run(localDeviceId, now);
			addMembership.run(peerDeviceId, now);
			markScopeMembershipCacheFresh(db, "https://coord.example.test", "group-1", now);

			const second = await coordinatorStatusSnapshot(store, config);
			const discovered = (second.discovered_devices as Array<Record<string, unknown>>)[0];

			expect(fetchCount).toBe(firstFetchCount);
			expect(second.paired_peer_count).toBe(1);
			expect(
				db
					.prepare("SELECT pinned_fingerprint, public_key FROM sync_peers WHERE peer_device_id = ?")
					.get(peerDeviceId),
			).toEqual({
				pinned_fingerprint: fingerprintPublicKey(peerPublicKey),
				public_key: peerPublicKey,
			});
			expect(first.discovered_devices).toEqual(second.discovered_devices);
			expect(Object.hasOwn(discovered ?? {}, "public_key")).toBe(false);
			expect(Object.hasOwn(discovered ?? {}, "coordinator_id")).toBe(false);
		} finally {
			globalThis.fetch = prevFetch;
			if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
			else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			db.close();
			peerDb.close();
			rmSync(keysDir, { recursive: true, force: true });
			rmSync(peerKeysDir, { recursive: true, force: true });
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

function markScopeMembershipCacheFresh(
	db: InstanceType<typeof Database>,
	coordinatorId: string,
	groupId: string,
	now: string,
): void {
	db.prepare(`INSERT OR REPLACE INTO scope_membership_cache_state(
		coordinator_id, group_id, last_refresh_at, last_success_at, last_error, updated_at
	) VALUES (?, ?, ?, ?, NULL, ?)`).run(coordinatorId, groupId, now, now, now);
}

describe("trustCoordinatorPeersWithSharedManagedScopes", () => {
	it("refreshes reciprocal trust after both devices gain the managed scope", async () => {
		const db = new Database(":memory:");
		const peerDb = new Database(":memory:");
		const keysDir = mkdtempSync(join(tmpdir(), "codemem-coordinator-local-key-"));
		const peerKeysDir = mkdtempSync(join(tmpdir(), "codemem-coordinator-peer-key-"));
		const prevFetch = globalThis.fetch;
		try {
			initTestSchema(db);
			initTestSchema(peerDb);
			const [localDeviceId] = ensureDeviceIdentity(db, { keysDir });
			const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
			const peerPublicKey = loadPublicKey(peerKeysDir);
			if (!peerPublicKey) throw new Error("expected peer public key");
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO replication_scopes(
				 scope_id, label, kind, authority_type, coordinator_id, group_id,
				 membership_epoch, status, created_at, updated_at
				 ) VALUES ('scope-1', 'Project', 'managed_project', 'coordinator',
				 'https://coord.example.test', 'group-1', 1, 'active', ?, ?)`,
			).run(now, now);
			const addMembership = db.prepare(
				`INSERT INTO scope_memberships(
				 scope_id, device_id, role, status, membership_epoch, updated_at
				 ) VALUES ('scope-1', ?, 'member', 'active', 1, ?)`,
			);
			addMembership.run(localDeviceId, now);
			addMembership.run(peerDeviceId, now);
			markScopeMembershipCacheFresh(db, "https://coord.example.test", "group-1", now);
			globalThis.fetch = (async () =>
				new Response(
					JSON.stringify({
						items: [
							{
								device_id: peerDeviceId,
								display_name: "Project peer",
								public_key: peerPublicKey,
								fingerprint: fingerprintPublicKey(peerPublicKey),
								addresses: ["http://peer.example:7337"],
								stale: false,
							},
						],
					}),
					{ status: 200 },
				)) as typeof fetch;

			await expect(
				refreshAuthorizedCoordinatorPeerTrust(
					{ db, dbPath: ":memory:" },
					readCoordinatorSyncConfig({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_groups: ["group-1"],
					}),
					{ keysDir },
				),
			).resolves.toMatchObject({ trusted: 1 });
			expect(
				db
					.prepare(
						`SELECT peer_device_id, discovered_via_coordinator_id, discovered_via_group_id,
						 trust_provenance
						 FROM sync_peers WHERE peer_device_id = ?`,
					)
					.get(peerDeviceId),
			).toEqual({
				peer_device_id: peerDeviceId,
				discovered_via_coordinator_id: "https://coord.example.test",
				discovered_via_group_id: "group-1",
				trust_provenance: "coordinator_policy",
			});

			db.prepare(
				"UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = 'scope-1' AND device_id = ?",
			).run(peerDeviceId);
			db.prepare(
				`UPDATE scope_membership_cache_state SET last_error = 'coordinator_unavailable'
				 WHERE coordinator_id = 'https://coord.example.test' AND group_id = 'group-1'`,
			).run();
			expect(revokeUnauthorizedCoordinatorPeerTrust(db, localDeviceId)).toBe(0);
			expect(
				db
					.prepare("SELECT pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?")
					.pluck()
					.get(peerDeviceId),
			).toBe(fingerprintPublicKey(peerPublicKey));

			markScopeMembershipCacheFresh(db, "https://coord.example.test", "group-1", now);
			expect(revokeUnauthorizedCoordinatorPeerTrust(db, localDeviceId)).toBe(1);
			expect(
				db
					.prepare("SELECT peer_device_id FROM sync_peers WHERE peer_device_id = ?")
					.get(peerDeviceId),
			).toBeUndefined();
		} finally {
			globalThis.fetch = prevFetch;
			db.close();
			peerDb.close();
			rmSync(keysDir, { recursive: true, force: true });
			rmSync(peerKeysDir, { recursive: true, force: true });
		}
	});

	it("does not revoke invite-derived or manually approved coordinator trust", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			db.prepare(
				`INSERT INTO sync_peers(
				 peer_device_id, pinned_fingerprint, public_key, actor_id,
				 discovered_via_coordinator_id, discovered_via_group_id, created_at
				 ) VALUES ('peer-invite', 'fp-invite', 'pk-invite', 'identity-invite',
				 'https://coord.example.test', 'group-1', ?)`,
			).run(new Date().toISOString());
			db.prepare(
				`INSERT INTO sync_peers(
				 peer_device_id, pinned_fingerprint, public_key,
				 discovered_via_coordinator_id, discovered_via_group_id, created_at
				 ) VALUES ('peer-manual', 'fp-manual', 'pk-manual',
				 'https://coord.example.test', 'group-1', ?)`,
			).run(new Date().toISOString());

			expect(revokeUnauthorizedCoordinatorPeerTrust(db, "local-device")).toBe(0);
			expect(
				db
					.prepare(
						`SELECT peer_device_id, pinned_fingerprint, public_key FROM sync_peers
						 ORDER BY peer_device_id`,
					)
					.all(),
			).toEqual([
				{
					peer_device_id: "peer-invite",
					pinned_fingerprint: "fp-invite",
					public_key: "pk-invite",
				},
				{
					peer_device_id: "peer-manual",
					pinned_fingerprint: "fp-manual",
					public_key: "pk-manual",
				},
			]);
		} finally {
			db.close();
		}
	});

	it("trusts a discovered peer only when local policy grants both devices the managed scope", () => {
		const db = new Database(":memory:");
		const keysDir = mkdtempSync(join(tmpdir(), "codemem-coordinator-peer-key-"));
		try {
			initTestSchema(db);
			const [peerDeviceId] = ensureDeviceIdentity(db, { keysDir });
			const publicKey = loadPublicKey(keysDir);
			if (!publicKey) throw new Error("expected peer public key");
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO replication_scopes(
				 scope_id, label, kind, authority_type, coordinator_id, group_id,
				 membership_epoch, status, created_at, updated_at
				 ) VALUES ('scope-1', 'Project', 'managed_project', 'coordinator',
				 'coordinator-1', 'group-1', 1, 'active', ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO scope_memberships(
				 scope_id, device_id, role, status, membership_epoch, updated_at
				 ) VALUES ('scope-1', ?, 'member', 'active', 1, ?)`,
			).run(peerDeviceId, now);
			const peers = [
				{
					device_id: peerDeviceId,
					display_name: "Project peer",
					public_key: publicKey,
					fingerprint: fingerprintPublicKey(publicKey),
					addresses: ["http://peer.example:7337"],
					coordinator_id: "coordinator-1",
					groups: ["group-1"],
				},
			];

			db.prepare(
				`INSERT INTO scope_memberships(
				 scope_id, device_id, role, status, membership_epoch, updated_at
				 ) VALUES ('scope-1', 'local-device', 'member', 'active', 1, ?)`,
			).run(now);
			db.prepare(
				"UPDATE scope_memberships SET membership_epoch = 0 WHERE scope_id = 'scope-1' AND device_id = ?",
			).run(peerDeviceId);

			expect(trustCoordinatorPeersWithSharedManagedScopes(db, "local-device", peers)).toBe(0);
			db.prepare(
				"UPDATE scope_memberships SET membership_epoch = 1 WHERE scope_id = 'scope-1' AND device_id = ?",
			).run(peerDeviceId);

			expect(trustCoordinatorPeersWithSharedManagedScopes(db, "local-device", peers)).toBe(0);
			markScopeMembershipCacheFresh(db, "coordinator-1", "group-1", now);
			db.prepare(
				`UPDATE scope_membership_cache_state SET last_error = 'coordinator_unavailable'
				 WHERE coordinator_id = 'coordinator-1' AND group_id = 'group-1'`,
			).run();
			expect(trustCoordinatorPeersWithSharedManagedScopes(db, "local-device", peers)).toBe(0);
			markScopeMembershipCacheFresh(db, "coordinator-1", "group-1", now);
			db.prepare(
				`INSERT INTO sync_peers(peer_device_id, claimed_local_actor, created_at)
				 VALUES (?, 1, ?)`,
			).run(peerDeviceId, now);
			expect(trustCoordinatorPeersWithSharedManagedScopes(db, "local-device", peers)).toBe(0);
			db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(peerDeviceId);
			expect(trustCoordinatorPeersWithSharedManagedScopes(db, "local-device", peers)).toBe(1);
			expect(
				db
					.prepare(
						"SELECT pinned_fingerprint, public_key, addresses_json FROM sync_peers WHERE peer_device_id = ?",
					)
					.get(peerDeviceId),
			).toEqual({
				pinned_fingerprint: fingerprintPublicKey(publicKey),
				public_key: publicKey,
				addresses_json: JSON.stringify(["http://peer.example:7337"]),
			});
		} finally {
			db.close();
			rmSync(keysDir, { recursive: true, force: true });
		}
	});

	it("pins only the key discovered through the shared scope authority when a conflicting key appears first", () => {
		const db = new Database(":memory:");
		const attackerDb = new Database(":memory:");
		const legitimateDb = new Database(":memory:");
		const attackerKeysDir = mkdtempSync(join(tmpdir(), "codemem-coordinator-attacker-key-"));
		const legitimateKeysDir = mkdtempSync(join(tmpdir(), "codemem-coordinator-legitimate-key-"));
		try {
			initTestSchema(db);
			initTestSchema(attackerDb);
			initTestSchema(legitimateDb);
			ensureDeviceIdentity(attackerDb, { keysDir: attackerKeysDir });
			ensureDeviceIdentity(legitimateDb, { keysDir: legitimateKeysDir });
			const attackerPublicKey = loadPublicKey(attackerKeysDir);
			const legitimatePublicKey = loadPublicKey(legitimateKeysDir);
			if (!attackerPublicKey || !legitimatePublicKey) {
				throw new Error("expected peer public keys");
			}
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO replication_scopes(
				 scope_id, label, kind, authority_type, coordinator_id, group_id,
				 membership_epoch, status, created_at, updated_at
				 ) VALUES ('scope-1', 'Project', 'managed_project', 'coordinator',
				 'https://coord.example.test', 'group-legitimate', 1, 'active', ?, ?)`,
			).run(now, now);
			const addMembership = db.prepare(
				`INSERT INTO scope_memberships(
				 scope_id, device_id, role, status, membership_epoch, updated_at
				 ) VALUES ('scope-1', ?, 'member', 'active', 1, ?)`,
			);
			addMembership.run("local-device", now);
			addMembership.run("shared-device", now);
			markScopeMembershipCacheFresh(db, "https://coord.example.test", "group-legitimate", now);

			const trusted = trustCoordinatorPeersWithSharedManagedScopes(db, "local-device", [
				{
					device_id: "shared-device",
					public_key: attackerPublicKey,
					fingerprint: fingerprintPublicKey(attackerPublicKey),
					coordinator_id: "https://coord.example.test",
					groups: ["group-attacker"],
				},
				{
					device_id: "shared-device",
					public_key: legitimatePublicKey,
					fingerprint: fingerprintPublicKey(legitimatePublicKey),
					coordinator_id: "https://coord.example.test",
					groups: ["group-legitimate"],
				},
			]);

			expect(trusted).toBe(1);
			expect(
				db
					.prepare("SELECT pinned_fingerprint, public_key FROM sync_peers WHERE peer_device_id = ?")
					.get("shared-device"),
			).toEqual({
				pinned_fingerprint: fingerprintPublicKey(legitimatePublicKey),
				public_key: legitimatePublicKey,
			});
		} finally {
			db.close();
			attackerDb.close();
			legitimateDb.close();
			rmSync(attackerKeysDir, { recursive: true, force: true });
			rmSync(legitimateKeysDir, { recursive: true, force: true });
		}
	});

	it("rejects discovered peers with missing or mismatched coordinator authority metadata", () => {
		const db = new Database(":memory:");
		const keysDb = new Database(":memory:");
		const keysDir = mkdtempSync(join(tmpdir(), "codemem-coordinator-mismatch-key-"));
		try {
			initTestSchema(db);
			initTestSchema(keysDb);
			ensureDeviceIdentity(keysDb, { keysDir });
			const publicKey = loadPublicKey(keysDir);
			if (!publicKey) throw new Error("expected peer public key");
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO replication_scopes(
				 scope_id, label, kind, authority_type, coordinator_id, group_id,
				 membership_epoch, status, created_at, updated_at
				 ) VALUES ('scope-1', 'Project', 'managed_project', 'coordinator',
				 'https://coord.example.test', 'group-1', 1, 'active', ?, ?)`,
			).run(now, now);
			const addMembership = db.prepare(
				`INSERT INTO scope_memberships(
				 scope_id, device_id, role, status, membership_epoch, updated_at
				 ) VALUES ('scope-1', ?, 'member', 'active', 1, ?)`,
			);
			addMembership.run("local-device", now);
			addMembership.run("peer-device", now);
			markScopeMembershipCacheFresh(db, "https://coord.example.test", "group-1", now);
			const peer = {
				device_id: "peer-device",
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
				groups: ["group-1"],
			};

			expect(trustCoordinatorPeersWithSharedManagedScopes(db, "local-device", [peer])).toBe(0);
			expect(
				trustCoordinatorPeersWithSharedManagedScopes(db, "local-device", [
					{ ...peer, coordinator_id: 123 },
				]),
			).toBe(0);
			expect(
				trustCoordinatorPeersWithSharedManagedScopes(db, "local-device", [
					{ ...peer, coordinator_id: "https://other-coord.example.test" },
				]),
			).toBe(0);
			expect(
				trustCoordinatorPeersWithSharedManagedScopes(db, "local-device", [
					{ ...peer, coordinator_id: "https://coord.example.test", groups: "group-1" },
				]),
			).toBe(0);
			expect(
				trustCoordinatorPeersWithSharedManagedScopes(db, "local-device", [
					{ ...peer, coordinator_id: "https://coord.example.test", groups: undefined },
				]),
			).toBe(0);
			expect(
				trustCoordinatorPeersWithSharedManagedScopes(db, "local-device", [
					{
						...peer,
						coordinator_id: "https://coord.example.test",
						groups: ["group-1", null],
					},
				]),
			).toBe(0);
			expect(db.prepare("SELECT COUNT(1) AS total FROM sync_peers").get()).toEqual({
				total: 0,
			});
		} finally {
			db.close();
			keysDb.close();
			rmSync(keysDir, { recursive: true, force: true });
		}
	});
});
