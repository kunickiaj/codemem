import {
	TRAVERSAL_NONCE_SQL,
	TRAVERSAL_STATE_SQL,
} from "./peer-traversal-coordinator-write-sql.js";
import {
	decodeTraversalSignalPacket,
	encodeTraversalSignalBody,
	encodeTraversalSignalPacket,
} from "./peer-traversal-signal-codec.js";
import type { VerifiedTraversalSignalProof } from "./peer-traversal-signal-proof.js";
import {
	type RelayAdmissionNonceAssociation,
	type RelayAdmissionNonceReceipt,
	readRelayAdmissionNonceReceipt,
} from "./relay-admission-clock.js";
import {
	type CapturedRelayAdmissionParticipants,
	captureRelayAdmissionParticipants,
} from "./relay-admission-participant-nonce.js";
import {
	type RelayAdmissionReadinessStamp,
	readRelayAdmissionReadinessStamp,
} from "./relay-admission-readiness.js";

export interface TraversalSignalWriteOptions {
	readonly proof: VerifiedTraversalSignalProof;
	readonly participants: CapturedRelayAdmissionParticipants;
	readonly namespace: { readonly authorityId: string; readonly groupId: string };
	readonly policyRevision: number;
	readonly execId: string;
}

export interface TraversalSignalWriteStatement {
	readonly sql: string;
	readonly bindings: readonly (string | number | null)[];
	readonly association: RelayAdmissionNonceAssociation;
	readonly expected: {
		readonly sessionId: string;
		readonly packetDigest: string;
		readonly phase: 1;
		readonly policyRevision: number;
	};
}

function capturePacket(proof: VerifiedTraversalSignalProof) {
	const { value, bodyBytes, signatureBytes, timestamp, nonce } = proof;
	if (value.phase !== "prepare") return null;
	const encoded = encodeTraversalSignalBody({ ...value });
	if (!(bodyBytes instanceof Uint8Array) || !(signatureBytes instanceof Uint8Array)) return null;
	const ownedBody = new Uint8Array(bodyBytes);
	const ownedSignature = new Uint8Array(signatureBytes);
	if (encoded.length !== ownedBody.length || !encoded.every((byte, i) => byte === ownedBody[i]))
		return null;
	return decodeTraversalSignalPacket(
		encodeTraversalSignalPacket({
			bodyBytes: ownedBody,
			signatureBytes: ownedSignature,
			timestamp,
			nonce,
		}),
	);
}

function captureInputs(options: TraversalSignalWriteOptions) {
	const { proof, participants, namespace, policyRevision, execId } = options;
	const { authorityId, groupId } = namespace;
	const { packetDigest, signer } = proof;
	const decoded = capturePacket(proof);
	if (!decoded) return null;
	const { deviceId: signerDevice, publicKey: signerPublicKey, keyId: signerKeyId } = signer;
	const { source, target } = participants;
	if (
		!Object.isFrozen(participants) ||
		!Object.isFrozen(source) ||
		!target ||
		!Object.isFrozen(target)
	)
		return null;
	const sourceTuple = Object.freeze({ ...source });
	const targetTuple = Object.freeze({ ...target });
	if (
		!Number.isSafeInteger(policyRevision) ||
		policyRevision <= 0 ||
		typeof execId !== "string" ||
		execId.length !== 32 ||
		!/^[0-9a-f]{32}$/.test(execId)
	)
		return null;
	const body = decoded.value;
	if (
		body.authorityId !== authorityId ||
		body.groupId !== groupId ||
		sourceTuple.group_id !== groupId ||
		targetTuple.group_id !== groupId ||
		sourceTuple.device_id !== body.sourceDeviceId ||
		targetTuple.device_id !== body.targetDeviceId ||
		sourceTuple.keyId !== body.sourceKeyId ||
		targetTuple.keyId !== body.targetKeyId ||
		signerDevice !== body.sourceDeviceId ||
		signerKeyId !== sourceTuple.keyId ||
		signerPublicKey !== sourceTuple.public_key
	)
		return null;
	return {
		decoded,
		packetDigest,
		sourceTuple,
		targetTuple,
		authorityId,
		groupId,
		policyRevision,
		execId,
	};
}

