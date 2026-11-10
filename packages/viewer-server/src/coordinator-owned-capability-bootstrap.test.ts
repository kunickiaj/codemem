import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coordinatorListDevicesAction } from "../../core/src/coordinator-actions.js";
import {
	LEGACY_SETUP,
	type LinkedLegacySetupFixture,
	linkedLegacySetupFixture,
} from "../../core/src/linked-legacy-setup-test-fixtures.js";
import { MemoryStore } from "../../core/src/store.js";
import { createRecipientPolicyReconcilerEffects } from "./routes/sync.js";

vi.mock("@codemem/core", async () => import("../../core/src/index.js"));

const ORIGIN = "https://coordinator.example.test";
const SCOPE = "fixture-capability-scope";
const SECRET = "synthetic-bootstrap-admin";

let fixture: LinkedLegacySetupFixture;
let directory: string;
let store: MemoryStore;
let mutateListing: (row: Record<string, unknown>) => void;
let peerStatus: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(LEGACY_SETUP.now);
	directory = mkdtempSync(join(tmpdir(), "codemem-owned-bootstrap-"));
	const keysDir = join(directory, "keys");
	mkdirSync(keysDir);
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_DEVICE_ID", "device-a");
	fixture = await linkedLegacySetupFixture("SQLite", { adminSecret: SECRET });
	writeFileSync(
		join(keysDir, "device.key"),
		fixture.keyA.privateKey.export({ type: "pkcs8", format: "pem" }),
	);
	writeFileSync(join(keysDir, "device.key.pub"), fixture.keyA.publicKey);
	store = Object.assign(Object.create(MemoryStore.prototype), {
		db: fixture.local,
		deviceId: fixture.keyA.deviceId,
		dbPath: join(directory, "unused.sqlite"),
	});
	fixture.local
		.prepare(`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id,
			membership_epoch, status, created_at, updated_at
		) VALUES (?, 'Bootstrap boundary', 'managed_project', 'coordinator', ?, ?,
			1, 'active', ?, ?)`)
		.run(SCOPE, ORIGIN, LEGACY_SETUP.groupId, LEGACY_SETUP.now, LEGACY_SETUP.now);
	const presence = await fixture.signed(fixture.keyB, "POST", "/v1/presence", {
		group_id: LEGACY_SETUP.groupId,
		addresses: ["http://peer.example.test"],
		ttl_s: 600,
		capabilities: { sync_capability: "scoped", sync_features: ["reassign_scope"] },
	});
	expect(presence.status).toBe(200);
	mutateListing = () => {};
	peerStatus = { device_id: fixture.keyB.deviceId, fingerprint: fixture.keyB.fingerprint };
	fetchMock = vi.fn<typeof fetch>(async (input, init) => {
		const request = new Request(input, init);
		if (new URL(request.url).origin === "http://peer.example.test") {
			return Response.json(peerStatus);
		}
		if (new URL(request.url).origin !== ORIGIN) throw new Error("External network forbidden");
		const response = await fixture.app.request(request);
		if (new URL(request.url).pathname !== "/v1/admin/devices") return response;
		const payload = (await response.json()) as { items: Record<string, unknown>[] };
		payload.items.filter((row) => row.device_id === fixture.keyB.deviceId).forEach(mutateListing);
		return Response.json(payload, { status: response.status });
	});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
	await fixture?.close();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});

function effects(overrides: { remoteUrl?: string; groups?: string[] } = {}) {
	return createRecipientPolicyReconcilerEffects(store, {
		config: {
			syncCoordinatorUrl: overrides.remoteUrl ?? ORIGIN,
			syncCoordinatorAdminSecret: SECRET,
			syncCoordinatorGroups: overrides.groups ?? [LEGACY_SETUP.groupId],
		} as never,
		now: () => new Date().toISOString(),
	});
}

async function probe(e = effects()) {
	await e.listBoundaryEnrollments({
		scopeId: SCOPE,
		canonicalProjectIdentity: LEGACY_SETUP.project,
	});
	return e.probeCapability({ deviceId: fixture.keyB.deviceId, scopeId: SCOPE });
}

