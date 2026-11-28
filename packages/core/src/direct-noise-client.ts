import { createPrivateKey, randomBytes } from "node:crypto";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { duplexPair } from "node:stream";
import { finished } from "node:stream/promises";
import type { Database } from "./db.js";
import {
	DIRECT_NOISE_LOGICAL_ORIGIN,
	DIRECT_NOISE_TRANSPORT_LABEL,
	DIRECT_NOISE_UPGRADE_PROTOCOL,
	directNoiseUpgradeTarget,
} from "./direct-noise-upgrade.js";
import type { OwnedPeerHttpConnection, PeerHttpConnectionFactory } from "./peer-http-client.js";
import { prepareRelayNoiseInitiator } from "./relay-noise.js";
import { buildDirectPeerAuthHeaders } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { loadPrivateKey } from "./sync-identity.js";

/** The peer did not switch to Noise: a non-101 answer, or no answer before the switch. */
export class DirectNoiseNotOffered extends Error {
	constructor(readonly detail: string) {
		super(`peer did not accept an encrypted connection (${detail})`);
		this.name = "DirectNoiseNotOffered";
	}
}

/**
 * The listener is at a cap right now: 503 for its handshake or stream caps,
 * 429 for its per-address request limit, or "closed" when it closed the
 * connection before sending any byte, which is how its socket caps refuse.
 * Retry later. This never means the peer lacks Noise.
 */
export class DirectNoiseBusy extends Error {
	constructor(
		readonly status: 429 | 503 | "closed",
		/** The listener's Retry-After, in seconds, when it sent one. */
		readonly retryAfterS: number | undefined,
	) {
		super(`peer is busy (${status})`);
		this.name = "DirectNoiseBusy";
	}
}

const MAX_RESPONSE_HEAD_BYTES = 16 * 1024;

/** A non-101 answer to the upgrade: busy for 429 and 503, otherwise not offered. */
function refusedSwitch(head: string, status: string | undefined): Error {
	if (status !== "429" && status !== "503")
		return new DirectNoiseNotOffered(`status ${status ?? "none"}`);
	const retryAfter = /\r\nretry-after:[ \t]*(\d{1,4})[ \t]*\r\n/i.exec(head)?.[1];
	return new DirectNoiseBusy(
		status === "429" ? 429 : 503,
		retryAfter ? Number(retryAfter) : undefined,
	);
}

export interface DirectNoiseEndpoint {
	readonly db: Database;
	readonly host: string;
	readonly port: number;
	readonly localDeviceId: string;
	readonly peerDeviceId: string;
	readonly keysDir?: string;
	readonly dbPath?: string;
	/** The key the handshake must prove. It must still be the current pin when dialing. */
	readonly expectedPin: string;
}

function localIdentity(endpoint: DirectNoiseEndpoint) {
	const row = endpoint.db.prepare("SELECT device_id, public_key FROM sync_device LIMIT 1").get() as
		| { device_id: string; public_key: string }
		| undefined;
	if (!row || row.device_id !== endpoint.localDeviceId) throw new Error("device identity changed");
	const bytes = loadPrivateKey(endpoint.keysDir, endpoint.dbPath, row.device_id);
	if (!bytes) throw new Error("private key missing");
	return { key: createPrivateKey(bytes), expectedPin: row.public_key.trim() };
}

/** The peer's key as pinned now, only while it matches the pinned fingerprint. */
export function currentPeerPin(db: Database, peerDeviceId: string): string | null {
	const row = db
		.prepare("SELECT public_key, pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?")
		.get(peerDeviceId) as
		| { public_key: string | null; pinned_fingerprint: string | null }
		| undefined;
	const publicKey = row?.public_key?.trim();
	if (!publicKey || fingerprintPublicKey(publicKey) !== row?.pinned_fingerprint) return null;
	return publicKey;
}

function connect(endpoint: DirectNoiseEndpoint, signal: AbortSignal): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: endpoint.host, port: endpoint.port });
		const fail = (error: Error) => {
			socket.destroy();
			reject(new DirectNoiseNotOffered(`connect: ${error.message}`));
		};
		socket.once("connect", () => {
			socket.off("error", fail);
			resolve(socket);
		});
		socket.once("error", fail);
		signal.addEventListener("abort", () => fail(new Error("cancelled")), { once: true });
	});
}

