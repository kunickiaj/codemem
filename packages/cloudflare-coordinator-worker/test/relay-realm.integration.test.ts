import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	encodeRelayAdmissionBody,
	encodeRelayCheckPacket,
	encodeRelayRegistrationBody,
} from "../../core/src/relay-admission-codec.js";
import { decodeRelayControl, type RelayControl } from "../../core/src/relay-control-codec.js";
import { encodeRelayDataFrame } from "../../core/src/relay-data-frame.js";
import { relayEd25519KeyId } from "../../core/src/relay-ed25519.js";
import {
	initializeRelayQuotaSchema,
	provisionLocalRelayQuota,
	type RelayQuotaProfile,
	setRelayQuotaEnabled,
} from "../../core/src/relay-quota-sqlite.js";
import {
	relayAudienceId,
	relayRealmId,
	verifyRelayServiceProof,
} from "../../core/src/relay-service-proof.js";
import { captureRelayEnv, readRelayConfig } from "../src/relay-config.js";
import { durableObjectRelayQuotaDatabase } from "../src/relay-quota-do.js";
import {
	concurrentRouteOutboundBound,
	RELAY_DURABLE_OBJECT_LIMITS,
	RELAY_ISOLATE_MEMORY_BYTES,
	RELAY_OUTBOUND_BUDGET_BYTES,
	replyCode,
} from "../src/relay-realm.js";
import {
	MAX_ATTACHMENT_BYTES,
	RELAY_CLOSE_GRACE_MS,
	RelaySocketAdapter,
} from "../src/relay-socket-adapter.js";
import { relayRealmTestState } from "./relay-realm-do-object.js";

const MiB = 1024 * 1024;
const KEYS: Record<string, string> = {
	source: "1".repeat(64),
	target: "2".repeat(64),
	third: "3".repeat(64),
};
const PROFILE: RelayQuotaProfile = {
	upgrade: { service: { ratePerMinute: 120, burst: 16 }, realm: { ratePerMinute: 120, burst: 16 } },
	control: {
		service: { ratePerMinute: 120, burst: 16 },
		realm: { ratePerMinute: 120, burst: 16 },
		device: { ratePerMinute: 120, burst: 16 },
	},
	open: {
		service: { ratePerMinute: 1024, burst: 1024 },
		realm: { ratePerMinute: 128, burst: 128 },
		device: { ratePerMinute: 30, burst: 4 },
		pair: { ratePerMinute: 20, burst: 2 },
	},
	traffic: {
		service: { ratePerMinute: 1024 * MiB, burst: 256 * MiB },
		realm: { ratePerMinute: 128 * MiB, burst: 64 * MiB },
		device: { ratePerMinute: 64 * MiB, burst: 40 * MiB },
		pair: { ratePerMinute: 40 * MiB, burst: 40 * MiB },
	},
};

const config = readRelayConfig(
	captureRelayEnv({
		...env,
		CODEMEM_RELAY_ENABLED: "true",
		CODEMEM_RELAY_ADMISSION_BINDING: "RELAY_ADMISSION_CONFIG",
		RELAY_ADMISSION_CONFIG: { fetch: () => Promise.reject(new Error("unused")) },
	}),
);
if (!config) throw new Error("Relay test config is invalid");
const { authorityId } = config;
const realmId = relayRealmId(authorityId, "relay-test-group");
const otherRealmId = relayRealmId(authorityId, "relay-other-group");
// Derived from the SSH public key that vitest.config.ts exported with Node, as clients do.
const servicePublicKey = env.RELAY_TEST_SERVICE_PUBLIC_KEY;
const serviceKeyId = await relayEd25519KeyId(servicePublicKey);
const audienceId = relayAudienceId(config.audienceOrigin, serviceKeyId);
const namespace = { authorityId, groupId: "relay-test-group", relayAudienceId: audienceId };

const hex = (bytes: number) =>
	Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
