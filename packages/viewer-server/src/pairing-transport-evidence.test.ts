import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPairingPayload,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	loadPublicKey,
	MemoryStore,
	readPeerTransportPolicy,
} from "@codemem/core";
import { afterEach, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { createApp } from "./index.js";

const peerId = "fixture-peer";
const base = {
	device_id: peerId,
	fingerprint: fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
	public_key: CANONICAL_PUBLIC_KEY,
	addresses: ["http://127.0.0.1:7337"],
};
const cleanup: Array<() => void> = [];

afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "codemem-pairing-transport-"));
	cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(
		join(directory, "config.json"),
		JSON.stringify({ sync_enabled: true, sync_host: "127.0.0.1", sync_port: 7337 }),
	);
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_KEYS_DIR", join(directory, "keys"));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
	const store = new MemoryStore(join(directory, "mem.sqlite"));
	cleanup.push(() => store.close());
	const app = createApp({ storeFactory: () => store });
	const importPayload = (payload: Record<string, unknown>) =>
		app.request("/api/sync/invites/import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ invite: JSON.stringify(payload) }),
		});
	return { store, app, importPayload, keysDir: join(directory, "keys") };
}

it("serves the shared pairing payload, without transports while Noise is off", async () => {
	const f = fixture();
	const [deviceId, fingerprint] = ensureDeviceIdentity(f.store.db, { keysDir: f.keysDir });
	const response = await f.app.request("/api/sync/pairing");
	expect(response.status).toBe(200);
	const { pairing_filter_hint: hint, ...payload } = (await response.json()) as Record<
		string,
		unknown
	>;
	expect(hint).toEqual(expect.any(String));
	expect(payload).toEqual(
		buildPairingPayload({
			deviceId,
			fingerprint,
			publicKey: loadPublicKey(f.keysDir) ?? "",
			addresses: ["http://127.0.0.1:7337"],
		}),
	);
	expect(payload).not.toHaveProperty("transports");
});

it("records Noise from an imported payload that lists it, and never downgrades", async () => {
	const f = fixture();
	expect((await f.importPayload({ ...base, transports: ["noise1"] })).status).toBe(200);
	expect(readPeerTransportPolicy(f.store.db, peerId)).toBe("noise_required");
	expect((await f.importPayload(base)).status).toBe(200);
	expect(readPeerTransportPolicy(f.store.db, peerId)).toBe("noise_required");
});

it("records an imported payload without transports as legacy plaintext", async () => {
	const f = fixture();
	expect((await f.importPayload(base)).status).toBe(200);
	expect(readPeerTransportPolicy(f.store.db, peerId)).toBe("legacy_plaintext");
});
