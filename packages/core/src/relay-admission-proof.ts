import {
	type DecodedRelayCheck,
	decodeRelayCheckPacket,
	type RelayAdmissionRole,
} from "./relay-admission-codec.js";
import { parseRelayEd25519PublicKey } from "./relay-ed25519.js";

export interface RelayProofSigner {
	readonly deviceId: string;
	readonly publicKey: string;
}

export type RelayProofExpectation =
	| { readonly kind: "admission"; readonly role: RelayAdmissionRole }
	| { readonly kind: "registration" };

export interface RelayProofVerificationOptions {
	readonly packet: unknown;
	readonly expected: RelayProofExpectation;
	readonly signer: RelayProofSigner;
	readonly deviceHeader: string;
	readonly externalPathname: string;
}

export type VerifiedRelayCheckProof = DecodedRelayCheck & {
	readonly signer: RelayProofSigner & { readonly keyId: string };
	readonly packetDigest: string;
};

function captureExpectation(value: unknown): RelayProofExpectation | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const keys = Reflect.ownKeys(value);
	if (!keys.includes("kind") || !("kind" in value)) return null;
	const kind = value.kind;
	if (kind === "registration" && keys.length === 1) return { kind };
	if (kind !== "admission" || keys.length !== 2 || !keys.includes("role") || !("role" in value)) {
		return null;
	}
	const role = value.role;
	if (role !== "source" && role !== "relay" && role !== "responder") return null;
	return { kind, role };
}

function hasInvalidPathCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return (
			code <= 32 ||
			(code >= 127 && code <= 159) ||
			(code >= 0xd800 && code <= 0xdfff) ||
			"?#\\".includes(character)
		);
	});
}

function isAdmissionPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.startsWith("/") &&
		!value.startsWith("//") &&
		!hasInvalidPathCharacter(value) &&
		value.endsWith("/v1/relay/admission-check")
	);
}

function matchesExpectation(decoded: DecodedRelayCheck, expected: RelayProofExpectation): boolean {
	if (decoded.kind === "registration") return expected.kind === "registration";
	return expected.kind === "admission" && decoded.value.role === expected.role;
}

function captureProofInputs(options: RelayProofVerificationOptions) {
	const { packet, expected, signer, deviceHeader, externalPathname } = options;
	const expectation = captureExpectation(expected);
	const { deviceId, publicKey } = signer;
	if (
		!expectation ||
		typeof deviceId !== "string" ||
		typeof publicKey !== "string" ||
		typeof deviceHeader !== "string" ||
		!isAdmissionPath(externalPathname)
	) {
		return null;
	}
	const decoded = decodeRelayCheckPacket(packet);
	if (!matchesExpectation(decoded, expectation)) return null;
	let signedDeviceId: string;
	let signedKeyId: string;
	if (decoded.kind === "admission") {
		signedDeviceId = decoded.value.sourceDeviceId;
		signedKeyId = decoded.value.sourceKeyId;
	} else {
		signedDeviceId = decoded.value.deviceId;
		signedKeyId = decoded.value.keyId;
	}
	if (deviceHeader !== signedDeviceId || deviceId !== signedDeviceId) return null;
	return {
		decoded,
		signer: { deviceId, publicKey },
		signedKeyId,
		externalPathname,
		key: parseRelayEd25519PublicKey(publicKey),
	};
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Verifies one packet against an explicitly trusted existing key pin, without consuming its nonce.
 * A proof is not fresh or authorized. The caller must still check current authority, enrollments,
 * policy, readiness, quotas, time windows, and nonce insertion in its final atomic decision.
 */
export async function verifyRelayCheckProof(
	options: RelayProofVerificationOptions,
): Promise<VerifiedRelayCheckProof | null> {
	try {
		// Capture caller-owned data and decode owned bytes before any asynchronous operation.
		const captured = captureProofInputs(options);
		if (!captured) return null;
		const { decoded, signer, signedKeyId, externalPathname, key } = captured;
		const keyId = await sha256Hex(key.wireKey);
		if (keyId !== signedKeyId) return null;
		const packetDigest = await sha256Hex(decoded.bodyBytes);
		const canonical = [
			"POST",
			externalPathname,
			decoded.timestamp,
			decoded.nonce,
			packetDigest,
		].join("\n");
		const verificationKey = await globalThis.crypto.subtle.importKey(
			"raw",
			new Uint8Array(key.rawKey),
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		const verified = await globalThis.crypto.subtle.verify(
			"Ed25519",
			verificationKey,
			new Uint8Array(decoded.signatureBytes),
			new TextEncoder().encode(canonical),
		);
		if (!verified) return null;
		return { ...decoded, signer: { ...signer, keyId }, packetDigest };
	} catch {
		return null;
	}
}
