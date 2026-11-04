import WebSocket, { type RawData, WebSocketServer } from "ws";
import { decodeRelayControl } from "./relay-control-codec.js";
import { RELAY_DATA_FRAME_HEADER_BYTES } from "./relay-data-frame.js";

/**
 * Test-only relay WebSocket proxy that scripts transport faults between real peer clients and a
 * real relay runtime. It classifies frames from their cleartext relay headers only. It never holds
 * Noise or identity keys, never decrypts DATA payloads, and changes bytes only for explicit
 * truncation or substitution.
 */

/** `toRelay` frames travel from a peer client to the runtime; `toPeer` frames travel back. */
export type RelayFaultDirection = "toRelay" | "toPeer";

export type RelayFaultFrameKind =
	| { readonly kind: "control"; readonly type: string; readonly session: string }
	| { readonly kind: "data"; readonly session: string; readonly length: number };

export type RelayFaultFrame = RelayFaultFrameKind & {
	readonly direction: RelayFaultDirection;
	/** Accept order of the peer socket, starting at 0. */
	readonly socket: number;
	/** Per-socket, per-direction arrival order, starting at 0. */
	readonly index: number;
	readonly byteLength: number;
};

export type RelayFaultAction =
	| { readonly type: "pass" }
	| { readonly type: "drop" }
	| { readonly type: "duplicate" }
	/** Holds the frame until `ms` elapses. Later frames keep flowing. */
	| { readonly type: "delay"; readonly ms: number }
	/** Holds the frame until the next frame in the same direction is forwarded, then sends it. */
	| { readonly type: "reorder" }
	/** Forwards only the first `keep` bytes with the original frame type. */
	| { readonly type: "truncate"; readonly keep: number }
	/** Forwards replacement bytes. A string is sent as a text frame, bytes as a binary frame. */
	| { readonly type: "substitute"; readonly bytes: (original: Buffer) => string | Uint8Array };

export type RelayFaultRule = (frame: RelayFaultFrame) => RelayFaultAction | undefined;

export type RelayFaultEvent = RelayFaultFrame & {
	readonly action: RelayFaultAction["type"] | "release" | "discard";
	/** Bytes written to the next hop for this event. Zero for drops, holds, and discards. */
	readonly forwardedBytes: number;
};

/** The proxy receives only an upstream URL and a rule. It has no access to key material. */
export interface RelayFaultProxyOptions {
	readonly upstreamUrl: string;
	readonly rule?: RelayFaultRule;
}

export interface RelayFaultProxy {
	/** `127.0.0.1:port` for clients to dial with the same `/v1/relay` path. */
	readonly host: string;
	readonly events: readonly RelayFaultEvent[];
	/** Frames held in memory by delay or reorder actions that have not been released. */
	held(): number;
	close(): Promise<void>;
}

interface Held {
	readonly frame: RelayFaultFrame;
	readonly data: Buffer;
	readonly binary: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

const MAX_MESSAGE_BYTES = RELAY_DATA_FRAME_HEADER_BYTES + 65_536;

function toBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}

/** Reads only cleartext relay framing. DATA payload bytes are counted, never inspected. */
export function classifyRelayFrame(data: Buffer, binary: boolean): RelayFaultFrameKind {
	if (!binary) {
		try {
			const control = decodeRelayControl(data);
			return { kind: "control", type: control.type, session: control.session };
		} catch {
			return { kind: "control", type: "invalid", session: "" };
		}
	}
	const session =
		data.byteLength >= RELAY_DATA_FRAME_HEADER_BYTES ? data.subarray(2, 18).toString("hex") : "";
	return {
		kind: "data",
		session,
		length: Math.max(0, data.byteLength - RELAY_DATA_FRAME_HEADER_BYTES),
	};
}

class ProxiedSocket {
	private readonly held = new Set<Held>();
	private readonly reordered: Record<RelayFaultDirection, Held[]> = { toRelay: [], toPeer: [] };
	private readonly counts: Record<RelayFaultDirection, number> = { toRelay: 0, toPeer: 0 };
	private readonly beforeOpen: { data: Buffer; binary: boolean }[] = [];

	constructor(
		private readonly id: number,
		private readonly peer: WebSocket,
		private readonly upstream: WebSocket,
		private readonly rule: RelayFaultRule,
		private readonly log: RelayFaultEvent[],
	) {
		upstream.once("open", () => {
			for (const { data, binary } of this.beforeOpen.splice(0))
				this.receive("toRelay", data, binary);
		});
		peer.on("message", (data, binary) => this.arrive("toRelay", toBuffer(data), binary));
		upstream.on("message", (data, binary) => this.receive("toPeer", toBuffer(data), binary));
		for (const socket of [peer, upstream]) {
			socket.on("error", () => this.close());
			socket.once("close", () => this.close());
		}
	}

