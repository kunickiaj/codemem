import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	readCoordinatorSyncConfig,
	refreshAuthorizedCoordinatorPeerTrust,
} from "./coordinator-runtime.js";
import type { MemoryStore } from "./store.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { ensureDeviceIdentity, loadPrivateKey, loadPublicKey } from "./sync-identity.js";
import { updatePeerAddresses } from "./sync-peer-addresses.js";
import {
	buildPairingPayload,
	ingestCoordinatorTransportStatements,
	localTransportStatementCapability,
	recordPairingTransportEvidence,
} from "./sync-transport-evidence.js";
import {
	DIRECT_NOISE_ACTIVE,
	promotePeerToNoiseRequired,
	readPeerTransportPolicy,
} from "./sync-transport-policy.js";
import { initTestSchema } from "./test-utils.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
	vi.unstubAllGlobals();
});

function testDb(): Database.Database {
	const db = new Database(":memory:");
	cleanup.push(() => db.close());
	initTestSchema(db);
	return db;
}

/** A device with a real runtime key pair, as a coordinator listing would describe it. */
function runtimeDevice() {
	const db = testDb();
	const keysDir = mkdtempSync(join(tmpdir(), "codemem-transport-evidence-"));
	cleanup.push(() => rmSync(keysDir, { recursive: true, force: true }));
	const [deviceId, fingerprint] = ensureDeviceIdentity(db, { keysDir });
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("expected a runtime key pair");
	const statement = (active: boolean) =>
		localTransportStatementCapability({
			deviceId,
			fingerprint,
			privateKey: () => loadPrivateKey(keysDir, undefined, deviceId),
			active,
		});
	return { deviceId, fingerprint, publicKey, keysDir, statement };
}

function pin(db: Database.Database, device: { deviceId: string; publicKey: string }) {
	updatePeerAddresses(db, device.deviceId, ["http://127.0.0.1:7337"], {
		pinnedFingerprint: fingerprintPublicKey(device.publicKey),
		publicKey: device.publicKey,
		replaceTrust: true,
	});
}

describe("pairing payload transports", () => {
	it("advertises nothing while direct Noise is switched off", () => {
		const a = runtimeDevice();
		expect(DIRECT_NOISE_ACTIVE).toBe(false);
		const payload = buildPairingPayload({ ...a, addresses: ["http://10.0.0.2:7337"] });
		expect(payload).toEqual({
			device_id: a.deviceId,
			fingerprint: a.fingerprint,
			public_key: a.publicKey,
			address: "http://10.0.0.2:7337",
			addresses: ["http://10.0.0.2:7337"],
		});
		expect(
			localTransportStatementCapability({
				deviceId: a.deviceId,
				fingerprint: a.fingerprint,
				privateKey: () => {
					throw new Error("must not load a key while switched off");
				},
			}),
		).toEqual({});
		expect(buildPairingPayload({ ...a, addresses: [], advertiseNoise: true }).transports).toEqual([
			"noise1",
		]);
	});

	it("promotes on a payload that lists Noise and never downgrades on one that does not", () => {
		const db = testDb();
		const a = runtimeDevice();
		const legacy = buildPairingPayload({ ...a, addresses: ["http://10.0.0.2:7337"] });
		pin(db, a);
		expect(recordPairingTransportEvidence(db, a.deviceId, { ...legacy })).toBe(false);
		expect(readPeerTransportPolicy(db, a.deviceId)).toBe("legacy_plaintext");
		const modern = { ...legacy, transports: ["noise1"] };
		expect(recordPairingTransportEvidence(db, a.deviceId, modern)).toBe(true);
		expect(recordPairingTransportEvidence(db, a.deviceId, { ...legacy })).toBe(false);
		expect(readPeerTransportPolicy(db, a.deviceId)).toBe("noise_required");
		expect(recordPairingTransportEvidence(db, "b", { transports: "noise1" })).toBe(false);
	});
});

