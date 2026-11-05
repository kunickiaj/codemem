import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { type ServerOptions, WebSocketServer } from "ws";
import {
	RELAY_ADDRESS_PENDING_SOCKETS,
	RelayAddressAllowances,
	relayAddressKey,
} from "./relay-address-allowance.js";
import type { RelayAdmissionBudgetStatus } from "./relay-admission-decision.js";
import {
	createRelayServer,
	type RelayServerOptions,
	type RelayServerSocket,
	type RelaySocketEvents,
} from "./relay-server.js";

const MAX_MESSAGE_BYTES = 65_558;
const MAX_CONTROL_BYTES = 4096;

export interface RelayWebSocketRuntimeOptions {
	readonly relay: RelayServerOptions;
	readonly enabled?: boolean;
	/** An existing HTTP(S) server permits co-hosting without owning its listener. */
	readonly server?: Server;
	readonly path?: string;
	readonly reserveUpgrade?: (signal: AbortSignal) => Promise<RelayAdmissionBudgetStatus>;
	readonly limits?: {
		readonly sockets: number;
		readonly pendingSockets: number;
		readonly writeBytes: number;
	};
}

export interface RelayWebSocketRuntimeHandle {
	readonly server: Server;
	counters(): {
		sockets: number;
		pendingSockets: number;
		routes: number;
		queuedBytes: number;
		trafficQuotaAborts: number;
		pendingUpgrades: number;
	};
	disable(): void;
	close(): Promise<void>;
}

interface LiveSocket {
	readonly webSocket: WebSocket;
	readonly address: string;
	readonly events: RelaySocketEvents | null;
}
interface PendingUpgrade {
	readonly socket: Duplex;
	readonly address: string;
	readonly cancel: AbortController;
	readonly done: ReturnType<typeof Promise.withResolvers<void>>;
}

function finiteLimit(value: number | undefined, ceiling: number): number {
	if (value === undefined) return 0;
	if (!Number.isSafeInteger(value) || value < 0 || value > ceiling)
		throw new Error("Invalid relay WebSocket limits");
	return value;
}

/** Never starts a listener. Only explicit positive configuration accepts upgrades. */
export function createRelayWebSocketRuntime(
	options: RelayWebSocketRuntimeOptions,
): RelayWebSocketRuntimeHandle {
	return new RelayWebSocketRuntime(options);
}

class RelayWebSocketRuntime {
	readonly server: Server;
	private readonly ownsServer: boolean;
	private readonly relay: ReturnType<typeof createRelayServer>;
	private readonly webSockets: WebSocketServer;
	private readonly sockets = new Set<LiveSocket>();
	private readonly pending = new Set<PendingUpgrade>();
	private readonly addresses = new RelayAddressAllowances();
	private readonly limits: { sockets: number; pendingSockets: number; writeBytes: number };
	private enabled: boolean;
	private readonly path: string;
	constructor(private readonly options: RelayWebSocketRuntimeOptions) {
		this.path = options.path ?? "/v1/relay";
		if (!/^\/[A-Za-z0-9/_-]+$/.test(this.path)) throw new Error("Invalid relay WebSocket path");
		this.limits = {
			sockets: finiteLimit(options.limits?.sockets, 128),
			pendingSockets: finiteLimit(options.limits?.pendingSockets, 16),
			writeBytes: finiteLimit(options.limits?.writeBytes, 2 * 1024 * 1024),
		};
		this.enabled =
			options.enabled === true && Object.values(this.limits).every((value) => value > 0);
		this.relay = createRelayServer(options.relay);
		this.ownsServer = options.server === undefined;
		this.server =
			options.server ??
			createServer({ maxHeaderSize: 16 * 1024 }, (_request, response) => {
				response.writeHead(404, { "content-length": "0", connection: "close" });
				response.end();
			});
		if (this.ownsServer) {
			this.server.maxHeadersCount = 32;
			this.server.headersTimeout = 10_000;
			this.server.requestTimeout = 10_000;
			this.server.maxConnections = this.limits.sockets || 128;
			this.server.on("connection", (socket) => socket.setTimeout(30_000, () => socket.destroy()));
		}
		// The pinned runtime supports these receive limits before message dispatch.
		const webSocketOptions: ServerOptions & { maxFragments: number; maxBufferedChunks: number } = {
			noServer: true,
			clientTracking: false,
			perMessageDeflate: false,
			autoPong: false,
			allowSynchronousEvents: false,
			maxPayload: MAX_MESSAGE_BYTES,
			maxFragments: 32,
			maxBufferedChunks: 256,
		};
		this.webSockets = new WebSocketServer(webSocketOptions);
		this.server.on("upgrade", this.upgrade);
	}

	counters() {
		return { ...this.relay.counters(), pendingUpgrades: this.pending.size };
	}

	disable(): void {
		this.enabled = false;
		for (const pending of this.pending) {
			pending.cancel.abort();
			pending.socket.destroy();
		}
		this.relay.close();
		for (const live of this.sockets) live.webSocket.terminate();
	}

	async close(): Promise<void> {
		const closedSockets = [...this.sockets].map(
			({ webSocket }) => new Promise<void>((resolve) => webSocket.once("close", () => resolve())),
		);
		const closedUpgrades = [...this.pending].map((pending) => pending.done.promise);
		this.disable();
		this.server.off("upgrade", this.upgrade);
		const webSocketsClosed = new Promise<void>((resolve) => this.webSockets.close(() => resolve()));
		for (const live of this.sockets) live.webSocket.terminate();
		if (this.ownsServer) {
			const closedServer = new Promise<void>((resolve) => this.server.close(() => resolve()));
			this.server.closeAllConnections();
			await closedServer;
		}
		await Promise.all([webSocketsClosed, ...closedSockets, ...closedUpgrades]);
	}

