import { DurableObject } from "cloudflare:workers";
import {
	createRelayCoordinatorClient,
	createRelayServer,
	initializeRelayQuotaSchema,
	type RelayServerLimits,
	type RelayServerSocket,
	relayAudienceId,
	type SqliteRelayQuotaPort,
} from "@codemem/core/internal/relay-host";
import {
	captureRelayEnv,
	importRelayServiceSigner,
	type RelayRealmConfig,
	readRelayConfig,
} from "./relay-config.js";
import {
	createDurableObjectRelayQuota,
	durableObjectRelayQuotaDatabase,
} from "./relay-quota-do.js";
import { RELAY_CLOSE_UNAVAILABLE, RelaySocketAdapter } from "./relay-socket-adapter.js";

const MiB = 1024 * 1024;
/**
 * Limits for one realm object. Workers gives no send completion, no
 * `bufferedAmount` and no input pause, so the adapter cannot apply backpressure.
 * These limits bound what concurrent routes can hand to the runtime: at most
 * `routes` exchanges are open at once, and each forwards at most `routeBytes`
 * of DATA wire bytes in both directions together. They do not bound bytes the
 * runtime still holds for routes that have ended (see concurrentRouteOutboundBound).
 */
export const RELAY_DURABLE_OBJECT_LIMITS: Readonly<RelayServerLimits> = Object.freeze({
	sockets: 128,
	pendingSockets: 16,
	routes: 8,
	deviceRoutes: 4,
	// Engine-held frames: 8 routes x 2 directions x 256 KiB.
	queuedBytes: 4 * MiB,
	deviceQueuedBytes: 2 * MiB,
	coordinatorTimeoutMs: 10_000,
	quotaTimeoutMs: 3000,
	routeBytes: 2 * MiB,
});
/** Engine caps per exchange that the bound below relies on. */
const ROUTE_FRAMES = 2048;
const FRAME_HEADER_BYTES = 14;
/** OPEN, ACCEPTED or REJECTED, and CLOSE messages for one route, each under 4 KiB. */
const ROUTE_CONTROL_BYTES = 8 * 4096;
/** SERVICE_PROOF, SOCKET_CHALLENGE and REGISTERED for one socket. */
const SOCKET_SETUP_BYTES = 4 * 4096;
/**
 * Cloudflare documents a 128 MB isolate memory limit that objects of one class may
 * share. This uses the smaller decimal reading, 128,000,000 bytes.
 */
export const RELAY_ISOLATE_MEMORY_BYTES = 128_000_000;
/** A quarter of the isolate limit. */
export const RELAY_OUTBOUND_BUDGET_BYTES = RELAY_ISOLATE_MEMORY_BYTES / 4;

/**
 * Worst case bytes handed to the runtime and not yet read for the routes and
 * setup exchanges that can be open at the same time, plus the engine's own queue.
 *
 * This covers concurrent routes only. Bytes the runtime still holds for routes
 * that have already ended, for example for a reader that stays stalled across
 * many later routes, are limited only by the traffic quota rate. That gap is the
 * agreed activation gate in the relay operations contract.
 */
export function concurrentRouteOutboundBound(limits: Readonly<RelayServerLimits>): number {
	const perRoute = limits.routeBytes + ROUTE_FRAMES * FRAME_HEADER_BYTES + ROUTE_CONTROL_BYTES;
	return limits.routes * perRoute + limits.sockets * SOCKET_SETUP_BYTES + limits.queuedBytes;
}
if (concurrentRouteOutboundBound(RELAY_DURABLE_OBJECT_LIMITS) > RELAY_OUTBOUND_BUDGET_BYTES)
	throw new Error("Relay Durable Object limits exceed the outbound memory budget");

const RELAY_PATH = /^\/v1\/relay\/([0-9a-f]{64})$/;

interface RealmHost {
	readonly realmId: string;
	readonly engine: ReturnType<typeof createRelayServer>;
	readonly quota: SqliteRelayQuotaPort;
	readonly sockets: Map<WebSocket, RelaySocketAdapter>;
}

function status(code: number): Response {
	return new Response(null, { status: code });
}

/** The close code sent back to a peer: its own code when that is valid to send, else 1000. */
export function replyCode(code: number): number {
	if (code >= 3000 && code <= 4999) return code;
	return [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011].includes(code) ? code : 1000;
}

function closeQuietly(webSocket: WebSocket, code: number): void {
	try {
		webSocket.serializeAttachment(null);
	} catch {
		/* Nothing stored. */
	}
	try {
		webSocket.close(code, "relay unavailable");
	} catch {
		/* Already closing. */
	}
}