describe("coordinator transport statements", () => {
	it("promotes a pinned peer whose own statement lists Noise", () => {
		const db = testDb();
		const a = runtimeDevice();
		pin(db, a);
		const listing = [
			{ device_id: a.deviceId, public_key: a.publicKey, capabilities: a.statement(true) },
		];
		expect(ingestCoordinatorTransportStatements(db, listing)).toBe(1);
		expect(readPeerTransportPolicy(db, a.deviceId)).toBe("noise_required");
		expect(ingestCoordinatorTransportStatements(db, listing)).toBe(0);
	});

	it("does not downgrade a noise_required peer when the listing omits or breaks the statement", () => {
		const db = testDb();
		const a = runtimeDevice();
		pin(db, a);
		promotePeerToNoiseRequired(db, a.deviceId, "transport_statement");
		const broken = a.statement(true).transport_statement;
		const listings = [
			[{ device_id: a.deviceId, public_key: a.publicKey }],
			[{ device_id: a.deviceId, public_key: a.publicKey, capabilities: {} }],
			[
				{
					device_id: a.deviceId,
					capabilities: { transport_statement: { ...broken, signature: "" } },
				},
			],
			[{ device_id: a.deviceId, capabilities: a.statement(false) }],
		];
		for (const listing of listings) {
			expect(ingestCoordinatorTransportStatements(db, listing)).toBe(0);
			expect(readPeerTransportPolicy(db, a.deviceId)).toBe("noise_required");
		}
	});

	it("checks the statement against the pinned key, not the listed one", () => {
		const db = testDb();
		const a = runtimeDevice();
		const impostor = runtimeDevice();
		pin(db, a);
		// The listing swaps in another key and a statement that key really signed.
		const forged = localTransportStatementCapability({
			deviceId: a.deviceId,
			fingerprint: fingerprintPublicKey(impostor.publicKey),
			privateKey: () => loadPrivateKey(impostor.keysDir, undefined, impostor.deviceId),
			active: true,
		});
		const listing = [
			{ device_id: a.deviceId, public_key: impostor.publicKey, capabilities: forged },
		];
		expect(ingestCoordinatorTransportStatements(db, listing)).toBe(0);
		expect(readPeerTransportPolicy(db, a.deviceId)).toBe("legacy_plaintext");
		// A device this store has not pinned is ignored, whatever its statement says.
		const stranger = [{ device_id: impostor.deviceId, capabilities: impostor.statement(true) }];
		expect(ingestCoordinatorTransportStatements(db, stranger)).toBe(0);
		expect(readPeerTransportPolicy(db, impostor.deviceId)).toBeNull();
	});
});

describe("coordinator refresh", () => {
	it("keeps a later group's valid statement when an earlier group's record lacks one", async () => {
		const db = testDb();
		const local = mkdtempSync(join(tmpdir(), "codemem-transport-local-"));
		cleanup.push(() => rmSync(local, { recursive: true, force: true }));
		ensureDeviceIdentity(db, { keysDir: local });
		const a = runtimeDevice();
		const impostor = runtimeDevice();
		pin(db, a);
		const base = { device_id: a.deviceId, public_key: a.publicKey, fingerprint: a.fingerprint };
		const forged = localTransportStatementCapability({
			deviceId: a.deviceId,
			fingerprint: a.fingerprint,
			privateKey: () => loadPrivateKey(impostor.keysDir, undefined, impostor.deviceId),
			active: true,
		});
		// The first group's record is stale and carries no usable statement; the second is valid.
		const byGroup: Record<string, Record<string, unknown>[]> = {
			"group-1": [{ ...base, stale: true, addresses: [], capabilities: forged }],
			"group-2": [{ ...base, addresses: [], capabilities: a.statement(true) }],
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				const items = byGroup[url.searchParams.get("group_id") ?? ""] ?? [];
				return new Response(JSON.stringify({ items }), { status: 200 });
			}),
		);
		const config = readCoordinatorSyncConfig({
			sync_enabled: true,
			sync_coordinator_url: "https://coord.example.test",
			sync_coordinator_groups: ["group-1", "group-2"],
		});
		const store = { db, dbPath: `:memory:-${randomUUID()}` } as unknown as MemoryStore;

		await refreshAuthorizedCoordinatorPeerTrust(store, config, { keysDir: local });

		expect(readPeerTransportPolicy(db, a.deviceId)).toBe("noise_required");
	});

	it("ingests statements during a coordinator peer refresh", async () => {
		const db = testDb();
		const local = mkdtempSync(join(tmpdir(), "codemem-transport-local-"));
		cleanup.push(() => rmSync(local, { recursive: true, force: true }));
		ensureDeviceIdentity(db, { keysDir: local });
		const a = runtimeDevice();
		pin(db, a);
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			if (url.pathname !== "/v1/peers") throw new Error(`unexpected ${url.pathname}`);
			const item = {
				device_id: a.deviceId,
				public_key: a.publicKey,
				fingerprint: a.fingerprint,
				addresses: [],
				capabilities: a.statement(true),
			};
			return new Response(JSON.stringify({ items: [item] }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const config = readCoordinatorSyncConfig({
			sync_enabled: true,
			sync_coordinator_url: "https://coord.example.test",
			sync_coordinator_groups: ["group-1"],
		});
		const store = { db, dbPath: `:memory:-${randomUUID()}` } as unknown as MemoryStore;
		await refreshAuthorizedCoordinatorPeerTrust(store, config, { keysDir: local });
		expect(fetchMock).toHaveBeenCalled();
		expect(readPeerTransportPolicy(db, a.deviceId)).toBe("noise_required");
	});
});
