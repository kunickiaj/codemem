import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { readCoordinatorSyncConfig } from "./coordinator-sync-config.js";
import { connect } from "./db.js";
import { relayPeerScopes } from "./relay-peer-reachability.js";
import { refreshConfiguredScopeMembershipCache } from "./scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheTime,
	cacheWireSnapshot,
} from "./scope-membership-cache-test-fixtures.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { requestJson } from "./sync-http-client.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

vi.mock("./sync-http-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./sync-http-client.js")>()),
	requestJson: vi.fn(),
}));

const coordinatorId = "https://coord.example.test";
const config = {
	...readCoordinatorSyncConfig({}),
	syncEnabled: true,
	syncCoordinatorUrl: coordinatorId,
	syncCoordinatorGroups: ["group-a"],
	syncCoordinatorAdminSecret: "test-secret",
};
const request = vi.mocked(requestJson);
let directory: string;
let db: ReturnType<typeof connect>;
let dbPath: string;
let keysDir: string;
let snapshot: ReturnType<typeof cacheWireSnapshot>;
const scope = cacheScope({ coordinator_id: coordinatorId, kind: "managed_project" });

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(cacheTime));
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	directory = mkdtempSync(join(tmpdir(), "codemem-demand-refresh-"));
	dbPath = join(directory, "mem.sqlite");
	keysDir = join(directory, "keys");
	db = connect(dbPath);
	initTestSchema(db);
	const [localId] = ensureDeviceIdentity(db, { keysDir });
	const localKey = db.prepare("SELECT public_key FROM sync_device").pluck().get() as string;
	db.prepare(
		"INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
	).run("peer-a", CANONICAL_PUBLIC_KEY, fingerprintPublicKey(CANONICAL_PUBLIC_KEY), cacheTime);
	snapshot = cacheWireSnapshot(scope, [cacheMember(scope, localId), cacheMember(scope, "peer-a")]);
	const local = snapshot.items.find((item) => item.membership.device_id === localId);
	if (!local?.enrollment) throw new Error("Missing synthetic local authorization");
	const keyId = await ed25519KeyId(localKey);
	if (!keyId) throw new Error("Invalid synthetic authorization key");
	snapshot = {
		...snapshot,
		items: snapshot.items.map((item) =>
			item === local
				? {
						...local,
						enrollment: {
							...local.enrollment,
							public_key: localKey,
							fingerprint: fingerprintPublicKey(localKey),
						},
						key_id: keyId,
					}
				: item,
		),
	};
	request.mockImplementation(
		async (_method, url) =>
			[200, url.includes("/members?") ? snapshot : { version: 1, items: [scope] }] as Awaited<
				ReturnType<typeof requestJson>
			>,
	);
	const seeded = await refreshConfiguredScopeMembershipCache(db, config, { keysDir, dbPath });
	expect(seeded, JSON.stringify(seeded)).toMatchObject({ status: "refreshed" });
	request.mockClear();
});

afterEach(() => {
	db.close();
	rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("on-demand scope authorization", () => {
	it("revalidates the 61-second stale cache before the next 120-second daemon tick", async () => {
		vi.setSystemTime(new Date(Date.parse(cacheTime) + 61_000));
		expect(relayPeerScopes(db, "peer-a", coordinatorId)).toHaveLength(0);
		await refreshConfiguredScopeMembershipCache(db, config, { keysDir, dbPath, onlyIfStale: true });
		expect(request).toHaveBeenCalledTimes(2);
		expect(relayPeerScopes(db, "peer-a", coordinatorId)).toHaveLength(1);
	});

	it("does not make a coordinator request while configured authorization is fresh", async () => {
		vi.setSystemTime(new Date(Date.parse(cacheTime) + 59_000));
		await refreshConfiguredScopeMembershipCache(db, config, { keysDir, dbPath, onlyIfStale: true });
		expect(request).not.toHaveBeenCalled();
		expect(relayPeerScopes(db, "peer-a", coordinatorId)).toHaveLength(1);
	});

	it("preserves the daemon's unconditional refresh behavior", async () => {
		await refreshConfiguredScopeMembershipCache(db, config, { keysDir, dbPath });
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("ignores stale cache records for authorities that are not configured", async () => {
		db.prepare(`INSERT INTO scope_membership_cache_state
			(coordinator_id, group_id, last_refresh_at, last_success_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
			"https://other.example.test",
			"old-group",
			"2026-01-01",
			"2026-01-01",
			"2026-01-01",
		);
		await refreshConfiguredScopeMembershipCache(db, config, { keysDir, dbPath, onlyIfStale: true });
		expect(request).not.toHaveBeenCalled();
	});

	it("does not initialize a missing local identity during on-demand refresh", async () => {
		db.prepare("DELETE FROM sync_device").run();
		await refreshConfiguredScopeMembershipCache(db, config, { keysDir, dbPath, onlyIfStale: true });
		expect(request).not.toHaveBeenCalled();
		expect(db.prepare("SELECT COUNT(*) AS count FROM sync_device").get()).toEqual({ count: 0 });
	});

	it("leaves relay unavailable when coordinator revalidation fails", async () => {
		vi.setSystemTime(new Date(Date.parse(cacheTime) + 61_000));
		request.mockRejectedValue(new Error("synthetic coordinator unavailable"));
		await refreshConfiguredScopeMembershipCache(db, config, { keysDir, dbPath, onlyIfStale: true });
		expect(relayPeerScopes(db, "peer-a", coordinatorId)).toHaveLength(0);
		const row = db.prepare("SELECT last_success_at FROM scope_membership_cache_state").get();
		expect(row).toEqual({ last_success_at: cacheTime });
	});

	it("does not restore a peer that the fresh snapshot removes", async () => {
		vi.setSystemTime(new Date(Date.parse(cacheTime) + 61_000));
		snapshot = {
			...snapshot,
			items: snapshot.items.filter((item) => item.membership.device_id !== "peer-a"),
		};
		await refreshConfiguredScopeMembershipCache(db, config, { keysDir, dbPath, onlyIfStale: true });
		expect(request).toHaveBeenCalledTimes(2);
		expect(relayPeerScopes(db, "peer-a", coordinatorId)).toHaveLength(0);
	});

	it("does not authorize relay from malformed fresh enrollment evidence", async () => {
		vi.setSystemTime(new Date(Date.parse(cacheTime) + 61_000));
		snapshot = {
			...snapshot,
			items: snapshot.items.map((item) => ({ ...item, key_id: "0".repeat(64) })),
		};
		const refreshed = await refreshConfiguredScopeMembershipCache(db, config, {
			keysDir,
			dbPath,
			onlyIfStale: true,
		});
		expect(refreshed.status).toBe("stale");
		expect(relayPeerScopes(db, "peer-a", coordinatorId)).toHaveLength(0);
	});
});