function isUpgrade(request: Request): boolean {
	return request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * One relay realm, reached at /v1/relay/<realmId>. Registered sockets hibernate:
 * no timer or keepalive runs for them. Pending setups and live routes arm engine
 * timers of at most 60 s, which keep the object resident only until they end.
 *
 * The UTC clock is the Cloudflare host clock (`Date.now()`), treated as a verified
 * UTC source within the 5 s that registration restore assumes. `performance.now()`
 * supplies the monotonic clock and restarts after eviction, which restore handles.
 */
export class RelayRealm extends DurableObject<Record<string, never>> {
	private readonly config: RelayRealmConfig | null;
	private host: Promise<RealmHost | null> | null = null;

	constructor(ctx: DurableObjectState, env: Readonly<Record<string, unknown>>) {
		// The base class keeps no env. Only the allowlisted snapshot survives this call.
		super(ctx, {});
		this.config = readRelayConfig(captureRelayEnv(env));
	}

	override async fetch(request: Request): Promise<Response> {
		if (!this.config) {
			this.closeAll();
			return status(503);
		}
		const realmId = RELAY_PATH.exec(new URL(request.url).pathname)?.[1];
		if (!realmId || !this.config.realms.has(realmId)) return status(404);
		if (!isUpgrade(request)) return status(426);
		const host = await this.ensureHost();
		if (!host) return status(503);
		if (host.realmId !== realmId) return status(404);
		const reserved = await host.quota.reserveUpgrade(new AbortController().signal);
		if (reserved !== "reserved") return status(reserved === "denied" ? 429 : 503);
		return this.accept(host);
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const host = await this.liveHost(ws);
		await host?.sockets.get(ws)?.deliver(message);
	}

	override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		await this.peerGone(ws, replyCode(code));
	}

	override async webSocketError(ws: WebSocket): Promise<void> {
		await this.peerGone(ws, 1011);
	}

	/** Tests narrow these to reach limits within the quota bursts. Never raise them. */
	protected relayLimits(): Readonly<RelayServerLimits> {
		return RELAY_DURABLE_OBJECT_LIMITS;
	}

	private accept(host: RealmHost): Response {
		const { 0: client, 1: server } = new WebSocketPair();
		const adapter = new RelaySocketAdapter(server, () => host.sockets.delete(server));
		const events = host.engine.adopt(adapter);
		if (!events) return status(503);
		adapter.bind(events);
		try {
			this.ctx.acceptWebSocket(server);
		} catch {
			// The socket never opened, so release its pending slot now.
			events.closed();
			return status(503);
		}
		host.sockets.set(server, adapter);
		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * The compatibility date predates automatic close replies, so the object
	 * answers every peer close itself.
	 */
	private async peerGone(ws: WebSocket, code: number): Promise<void> {
		const host = this.config ? await this.ensureHost() : null;
		host?.sockets.get(ws)?.peerClosed();
		closeQuietly(ws, code);
	}

	/** Returns the host for a socket event, closing sockets the relay cannot serve. */
	private async liveHost(ws: WebSocket): Promise<RealmHost | null> {
		if (!this.config) {
			this.closeAll();
			return null;
		}
		const host = await this.ensureHost();
		if (!host?.sockets.has(ws)) {
			closeQuietly(ws, RELAY_CLOSE_UNAVAILABLE);
			return null;
		}
		return host;
	}

	private closeAll(): void {
		for (const ws of this.ctx.getWebSockets()) closeQuietly(ws, RELAY_CLOSE_UNAVAILABLE);
	}

	/** A failed setup, such as unprovisioned quota, is retried on the next event. */
	private async ensureHost(): Promise<RealmHost | null> {
		const pending = this.host ?? this.createHost().catch(() => null);
		this.host = pending;
		const host = await pending;
		if (!host && this.host === pending) this.host = null;
		return host;
	}

	/** Builds the engine on the first event after construction, then restores hibernated sockets. */
	private async createHost(): Promise<RealmHost | null> {
		const config = this.config;
		if (!config) return null;
		const storage = this.ctx.storage;
		initializeRelayQuotaSchema(durableObjectRelayQuotaDatabase(storage));
		// The provisioned quota root pins this object to one realm.
		const row = storage.sql
			.exec("SELECT realm_id FROM relay_quota_root WHERE singleton = 1")
			.toArray()[0];
		const realmId = typeof row?.realm_id === "string" ? row.realm_id : null;
		const groupId = realmId ? config.realms.get(realmId) : undefined;
		const limits = this.relayLimits();
		if (!realmId || !groupId || concurrentRouteOutboundBound(limits) > RELAY_OUTBOUND_BUDGET_BYTES)
			return null;
		const signer = await importRelayServiceSigner(config.serviceKey);
		const sockets = new Map<WebSocket, RelaySocketAdapter>();
		const quota = createDurableObjectRelayQuota({ storage, realmId, enabled: true });
		const engine = createRelayServer({
			namespace: {
				authorityId: config.authorityId,
				groupId,
				relayAudienceId: relayAudienceId(config.audienceOrigin, signer.keyId),
			},
			limits,
			coordinator: createRelayCoordinatorClient({
				url: config.admissionUrl,
				fetcher: config.admission,
			}),
			quota,
			signer,
			clock: { monotonicMs: () => performance.now(), utcMs: () => Date.now() },
			random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
			onRegistration: (socket, snapshot) => adapterOf(socket).storeSnapshot(snapshot),
		});
		const host = { realmId, engine, quota, sockets };
		this.restoreSockets(host);
		return host;
	}

	/** Pending setups, routes and queued frames never survive. Only verified registrations do. */
	private restoreSockets(host: RealmHost): void {
		for (const ws of this.ctx.getWebSockets()) {
			const adapter = new RelaySocketAdapter(ws, () => host.sockets.delete(ws));
			const events = host.engine.restore(adapter, ws.deserializeAttachment());
			if (!events) {
				adapter.close();
				continue;
			}
			adapter.bind(events);
			host.sockets.set(ws, adapter);
		}
	}
}

function adapterOf(socket: RelayServerSocket): RelaySocketAdapter {
	if (!(socket instanceof RelaySocketAdapter)) throw new Error("Unknown relay socket");
	return socket;
}
