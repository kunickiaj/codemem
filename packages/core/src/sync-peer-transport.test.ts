import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { PeerTransportRefused, peerTransportExecutor } from "./sync-peer-transport.js";
import { readPeerTransportPolicy } from "./sync-transport-policy.js";
import { initTestSchema } from "./test-utils.js";

/** The pin the fake Noise stream claims to have authenticated, and the inner answers it gives. */
const stream = vi.hoisted(() => ({
	pin: "",
	opened: 0,
	expectedPins: [] as string[],
	answer: (_url: string): [number, Record<string, unknown>] => [404, {}],
}));

vi.mock("./direct-noise-client.js", async (original) => ({
	...(await original<typeof import("./direct-noise-client.js")>()),
	directNoiseConnectionFactory: (endpoint: { expectedPin: string }) => ({
		open: async () => {
			throw new Error("unused");
		},
		lastFailure: () => undefined,
		authenticatedPin: () => {
			stream.expectedPins.push(endpoint.expectedPin);
			return stream.pin;
		},
	}),
}));

vi.mock("./peer-http-client.js", async (original) => ({
	...(await original<typeof import("./peer-http-client.js")>()),
	createPeerHttpExecutor: () => async (_method: string, url: string) => {
		stream.opened += 1;
		return stream.answer(url);
	},
}));

const databases: Database.Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	stream.opened = 0;
	stream.expectedPins = [];
});

function pinned(pin: string) {
	const db = new Database(":memory:");
	databases.push(db);
	initTestSchema(db);
	db.prepare(
		"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at) VALUES ('peer', ?, ?, '2026-01-01T00:00:00Z')",
	).run(fingerprintPublicKey(pin), pin);
	const repin = (next: string) =>
		db
			.prepare(
				"UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ? WHERE peer_device_id = 'peer'",
			)
			.run(next, fingerprintPublicKey(next));
	const execute = peerTransportExecutor({
		db,
		peerDeviceId: "peer",
		localDeviceId: "local",
		active: true,
	});
	return { db, repin, execute };
}

const statusNaming =
	(pin: string) =>
	(url: string): [number, Record<string, unknown>] =>
		new URL(url).pathname === "/v1/status"
			? [200, { fingerprint: fingerprintPublicKey(pin) }]
			: [200, { items: [] }];

it("neither promotes nor unlocks snapshots when the stream proved a different pin than the current one", async () => {
	const p = pinned("key-current");
	stream.pin = "key-other";
	stream.answer = statusNaming("key-current");

	await expect(p.execute("GET", "http://127.0.0.1:7/v1/status")).rejects.toThrow(
		PeerTransportRefused,
	);

	expect(readPeerTransportPolicy(p.db, "peer")).toBe("legacy_plaintext");
	await expect(p.execute("GET", "http://127.0.0.1:7/v1/snapshot?limit=1")).rejects.toThrow(
		PeerTransportRefused,
	);
	expect(stream.opened).toBe(1);
});

it("refuses a snapshot after a re-pin, though the earlier status was valid for the old pin", async () => {
	const p = pinned("key-a");
	stream.pin = "key-a";
	stream.answer = statusNaming("key-a");
	await p.execute("GET", "http://127.0.0.1:7/v1/status");
	expect(readPeerTransportPolicy(p.db, "peer")).toBe("noise_required");

	p.repin("key-b");
	stream.pin = "key-b";

	await expect(p.execute("GET", "http://127.0.0.1:7/v1/snapshot?limit=1")).rejects.toThrow(
		/status_first/,
	);
	expect(stream.opened).toBe(1);
});

it("asks the snapshot's handshake to prove the pin its status named", async () => {
	const p = pinned("key-a");
	stream.pin = "key-a";
	stream.answer = statusNaming("key-a");
	await p.execute("GET", "http://127.0.0.1:7/v1/status");

	await p.execute("GET", "http://127.0.0.1:7/v1/snapshot?limit=1");

	expect(stream.expectedPins).toEqual(["key-a", "key-a"]);
});

it("drops a Noise answer when the pin rotates while the response is pending", async () => {
	const p = pinned("key-a");
	stream.pin = "key-a";
	stream.answer = (url) => {
		p.repin("key-b");
		return statusNaming("key-a")(url);
	};

	await expect(p.execute("GET", "http://127.0.0.1:7/v1/status")).rejects.toThrow(
		/peer key changed while the response was pending/,
	);

	expect(readPeerTransportPolicy(p.db, "peer")).toBe("legacy_plaintext");
});

it("holds a snapshot to the status pin when the pin rotates before dialing", async () => {
	const p = pinned("key-a");
	stream.pin = "key-a";
	stream.answer = statusNaming("key-a");
	await p.execute("GET", "http://127.0.0.1:7/v1/status");

	// The status check passes, then a re-pin lands before the connection is set up.
	const snapshot = p.execute("GET", "http://127.0.0.1:7/v1/snapshot?limit=1");
	p.repin("key-b");
	stream.pin = "key-b";

	await expect(snapshot).rejects.toThrow(PeerTransportRefused);
	expect(stream.expectedPins.at(-1)).toBe("key-a");
});