const nowSeconds = () => Math.floor(Date.now() / 1000);
function packet(bodyBytes: Uint8Array, createdAt: number) {
	return encodeRelayCheckPacket({
		bodyBytes,
		timestamp: String(createdAt),
		nonce: hex(16),
		signatureBytes: crypto.getRandomValues(new Uint8Array(64)),
	});
}

async function realmObject({ provision = realmId }: { provision?: string | null } = {}) {
	const stub = env.RELAY_REALM_TEST.get(env.RELAY_REALM_TEST.newUniqueId());
	if (provision) await provisionQuota(stub, provision);
	return stub;
}
function provisionQuota(stub: DurableObjectStub, provision: string) {
	return runInDurableObject(stub, (_object, state) => {
		const database = durableObjectRelayQuotaDatabase(state.storage);
		initializeRelayQuotaSchema(database);
		provisionLocalRelayQuota(database, { realmId: provision, profile: PROFILE });
		setRelayQuotaEnabled(database, { realmId: provision, enabled: true });
	});
}
type RealmStub = Awaited<ReturnType<typeof realmObject>>;

function upgrade(stub: RealmStub, path = `/v1/relay/${realmId}`, init: RequestInit = {}) {
	return stub.fetch(`https://coordinator.example.test${path}`, {
		headers: { Upgrade: "websocket" },
		...init,
	});
}

async function connect(stub: RealmStub) {
	const response = await upgrade(stub);
	const ws = response.webSocket;
	if (response.status !== 101 || !ws) throw new Error(`Upgrade failed: ${response.status}`);
	ws.accept();
	ws.binaryType = "arraybuffer";
	const peer = {
		ws,
		texts: [] as RelayControl[],
		binaries: [] as Uint8Array[],
		closeCode: null as number | null,
		send: (message: RelayControl) => ws.send(JSON.stringify(message)),
		async next(type: RelayControl["type"], session?: string) {
			let found: RelayControl | undefined;
			await vi.waitUntil(() => {
				found = peer.texts.find((m) => m.type === type && (!session || m.session === session));
				return found;
			});
			return found as RelayControl;
		},
	};
	ws.addEventListener("message", (event) => {
		if (typeof event.data === "string")
			peer.texts.push(decodeRelayControl(new TextEncoder().encode(event.data)));
		else peer.binaries.push(new Uint8Array(event.data as ArrayBuffer));
	});
	ws.addEventListener("close", (event) => {
		peer.closeCode = event.code;
	});
	return peer;
}
type Peer = Awaited<ReturnType<typeof connect>>;

async function register(stub: RealmStub, deviceId: string) {
	const peer = await connect(stub);
	const session = hex(16);
	const startedAtMs = Date.now();
	peer.send({ v: 1, type: "SERVICE_CHALLENGE", session, body: { audienceId } });
	const proof = await peer.next("SERVICE_PROOF", session);
	const verified =
		proof.type === "SERVICE_PROOF" &&
		(await verifyRelayServiceProof({
			audienceId,
			challengeId: session,
			publicKey: servicePublicKey,
			body: proof.body,
			startedAtMs,
			nowMs: Date.now(),
			deadlineMs: startedAtMs + 5000,
		}));
	if (!verified) throw new Error("Relay service proof failed client verification");
	const challenge = await peer.next("SOCKET_CHALLENGE");
	const createdAt = nowSeconds();
	const body = encodeRelayRegistrationBody({
		...namespace,
		deviceId,
		keyId: KEYS[deviceId] ?? "",
		socketChallengeId: challenge.session,
		createdAt,
		admitBefore: createdAt + 30,
	});
	peer.send({ v: 1, type: "REGISTER", session: challenge.session, body: packet(body, createdAt) });
	const registered = await peer.next("REGISTERED", challenge.session);
	return { peer, proof, registered };
}

