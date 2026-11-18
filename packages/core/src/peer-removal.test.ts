import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CoordinatorSyncConfig,
	coordinatorAdminReadiness,
	isCoordinatorAdminDevice,
	readCoordinatorSyncConfig,
} from "./coordinator-sync-config.js";
import { ensureMemoryRetirementDeliverySchema } from "./memory-retirement-delivery-schema.js";
import {
	type CoordinatorDeviceAnswer,
	decidePeerBinding,
	removePeerFromThisDevice,
} from "./peer-removal.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-11-17T00:00:00.000Z";
const LOCAL = "device-local";
const PEER = "device-peer";
const IDENTITY = "identity-a";
let configDirectory: string;
beforeEach(() => {
	configDirectory = mkdtempSync(join(tmpdir(), "peer-removal-config-"));
	const path = join(configDirectory, "config.json");
	writeFileSync(path, "{}");
	vi.stubEnv("CODEMEM_CONFIG", path);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(configDirectory, { recursive: true, force: true });
});

/** Coordinator settings that do not depend on the environment or a config file. */
function settings(
	overrides: { url?: string; groups?: string[]; adminSecret?: string } = {},
): CoordinatorSyncConfig {
	const groups = overrides.groups ?? [];
	return {
		...readCoordinatorSyncConfig({}),
		syncCoordinatorUrl: overrides.url ?? "",
		syncCoordinatorGroup: groups[0] ?? "",
		syncCoordinatorGroups: groups,
		syncCoordinatorAdminSecret: overrides.adminSecret ?? "",
	};
}

const URL = "https://coord.example.test";
const NO_COORDINATOR = settings();
const MEMBER = settings({ url: URL, groups: ["group-a"] });
const ADMIN = settings({ url: URL, groups: ["group-a"], adminSecret: "fixture-admin-secret" });

describe("coordinator admin readiness", () => {
	it.each([
		["no URL", NO_COORDINATOR, "not_configured", false],
		[
			"a secret and a group but no URL",
			settings({ groups: ["group-a"], adminSecret: "fixture-admin-secret" }),
			"not_configured",
			false,
		],
		["a URL and a group but no secret", MEMBER, "partial", false],
		[
			"a URL and a secret but no group",
			settings({ url: URL, adminSecret: "fixture-admin-secret" }),
			"partial",
			false,
		],
		["a URL, a group, and the secret", ADMIN, "ready", true],
	] as const)("%s is %s", (_name, config, readiness, adminDevice) => {
		expect(coordinatorAdminReadiness(config)).toBe(readiness);
		expect(isCoordinatorAdminDevice(config)).toBe(adminDevice);
	});
});

describe("decidePeerBinding", () => {
	it.each([
		// admin device, coordinator configured, coordinator answer, binding
		[true, true, "removed", "ended"],
		[true, true, "revoked", "ended"],
		[true, true, "not_enrolled", "ended"],
		[true, true, "enrolled", "ended"],
		[true, true, "unknown", "ended"],
		[true, false, "removed", "ended"],
		[true, false, "revoked", "ended"],
		[true, false, "not_enrolled", "ended"],
		[true, false, "enrolled", "ended"],
		[true, false, "unknown", "ended"],
		[false, false, "removed", "ended"],
		[false, false, "revoked", "ended"],
		[false, false, "not_enrolled", "ended"],
		[false, false, "enrolled", "ended"],
		[false, false, "unknown", "ended"],
		[false, true, "removed", "ended"],
		[false, true, "revoked", "ended"],
		[false, true, "not_enrolled", "ended"],
		[false, true, "enrolled", "kept"],
		[false, true, "unknown", "kept"],
		// An answer outside the known set is no confirmation.
		[false, true, "absent" as CoordinatorDeviceAnswer, "kept"],
	] as const)(
		"admin device %s, coordinator configured %s, answer %s: the binding is %s",
		(isAdminDevice, coordinatorConfigured, coordinatorAnswer, outcome) => {
			expect(decidePeerBinding({ isAdminDevice, coordinatorConfigured, coordinatorAnswer })).toBe(
				outcome,
			);
		},
	);
});

let db: InstanceType<typeof Database>;

function seedPeer(deviceId: string) {
	db.prepare("INSERT INTO sync_peers(peer_device_id, name, created_at) VALUES (?, 'Peer', ?)").run(
		deviceId,
		NOW,
	);
	db.prepare(
		`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
		 revision, migration_state, idempotency_key, created_at, updated_at)
		 VALUES (?, ?, 'Peer', 'active', 'test', '1', 'user_managed', ?, ?, ?)`,
	).run(deviceId, IDENTITY, `binding:${deviceId}`, NOW, NOW);
}

function state(deviceId = PEER) {
	const count = (table: string) =>
		Number(
			db.prepare(`SELECT COUNT(*) FROM ${table} WHERE peer_device_id = ?`).pluck().get(deviceId),
		);
	return {
		pairings: count("sync_peers"),
		binding: db
			.prepare("SELECT status FROM identity_devices WHERE device_id = ?")
			.pluck()
			.get(deviceId),
	};
}

const KEPT = { pairings: 0, binding: "active" };

function useSeededStore() {
	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		ensureMemoryRetirementDeliverySchema(db);
		seedPeer(PEER);
	});

	afterEach(() => db.close());
}

const remove = (
	readConfig: () => CoordinatorSyncConfig,
	lookupCoordinatorAnswer?: Parameters<
		typeof removePeerFromThisDevice
	>[1]["lookupCoordinatorAnswer"],
	peerDeviceId = PEER,
) =>
	removePeerFromThisDevice(db, {
		localDeviceId: LOCAL,
		peerDeviceId,
		readConfig,
		lookupCoordinatorAnswer,
	});

describe("removePeerFromThisDevice when it cannot decide or cannot write", () => {
	useSeededStore();

	it("keeps the binding when the lookup fails", async () => {
		const result = await remove(
			() => MEMBER,
			async () => {
				throw new Error("lookup failed");
			},
		);

		expect(result.binding).toBe("kept");
		expect(state()).toEqual(KEPT);
	});

	it("keeps the binding when the coordinator settings cannot be read", async () => {
		const result = await remove(() => {
			throw new Error("settings unreadable");
		});

		expect(result.binding).toBe("kept");
		expect(state()).toEqual(KEPT);
	});

	it("reads the coordinator settings after the answer arrives, so a secret removed meanwhile keeps the binding", async () => {
		let current = ADMIN;

		const result = await remove(
			() => current,
			async () => {
				current = MEMBER;
				return "enrolled";
			},
		);

		expect(result.binding).toBe("kept");
		expect(state()).toEqual(KEPT);
	});

	it("never ends this device's own binding, even on an admin device", async () => {
		seedPeer(LOCAL);

		const result = await remove(() => ADMIN, undefined, LOCAL);

		expect(result.binding).toBe("kept");
		expect(result.removed).toMatchObject({ syncPeers: 1, identityDevices: 0 });
		expect(state(LOCAL)).toEqual(KEPT);
		expect(state(PEER).pairings).toBe(1);
	});
});
