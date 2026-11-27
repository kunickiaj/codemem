import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CoordinatorEnrollment,
	type DeviceIdentityCoordinatorEvidence,
	fingerprintPublicKey,
	legacyPairingAssignmentsConverted,
	MemoryStore,
	readCoordinatorSyncConfig,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	convertLegacyPairingAssignmentsOperation,
	loadAllGroupsDeviceIdentityCoordinatorEvidence,
	syncRoutes,
} from "./routes/sync.js";

const NOW = "2026-11-18T00:00:00.000Z";
const PEER = "device-peer";
let directory: string;
let store: MemoryStore;

function claimPeerAsOwnDevice() {
	const publicKey = "peer-key";
	store.db
		.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, public_key, pinned_fingerprint,
			 claimed_local_actor, created_at) VALUES (?, 'Laptop', ?, ?, 1, ?)`,
		)
		.run(PEER, publicKey, fingerprintPublicKey(publicKey), NOW);
}

function boundIdentity() {
	return store.db
		.prepare("SELECT identity_id FROM identity_devices WHERE device_id = ?")
		.pluck()
		.get(PEER);
}

// The older route needs the admin device; these tests are about the conversion.
const ADMIN_ROUTE_OPTIONS = {
	readCoordinatorConfig: () =>
		readCoordinatorSyncConfig({
			sync_coordinator_url: "https://coord.example.test",
			sync_coordinator_groups: ["group-admin"],
			sync_coordinator_admin_secret: "fixture-admin-secret",
		}),
};

async function clearClaim(options: Parameters<typeof syncRoutes>[2] = ADMIN_ROUTE_OPTIONS) {
	return syncRoutes(() => store, undefined, options).request("/api/sync/peers/identity", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ peer_device_id: PEER, claimed_local_actor: false }),
	});
}

function localActorRows() {
	return store.db.prepare("SELECT COUNT(*) FROM actors WHERE is_local = 1").pluck().get();
}

function peerEnrollment(groupId: string, identityId: string): CoordinatorEnrollment {
	return {
		group_id: groupId,
		device_id: PEER,
		public_key: "peer-key",
		fingerprint: fingerprintPublicKey("peer-key"),
		identity_id: identityId,
		display_name: "Laptop",
		enabled: 1,
		created_at: NOW,
	};
}

const available = async (): Promise<DeviceIdentityCoordinatorEvidence> => ({
	availability: "available",
	safeErrorCode: null,
	enrollments: [],
});
const unreachable = async (): Promise<DeviceIdentityCoordinatorEvidence> => ({
	availability: "unavailable",
	safeErrorCode: "coordinator_unavailable",
	enrollments: [],
});

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "legacy-pairing-assignment-"));
	vi.stubEnv("CODEMEM_KEYS_DIR", join(directory, "keys"));
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_ACTOR_ID", "identity-local");
	vi.stubEnv("CODEMEM_DEVICE_ID", "device-local");
	writeFileSync(join(directory, "config.json"), JSON.stringify({ actor_id: "identity-local" }));
	store = new MemoryStore(join(directory, "memory.sqlite"));
});

afterEach(() => {
	store.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe("converting older device assignments during coordinator maintenance", () => {
	it("binds a device claimed as the user's own to the local Identity, creating that Identity first", async () => {
		claimPeerAsOwnDevice();

		const result = await convertLegacyPairingAssignmentsOperation(store, {
			loadCoordinatorEvidence: available,
		});

		expect(result).toEqual({ status: "converted", waitingReason: null });
		expect(boundIdentity()).toBe(store.actorId);
	});

	it("writes nothing when the admin secret is removed while the evidence is fetched", async () => {
		claimPeerAsOwnDevice();
		const admin = {
			actor_id: "identity-local",
			sync_coordinator_url: "https://coord.example.test",
			sync_coordinator_groups: ["group-admin"],
			sync_coordinator_admin_secret: "fixture-admin-secret",
		};
		for (const name of ["URL", "GROUP", "GROUPS", "ADMIN_SECRET"]) {
			vi.stubEnv(`CODEMEM_SYNC_COORDINATOR_${name}`, undefined);
		}
		writeFileSync(join(directory, "config.json"), JSON.stringify(admin));

		const result = await convertLegacyPairingAssignmentsOperation(store, {
			loadCoordinatorEvidence: async (config) => {
				expect(config.syncCoordinatorAdminSecret).toBe("fixture-admin-secret");
				writeFileSync(
					join(directory, "config.json"),
					JSON.stringify({ ...admin, sync_coordinator_admin_secret: "" }),
				);
				return available();
			},
		});

		expect(result).toEqual({ status: "waiting", waitingReason: "coordinator_authority_changed" });
		expect(boundIdentity()).toBeUndefined();
		expect(legacyPairingAssignmentsConverted(store.db)).toBe(false);
	});

	it("changes nothing while the configured coordinator cannot be read", async () => {
		claimPeerAsOwnDevice();

		const result = await convertLegacyPairingAssignmentsOperation(store, {
			loadCoordinatorEvidence: unreachable,
		});

		expect(result).toEqual({
			status: "waiting",
			waitingReason: "coordinator_evidence_unavailable",
		});
		expect(boundIdentity()).toBeUndefined();
	});

	it("leaves the Identity records as they were when it has to wait", async () => {
		claimPeerAsOwnDevice();
		const actorsBefore = localActorRows();
		expect(actorsBefore).toBe(0);

		await convertLegacyPairingAssignmentsOperation(store, { loadCoordinatorEvidence: unreachable });

		expect(localActorRows()).toBe(actorsBefore);
	});

	it("leaves a device unbound when a group this device does not sync with names someone else", async () => {
		claimPeerAsOwnDevice();
		const listEnrollments = vi.fn(async () => [
			peerEnrollment("group-configured", store.actorId),
			peerEnrollment("group-elsewhere", "identity-other"),
		]);

		const result = await convertLegacyPairingAssignmentsOperation(store, {
			loadCoordinatorEvidence: () =>
				loadAllGroupsDeviceIdentityCoordinatorEvidence({
					config: {
						...readCoordinatorSyncConfig(),
						syncCoordinatorUrl: "https://coordinator.example.test",
						syncCoordinatorAdminSecret: "synthetic-admin",
						syncCoordinatorGroups: ["group-configured"],
					},
					listEnrollments,
				}),
		});

		expect(result.status).toBe("converted");
		expect(listEnrollments).toHaveBeenCalledWith(expect.anything(), { includeArchived: true });
		expect(boundIdentity()).toBeUndefined();
	});

	it("waits on an install with no coordinator, where the older route is refused", async () => {
		claimPeerAsOwnDevice();

		const result = await convertLegacyPairingAssignmentsOperation(store, {
			loadCoordinatorEvidence: () =>
				loadAllGroupsDeviceIdentityCoordinatorEvidence({
					config: {
						...readCoordinatorSyncConfig(),
						syncCoordinatorUrl: "",
						syncCoordinatorAdminSecret: "",
						syncCoordinatorGroups: [],
					},
				}),
		});

		expect(result.status).toBe("waiting");
		expect(legacyPairingAssignmentsConverted(store.db)).toBe(false);
		// Assigning a device to a person needs a coordinator and its admin secret.
		const refused = await clearClaim({
			readCoordinatorConfig: () => readCoordinatorSyncConfig({}),
		});
		expect(refused.status).toBe(403);
		expect(store.sameActorPeerIds()).toEqual([PEER]);
	});

	it("does not ask the coordinator again once the conversion has run", async () => {
		await convertLegacyPairingAssignmentsOperation(store, { loadCoordinatorEvidence: available });
		const loadCoordinatorEvidence = vi.fn(available);

		const result = await convertLegacyPairingAssignmentsOperation(store, {
			loadCoordinatorEvidence,
		});

		expect(result.status).toBe("already_converted");
		expect(loadCoordinatorEvidence).not.toHaveBeenCalled();
	});
});

describe("reading coordinator evidence for the conversion", () => {
	it("reports a coordinator that cannot be read as unavailable", async () => {
		const evidence = await loadAllGroupsDeviceIdentityCoordinatorEvidence({
			config: {
				...readCoordinatorSyncConfig(),
				syncCoordinatorUrl: "https://coordinator.example.test",
				syncCoordinatorAdminSecret: "synthetic-admin",
				syncCoordinatorGroups: ["group-configured"],
			},
			listEnrollments: async () => {
				throw new Error("coordinator_evidence_too_large");
			},
		});

		expect(evidence).toMatchObject({
			availability: "unavailable",
			safeErrorCode: "coordinator_unavailable",
		});
	});

	it("cannot read enrollments without the admin secret", async () => {
		const evidence = await loadAllGroupsDeviceIdentityCoordinatorEvidence({
			config: {
				...readCoordinatorSyncConfig(),
				syncCoordinatorUrl: "https://coordinator.example.test",
				syncCoordinatorAdminSecret: "",
			},
		});

		expect(evidence.safeErrorCode).toBe("coordinator_configuration_required");
	});
});

describe("a device with coordinator credentials and no configured group", () => {
	const listEnrollments = vi.fn(async () => []);
	const loadCoordinatorEvidence = () =>
		loadAllGroupsDeviceIdentityCoordinatorEvidence({
			config: {
				...readCoordinatorSyncConfig(),
				syncCoordinatorUrl: "https://coordinator.example.test",
				syncCoordinatorAdminSecret: "synthetic-admin",
				syncCoordinatorGroups: [],
			},
			listEnrollments,
		});

	it("does not finish the conversion, because Devices could not bind a paired device there", async () => {
		const result = await convertLegacyPairingAssignmentsOperation(store, {
			loadCoordinatorEvidence,
		});

		expect(result.status).toBe("waiting");
		expect(listEnrollments).not.toHaveBeenCalled();
		expect(legacyPairingAssignmentsConverted(store.db)).toBe(false);
	});

	it("keeps the older assignment route working for a device paired afterward", async () => {
		await convertLegacyPairingAssignmentsOperation(store, { loadCoordinatorEvidence });
		claimPeerAsOwnDevice();

		expect((await clearClaim()).status).toBe(200);
	});
});

describe("the older person assignment route after the conversion", () => {
	it("refuses a change that would no longer change whose device it is", async () => {
		claimPeerAsOwnDevice();
		await convertLegacyPairingAssignmentsOperation(store, { loadCoordinatorEvidence: available });

		const response = await clearClaim();

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "device_identity_managed_in_devices" });
		expect(store.sameActorPeerIds()).toEqual([PEER]);
	});

	it("still applies the change before the conversion has run", async () => {
		claimPeerAsOwnDevice();

		const response = await clearClaim();

		expect(response.status).toBe(200);
		expect(store.sameActorPeerIds()).toEqual([]);
	});
});
