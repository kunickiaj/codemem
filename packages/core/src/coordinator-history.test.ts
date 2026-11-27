import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deviceHasCoordinatorHistory,
	ensureCoordinatorHistorySchema,
	readStoreId,
	storeHasCoordinatorHistory,
} from "./coordinator-history.js";
import { lookupCoordinatorPeers, readCoordinatorSyncConfig } from "./coordinator-runtime.js";
import { connect } from "./db.js";
import { rememberPeerProjectFilterManagement } from "./peer-project-filter-management.js";
import { ensureScopeMembershipCacheStateTable } from "./scope-membership-cache.js";
import { refreshCoordinatorForDaemon } from "./sync-daemon.js";
import { updatePeerAddresses } from "./sync-peer-addresses.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-11-27T12:00:00.000Z";
const PEER_KEY = "ssh-ed25519 peer-public-key";
const PEER_FINGERPRINT = "peer-fingerprint";

let directory: string;
let db: Database.Database;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "coordinator-history-"));
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, "{}");
	vi.stubEnv("CODEMEM_CONFIG", configPath);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	for (const name of ["URL", "GROUP", "GROUPS", "ADMIN_SECRET"]) {
		vi.stubEnv(`CODEMEM_SYNC_COORDINATOR_${name}`, undefined);
	}
	db = new Database(join(directory, "mem.sqlite"));
	initTestSchema(db);
});

afterEach(() => {
	db.close();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(directory, { recursive: true, force: true });
});

function history() {
	return db
		.prepare(
			"SELECT subject_kind, device_id, fingerprint, source FROM coordinator_history ORDER BY 1, 2, 3",
		)
		.all();
}

/** What `sync pair --accept` saves: a pin with manual addresses and no coordinator fields. */
function pairManually(deviceId = "peer-1") {
	updatePeerAddresses(db, deviceId, ["peer.example.test:7337"], {
		pinnedFingerprint: PEER_FINGERPRINT,
		publicKey: PEER_KEY,
		replaceTrust: true,
	});
}

function insertScope(scopeId: string, authority: string, coordinatorId: string | null) {
	db.prepare(
		`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id, group_id,
		 membership_epoch, status, created_at, updated_at) VALUES (?, ?, 'team', ?, ?, ?, 1, 'active', ?, ?)`,
	).run(scopeId, scopeId, authority, coordinatorId, coordinatorId && "group-1", NOW, NOW);
}

function stubPeerListing(deviceId: string, fingerprint: string) {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						items: [{ device_id: deviceId, fingerprint, public_key: PEER_KEY, addresses: [] }],
					}),
					{ status: 200 },
				),
		),
	);
}

async function listCoordinatorPeers() {
	return lookupCoordinatorPeers(
		{ db, dbPath: join(directory, "mem.sqlite") },
		readCoordinatorSyncConfig({
			sync_coordinator_url: "https://coord.example.test",
			sync_coordinator_groups: ["team-a"],
		}),
		{ keysDir: join(directory, "keys") },
	);
}

describe("store identity", () => {
	it("is created once and kept across reopening, and differs between stores", () => {
		const storeId = readStoreId(db);
		db.close();
		db = connect(join(directory, "mem.sqlite"));
		ensureCoordinatorHistorySchema(db);

		const other = new Database(":memory:");
		initTestSchema(other);

		expect(storeId).toMatch(/^[0-9a-f-]{36}$/u);
		expect(readStoreId(db)).toBe(storeId);
		expect(readStoreId(other)).not.toBe(storeId);
		other.close();
	});
});