function openMessage(
	sourceDeviceId: string,
	targetDeviceId: string,
	session: string,
): RelayControl {
	const createdAt = nowSeconds();
	const common = {
		...namespace,
		sourceDeviceId,
		sourceKeyId: KEYS[sourceDeviceId] ?? "",
		targetDeviceId,
		targetKeyId: KEYS[targetDeviceId] ?? "",
		routeSessionId: session,
		messageADigest: "d".repeat(64),
		createdAt,
		admitBefore: createdAt + 30,
		routeNotAfter: createdAt + 55,
	};
	const check = (role: "relay" | "responder") =>
		packet(encodeRelayAdmissionBody({ ...common, role }), createdAt);
	return { v: 1, type: "OPEN", session, body: { checks: [check("relay"), check("responder")] } };
}

async function route(stub: RealmStub) {
	const a = (await register(stub, "source")).peer;
	const b = (await register(stub, "target")).peer;
	const session = hex(16);
	a.send(openMessage("source", "target", session));
	await b.next("OPEN", session);
	b.send({ v: 1, type: "ACCEPTED", session, body: {} });
	await a.next("ACCEPTED", session);
	return { a, b, session };
}

const frame = (session: string, size: number, fill = 7) =>
	encodeRelayDataFrame({ sessionId: session, payload: new Uint8Array(size).fill(fill) });
const closedWith = (peer: Peer, code: number) => vi.waitUntil(() => peer.closeCode === code);

afterEach(() => {
	Object.assign(relayRealmTestState(), { enabled: true, limits: {}, admissions: [] });
});

describe("RelayRealm upgrade and registration", () => {
	it("registers through the admission binding with the configured pathname", async () => {
		// Arrange
		const stub = await realmObject();
		// Act
		const { proof, registered } = await register(stub, "source");
		// Assert
		expect(proof.body).toMatchObject({ keyId: serviceKeyId });
		expect(registered.body).toMatchObject({ deviceId: "source", realmId, authorityId });
		expect(relayRealmTestState().admissions).toEqual([
			{ pathname: "/sync/v1/relay/admission-check", kind: "registration", deviceHeader: "source" },
		]);
	});

	it("stores a bounded snapshot attachment and keeps no env", async () => {
		// Arrange
		const stub = await realmObject();
		await register(stub, "source");
		// Act
		const { attachments, envKeys, fields } = await runInDurableObject(stub, (object, state) => ({
			attachments: state.getWebSockets().map((ws) => ws.deserializeAttachment()),
			envKeys: Object.keys((object as unknown as { env: object }).env),
			fields: JSON.stringify(Object.keys(object)),
		}));
		// Assert
		expect(attachments).toHaveLength(1);
		expect(attachments[0]).toMatchObject({ v: 1, realmId, deviceId: "source", keyId: KEYS.source });
		expect(Object.keys(attachments[0]).toSorted()).toEqual([
			"acceptedAtUtcMs",
			"deviceId",
			"keyId",
			"realmId",
			"renewNotBeforeUtcMs",
			"restoreNotAfterUtcMs",
			"v",
		]);
		expect(JSON.stringify(attachments[0]).length).toBeLessThan(MAX_ATTACHMENT_BYTES);
		expect(envKeys).toEqual([]);
		expect(fields).not.toContain("COORDINATOR_DB");
	});

	it("clears the attachment when the engine closes the socket", async () => {
		// Arrange
		const stub = await realmObject();
		const { peer } = await register(stub, "source");
		// Act
		peer.ws.send("not a relay control");
		await closedWith(peer, 1008);
		const attachments = await runInDurableObject(stub, (_object, state) =>
			state.getWebSockets().map((ws) => ws.deserializeAttachment()),
		);
		// Assert
		expect(attachments.every((attachment) => attachment === null)).toBe(true);
	});

	it.each([
		["unknown realm", `/v1/relay/${"f".repeat(64)}`, {}, 404],
		["malformed realm", "/v1/relay/abc", {}, 404],
		["other path", "/v1/other", {}, 404],
		["configured realm pinned elsewhere", `/v1/relay/${otherRealmId}`, {}, 404],
		["missing upgrade", `/v1/relay/${realmId}`, { headers: {} }, 426],
	] as const)("refuses %s", async (_name, path, init, expected) => {
		// Arrange
		const stub = await realmObject();
		// Act
		const response = await upgrade(stub, path, init);
		// Assert
		expect(response.status).toBe(expected);
		expect(response.webSocket).toBeNull();
	});

	it("refuses upgrades while the realm quota is unprovisioned", async () => {
		// Arrange
		const stub = await realmObject({ provision: null });
		// Act
		const response = await upgrade(stub);
		await provisionQuota(stub, realmId);
		const retried = await upgrade(stub);
		// Assert
		expect(response.status).toBe(503);
		expect(retried.status).toBe(101);
		retried.webSocket?.accept();
		retried.webSocket?.close(1000);
	});
});

