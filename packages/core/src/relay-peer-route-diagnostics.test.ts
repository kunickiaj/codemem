import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { parseRelayEd25519PublicKey } from "./relay-ed25519.js";
import { RelayFailure } from "./relay-failure-reason.js";
import {
	createRelayPeerClient,
	type RelayPeerClient,
	type RelayPeerClientOptions,
} from "./relay-peer-client.js";
import { disposableIdentity } from "./relay-peer-client-test-fixtures.js";
import { settle } from "./relay-server-test-fixtures.js";
import { relayAudienceId, relayBodyDigest, relayRealmId } from "./relay-service-proof.js";

const wire = vi.hoisted(() => ({
	failConnect: false,
	incoming: {} as Record<string, unknown>,
	sockets: [] as unknown[],
}));
vi.mock("./relay-service-proof.js", async (original) => ({
	...(await original<typeof import("./relay-service-proof.js")>()),
	verifyRelayServiceProof: vi.fn(async () => true),
}));
vi.mock("./relay-admission-proof.js", () => ({ verifyRelayCheckProof: vi.fn(async () => true) }));
vi.mock("./relay-admission-codec.js", async (original) => {
	const actual = await original<typeof import("./relay-admission-codec.js")>();
	return {
		...actual,
		decodeRelayCheckPacket: (packet: Parameters<typeof actual.decodeRelayCheckPacket>[0]) => {
			if (Object.keys(packet).length === 0) return { kind: "admission", value: wire.incoming };
			return actual.decodeRelayCheckPacket(packet);
		},
	};
});
vi.mock("./relay-control-codec.js", async (original) => ({
	...(await original<typeof import("./relay-control-codec.js")>()),
	decodeRelayControl: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()),
}));
vi.mock("ws", async () => {
	const { EventEmitter } = await import("node:events");
	class Socket extends EventEmitter {
		static OPEN = 1;
		static CONNECTING = 0;
		readyState = 1;
		bufferedAmount = 0;
		sent: { type: string; session: string }[] = [];
		constructor() {
			super();
			wire.sockets.push(this);
			queueMicrotask(() =>
				this.emit(wire.failConnect ? "error" : "open", new Error("private-socket-error")),
			);
		}
		send(bytes: string, _options: unknown, done: (error?: Error) => void) {
			const message = JSON.parse(bytes);
			this.sent.push(message);
			done();
			if (message.type === "SERVICE_CHALLENGE")
				queueMicrotask(() => {
					this.receive({ type: "SERVICE_PROOF", session: message.session, body: {} });
					this.receive({ type: "SOCKET_CHALLENGE", session: "c".repeat(32), body: {} });
				});
			if (message.type === "REGISTER")
				queueMicrotask(() =>
					this.receive({
						type: "REGISTERED",
						session: message.session,
						body: {
							deviceId: "target",
							keyId: wire.incoming.targetKeyId,
							authorityId: "b".repeat(64),
							realmId: relayRealmId("b".repeat(64), "group"),
							remainingMs: 300000,
						},
					}),
				);
		}
		receive(message: unknown) {
			this.emit("message", Buffer.from(JSON.stringify(message)), false);
		}
		terminate() {
			this.readyState = 3;
			queueMicrotask(() => this.emit("close"));
		}
	}
	return { default: Socket };
});

const clients: RelayPeerClient[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
	wire.sockets = [];
	wire.failConnect = false;
	vi.restoreAllMocks();
});

function fixture(onRouteFailure?: RelayPeerClientOptions["onRouteFailure"]) {
	const localIdentity = disposableIdentity(2);
	const peer = disposableIdentity(1);
	const service = disposableIdentity(3);
	const keyId = (pin: string) => relayBodyDigest(parseRelayEd25519PublicKey(pin).wireKey);
	const audience = relayAudienceId("wss://relay.example.test", keyId(service.expectedPin));
	wire.incoming = {
		sourceDeviceId: "source",
		sourceKeyId: keyId(peer.expectedPin),
		targetDeviceId: "target",
		targetKeyId: keyId(localIdentity.expectedPin),
		authorityId: "b".repeat(64),
		groupId: "group",
		relayAudienceId: audience,
		messageADigest: "d".repeat(64),
	};
	const check = vi.fn(async () => {
		throw new RelayFailure("relay_admission_failed", "private-coordinator-sentinel");
	});
	const client = createRelayPeerClient({
		enabled: true,
		url: "wss://relay.example.test/relay",
		servicePublicKey: service.expectedPin,
		deviceId: "target",
		localIdentity,
		authorityId: "b".repeat(64),
		groupId: "group",
		relayAudienceId: audience,
		externalPathname: "/v1/relay/admission-check",
		coordinator: { check },
		resolvePeerPin: () => peer.expectedPin,
		validateLocal: () => true,
		onInbound: vi.fn(async () => {}),
		onRouteFailure,
	});
	clients.push(client);
	return { client, check, pin: peer.expectedPin };
}