describe("coordinator writes record history in the same transaction", () => {
	it("records nothing for a store with local scopes and a manual pairing", () => {
		insertScope("local-only", "local", null);
		pairManually();

		expect(history()).toEqual([]);
		expect(storeHasCoordinatorHistory(db)).toBe(false);
		expect(deviceHasCoordinatorHistory(db, "peer-1")).toBe(false);
	});

	it("records a coordinator scope, membership and refresh", () => {
		insertScope("team-scope", "coordinator", "https://coord.example.test");
		// An upsert repeats the trigger's write, which must not abort the coordinator's write.
		const membership = db.prepare(
			`INSERT INTO scope_memberships(scope_id, device_id, membership_epoch, coordinator_id, group_id,
			 updated_at) VALUES ('team-scope', 'member-1', 1, 'https://coord.example.test', 'group-1', ?)
			 ON CONFLICT(scope_id, device_id) DO UPDATE SET coordinator_id = excluded.coordinator_id`,
		);
		membership.run(NOW);
		membership.run(NOW);
		db.prepare(
			`INSERT INTO scope_membership_cache_state(coordinator_id, group_id, last_refresh_at, updated_at)
			 VALUES ('https://coord.example.test', 'group-1', ?, ?)`,
		).run(NOW, NOW);

		expect(history()).toEqual([
			{
				subject_kind: "device",
				device_id: "member-1",
				fingerprint: "",
				source: "scope_membership",
			},
			{ subject_kind: "store", device_id: "", fingerprint: "", source: "scope" },
		]);
	});

	it("records a membership refresh and a filter policy marker on their own", () => {
		// The refresh table can be created after startup, and still gets its trigger.
		db.exec("DROP TABLE scope_membership_cache_state");
		ensureScopeMembershipCacheStateTable(db);
		db.prepare(
			`INSERT INTO scope_membership_cache_state(coordinator_id, group_id, last_refresh_at, updated_at)
			 VALUES ('https://coord.example.test', 'group-1', ?, ?)`,
		).run(NOW, NOW);
		const other = new Database(":memory:");
		initTestSchema(other);
		rememberPeerProjectFilterManagement(other);

		expect(history()).toEqual([
			{ subject_kind: "store", device_id: "", fingerprint: "", source: "membership_cache" },
		]);
		expect(other.prepare("SELECT source FROM coordinator_history").pluck().all()).toEqual([
			"filter_management",
		]);
		other.close();
	});

	it("records an invitation's inviter pin and managed Project in the same write", () => {
		// What accepting an invitation saves: the inviter's pin, then its group and grant.
		updatePeerAddresses(db, "inviter", [], {
			pinnedFingerprint: PEER_FINGERPRINT,
			publicKey: PEER_KEY,
			replaceTrust: true,
		});
		db.prepare(
			"UPDATE sync_peers SET pending_bootstrap_grant_id = 'grant-1', discovered_via_group_id = 'team-a'",
		).run();
		const other = new Database(":memory:");
		initTestSchema(other);
		other
			.prepare(
				`INSERT INTO recipient_managed_project_projections(canonical_project_identity, display_name,
				 managed_scope_id, coordinator_id, group_id, recipient_identity_id, accepting_device_id,
				 source_operation_id, reviewed_project_set_digest, accepted_at, created_at, updated_at)
				 VALUES ('project', 'Project', 'scope', 'https://coord.example.test', 'team-a', 'identity',
				 'device', 'operation', 'digest', ?, ?, ?)`,
			)
			.run(NOW, NOW, NOW);

		expect(history()).toEqual([
			{
				subject_kind: "device",
				device_id: "inviter",
				fingerprint: PEER_FINGERPRINT,
				source: "peer_trust",
			},
			{ subject_kind: "store", device_id: "", fingerprint: "", source: "peer_trust" },
		]);
		expect(other.prepare("SELECT source FROM coordinator_history").pluck().all()).toEqual([
			"invitation",
		]);
		other.close();
	});
});

