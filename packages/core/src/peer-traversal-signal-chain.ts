import type { TraversalSignalPhase } from "./peer-traversal-signal-codec.js";
import {
	type TraversalSignalProofSigner,
	type VerifiedTraversalSignalProof,
	verifyTraversalSignalProof,
} from "./peer-traversal-signal-proof.js";
import { parseRelayEd25519PublicKey } from "./relay-ed25519.js";

export interface TraversalSignalChainExpectation {
	readonly authorityId: string;
	readonly groupId: string;
	readonly source: TraversalSignalProofSigner;
	readonly target: TraversalSignalProofSigner;
	readonly sessionId: string;
	readonly messageADigest: string;
}

export interface TraversalSignalChainVerificationOptions {
	readonly packets: readonly unknown[];
	readonly expectedPhase: TraversalSignalPhase;
	readonly expected: TraversalSignalChainExpectation;
	readonly externalPathname: string;
}

export interface VerifiedTraversalSignalChain {
	readonly proofs: readonly VerifiedTraversalSignalProof[];
	readonly phase: TraversalSignalPhase;
	readonly attemptNotAfter: number;
}

const PHASES = ["prepare", "offer", "offer-check", "answer", "answer-check"] as const;

function phaseAt(index: number): TraversalSignalPhase {
	const phase = PHASES[index];
	if (phase === undefined) throw new Error("Invalid traversal prefix length");
	return phase;
}

function captureInputs(options: TraversalSignalChainVerificationOptions) {
	const { packets, expectedPhase, expected, externalPathname } = options;
	const phaseIndex = PHASES.indexOf(expectedPhase);
	if (phaseIndex < 0 || !Array.isArray(packets) || typeof externalPathname !== "string")
		return null;
	const count = packets.length;
	if (count !== phaseIndex + 1) return null;
	const { authorityId, groupId, source, target, sessionId, messageADigest } = expected;
	const { deviceId: sourceDeviceId, publicKey: sourcePublicKey } = source;
	const { deviceId: targetDeviceId, publicKey: targetPublicKey } = target;
	if (
		typeof authorityId !== "string" ||
		typeof groupId !== "string" ||
		typeof sessionId !== "string" ||
		typeof messageADigest !== "string" ||
		typeof sourceDeviceId !== "string" ||
		typeof sourcePublicKey !== "string" ||
		typeof targetDeviceId !== "string" ||
		typeof targetPublicKey !== "string"
	)
		return null;
	const snapshot: unknown[] = [];
	for (let index = 0; index < count; index++) snapshot.push(packets[index]);
	return {
		packets: snapshot,
		expectedPhase,
		externalPathname,
		expected: {
			authorityId,
			groupId,
			sessionId,
			messageADigest,
			source: { deviceId: sourceDeviceId, publicKey: sourcePublicKey },
			target: { deviceId: targetDeviceId, publicKey: targetPublicKey },
		},
		sourceWireKey: parseRelayEd25519PublicKey(sourcePublicKey).wireKey,
		targetWireKey: parseRelayEd25519PublicKey(targetPublicKey).wireKey,
	};
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function matchesAttempt(
	proof: VerifiedTraversalSignalProof,
	expected: TraversalSignalChainExpectation,
	sourceKeyId: string,
	targetKeyId: string,
	attemptNotAfter: number,
): boolean {
	const value = proof.value;
	return (
		value.authorityId === expected.authorityId &&
		value.groupId === expected.groupId &&
		value.sourceDeviceId === expected.source.deviceId &&
		value.targetDeviceId === expected.target.deviceId &&
		value.sourceKeyId === sourceKeyId &&
		value.targetKeyId === targetKeyId &&
		value.sessionId === expected.sessionId &&
		value.messageADigest === expected.messageADigest &&
		value.attemptNotAfter === attemptNotAfter
	);
}

function matchesLinks(
	proof: VerifiedTraversalSignalProof,
	proofs: readonly VerifiedTraversalSignalProof[],
): boolean {
	const value = proof.value;
	if (value.phase === "prepare") return true;
	if (value.prepareDigest !== proofs[0]?.packetDigest) return false;
	if (value.phase === "offer") return true;
	if (value.offerDigest !== proofs[1]?.packetDigest) return false;
	return value.phase !== "answer-check" || value.answerDigest === proofs[3]?.packetDigest;
}

/** Verifies signed prefix evidence only, without authority, freshness or nonce consumption.
 * The signer ID supplies deviceHeader for portable packets. Actual received HTTP headers
 * require separate validation. This result grants no permission to activate RTC. */
export async function verifyTraversalSignalChain(
	options: TraversalSignalChainVerificationOptions,
): Promise<VerifiedTraversalSignalChain | null> {
	try {
		// Snapshot every caller-owned value before starting asynchronous verification.
		const captured = captureInputs(options);
		if (!captured) return null;
		const pending: Promise<VerifiedTraversalSignalProof | null>[] = [];
		for (let index = 0; index < captured.packets.length; index++) {
			const phase = phaseAt(index);
			const signer =
				index === 2 || index === 3 ? captured.expected.target : captured.expected.source;
			// Each call owns its decoded bytes synchronously before its first await.
			pending.push(
				verifyTraversalSignalProof({
					packet: captured.packets[index],
					expectedPhase: phase,
					signer,
					deviceHeader: signer.deviceId,
					externalPathname: captured.externalPathname,
				}),
			);
		}
		const [sourceKeyId, targetKeyId, results] = await Promise.all([
			sha256Hex(captured.sourceWireKey),
			sha256Hex(captured.targetWireKey),
			Promise.all(pending),
		]);
		const proofs: VerifiedTraversalSignalProof[] = [];
		for (const result of results) {
			if (result === null) return null;
			proofs.push(result);
		}
		const prepare = proofs[0];
		if (!prepare) return null;
		const attemptNotAfter = prepare.value.attemptNotAfter;
		for (const proof of proofs) {
			if (
				!matchesAttempt(proof, captured.expected, sourceKeyId, targetKeyId, attemptNotAfter) ||
				!matchesLinks(proof, proofs)
			)
				return null;
		}
		return { proofs, phase: captured.expectedPhase, attemptNotAfter };
	} catch {
		return null;
	}
}