describe("RelayRealm forwarding", () => {
	it("forwards DATA in both directions between two peers", async () => {
		// Arrange
		const stub = await realmObject();
		const { a, b, session } = await route(stub);
		// Act
		a.ws.send(frame(session, 1000, 1));
		await vi.waitUntil(() => b.binaries.length === 1);
		b.ws.send(frame(session, 500, 2));
		await vi.waitUntil(() => a.binaries.length === 1);
		// Assert
		expect(b.binaries[0]).toEqual(frame(session, 1000, 1));
		expect(a.binaries[0]).toEqual(frame(session, 500, 2));
		expect(relayRealmTestState().admissions.map((entry) => entry.kind)).toEqual([
			"registration",
			"registration",
			"admission",
		]);
	});

	it("rejects an OPEN whose target is offline", async () => {
		// Arrange
		const stub = await realmObject();
		const { peer } = await register(stub, "source");
		const session = hex(16);
		// Act
		peer.send(openMessage("source", "target", session));
		// Assert
		await peer.next("REJECTED", session);
		expect(peer.closeCode).toBeNull();
	});

	it("aborts a route at the 2 MiB route byte cap", async () => {
		// Arrange
		const stub = await realmObject();
		const { a, b, session } = await route(stub);
		const full = frame(session, 65_536);
		const allowed = Math.floor(RELAY_DURABLE_OBJECT_LIMITS.routeBytes / full.length);
		// Act
		for (let sent = 1; sent <= allowed; sent++) {
			a.ws.send(full);
			await vi.waitUntil(() => b.binaries.length === sent, { timeout: 5000 });
		}
		a.ws.send(full);
		// Assert
		await a.next("CLOSE", session);
		await b.next("CLOSE", session);
		expect(a.texts.find((m) => m.type === "CLOSE")?.body).toEqual({ mode: "abort" });
		expect(b.binaries).toHaveLength(allowed);
	});

	it("rejects an OPEN beyond the realm route limit", async () => {
		// Arrange
		relayRealmTestState().limits = { routes: 1 };
		const stub = await realmObject();
		const a = (await register(stub, "source")).peer;
		const b = (await register(stub, "target")).peer;
		const c = (await register(stub, "third")).peer;
		const first = hex(16);
		const second = hex(16);
		a.send(openMessage("source", "target", first));
		await b.next("OPEN", first);
		// Act
		c.send(openMessage("third", "target", second));
		// Assert
		await c.next("REJECTED", second);
		expect(b.texts.some((m) => m.session === second)).toBe(false);
	});
});

