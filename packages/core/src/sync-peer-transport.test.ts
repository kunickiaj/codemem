import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { DirectNoiseBusy } from "./direct-noise-client.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import type { RequestJsonExecutor } from "./sync-http-client.js";
import {
	PEER_KEY_MISSING_MESSAGE,
	type PeerTransportOptions,
	PeerTransportRefused,
	peerTransportExecutor,
} from "./sync-peer-transport.js";
import { promotePeerToNoiseRequired, readPeerTransportPolicy } from "./sync-transport-policy.js";
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

// The grant's pin-only status is signed. These tests check where requests go, so signing needs no key.
vi.mock("./sync-auth.js", async (original) => ({
	...(await original<typeof import("./sync-auth.js")>()),
	buildDirectPeerAuthHeaders: () => ({}),
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

function pinned(pin: string, extra: Partial<PeerTransportOptions> = {}) {
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
		...extra,
	});
	return { db, repin, execute };
}

const statusNaming =
	(pin: string) =>
	(url: string): [number, Record<string, unknown>] =>
		new URL(url).pathname.endsWith("/v1/status")
			? [200, { fingerprint: fingerprintPublicKey(pin) }]
			: [200, { items: [] }];

it("neither promotes nor unlocks snapshots when the stream proved a different pin than the current one", async () => {
	const p = pinned("key-current");
	stream.pin = "key-other";
	stream.answer = statusNaming("key-current");

	await expect(
		p.execute("GET", "http://127.0.0.1:7/v1/status", { operation: "status" }),
	).rejects.toThrow(PeerTransportRefused);

	expect(readPeerTransportPolicy(p.db, "peer")).toBe("legacy_plaintext");
	await expect(
		p.execute("GET", "http://127.0.0.1:7/v1/snapshot?limit=1", { operation: "snapshot" }),
	).rejects.toThrow(PeerTransportRefused);
	expect(stream.opened).toBe(1);
});

it("refuses a snapshot after a re-pin, though the earlier status was valid for the old pin", async () => {
	const p = pinned("key-a");
	stream.pin = "key-a";
	stream.answer = statusNaming("key-a");
	await p.execute("GET", "http://127.0.0.1:7/v1/status", { operation: "status" });
	expect(readPeerTransportPolicy(p.db, "peer")).toBe("noise_required");

	p.repin("key-b");
	stream.pin = "key-b";

	await expect(
		p.execute("GET", "http://127.0.0.1:7/v1/snapshot?limit=1", { operation: "snapshot" }),
	).rejects.toThrow(/status_first/);
	expect(stream.opened).toBe(1);
});

it("asks the snapshot's handshake to prove the pin its status named", async () => {
	const p = pinned("key-a");
	stream.pin = "key-a";
	stream.answer = statusNaming("key-a");
	await p.execute("GET", "http://127.0.0.1:7/v1/status", { operation: "status" });

	await p.execute("GET", "http://127.0.0.1:7/v1/snapshot?limit=1", { operation: "snapshot" });

	expect(stream.expectedPins).toEqual(["key-a", "key-a"]);
});

it("drops a Noise answer when the pin rotates while the response is pending", async () => {
	const p = pinned("key-a");
	stream.pin = "key-a";
	stream.answer = (url) => {
		p.repin("key-b");
		return statusNaming("key-a")(url);
	};

	await expect(
		p.execute("GET", "http://127.0.0.1:7/v1/status", { operation: "status" }),
	).rejects.toThrow(/peer key changed while the response was pending/);

	expect(readPeerTransportPolicy(p.db, "peer")).toBe("legacy_plaintext");
});

it("holds a snapshot to the status pin when the pin rotates before dialing", async () => {
	const p = pinned("key-a");
	stream.pin = "key-a";
	stream.answer = statusNaming("key-a");
	await p.execute("GET", "http://127.0.0.1:7/v1/status", { operation: "status" });

	// The status check passes, then a re-pin lands before the connection is set up.
	const snapshot = p.execute("GET", "http://127.0.0.1:7/v1/snapshot?limit=1", {
		operation: "snapshot",
	});
	p.repin("key-b");
	stream.pin = "key-b";

	await expect(snapshot).rejects.toThrow(PeerTransportRefused);
	expect(stream.expectedPins.at(-1)).toBe("key-a");
});

/** A plaintext listener that reads each request and never answers it. */
async function silentListener() {
	const server = createServer(() => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const close = () =>
		new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		});
	return { port: (server.address() as AddressInfo).port, close };
}

function grantHolder() {
	const p = pinned("key-a", { bootstrapGrantId: "grant-1" });
	promotePeerToNoiseRequired(p.db, "peer", "transport_statement");
	return p;
}