async function captureValidatedInputs(options: TraversalSignalWriteOptions) {
	const captured = captureInputs(options);
	if (!captured) return null;
	const { decoded, sourceTuple, targetTuple, groupId, packetDigest } = captured;
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new Uint8Array(decoded.bodyBytes),
	);
	const actualDigest = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	if (actualDigest !== packetDigest) return null;
	const participants = await captureRelayAdmissionParticipants([sourceTuple, targetTuple], {
		groupId,
		sourceDeviceId: decoded.value.sourceDeviceId,
		targetDeviceId: decoded.value.targetDeviceId,
	});
	if (
		!participants ||
		participants.source.keyId !== sourceTuple.keyId ||
		participants.target?.keyId !== targetTuple.keyId
	)
		return null;
	return { ...captured, participants };
}

async function buildStatement(
	options: TraversalSignalWriteOptions,
	kind: "nonce" | "state",
): Promise<TraversalSignalWriteStatement | null> {
	try {
		const captured = await captureValidatedInputs(options);
		if (!captured) return null;
		const { decoded, participants, authorityId, groupId, policyRevision, execId, packetDigest } =
			captured;
		const body = decoded.value;
		const bindings: (string | number | null)[] = [
			body.sourceDeviceId,
			decoded.nonce,
			execId,
			body.admitBefore * 1000,
			authorityId,
			groupId,
			body.sessionId,
			policyRevision,
			JSON.stringify(participants.source),
			JSON.stringify(participants.target),
			body.createdAt * 1000,
			body.attemptNotAfter * 1000,
		];
		if (kind === "state") bindings.push(body.messageADigest, packetDigest);
		return Object.freeze({
			sql: kind === "nonce" ? TRAVERSAL_NONCE_SQL : TRAVERSAL_STATE_SQL,
			bindings: Object.freeze(bindings),
			association: Object.freeze({
				deviceId: body.sourceDeviceId,
				nonce: decoded.nonce,
				attemptId: execId,
			}),
			expected: Object.freeze({
				sessionId: body.sessionId,
				packetDigest,
				phase: 1 as const,
				policyRevision,
			}),
		});
	} catch {
		return null;
	}
}

/** Private PREPARE compiler only. It executes nothing and authenticates no cast proof.
 * The caller owns provenance, signature checks, budgets and both execution receipts. */
export async function buildTraversalNonceStatement(
	options: TraversalSignalWriteOptions,
): Promise<TraversalSignalWriteStatement | null> {
	return buildStatement(options, "nonce");
}

/** Independent state write. The future orchestrator must first own the nonce receipt. */
export async function buildTraversalStateStatement(
	options: TraversalSignalWriteOptions,
): Promise<TraversalSignalWriteStatement | null> {
	return buildStatement(options, "state");
}

/** Shape parser for the same INSERT RETURNING only. A stored row alone grants nothing. */
export function readTraversalStateReceipt(
	row: unknown,
	statement: TraversalSignalWriteStatement,
): {
	receipt: RelayAdmissionNonceReceipt;
	readiness: RelayAdmissionReadinessStamp;
	updatedAtMs: number;
} | null {
	try {
		if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
		const {
			deviceId,
			nonce,
			attemptId,
			decidedAtMs,
			createdAt,
			readinessRevision,
			readinessObservedAtMs,
			policyRevision,
			sessionId,
			packetDigest,
			phase,
			updatedAtMs,
		} = row as Record<string, unknown>;
		const snapshot = {
			deviceId,
			nonce,
			attemptId,
			decidedAtMs,
			createdAt,
			readinessRevision,
			readinessObservedAtMs,
			policyRevision,
		};
		const expected = statement.expected;
		const receipt = readRelayAdmissionNonceReceipt(snapshot, statement.association);
		if (
			!receipt ||
			sessionId !== expected.sessionId ||
			packetDigest !== expected.packetDigest ||
			phase !== 1 ||
			phase !== expected.phase ||
			policyRevision !== expected.policyRevision ||
			updatedAtMs !== receipt.decidedAtMs
		)
			return null;
		const readiness = readRelayAdmissionReadinessStamp(snapshot, receipt);
		return readiness ? { receipt, readiness, updatedAtMs: receipt.decidedAtMs } : null;
	} catch {
		return null;
	}
}