	private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
		if (request.url !== this.path && !this.ownsServer) return;
		// Addresses come from the actual TCP connection, never forwarding headers.
		const remote = request.socket.remoteAddress;
		// Pending counts and attempt allowances are per fairness key, not per raw address.
		const address = remote ? relayAddressKey(remote) : remote;
		if (
			request.url !== this.path ||
			request.method !== "GET" ||
			!address ||
			!this.enabled ||
			!this.options.reserveUpgrade ||
			head.length > MAX_MESSAGE_BYTES ||
			!this.reserveAddress(address)
		) {
			socket.destroy();
			return;
		}
		const pending = {
			socket,
			address,
			cancel: new AbortController(),
			done: Promise.withResolvers<void>(),
		};
		this.pending.add(pending);
		request.socket.setKeepAlive(true, 60_000);
		socket.pause();
		socket.on("error", () => socket.destroy());
		socket.once("close", () => {
			pending.cancel.abort();
			this.releaseUpgrade(pending);
		});
		void this.authorizeUpgrade(request, head, pending);
	};

	private reserveAddress(address: string): boolean {
		if (this.sockets.size + this.pending.size >= this.limits.sockets) return false;
		const unregistered = [...this.sockets].filter((live) => live.events?.pending());
		if (unregistered.length + this.pending.size >= this.limits.pendingSockets) return false;
		const fromAddress = unregistered.filter((live) => live.address === address).length;
		const pendingAddress = [...this.pending].filter((entry) => entry.address === address).length;
		if (fromAddress + pendingAddress >= RELAY_ADDRESS_PENDING_SOCKETS) return false;
		return this.addresses.take(address);
	}

	private async authorizeUpgrade(
		request: IncomingMessage,
		head: Buffer,
		pending: PendingUpgrade,
	): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort = () => {};
		let handedOff = false;
		try {
			const status = await Promise.race([
				this.options.reserveUpgrade?.(pending.cancel.signal),
				new Promise<null>((resolve) => {
					abort = () => resolve(null);
					pending.cancel.signal.addEventListener("abort", abort, { once: true });
					if (pending.cancel.signal.aborted) abort();
					timer = setTimeout(() => pending.cancel.abort(), 3000);
					timer.unref();
				}),
			]);
			if (!this.enabled || pending.cancel.signal.aborted || status !== "reserved") {
				pending.socket.destroy();
				return;
			}
			this.webSockets.handleUpgrade(request, pending.socket, head, (webSocket) => {
				this.adopt(webSocket, pending.address);
				handedOff = true;
				this.releaseUpgrade(pending);
				webSocket.resume();
			});
		} catch {
			pending.socket.destroy();
		} finally {
			if (timer) clearTimeout(timer);
			pending.cancel.signal.removeEventListener("abort", abort);
			pending.cancel.abort();
			if (!handedOff) pending.socket.destroy();
		}
	}

	private releaseUpgrade(pending: PendingUpgrade): void {
		this.pending.delete(pending);
		pending.done.resolve();
	}

	private adopt(webSocket: WebSocket, address: string): void {
		webSocket.binaryType = "nodebuffer";
		const adapter = createSocketAdapter(webSocket, this.limits.writeBytes);
		const events = this.relay.adopt(adapter.socket);
		const live = { webSocket, address, events };
		this.sockets.add(live);
		webSocket.on("error", () => webSocket.terminate());
		webSocket.once("close", () => {
			if (events) adapter.closed(events);
			this.sockets.delete(live);
		});
		if (!events) {
			webSocket.terminate();
			return;
		}
		webSocket.on("ping", () => webSocket.terminate());
		webSocket.on("pong", () => webSocket.terminate());
		webSocket.on("message", (data, binary) => {
			if (!Buffer.isBuffer(data) || (!binary && data.length > MAX_CONTROL_BYTES)) {
				webSocket.terminate();
				return;
			}
			if (binary) events.binary(data);
			else void events.text(data);
		});
	}
}

function createSocketAdapter(webSocket: WebSocket, writeLimit: number) {
	const pending = new Map<(error?: Error) => void, number>();
	let ownedBytes = 0;
	let physicallyClosed = false;
	function finish(callback: (error?: Error) => void, error?: Error): void {
		const bytes = pending.get(callback);
		if (bytes === undefined) return;
		pending.delete(callback);
		ownedBytes -= bytes;
		callback(error);
	}
	function send(data: string | Uint8Array, callback: (error?: Error) => void): void {
		const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
		if (
			physicallyClosed ||
			webSocket.readyState !== WebSocket.OPEN ||
			Math.max(ownedBytes, webSocket.bufferedAmount) + bytes + 14 > writeLimit
		) {
			callback(new Error("Relay write unavailable"));
			webSocket.terminate();
			return;
		}
		ownedBytes += bytes + 14;
		pending.set(callback, bytes + 14);
		try {
			webSocket.send(data, { binary: typeof data !== "string", compress: false }, (error) => {
				if (error) {
					webSocket.terminate();
					return;
				}
				finish(callback);
			});
		} catch {
			// A throwing native send can still own bytes. Release on physical close.
			webSocket.terminate();
		}
	}
	const socket: RelayServerSocket = {
		sendText: send,
		sendBinary: send,
		bufferedBytes: () => (physicallyClosed ? 0 : Math.max(ownedBytes, webSocket.bufferedAmount)),
		pauseInput: () => webSocket.pause(),
		resumeInput: () => webSocket.resume(),
		close: () => webSocket.terminate(),
	};
	return {
		socket,
		closed(events: RelaySocketEvents) {
			physicallyClosed = true;
			events.closed();
			for (const callback of pending.keys()) finish(callback, new Error("Relay socket closed"));
		},
	};
}