it("stops the grant's pin-only status when the pass is cancelled", async () => {
	const listener = await silentListener();
	try {
		const p = grantHolder();
		const controller = new AbortController();
		const started = performance.now();
		setTimeout(() => controller.abort(new Error("pass cancelled")), 50);

		const failure = await p
			.execute("GET", `http://127.0.0.1:${listener.port}/v1/status`, {
				operation: "status",
				signal: controller.signal,
			})
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(stream.opened).toBe(0);
	} finally {
		await listener.close();
	}
});

it("holds the grant's pin-only status to the caller's shorter timeout", async () => {
	const listener = await silentListener();
	try {
		const p = grantHolder();
		const started = performance.now();

		// The reachability probe passes a timeout below requestJson's 3 s default.
		const failure = await p
			.execute("GET", `http://127.0.0.1:${listener.port}/v1/status`, {
				operation: "status",
				timeoutS: 0.2,
			})
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect(performance.now() - started).toBeLessThan(1_500);
		expect(stream.opened).toBe(0);
	} finally {
		await listener.close();
	}
});

/** A plaintext executor that records every request it would send. */
function recordingPlaintext() {
	return vi.fn<RequestJsonExecutor>(async (_method, url) =>
		new URL(url).pathname.endsWith("/v1/status")
			? [200, { fingerprint: fingerprintPublicKey("key-a") }]
			: [200, { items: [] }],
	);
}

it("refuses a request whose operation is missing or does not match its method", async () => {
	const plaintext = recordingPlaintext();
	const p = pinned("key-a", { plaintext });
	const url = "https://peer.invalid/base/v1/status";

	await expect(p.execute("GET", url)).rejects.toThrow(/operation_required/);
	await expect(p.execute("POST", url, { operation: "status" })).rejects.toThrow(
		/operation_required/,
	);
	expect(plaintext).not.toHaveBeenCalled();
});

it("refuses a snapshot before status at a prefixed HTTPS address on the legacy fallback", async () => {
	const plaintext = recordingPlaintext();
	const p = pinned("key-a", { plaintext });

	await expect(
		p.execute("GET", "https://peer.invalid/base/v1/snapshot?limit=1", { operation: "snapshot" }),
	).rejects.toThrow(/status_first/);

	expect(plaintext).not.toHaveBeenCalled();
});

it("sends nothing for a fingerprint-only peer at a prefixed HTTPS address", async () => {
	const plaintext = recordingPlaintext();
	const p = pinned("key-a", { plaintext });
	p.db.prepare("UPDATE sync_peers SET public_key = NULL WHERE peer_device_id = 'peer'").run();

	await expect(
		p.execute("GET", "https://peer.invalid/base/v1/status", { operation: "status" }),
	).rejects.toThrow(PEER_KEY_MISSING_MESSAGE);
	await expect(
		p.execute("GET", "https://peer.invalid/base/v1/snapshot?limit=1", { operation: "snapshot" }),
	).rejects.toThrow(PEER_KEY_MISSING_MESSAGE);

	expect(plaintext).not.toHaveBeenCalled();
});

it("checks the saved key before sending a bootstrap grant's pin-only status", async () => {
	const plaintext = recordingPlaintext();
	const p = pinned("key-a", { plaintext, bootstrapGrantId: "grant-1" });
	promotePeerToNoiseRequired(p.db, "peer", "transport_statement");
	p.db.prepare("UPDATE sync_peers SET public_key = NULL WHERE peer_device_id = 'peer'").run();

	await expect(
		p.execute("GET", "http://127.0.0.1:7/v1/status", { operation: "status" }),
	).rejects.toThrow(PEER_KEY_MISSING_MESSAGE);

	expect(plaintext).not.toHaveBeenCalled();
});

it("counts a status at a prefixed address, so it promotes and unlocks the snapshot there", async () => {
	const p = pinned("key-a");
	stream.pin = "key-a";
	stream.answer = statusNaming("key-a");

	await p.execute("GET", "http://127.0.0.1:7/base/v1/status", { operation: "status" });
	await p.execute("GET", "http://127.0.0.1:7/base/v1/snapshot?limit=1", { operation: "snapshot" });

	expect(readPeerTransportPolicy(p.db, "peer")).toBe("noise_required");
	expect(stream.opened).toBe(2);
});

