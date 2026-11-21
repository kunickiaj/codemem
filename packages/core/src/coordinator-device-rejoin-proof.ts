import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { verifyOwnerEnrollmentSignature } from "./coordinator-owner-enrollment-proof.js";

interface DeviceRejoinProofSubject {
	origin: string;
	attemptId: string;
	deviceId: string;
	keyId: string;
}

export type DeviceRejoinProof = DeviceRejoinProofSubject &
	(
		| {
				operation: "start";
				publicKey: string;
				browserStartHash: string;
				loopbackRedirect: string;
				timestampMs: number;
		  }
		| { operation: "status"; timestampMs: number }
		| {
				operation: "finalize";
				coordinatorId: string;
				authConfigRevision: string;
				publicKey: string;
				fingerprint: string;
				issuer: string;
				identityId: string;
				bindingId: string;
				removalDigest: string;
				confirmation: string;
				completion: string;
		  }
	);

/** The exact JSON message for the device to sign, with a distinct purpose per operation. */
export function deviceRejoinProofMessage(proof: DeviceRejoinProof): string {
	const { origin, attemptId, deviceId, keyId } = proof;
	switch (proof.operation) {
		case "start":
			return JSON.stringify([
				"codemem-device-rejoin-start-v1",
				origin,
				attemptId,
				deviceId,
				proof.publicKey,
				keyId,
				proof.browserStartHash,
				proof.loopbackRedirect,
				proof.timestampMs,
			]);
		case "status":
			return JSON.stringify([
				"codemem-device-rejoin-status-v1",
				origin,
				attemptId,
				deviceId,
				keyId,
				proof.timestampMs,
			]);
		case "finalize":
			return JSON.stringify([
				"codemem-device-rejoin-finalize-v1",
				proof.coordinatorId,
				origin,
				proof.authConfigRevision,
				attemptId,
				deviceId,
				proof.publicKey,
				keyId,
				proof.fingerprint,
				proof.issuer,
				proof.identityId,
				proof.bindingId,
				proof.removalDigest,
				proof.confirmation,
				proof.completion,
			]);
	}
}

/**
 * Verifies key possession only. The caller selects the operation, validates
 * input and freshness, and supplies the trusted origin, stored tombstone key,
 * and any pinned attempt values. Current authority is checked separately.
 */
export async function verifyDeviceRejoinProof(
	proof: DeviceRejoinProof,
	input: { tombstonePublicKey: string; signature: string },
): Promise<boolean> {
	// Capture the fields used for both checks before asynchronous key hashing.
	const { tombstonePublicKey, signature } = input;
	const { keyId } = proof;
	const signedPublicKey = proof.operation === "status" ? tombstonePublicKey : proof.publicKey;
	const message = deviceRejoinProofMessage(proof);
	const storedKeyId = await ed25519KeyId(tombstonePublicKey);
	if (storedKeyId === null || storedKeyId !== keyId) return false;
	if (signedPublicKey !== tombstonePublicKey && (await ed25519KeyId(signedPublicKey)) !== keyId)
		return false;
	return verifyOwnerEnrollmentSignature(tombstonePublicKey, message, signature);
}
