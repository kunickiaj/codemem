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

const MAX_RESPONSE_HEAD_BYTES = 16 * 1024;

export interface DirectNoiseEndpoint {
	readonly db: Database;
	readonly host: string;
	readonly port: number;
	readonly localDeviceId: string;
	readonly peerDeviceId: string;
	readonly keysDir?: string;
	readonly dbPath?: string;
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
function readSwitch(socket: net.Socket): Promise<void> {
	return new Promise((resolve, reject) => {
		let buffered = Buffer.alloc(0);
		const done = (error?: Error) => {
			socket.off("data", onData);
			socket.off("close", onClose);
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
			const status = /^HTTP\/1\.1 (\d{3}) /.exec(buffered.toString("latin1"))?.[1];
			if (status !== "101") return done(new DirectNoiseNotOffered(`status ${status ?? "none"}`));
			if (buffered.byteLength !== end + 4) return done(new Error("data after the protocol switch"));
			done();
		};
		const onClose = () => done(new DirectNoiseNotOffered("closed"));
		socket.on("data", onData);
		socket.once("close", onClose);
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
 * only after the peer answers 101. The peer must prove the pinned key.
 */
async function openStream(
	endpoint: DirectNoiseEndpoint,
	options: { signal: AbortSignal; deadlineMs: number },
): Promise<OwnedPeerHttpConnection> {
	const pin = currentPeerPin(endpoint.db, endpoint.peerDeviceId);
	if (!pin) throw new Error("peer not pinned");
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
		await readSwitch(socket);
		wire.pipe(socket);
		socket.pipe(wire);
		socket.resume();
		prepared.release(performance.now());
		const secured = await prepared.authenticated;
		const raw = socket;
		const completion = Promise.all([finished(secured.duplex), finished(raw)]).then(() => {});
		void completion.catch(() => {});
		return {
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
): PeerHttpConnectionFactory & { lastFailure(): Error | undefined } {
	let failure: Error | undefined;
	return {
		async open(options) {
			try {
				failure = undefined;
				return await openStream(endpoint, options);
			} catch (error) {
				failure = error instanceof Error ? error : new Error("Direct Noise open failed");
				throw failure;
			}
		},
		lastFailure: () => failure,
	};
}