describe("coordinator-owned capability bootstrap", () => {
	it("uses actual canonical ownership and signed presence without an invite or peer pin", async () => {
		// Arrange: the maintained coordinator producer returns independent B ownership.
		const devices = await coordinatorListDevicesAction({
			groupId: LEGACY_SETUP.groupId,
			remoteUrl: ORIGIN,
			adminSecret: SECRET,
		});
		expect(devices.find((row) => row.device_id === fixture.keyB.deviceId)).toMatchObject({
			ownership_identity_id: LEGACY_SETUP.identityId,
			identity_id: LEGACY_SETUP.identityId,
			public_key: fixture.keyB.publicKey,
			fingerprint: fixture.keyB.fingerprint,
		});
		const before = fixture.local.prepare("SELECT * FROM sync_peers").all();
		const e = effects();
		// Act
		const listing = await e.listBoundaryEnrollments({
			scopeId: SCOPE,
			canonicalProjectIdentity: LEGACY_SETUP.project,
		});
		const result = await e.probeCapability({ scopeId: SCOPE, deviceId: fixture.keyB.deviceId });
		// Assert: capability preflight cannot itself create trust or grants.
		expect(result).toBe("supported");
		expect(listing).toStrictEqual(
			devices.map((row) => ({
				deviceId: row.device_id,
				identityId: row.identity_id,
				publicKey: row.public_key,
				fingerprint: row.fingerprint,
				enabled: row.enabled === 1,
			})),
		);
		expect(fixture.local.prepare("SELECT * FROM sync_peers").all()).toEqual(before);
		expect(
			fetchMock.mock.calls.some(([input]) => String(input).includes("/v1/admin/invites")),
		).toBe(false);
	});

	it.each([
		["missing", undefined],
		["null", null],
		["different", "identity-other"],
		["malformed", ` ${LEGACY_SETUP.identityId}`],
	])("does not substitute a legacy identity label for %s ownership", async (_label, ownership) => {
		// Arrange
		mutateListing = (row) => {
			row.ownership_identity_id = ownership;
		};
		// Act
		const result = await probe();
		// Assert
		expect(result).toBe("undetermined");
	});

	it.each(["missing", "expired", "unsupported"])(
		"requires fresh scoped signed presence: %s",
		async (kind) => {
			// Arrange
			mutateListing = (row) => {
				if (kind === "missing") delete row.presence_capabilities;
				if (kind === "expired") row.presence_expires_at = LEGACY_SETUP.now;
				if (kind === "unsupported") row.presence_capabilities = { sync_capability: "legacy" };
			};
			// Act
			const result = await probe();
			// Assert
			expect(result).toBe("undetermined");
		},
	);

	it("expires cached signed presence before probing", async () => {
		// Arrange
		const e = effects();
		await e.listBoundaryEnrollments({
			scopeId: SCOPE,
			canonicalProjectIdentity: LEGACY_SETUP.project,
		});
		vi.setSystemTime(new Date(Date.parse(LEGACY_SETUP.now) + 600_000));
		// Act
		const result = await e.probeCapability({ scopeId: SCOPE, deviceId: fixture.keyB.deviceId });
		// Assert
		expect(result).toBe("undetermined");
	});

	it("replaces ownership proof when the current snapshot removes it", async () => {
		// Arrange
		const e = effects();
		expect(await probe(e)).toBe("supported");
		mutateListing = (row) => {
			delete row.ownership_identity_id;
		};
		// Act
		const result = await probe(e);
		// Assert
		expect(result).toBe("undetermined");
	});
});

describe("coordinator-owned capability trust constraints", () => {
	it("requires reassign_scope in fresh signed scoped presence", async () => {
		// Arrange: signed presence is fresh, but the device lacks the required feature.
		const presence = await fixture.signed(fixture.keyB, "POST", "/v1/presence", {
			group_id: LEGACY_SETUP.groupId,
			addresses: ["http://peer.example.test"],
			ttl_s: 600,
			capabilities: { sync_capability: "scoped", sync_features: [] },
		});
		expect(presence.status).toBe(200);
		// Act
		const result = await probe();
		// Assert
		expect(result).toBe("undetermined");
	});

	it("requires the producer's ownership binding to match the actual canonical enrollment key", async () => {
		// Arrange: an old ownership binding for the same device cannot prove its current key.
		fixture.coordinator.db
			.prepare(`UPDATE enrolled_devices
			SET public_key = ?, fingerprint = ? WHERE device_id = ?`)
			.run(fixture.keyA.publicKey, fixture.keyA.fingerprint, fixture.keyB.deviceId);
		// Act
		const result = await probe();
		// Assert
		expect(result).toBe("undetermined");
	});

	it("rejects inconsistent enrollment key and fingerprint before bootstrap", async () => {
		// Arrange
		mutateListing = (row) => {
			row.fingerprint = "wrong-fingerprint";
		};
		// Act
		const result = probe();
		// Assert
		await expect(result).rejects.toThrow("recipient_policy_snapshot_invalid");
	});

	it("does not override a conflicting local pin", async () => {
		// Arrange
		fixture.local
			.prepare(`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, created_at)
			VALUES (?, 'conflicting-pin', ?)`)
			.run(fixture.keyB.deviceId, LEGACY_SETUP.now);
		// Act
		const result = await probe();
		// Assert
		expect(result).toBe("undetermined");
	});

	it.each(["supported", "unsupported"])(
		"preserves directly observed %s capability",
		async (expected) => {
			// Arrange
			fixture.local
				.prepare(`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key,
			addresses_json, created_at) VALUES (?, ?, ?, ?, ?)`)
				.run(
					fixture.keyB.deviceId,
					fixture.keyB.fingerprint,
					fixture.keyB.publicKey,
					JSON.stringify(["http://peer.example.test"]),
					LEGACY_SETUP.now,
				);
			peerStatus.sync_capability = expected === "supported" ? "scoped" : "legacy";
			peerStatus.sync_features = ["reassign_scope"];
			// Act
			const result = await probe();
			// Assert
			expect(result).toBe(expected);
		},
	);

	it.each([{ remoteUrl: "https://other.example.test" }, { groups: ["other-group"] }])(
		"rejects coordinator configuration outside the scope boundary: %j",
		async (options) => {
			// Arrange
			const e = effects(options);
			// Act
			const result = probe(e);
			// Assert
			await expect(result).rejects.toThrow("recipient_policy_effect_failed");
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);
});