it.each([
	["status", "https://peer.invalid/base/v1/snapshot?limit=1"],
	["ops", "https://peer.invalid/base/v1/snapshot?limit=1"],
	["status", "http://127.0.0.1:7/base/v1/snapshot?limit=1"],
	["ops", "http://127.0.0.1:7/v1/snapshot?limit=1"],
] as const)("sends nothing for a GET snapshot labeled %s at %s", async (label, url) => {
	const plaintext = recordingPlaintext();
	const p = pinned("key-a", { plaintext });
	stream.answer = statusNaming("key-a");

	await expect(p.execute("GET", url, { operation: label })).rejects.toThrow(/operation_required/);

	expect(plaintext).not.toHaveBeenCalled();
	expect(stream.opened).toBe(0);
});

it("accepts each operation on its own route under a base path", async () => {
	const p = pinned("key-a");
	stream.pin = "key-a";
	stream.answer = statusNaming("key-a");
	const base = "http://127.0.0.1:7/a/b";

	await p.execute("GET", `${base}/v1/status`, { operation: "status" });
	await p.execute("GET", `${base}/v1/ops?limit=1`, { operation: "ops" });
	await p.execute("POST", `${base}/v1/ops`, { operation: "push" });
	await p.execute("GET", `${base}/v1/snapshot?limit=1`, { operation: "snapshot" });

	expect(stream.opened).toBe(4);
});

/** Answers busy for the first `busyFor` exchanges, then like a seed that names key-a. */
function busyThen(busyFor: number) {
	let calls = 0;
	return (url: string): [number, Record<string, unknown>] => {
		calls += 1;
		if (calls <= busyFor) throw new DirectNoiseBusy(503, undefined);
		return statusNaming("key-a")(url);
	};
}

const FAST_RETRY = { attempts: 3, baseMs: 1, maxMs: 2 };

it.each(["legacy_plaintext", "noise_required"] as const)(
	"retries a busy listener and never sends plaintext for a %s peer",
	async (policy) => {
		const plaintext = recordingPlaintext();
		const p = pinned("key-a", { plaintext, busyRetry: FAST_RETRY });
		if (policy === "noise_required")
			promotePeerToNoiseRequired(p.db, "peer", "transport_statement");
		stream.pin = "key-a";
		stream.answer = busyThen(2);

		const [status] = await p.execute("GET", "http://127.0.0.1:7/v1/status", {
			operation: "status",
		});

		expect(status).toBe(200);
		expect(stream.opened).toBe(3);
		expect(plaintext).not.toHaveBeenCalled();
	},
);

it.each(["legacy_plaintext", "noise_required"] as const)(
	"fails a %s peer's request with the reason once the retries run out",
	async (policy) => {
		const plaintext = recordingPlaintext();
		const p = pinned("key-a", { plaintext, busyRetry: FAST_RETRY });
		if (policy === "noise_required")
			promotePeerToNoiseRequired(p.db, "peer", "transport_statement");
		stream.pin = "key-a";
		stream.answer = busyThen(Number.POSITIVE_INFINITY);

		await expect(
			p.execute("GET", "http://127.0.0.1:7/v1/status", { operation: "status" }),
		).rejects.toThrow("noise_busy: peer still busy (status 503) after 3 attempts; try again later");

		expect(stream.opened).toBe(3);
		expect(plaintext).not.toHaveBeenCalled();
		expect(readPeerTransportPolicy(p.db, "peer")).toBe(policy);
	},
);

it("keeps a legacy peer on Noise attempts after a busy failure, then promotes it over Noise", async () => {
	const plaintext = recordingPlaintext();
	const p = pinned("key-a", { plaintext, busyRetry: FAST_RETRY });
	stream.pin = "key-a";
	stream.answer = busyThen(3);
	const status = () => p.execute("GET", "http://127.0.0.1:7/v1/status", { operation: "status" });

	await expect(status()).rejects.toThrow(/noise_busy/);
	const [code] = await status();

	expect(code).toBe(200);
	expect(stream.opened).toBe(4);
	expect(plaintext).not.toHaveBeenCalled();
	expect(readPeerTransportPolicy(p.db, "peer")).toBe("noise_required");
});

it("stops waiting on a busy listener when the request is cancelled", async () => {
	const p = pinned("key-a", { busyRetry: { attempts: 6, baseMs: 10_000, maxMs: 10_000 } });
	stream.answer = busyThen(Number.POSITIVE_INFINITY);
	const controller = new AbortController();
	const started = performance.now();

	const request = p.execute("GET", "http://127.0.0.1:7/v1/status", {
		operation: "status",
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(new Error("cancelled")), 20);

	await expect(request).rejects.toThrow("cancelled");
	expect(performance.now() - started).toBeLessThan(1_000);
	expect(stream.opened).toBe(1);
});
