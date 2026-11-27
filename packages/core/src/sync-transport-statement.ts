import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { parseRelayEd25519PublicKey } from "./relay-ed25519.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

/**
 * A device's own signed list of the transports it speaks. It rides inside
 * coordinator presence capabilities, which the coordinator stores and returns
 * verbatim. A peer verifies it against the key it already pinned, so a
 * coordinator can withhold a statement but cannot forge or alter one.
 */
export const TRANSPORT_STATEMENT_CAPABILITY = "transport_statement";

const DOMAIN = Buffer.from("codemem-transport-statement/1\0", "ascii");
const MAX_PAYLOAD_BYTES = 1024;
const MAX_FEATURES = 16;
const FEATURE_PATTERN = /^[a-z0-9_]{1,64}$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface SignedTransportStatement {
	readonly payload: string;
	readonly signature: string;
}

export interface TransportStatementContent {
	readonly deviceId: string;
	readonly fingerprint: string;
	readonly features: readonly string[];
	readonly issuedAt: string;
}

function canonicalPayload(content: TransportStatementContent): string {
	return JSON.stringify({
		v: 1,
		device_id: content.deviceId,
		fingerprint: content.fingerprint,
		features: content.features,
		issued_at: content.issuedAt,
	});
}

function normalizedFeatures(features: readonly string[]): string[] {
	return [...new Set(features)].sort();
}

function signedBytes(payload: string): Buffer {
	return Buffer.concat([DOMAIN, Buffer.from(payload, "utf8")]);
}

function privateKeyObject(key: KeyObject | Buffer): KeyObject {
	if (!Buffer.isBuffer(key)) return key;
	try {
		return createPrivateKey(key);
	} catch {
		return createPrivateKey({ key, format: "pem", type: "pkcs8" });
	}
}

/** Sign this device's statement. The key must match the fingerprint's public key. */
export function createTransportStatement(
	content: TransportStatementContent,
	privateKey: KeyObject | Buffer,
): SignedTransportStatement {
	const features = normalizedFeatures(content.features);
	if (features.length > MAX_FEATURES || !features.every((f) => FEATURE_PATTERN.test(f)))
		throw new Error("invalid transport statement features");
	if (!content.deviceId.trim() || !content.fingerprint.trim())
		throw new Error("transport statement identity required");
	if (!Number.isFinite(Date.parse(content.issuedAt)))
		throw new Error("invalid transport statement time");
	const payload = canonicalPayload({ ...content, features });
	if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES)
		throw new Error("transport statement too large");
	const signature = sign(null, signedBytes(payload), privateKeyObject(privateKey));
	return { payload, signature: signature.toString("base64") };
}

function publicKeyObject(publicKey: string): KeyObject {
	const { rawKey } = parseRelayEd25519PublicKey(publicKey.trim());
	return createPublicKey({
		key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
		format: "der",
		type: "spki",
	});
}

function decodeSignature(value: string): Buffer | null {
	const bytes = Buffer.from(value, "base64");
	return bytes.length === 64 && bytes.toString("base64") === value ? bytes : null;
}

function parseContent(payload: string): TransportStatementContent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	const { device_id: deviceId, fingerprint, features, issued_at: issuedAt } = record;
	if (
		record.v !== 1 ||
		typeof deviceId !== "string" ||
		typeof fingerprint !== "string" ||
		typeof issuedAt !== "string" ||
		!Number.isFinite(Date.parse(issuedAt)) ||
		!Array.isArray(features) ||
		features.length > MAX_FEATURES ||
		!features.every((f) => typeof f === "string" && FEATURE_PATTERN.test(f))
	)
		return null;
	const content = { deviceId, fingerprint, features: features as string[], issuedAt };
	// Only the exact canonical encoding verifies, so one statement has one byte form.
	const canonical = canonicalPayload({
		...content,
		features: normalizedFeatures(content.features),
	});
	return canonical === payload ? content : null;
}

/**
 * The verified content, or null when the value is not a statement by this
 * device under this pinned key. Null never means "the peer lacks a feature".
 */
export function verifyTransportStatement(
	value: unknown,
	pinned: { readonly deviceId: string; readonly publicKey: string },
): TransportStatementContent | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.length !== 2 || keys[0] !== "payload" || keys[1] !== "signature") return null;
	const { payload, signature } = record;
	if (typeof payload !== "string" || typeof signature !== "string") return null;
	if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) return null;
	const content = parseContent(payload);
	if (!content || content.deviceId !== pinned.deviceId) return null;
	const signatureBytes = decodeSignature(signature);
	if (!signatureBytes) return null;
	try {
		if (content.fingerprint !== fingerprintPublicKey(pinned.publicKey)) return null;
		return verify(null, signedBytes(payload), publicKeyObject(pinned.publicKey), signatureBytes)
			? content
			: null;
	} catch {
		return null;
	}
}