describe("RelayRealm hibernation and switch", () => {
	it("restores registrations after eviction and fails a lost route closed", async () => {
		// Arrange
		const stub = await realmObject();
		const { a, b, session } = await route(stub);
		// A live route's 60 s timer keeps the object resident, so end it before eviction.
		a.send({ v: 1, type: "CLOSE", session, body: { mode: "end" } });
		b.send({ v: 1, type: "CLOSE", session, body: { mode: "end" } });
		await a.next("CLOSE", session);
		await b.next("CLOSE", session);
		await evictDurableObject(stub);
		// Act
		a.ws.send(frame(session, 100));
		await vi.waitUntil(() => a.texts.filter((m) => m.session === session).length === 3);
		const next = hex(16);
		a.send(openMessage("source", "target", next));
		// Assert
		expect(a.texts.findLast((m) => m.session === session)?.body).toEqual({ mode: "abort" });
		await b.next("OPEN", next);
		expect(b.binaries).toHaveLength(0);
		expect(a.closeCode).toBeNull();
	});

	it("refuses upgrades while switched off", async () => {
		// Arrange
		relayRealmTestState().enabled = false;
		const stub = await realmObject();
		// Act
		const response = await upgrade(stub);
		// Assert
		expect(response.status).toBe(503);
	});

	it("closes existing sockets after the switch turns off", async () => {
		// Arrange
		const stub = await realmObject();
		const { peer } = await register(stub, "source");
		relayRealmTestState().enabled = false;
		await evictDurableObject(stub);
		// Act
		peer.send({ v: 1, type: "SERVICE_CHALLENGE", session: hex(16), body: { audienceId } });
		// Assert
		await closedWith(peer, 1013);
		expect((await upgrade(stub)).status).toBe(503);
	});
});