describe("history outlasts its evidence and fails closed", () => {
	it("keeps history after the evidence is deleted and the settings are cleared", () => {
		pairManually();
		db.prepare(
			"UPDATE sync_peers SET discovered_via_group_id = 'group-1' WHERE peer_device_id = 'peer-1'",
		).run();
		insertScope("team-scope", "coordinator", "https://coord.example.test");

		db.prepare("DELETE FROM sync_peers").run();
		db.prepare("DELETE FROM replication_scopes").run();
		pairManually();

		expect(storeHasCoordinatorHistory(db)).toBe(true);
		expect(deviceHasCoordinatorHistory(db, "peer-1")).toBe(true);
	});

	it("records evidence an older runtime left behind when the history schema is added", () => {
		pairManually("peer-1");
		db.prepare(
			"UPDATE sync_peers SET pending_bootstrap_grant_id = 'grant-1' WHERE peer_device_id = 'peer-1'",
		).run();
		db.exec("DELETE FROM coordinator_history");
		for (const name of db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'coordinator_history_%'",
			)
			.pluck()
			.all() as string[]) {
			db.exec(`DROP TRIGGER ${name}`);
		}
		db.exec("DROP TABLE coordinator_history");

		ensureCoordinatorHistorySchema(db);

		expect(history()).toEqual([
			{
				subject_kind: "device",
				device_id: "peer-1",
				fingerprint: PEER_FINGERPRINT,
				source: "backfill",
			},
			{ subject_kind: "store", device_id: "", fingerprint: "", source: "backfill" },
		]);
	});

	it("reads live evidence when a trigger was missing, and fails closed without the table", () => {
		db.exec("DROP TRIGGER coordinator_history_scope_insert");
		insertScope("team-scope", "coordinator", "https://coord.example.test");
		expect(history()).toEqual([]);
		expect(storeHasCoordinatorHistory(db)).toBe(true);

		db.exec("DROP TABLE coordinator_history");
		expect(storeHasCoordinatorHistory(db)).toBe(true);
		expect(deviceHasCoordinatorHistory(db, "anyone")).toBe(true);
	});
});

describe("coordinator discovery records every listed device", () => {
	it("records a manually paired device that discovery lists, while its pin stays untagged", async () => {
		pairManually("peer-1");
		stubPeerListing("peer-1", PEER_FINGERPRINT);

		await listCoordinatorPeers();

		expect(
			db
				.prepare(
					"SELECT discovered_via_group_id, trust_provenance, explicit_pairing_fingerprint FROM sync_peers",
				)
				.get(),
		).toEqual({
			discovered_via_group_id: null,
			trust_provenance: null,
			explicit_pairing_fingerprint: PEER_FINGERPRINT,
		});
		expect(deviceHasCoordinatorHistory(db, "peer-1")).toBe(true);
		expect(storeHasCoordinatorHistory(db)).toBe(true);
	});

	it("keeps the history of a discovered device that is later paired manually", async () => {
		stubPeerListing("peer-1", PEER_FINGERPRINT);
		await listCoordinatorPeers();

		pairManually("peer-1");

		expect(deviceHasCoordinatorHistory(db, "peer-1")).toBe(true);
		expect(deviceHasCoordinatorHistory(db, "peer-2")).toBe(false);
	});
});

describe("configured coordinators are recorded before any coordinator call", () => {
	it.each([
		[
			"the config file",
			() =>
				writeFileSync(
					String(process.env.CODEMEM_CONFIG),
					JSON.stringify({ sync_coordinator_url: "https://coord.example.test" }),
				),
		],
		["the environment", () => vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUPS", "team-a")],
	])("records a coordinator set in %s and keeps it after removal", async (_source, configure) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		configure();

		// A URL or groups alone enable nothing, so no request is made.
		expect(await refreshCoordinatorForDaemon(db, join(directory, "mem.sqlite"))).toEqual({
			refreshed: false,
			peers: null,
		});
		writeFileSync(String(process.env.CODEMEM_CONFIG), "{}");
		vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUPS", undefined);
		await refreshCoordinatorForDaemon(db, join(directory, "mem.sqlite"));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(history()).toEqual([
			{ subject_kind: "store", device_id: "", fingerprint: "", source: "config" },
		]);
	});

	it("records nothing for a store without coordinator settings", async () => {
		await refreshCoordinatorForDaemon(db, join(directory, "mem.sqlite"));

		expect(storeHasCoordinatorHistory(db)).toBe(false);
	});
});
