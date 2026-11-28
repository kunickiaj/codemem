import { createPrivateKey, randomBytes } from "node:crypto";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { duplexPair } from "node:stream";
import { finished } from "node:stream/promises";
import type { Database } from "./db.js";
import { DirectNoiseRejected, SwitchReader, type SwitchReading } from "./direct-noise-switch.js";
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

export {
	DirectNoiseBusy,
	DirectNoiseNotOffered,
	DirectNoiseRejected,
} from "./direct-noise-switch.js";

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
			// No reply at all is not a 404, so it never leads to plaintext.
			reject(new DirectNoiseRejected(`connect: ${error.message}`));
		};
		socket.once("connect", () => {
			socket.off("error", fail);
			resolve(socket);
		});
		socket.once("error", fail);
		signal.addEventListener("abort", () => fail(new Error("cancelled")), { once: true });
	});
}

/**
 * Reads the listener's answer until it switches or refuses. A 404 counts as
 * "no Noise" only once it is complete, so the reply is read to its end.
 */
function readSwitch(socket: net.Socket, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const reader = new SwitchReader();
		const finish = (error?: Error) => {
			socket.off("data", onData);
			socket.off("close", onClose);
			signal.removeEventListener("abort", onAbort);
			socket.pause();
			if (error) reject(error);
			else resolve();
		};
		const settle = (reading: SwitchReading) => {
			if (reading.kind === "pending") return;
			finish(reading.kind === "switched" ? undefined : reading.error);
		};
		const onData = (chunk: Buffer) => settle(reader.push(chunk));
		const onClose = () => settle(reader.close());
		// A listener that never answers must not hold the socket past the exchange's deadline.
		const onAbort = () => finish(new Error("Direct Noise upgrade got no answer in time"));
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