describe("RelayRealm socket lifecycle", () => {
	const single = { sockets: 1, pendingSockets: 1 };
	const relayRequest = () =>
		new Request(`https://coordinator.example.test/v1/relay/${realmId}`, {
			headers: { Upgrade: "websocket" },
		});

	it("answers 429 when the upgrade quota denies", async () => {
		// Arrange
		const stub = await realmObject();
		await runInDurableObject(stub, (_object, state) =>
			setRelayQuotaEnabled(durableObjectRelayQuotaDatabase(state.storage), {
				realmId,
				enabled: false,
			}),
		);
		// Act
		const response = await upgrade(stub);
		// Assert
		expect(response.status).toBe(429);
	});

	it.each([
		["text over 4 KiB", "x".repeat(4097)],
		["binary over 65,558 bytes", new Uint8Array(65_559)],
	] as const)("closes the socket on %s", async (_name, message) => {
		// Arrange
		const stub = await realmObject();
		const peer = await connect(stub);
		// Act
		peer.ws.send(message);
		// Assert
		await closedWith(peer, 1008);
	});

	it("keeps an engine-closed socket charged until the peer confirms the close", async () => {
		// Arrange
		relayRealmTestState().limits = single;
		const stub = await realmObject();
		const peer = await connect(stub);
		peer.ws.send("not a relay control");
		await closedWith(peer, 1008);
		// Act
		const whileClosing = await upgrade(stub);
		peer.ws.close(1000);
		await vi.waitUntil(async () => (await upgrade(stub)).status === 101, { timeout: 2000 });
		// Assert
		expect(whileClosing.status).toBe(503);
	});

	it("frees the slot on a peer close and echoes its close code", async () => {
		// Arrange
		relayRealmTestState().limits = single;
		const stub = await realmObject();
		const peer = await connect(stub);
		const whileOpen = await upgrade(stub);
		// Act
		peer.ws.close(4001, "bye");
		await closedWith(peer, 4001);
		const after = await upgrade(stub);
		// Assert
		expect(whileOpen.status).toBe(503);
		expect(after.status).toBe(101);
	});

	it.each([
		[1000, 1000],
		[1001, 1001],
		[1011, 1011],
		[4001, 4001],
		[1004, 1000],
		[1005, 1000],
		[1006, 1000],
		[1015, 1000],
		[999, 1000],
		[5000, 1000],
	])("replies to close code %i with %i", (received, sent) => {
		// Act / Assert
		expect(replyCode(received)).toBe(sent);
	});

	it("releases the pending slot when acceptWebSocket throws", async () => {
		// Arrange
		relayRealmTestState().limits = single;
		const stub = await realmObject();
		// Act
		const statuses = await runInDurableObject(stub, async (object, state) => {
			const accept = vi.spyOn(state, "acceptWebSocket").mockImplementationOnce(() => {
				throw new Error("accept failed");
			});
			const failed = await object.fetch(relayRequest());
			const retried = await object.fetch(relayRequest());
			accept.mockRestore();
			retried.webSocket?.accept();
			retried.webSocket?.close(1000);
			return [failed.status, retried.status];
		});
		// Assert
		expect(statuses).toEqual([503, 101]);
	});

	it("closes a socket whose attachment fails restore after wake", async () => {
		// Arrange
		const stub = await realmObject();
		const { peer } = await register(stub, "source");
		await runInDurableObject(stub, (_object, state) => {
			for (const ws of state.getWebSockets()) ws.serializeAttachment({ v: 1, forged: true });
		});
		await evictDurableObject(stub);
		// Act
		peer.ws.send(frame(hex(16), 10));
		// Assert
		await closedWith(peer, 1008);
	});

	it("restores each socket once when two events arrive together on wake", async () => {
		// Arrange
		const stub = await realmObject();
		const a = (await register(stub, "source")).peer;
		const b = (await register(stub, "target")).peer;
		await evictDurableObject(stub);
		const lostA = hex(16);
		const lostB = hex(16);
		// Act
		a.ws.send(frame(lostA, 10));
		b.ws.send(frame(lostB, 10));
		await a.next("CLOSE", lostA);
		await b.next("CLOSE", lostB);
		const next = hex(16);
		a.send(openMessage("source", "target", next));
		// Assert
		await b.next("OPEN", next);
		expect(a.texts.filter((m) => m.session === lostA)).toHaveLength(1);
		expect(b.texts.filter((m) => m.session === lostB)).toHaveLength(1);
		expect([a.closeCode, b.closeCode]).toEqual([null, null]);
	});

	it("runs the production class default-off and keeps no env", async () => {
		// Arrange
		const stub = env.RELAY_REALM_PRODUCTION.get(env.RELAY_REALM_PRODUCTION.newUniqueId());
		// Act
		const response = await stub.fetch(relayRequest());
		const state = await runInDurableObject(stub, (object, ctx) => ({
			envKeys: Object.keys((object as unknown as { env: object }).env),
			sockets: ctx.getWebSockets().length,
		}));
		// Assert
		expect(response.status).toBe(503);
		expect(state).toEqual({ envKeys: [], sockets: 0 });
	});
});