function observer(mode: string) {
	return vi.fn((): void | Promise<void> => {
		if (mode === "throw") throw new Error("private-callback-sentinel");
		if (mode === "reject") return Promise.reject(new Error("private-callback-sentinel"));
		if (mode === "pending") return new Promise(() => {});
	});
}

describe("temporary relay peer route diagnostics", () => {
	it.each(["observe", "throw", "reject", "pending", "absent"])(
		"source cleanup completes with %s callback",
		async (mode) => {
			// Arrange: an in-memory socket fails registration after the source route exists.
			wire.failConnect = true;
			const onRouteFailure = observer(mode);
			const { client, pin } = fixture(mode === "absent" ? undefined : onRouteFailure);
			const factory = client.factory("source", pin);
			// Act.
			const opening = factory.open({
				signal: new AbortController().signal,
				deadlineMs: performance.now() + 10000,
			});
			// Assert: diagnostic failures cannot change the original error or block disposal.
			await expect(opening).rejects.toMatchObject({ reason: "relay_expired" });
			await settle();
			expect(factory.failureReason()).toBe("relay_unavailable");
			if (mode === "absent") expect(onRouteFailure).not.toHaveBeenCalled();
			else
				expect(onRouteFailure.mock.calls).toEqual([
					[
						{
							sessionId: expect.stringMatching(/^[0-9a-f]{32}$/),
							side: "source",
							reason: "relay_unavailable",
						},
					],
				]);
			await expect(client.close()).resolves.toBeUndefined();
		},
	);

	it.each(["observe", "throw", "reject", "pending"])(
		"target rejection completes with %s callback",
		async (mode) => {
			// Arrange: registration and coordinator responses are mocked, with no network or Noise exchange.
			const onRouteFailure = observer(mode);
			const { client, check } = fixture(onRouteFailure);
			await client.connect(new AbortController().signal, performance.now() + 10000);
			const socket = wire.sockets[0] as WebSocket & {
				receive(message: unknown): void;
				sent: { type: string; session: string }[];
			};
			const sessionId = "a".repeat(32);
			// Act.
			socket.receive({ type: "OPEN", session: sessionId, body: { checks: [{}, {}] } });
			await settle();
			// Assert: the raw failure emits once, rejects the wire route, and releases its resources.
			expect(check).toHaveBeenCalledTimes(1);
			expect(onRouteFailure.mock.calls).toEqual([
				[{ sessionId, side: "target", reason: "relay_admission_failed" }],
			]);
			expect(socket.sent).toContainEqual({
				v: 1,
				type: "CLOSE",
				session: sessionId,
				body: { mode: "abort" },
			});
			await expect(client.close()).resolves.toBeUndefined();
			expect(onRouteFailure).toHaveBeenCalledTimes(1);
		},
	);

	it("does not report registration success or closing a client without routes", async () => {
		// Arrange.
		const onRouteFailure = vi.fn();
		const { client } = fixture(onRouteFailure);
		// Act.
		await client.connect(new AbortController().signal, performance.now() + 10000);
		await client.close();
		// Assert.
		expect(onRouteFailure).not.toHaveBeenCalled();
	});

	it("does not fabricate a route diagnostic for a failure before route creation", async () => {
		// Arrange.
		const onRouteFailure = vi.fn();
		const { client, pin } = fixture(onRouteFailure);
		await client.close();
		// Act.
		const opening = client
			.factory("source", pin)
			.open({ signal: new AbortController().signal, deadlineMs: performance.now() + 10000 });
		// Assert.
		await expect(opening).rejects.toMatchObject({ reason: "relay_disabled" });
		expect(onRouteFailure).not.toHaveBeenCalled();
		expect(wire.sockets).toEqual([]);
	});
});
