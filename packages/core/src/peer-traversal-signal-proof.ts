import {
	type DecodedTraversalSignalPacket,
	decodeTraversalSignalPacket,
	TRAVERSAL_SIGNAL_PATH_SUFFIX,
	type TraversalSignalPhase,
} from "./peer-traversal-signal-codec.js";
import { parseRelayEd25519PublicKey } from "./relay-ed25519.js";

export interface TraversalSignalProofSigner {
	readonly deviceId: string;
	readonly publicKey: string;
}

export interface TraversalSignalProofVerificationOptions {
	readonly packet: unknown;
	readonly expectedPhase: TraversalSignalPhase;
	readonly signer: TraversalSignalProofSigner;
	readonly deviceHeader: string;
	readonly externalPathname: string;
}

export type VerifiedTraversalSignalProof = DecodedTraversalSignalPacket & {
	readonly signer: TraversalSignalProofSigner & { readonly keyId: string };
	readonly packetDigest: string;
};

function isPhase(value: unknown): value is TraversalSignalPhase {
	return (
		value === "prepare" ||
		value === "offer" ||
		value === "offer-check" ||
		value === "answer" ||
		value === "answer-check"
	);
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

function isSignalPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.startsWith("/") &&
		!value.startsWith("//") &&
		!hasInvalidPathCharacter(value) &&
		value.endsWith(TRAVERSAL_SIGNAL_PATH_SUFFIX)
	);
}

function captureProofInputs(options: TraversalSignalProofVerificationOptions) {
	const { packet, expectedPhase, signer, deviceHeader, externalPathname } = options;
	const { deviceId, publicKey } = signer;
	if (
		!isPhase(expectedPhase) ||
		typeof deviceId !== "string" ||
		typeof publicKey !== "string" ||
		typeof deviceHeader !== "string" ||
		!isSignalPath(externalPathname)
	)
		return null;
	const decoded = decodeTraversalSignalPacket(packet);
	if (decoded.value.phase !== expectedPhase) return null;
	const source =
		expectedPhase === "prepare" || expectedPhase === "offer" || expectedPhase === "answer-check";
	const signedDeviceId = source ? decoded.value.sourceDeviceId : decoded.value.targetDeviceId;
	const signedKeyId = source ? decoded.value.sourceKeyId : decoded.value.targetKeyId;
	if (deviceId !== signedDeviceId || deviceHeader !== signedDeviceId) return null;
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

/** Verifies one packet against a caller-trusted existing pin. This proof is not fresh or authorized.
 * The caller must separately check authority, the packet chain, time windows and nonce consumption. */
export async function verifyTraversalSignalProof(
	options: TraversalSignalProofVerificationOptions,
): Promise<VerifiedTraversalSignalProof | null> {
	try {
		// Own every caller-provided value and decoded byte sequence before asynchronous hashing.
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