describe("Workers relay socket adapter", () => {
	function fakeWebSocket() {
		return {
			send: vi.fn(),
			close: vi.fn(),
			serializeAttachment: vi.fn(),
		};
	}
	const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

	it("reports writes once, after send returns, and counts only its own bytes", async () => {
		// Arrange
		const ws = fakeWebSocket();
		const adapter = new RelaySocketAdapter(ws as unknown as WebSocket, () => {});
		const written = vi.fn();
		// Act
		adapter.sendBinary(new Uint8Array(10), written);
		const during = { calls: written.mock.calls.length, buffered: adapter.bufferedBytes() };
		await flush();
		// Assert
		expect(during).toEqual({ calls: 0, buffered: 10 });
		expect(written).toHaveBeenCalledExactlyOnceWith();
		expect(adapter.bufferedBytes()).toBe(0);
		expect(() => {
			adapter.pauseInput();
			adapter.resumeInput();
		}).not.toThrow();
	});

	it("clears the attachment before closing and stays charged until the peer confirms", async () => {
		// Arrange
		const ws = fakeWebSocket();
		const released = vi.fn();
		const adapter = new RelaySocketAdapter(ws as unknown as WebSocket, released);
		const closed = vi.fn();
		adapter.bind({ text: vi.fn(), binary: vi.fn(), closed, pending: () => false });
		const written = vi.fn();
		// Act
		adapter.close();
		adapter.close();
		adapter.sendText("{}", written);
		await flush();
		const beforeConfirm = {
			closed: closed.mock.calls.length,
			released: released.mock.calls.length,
		};
		adapter.peerClosed();
		adapter.peerClosed();
		// Assert
		expect(ws.serializeAttachment).toHaveBeenCalledExactlyOnceWith(null);
		expect(ws.serializeAttachment.mock.invocationCallOrder[0]).toBeLessThan(
			ws.close.mock.invocationCallOrder[0] ?? 0,
		);
		expect(ws.close).toHaveBeenCalledExactlyOnceWith(1008, "relay closed");
		expect(ws.send).not.toHaveBeenCalled();
		expect(written.mock.calls[0]?.[0]).toBeInstanceOf(Error);
		expect(beforeConfirm).toEqual({ closed: 0, released: 0 });
		expect(closed).toHaveBeenCalledOnce();
		expect(released).toHaveBeenCalledOnce();
	});

	it("releases a closed socket whose peer never answers after the grace period", async () => {
		// Arrange
		const released = vi.fn();
		const adapter = new RelaySocketAdapter(fakeWebSocket() as unknown as WebSocket, released, 20);
		const closed = vi.fn();
		adapter.bind({ text: vi.fn(), binary: vi.fn(), closed, pending: () => false });
		// Act
		adapter.close();
		await flush();
		const early = closed.mock.calls.length;
		await vi.waitUntil(() => closed.mock.calls.length > 0, { timeout: 1000 });
		adapter.peerClosed();
		// Assert
		expect(early).toBe(0);
		expect(closed).toHaveBeenCalledOnce();
		expect(released).toHaveBeenCalledOnce();
		expect(RELAY_CLOSE_GRACE_MS).toBeGreaterThanOrEqual(5000);
		expect(RELAY_CLOSE_GRACE_MS).toBeLessThanOrEqual(10_000);
	});

	it("reports a throwing send as a failed write", async () => {
		// Arrange
		const ws = fakeWebSocket();
		ws.send.mockImplementation(() => {
			throw new Error("closed");
		});
		const adapter = new RelaySocketAdapter(ws as unknown as WebSocket, () => {});
		const written = vi.fn();
		// Act
		adapter.sendText("{}", written);
		await flush();
		// Assert
		expect(written.mock.calls[0]?.[0]).toBeInstanceOf(Error);
		expect(adapter.bufferedBytes()).toBe(0);
	});

	it("rejects an oversized snapshot", () => {
		// Arrange
		const adapter = new RelaySocketAdapter(fakeWebSocket() as unknown as WebSocket, () => {});
		const snapshot = { v: 1, realmId: "x".repeat(MAX_ATTACHMENT_BYTES) } as never;
		// Act / Assert
		expect(() => adapter.storeSnapshot(snapshot)).toThrow("Relay attachment too large");
	});
});

describe("Durable Object relay memory bound", () => {
	it("keeps worst-case outbound bytes for concurrent routes within a quarter of the isolate", () => {
		// Arrange
		const limits = RELAY_DURABLE_OBJECT_LIMITS;
		// Act
		const bound = concurrentRouteOutboundBound(limits);
		// Assert
		expect(limits.routes).toBe(8);
		expect(limits.routeBytes).toBe(2 * MiB);
		expect(bound).toBeLessThanOrEqual(RELAY_OUTBOUND_BUDGET_BYTES);
		expect(RELAY_OUTBOUND_BUDGET_BYTES * 4).toBe(RELAY_ISOLATE_MEMORY_BYTES);
		expect(concurrentRouteOutboundBound({ ...limits, routeBytes: 20 * MiB })).toBeGreaterThan(
			RELAY_OUTBOUND_BUDGET_BYTES,
		);
	});
});