	heldCount(): number {
		return this.held.size;
	}

	close(): void {
		for (const entry of this.held) {
			if (entry.timer) clearTimeout(entry.timer);
			this.record(entry.frame, "discard", 0);
		}
		this.held.clear();
		this.reordered.toRelay.length = 0;
		this.reordered.toPeer.length = 0;
		this.beforeOpen.length = 0;
		this.peer.terminate();
		this.upstream.terminate();
	}

	private arrive(direction: RelayFaultDirection, data: Buffer, binary: boolean): void {
		if (this.upstream.readyState === WebSocket.CONNECTING) this.beforeOpen.push({ data, binary });
		else this.receive(direction, data, binary);
	}

	private receive(direction: RelayFaultDirection, data: Buffer, binary: boolean): void {
		const frame: RelayFaultFrame = {
			...classifyRelayFrame(data, binary),
			direction,
			socket: this.id,
			index: this.counts[direction]++,
			byteLength: data.byteLength,
		};
		const action = this.rule(frame) ?? { type: "pass" };
		this.apply(frame, action, { data, binary });
	}

	private apply(
		frame: RelayFaultFrame,
		action: RelayFaultAction,
		message: { data: Buffer; binary: boolean },
	): void {
		switch (action.type) {
			case "drop":
				this.record(frame, "drop", 0);
				return;
			case "duplicate":
				this.record(frame, "duplicate", this.write(frame, message) + this.write(frame, message));
				break;
			case "delay":
				this.hold(frame, message, action.ms);
				return;
			case "reorder":
				this.hold(frame, message);
				return;
			case "truncate": {
				const truncated = { data: message.data.subarray(0, action.keep), binary: message.binary };
				this.record(frame, "truncate", this.write(frame, truncated));
				break;
			}
			case "substitute": {
				const bytes = action.bytes(Buffer.from(message.data));
				const replaced = {
					data: Buffer.from(bytes),
					binary: typeof bytes !== "string",
				};
				this.record(frame, "substitute", this.write(frame, replaced));
				break;
			}
			default:
				this.record(frame, "pass", this.write(frame, message));
		}
		this.releaseReordered(frame.direction);
	}

	private hold(frame: RelayFaultFrame, message: { data: Buffer; binary: boolean }, ms?: number) {
		const entry: Held = { frame, ...message };
		this.held.add(entry);
		if (ms === undefined) {
			this.record(frame, "reorder", 0);
			this.reordered[frame.direction].push(entry);
			return;
		}
		this.record(frame, "delay", 0);
		entry.timer = setTimeout(() => this.release(entry), ms);
	}

	private releaseReordered(direction: RelayFaultDirection): void {
		for (const entry of this.reordered[direction].splice(0)) this.release(entry);
	}

	private release(entry: Held): void {
		if (!this.held.delete(entry)) return;
		this.record(entry.frame, "release", this.write(entry.frame, entry));
	}

	private write(frame: RelayFaultFrame, message: { data: Buffer; binary: boolean }): number {
		const target = frame.direction === "toRelay" ? this.upstream : this.peer;
		if (target.readyState !== WebSocket.OPEN) return 0;
		target.send(message.data, { binary: message.binary, compress: false });
		return message.data.byteLength;
	}

	private record(
		frame: RelayFaultFrame,
		action: RelayFaultEvent["action"],
		forwardedBytes: number,
	) {
		this.log.push({ ...frame, action, forwardedBytes });
	}
}

/** Starts a loopback proxy. Each accepted socket gets its own upstream socket to the runtime. */
export async function createRelayFaultProxy(
	options: RelayFaultProxyOptions,
): Promise<RelayFaultProxy> {
	const rule = options.rule ?? (() => undefined);
	const events: RelayFaultEvent[] = [];
	const sockets = new Set<ProxiedSocket>();
	const server = new WebSocketServer({
		host: "127.0.0.1",
		port: 0,
		perMessageDeflate: false,
		autoPong: false,
		maxPayload: MAX_MESSAGE_BYTES,
	});
	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	server.on("connection", (peer, request) => {
		const upstream = new WebSocket(new URL(request.url ?? "/", options.upstreamUrl), {
			perMessageDeflate: false,
			autoPong: false,
			followRedirects: false,
			maxPayload: MAX_MESSAGE_BYTES,
		});
		const proxied = new ProxiedSocket(sockets.size, peer, upstream, rule, events);
		sockets.add(proxied);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing loopback listener");
	return {
		host: `127.0.0.1:${address.port}`,
		events,
		held: () => [...sockets].reduce((total, socket) => total + socket.heldCount(), 0),
		async close() {
			for (const socket of sockets) socket.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
