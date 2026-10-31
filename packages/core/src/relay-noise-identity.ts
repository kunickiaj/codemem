import { createPrivateKey, createPublicKey, KeyObject, timingSafeEqual } from "node:crypto";
import { privateKeyFromRaw, publicKeyFromRaw } from "@libp2p/crypto/keys";
import type { PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { parseRelayEd25519PublicKey } from "./relay-ed25519.js";

export interface RelayNoiseLocalIdentity {
	readonly key: KeyObject | Uint8Array;
	readonly expectedPin: string;
}

/** Imports only caller-owned in-memory material. This module never loads or generates identity keys. */
export function importRelayNoiseIdentity(identity: RelayNoiseLocalIdentity) {
	const expected = parseRelayEd25519PublicKey(identity.expectedPin).rawKey;
	let key: KeyObject;
	if (identity.key instanceof KeyObject) {
		key = identity.key;
	} else if (identity.key instanceof Uint8Array) {
		const encoded = Buffer.from(identity.key);
		try {
			key = createPrivateKey({ key: encoded, format: "der", type: "pkcs8" });
		} finally {
			encoded.fill(0);
		}
	} else {
		throw new Error("Noise identity requires a private KeyObject or PKCS8 bytes");
	}
	if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
		throw new Error("Noise identity must be Ed25519");
	}
	const publicJwk = createPublicKey(key).export({ format: "jwk" });
	const privateJwk = key.export({ format: "jwk" });
	const rawPublic = decodeJwk32(publicJwk.x);
	if (!timingSafeEqual(rawPublic, expected)) throw new Error("Noise local pin mismatch");
	const seed = decodeJwk32(privateJwk.d);
	let rawPrivate: Buffer | undefined;
	try {
		rawPrivate = Buffer.concat([seed, rawPublic]);
		// The pinned public importer copies its input before retaining the key.
		const privateKey = privateKeyFromRaw(rawPrivate);
		if (privateKey.type !== "Ed25519") throw new Error("Noise identity must be Ed25519");
		return { privateKey, peerId: peerIdFromPublicKey(privateKey.publicKey) };
	} finally {
		seed.fill(0);
		rawPrivate?.fill(0);
	}
}

function decodeJwk32(value: string | undefined): Buffer {
	if (typeof value !== "string") throw new Error("Invalid Ed25519 JWK");
	const bytes = Buffer.from(value, "base64url");
	if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
		bytes.fill(0);
		throw new Error("Invalid Ed25519 JWK");
	}
	return bytes;
}

export function relayNoiseExpectedPeer(pin: string) {
	const rawKey = Buffer.from(parseRelayEd25519PublicKey(pin).rawKey);
	const publicKey = publicKeyFromRaw(rawKey);
	if (publicKey.type !== "Ed25519") throw new Error("Noise peer pin must be Ed25519");
	return { rawKey, peerId: peerIdFromPublicKey(publicKey) };
}

export function verifyRelayNoisePeer(observed: PeerId, expectedPin: string): void {
	const expected = relayNoiseExpectedPeer(expectedPin);
	const key = observed.publicKey;
	if (
		!observed.equals(expected.peerId) ||
		key?.type !== "Ed25519" ||
		key.raw.byteLength !== 32 ||
		!timingSafeEqual(key.raw, expected.rawKey)
	) {
		throw new Error("Noise remote pin mismatch");
	}
}

export interface RelayNoiseContext {
	readonly transportLabel: 1 | 2;
	readonly sessionId: Uint8Array;
}

export function relayNoisePrologue(context: RelayNoiseContext): Uint8Array {
	if (
		(context.transportLabel !== 1 && context.transportLabel !== 2) ||
		!(context.sessionId instanceof Uint8Array) ||
		context.sessionId.byteLength !== 16
	) {
		throw new Error("Invalid Noise transport context");
	}
	return Buffer.concat([
		Buffer.from("codemem-peer-stream/1\0", "ascii"),
		Buffer.from([context.transportLabel]),
		Buffer.from(context.sessionId),
	]);
}
