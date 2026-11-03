import { once } from "node:events";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { vi } from "vitest";
import WebSocket from "ws";
import {
	decodeRelayControl,
	encodeRelayControl,
	type RelayControl,
} from "./relay-control-codec.js";
import type { RelayServerLimits } from "./relay-server.js";
import { SESSION, serverFixture } from "./relay-server-test-fixtures.js";
import {
	createRelayWebSocketRuntime,
	type RelayWebSocketRuntimeOptions,
} from "./relay-websocket-runtime.js";

export const runtimeLimits = { sockets: 8, pendingSockets: 4, writeBytes: 1024 * 1024 };

/** Delays destroy on one real upgraded TCP socket to model asynchronous physical cleanup. */
export async function heldUpgradeFixture(status: "denied" | "timeout" | "throw") {
	const server = createServer((_request, response) => response.end());
	const destroyRequested = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const physicallyClosed = Promise.withResolvers<void>();
	let release = () => {};
	server.once("upgrade", (_request, socket: Duplex) => {
		const destroy = socket.destroy.bind(socket);
		const delayed = vi.spyOn(socket, "destroy").mockImplementation(() => {
			destroyRequested.resolve();
			return socket;
		});
		socket.once("close", () => physicallyClosed.resolve());
		release = () => {
			delayed.mockRestore();
			destroy();
		};
	});
	const reserveUpgrade = vi.fn(async () => {
		entered.resolve();
		if (status === "throw") throw new Error("Quota unavailable");
		if (status === "timeout") return new Promise<"denied">(() => {});
		return "denied" as const;
	});
	const fixture = await runtimeFixture({
		server,
		reserveUpgrade,
		limits: { ...runtimeLimits, sockets: 1, pendingSockets: 1 },
	});
	return {
		fixture,
		reserveUpgrade,
		entered: entered.promise,
		destroyRequested: destroyRequested.promise,
		physicallyClosed: physicallyClosed.promise,
		release: () => release(),
		async dispose() {
			release();
			await fixture.dispose();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		},
	};
}

type Peer = ReturnType<typeof peer>;
type RuntimeFixture = Omit<
	Awaited<ReturnType<typeof serverFixture>>,
	"dispose" | "register" | "route"
> & {
	runtime: Pick<
		ReturnType<typeof createRelayWebSocketRuntime>,
		"server" | "close" | "disable" | "counters"
	>;
	url: string;
	connect(options?: WebSocket.ClientOptions, path?: string): Peer;
	register(deviceId?: string): Promise<Peer>;
	route(): Promise<{ a: Peer; b: Peer }>;
	dispose(): Promise<void>;
};
export async function runtimeFixture(
	overrides: Partial<RelayWebSocketRuntimeOptions> = {},
	engineLimits: Partial<RelayServerLimits> = {},
): Promise<RuntimeFixture> {
	const signed = await serverFixture(engineLimits);
	const runtime: Pick<
		ReturnType<typeof createRelayWebSocketRuntime>,
		"server" | "close" | "disable" | "counters"
	> = createRelayWebSocketRuntime({
		relay: signed.options,
		enabled: true,
		limits: runtimeLimits,
		reserveUpgrade: async () => "reserved",
		...overrides,
	});
	const peers: ReturnType<typeof peer>[] = [];
	await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
	const address = runtime.server.address();
	if (!address || typeof address === "string") throw new Error("Missing loopback listener");
	const url = `ws://127.0.0.1:${address.port}/v1/relay`;
	function connect(options?: WebSocket.ClientOptions, path = url) {
		const client = peer(new WebSocket(path, options));
		peers.push(client);
		return client;
	}
	async function register(deviceId = "source") {
		const client = connect({ perMessageDeflate: true });
		return registerPeer(client, signed, deviceId);
	}
	async function route() {
		const a = await register(),
			b = await register("target");
		a.ws.send(encodeRelayControl(await signed.openPacket()));
		const open = await b.controlMessage();
		if (open.type !== "OPEN") throw new Error("Missing forwarded open");
		b.control("ACCEPTED");
		const accepted = await a.controlMessage();
		if (accepted.type !== "ACCEPTED") throw new Error("Missing acceptance");
		return { a, b };
	}
	return {
		...signed,
		runtime,
		url,
		connect,
		register,
		route,
		async dispose() {
			for (const client of peers) client.ws.terminate();
			await runtime.close();
			await Promise.all(peers.map((client) => client.closed));
			signed.dispose();
		},
	};
}

export async function registerPeer(
	client: ReturnType<typeof peer>,
	signed: Awaited<ReturnType<typeof serverFixture>>,
	deviceId: string,
) {
	await client.opened;
	client.control("SERVICE_CHALLENGE", { audienceId: signed.options.namespace.relayAudienceId });
	const proof = await client.controlMessage();
	if (proof.type !== "SERVICE_PROOF") throw new Error("Missing service proof");
	const challenge = await client.controlMessage();
	if (challenge.type !== "SOCKET_CHALLENGE") throw new Error("Missing socket challenge");
	const key = deviceId === "target" ? signed.target : signed.source;
	const packet = await signed.packet({
		...signed.options.namespace,
		deviceId,
		keyId: key.keyId,
		socketChallengeId: challenge.session,
		createdAt: 100,
		admitBefore: 130,
	});
	client.control("REGISTER", packet, challenge.session);
	const registered = await client.controlMessage();
	if (registered.type !== "REGISTERED") throw new Error("Registration denied");
	return client;
}

export function peer(ws: WebSocket) {
	const messages: { bytes: Buffer; binary: boolean }[] = [];
	const waiters: ((value: { bytes: Buffer; binary: boolean }) => void)[] = [];
	ws.on("message", (data, binary) => {
		if (!Buffer.isBuffer(data)) throw new Error("Unexpected message representation");
		const message = { bytes: data, binary };
		const resolve = waiters.shift();
		if (resolve) resolve(message);
		else messages.push(message);
	});
	const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
	const opened = once(ws, "open").then(
		() => true,
		() => false,
	);
	ws.on("error", () => {});
	async function next() {
		const message = messages.shift();
		return (
			message ?? new Promise<{ bytes: Buffer; binary: boolean }>((resolve) => waiters.push(resolve))
		);
	}
	return {
		ws,
		opened,
		closed,
		next,
		control(type: RelayControl["type"], body: unknown = {}, session = SESSION) {
			ws.send(encodeRelayControl({ v: 1, type, session, body } as RelayControl));
		},
		async controlMessage() {
			return decodeRelayControl((await next()).bytes);
		},
	};
}