/** Reads the response head. Anything sent after it would be Noise before Message A. */
function readSwitch(socket: net.Socket, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		let buffered = Buffer.alloc(0);
		const done = (error?: Error) => {
			socket.off("data", onData);
			socket.off("close", onClose);
			signal.removeEventListener("abort", onAbort);
			socket.pause();
			if (error) reject(error);
			else resolve();
		};
		const onData = (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			const end = buffered.indexOf("\r\n\r\n");
			if (end < 0) {
				if (buffered.byteLength > MAX_RESPONSE_HEAD_BYTES) done(new DirectNoiseNotOffered("head"));
				return;
			}
			const head = buffered.subarray(0, end + 4).toString("latin1");
			const status = /^HTTP\/1\.1 (\d{3}) /.exec(head)?.[1];
			if (status !== "101") return done(refusedSwitch(head, status));
			if (buffered.byteLength !== end + 4) return done(new Error("data after the protocol switch"));
			done();
		};
		// A listener without Noise answers the upgrade with a status. Closing with no
		// answer at all is how the socket caps refuse, so it is busy, never a downgrade.
		const onClose = () =>
			done(
				buffered.byteLength === 0
					? new DirectNoiseBusy("closed", undefined)
					: new DirectNoiseNotOffered("closed"),
			);
		// A listener that never answers must not hold the socket past the exchange's deadline.
		const onAbort = () => done(new Error("Direct Noise upgrade got no answer in time"));
		if (signal.aborted) return onAbort();
		socket.on("data", onData);
		socket.once("close", onClose);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function upgradeRequest(endpoint: DirectNoiseEndpoint, target: string): string {
	const headers = buildDirectPeerAuthHeaders({
		deviceId: endpoint.localDeviceId,
		recipientId: endpoint.peerDeviceId,
		method: "GET",
		url: `${DIRECT_NOISE_LOGICAL_ORIGIN}${target}`,
		bodyBytes: Buffer.alloc(0),
		keysDir: endpoint.keysDir,
		dbPath: endpoint.dbPath,
	});
	const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
	return `GET ${target} HTTP/1.1\r\nHost: ${endpoint.host}\r\nConnection: Upgrade\r\nUpgrade: ${DIRECT_NOISE_UPGRADE_PROTOCOL}\r\n${lines.join("")}\r\n`;
}

/**
 * Opens one Noise stream to a peer's sync listener. Message A is prepared
 * first so its digest can be signed into the upgrade target, and it is sent
 * only after the peer answers 101. The peer must prove the expected pin, and
 * that pin must be current both before dialing and after the handshake.
 */
async function openStream(
	endpoint: DirectNoiseEndpoint,
	options: { signal: AbortSignal; deadlineMs: number },
): Promise<OwnedPeerHttpConnection & { pin: string }> {
	const pin = endpoint.expectedPin;
	if (currentPeerPin(endpoint.db, endpoint.peerDeviceId) !== pin)
		throw new Error("peer key changed before dialing");
	const sessionId = randomBytes(16);
	const [client, wire] = duplexPair();
	const prepared = prepareRelayNoiseInitiator({
		transport: client,
		localIdentity: localIdentity(endpoint),
		expectedRemotePin: pin,
		context: { transportLabel: DIRECT_NOISE_TRANSPORT_LABEL, sessionId },
		signal: options.signal,
		deadlineMs: options.deadlineMs,
	});
	let socket: net.Socket | undefined;
	try {
		const { digest } = await prepared.opening;
		socket = await connect(endpoint, options.signal);
		socket.on("error", () => {});
		socket.write(upgradeRequest(endpoint, directNoiseUpgradeTarget(sessionId, digest)));
		await readSwitch(socket, options.signal);
		wire.pipe(socket);
		socket.pipe(wire);
		socket.resume();
		prepared.release(performance.now());
		const secured = await prepared.authenticated;
		// A re-pin during the handshake means this stream proved a key the store no longer trusts.
		if (currentPeerPin(endpoint.db, endpoint.peerDeviceId) !== pin) {
			secured.duplex.destroy();
			throw new Error("peer key changed during the handshake");
		}
		const raw = socket;
		const completion = Promise.all([finished(secured.duplex), finished(raw)]).then(() => {});
		void completion.catch(() => {});
		return {
			pin,
			duplex: secured.duplex,
			completion,
			async dispose(error) {
				secured.duplex.destroy(error);
				raw.destroy(error);
				await completion.catch(() => {});
			},
		};
	} catch (error) {
		prepared.cancel();
		socket?.destroy();
		throw error;
	}
}

/**
 * A connection factory for one peer address. It remembers why the last open
 * failed, because the HTTP executor reports every transport failure the same way.
 */
export function directNoiseConnectionFactory(
	endpoint: DirectNoiseEndpoint,
): PeerHttpConnectionFactory & {
	lastFailure(): Error | undefined;
	/** The pin the last opened stream authenticated, checked again just before inner traffic. */
	authenticatedPin(): string | null;
} {
	let failure: Error | undefined;
	let pin: string | null = null;
	return {
		async open(options) {
			try {
				failure = undefined;
				const stream = await openStream(endpoint, options);
				pin = stream.pin;
				return stream;
			} catch (error) {
				failure = error instanceof Error ? error : new Error("Direct Noise open failed");
				throw failure;
			}
		},
		lastFailure: () => failure,
		authenticatedPin: () => pin,
	};
}
