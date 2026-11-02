import { createHash } from "node:crypto";
import type { TraversalSignalDecision } from "./peer-traversal-coordinator-decision.js";
import {
	encodeTraversalSignalBody,
	encodeTraversalSignalPacket,
	type TraversalSignalBody,
	type TraversalSignalPacket,
	type TraversalSignalPhase,
} from "./peer-traversal-signal-codec.js";

export const common = {
	authorityId: "a".repeat(64),
	groupId: "group",
	sourceDeviceId: "source",
	sourceKeyId: "b".repeat(64),
	targetDeviceId: "target",
	targetKeyId: "c".repeat(64),
	sessionId: "d".repeat(32),
	messageADigest: "e".repeat(64),
	createdAt: 100,
	admitBefore: 130,
	attemptNotAfter: 155,
};
export const phases: TraversalSignalPhase[] = [
	"prepare",
	"offer",
	"offer-check",
	"answer",
	"answer-check",
];
export const raw = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

export function signalBody(phase: TraversalSignalPhase): TraversalSignalBody {
	const prepareDigest = "f".repeat(64);
	const offerDigest = "1".repeat(64);
	const descriptionBytes = Uint8Array.of(120);
	if (phase === "prepare") return { ...common, phase };
	if (phase === "offer") return { ...common, phase, prepareDigest, descriptionBytes };
	if (phase === "offer-check") return { ...common, phase, prepareDigest, offerDigest };
	if (phase === "answer") return { ...common, phase, prepareDigest, offerDigest, descriptionBytes };
	return { ...common, phase, prepareDigest, offerDigest, answerDigest: "2".repeat(64) };
}

export function signalPacket(phase: TraversalSignalPhase = "prepare") {
	// Format-only signature. Fake send ports below do not prove coordinator authentication.
	return encodeTraversalSignalPacket({
		bodyBytes: encodeTraversalSignalBody(signalBody(phase)),
		timestamp: "100",
		nonce: "3".repeat(32),
		signatureBytes: new Uint8Array(64),
	});
}

export function decision(phase: TraversalSignalPhase = "prepare"): TraversalSignalDecision {
	return {
		v: 1,
		ok: true,
		phase,
		sessionId: common.sessionId,
		packetDigest: createHash("sha256")
			.update(encodeTraversalSignalBody(signalBody(phase)))
			.digest("hex"),
		requestNonce: "3".repeat(32),
		decidedAtMs: 100000,
		attemptNotAfter: 155,
		remainingMs: 55000,
		policyRevision: 1,
		readyObservedAtMs: 100000,
	};
}

export function clientOptions(phase: TraversalSignalPhase = "prepare") {
	const target = phase === "offer-check" || phase === "answer";
	return {
		packet: signalPacket(phase),
		expectedPhase: phase,
		localDeviceId: target ? "target" : "source",
		namespace: { authorityId: common.authorityId, groupId: common.groupId },
		externalPathname: "/prefix/v1/traversal/signal",
		deadlineMs: 60000,
	};
}

export function signalEnvelope(type: "traversal-offer" | "traversal-answer" = "traversal-offer") {
	const pair =
		type === "traversal-offer"
			? (["prepare", "offer"] as const)
			: (["offer-check", "answer"] as const);
	const packets: [TraversalSignalPacket, TraversalSignalPacket] = [
		signalPacket(pair[0]),
		signalPacket(pair[1]),
	];
	return { v: 1 as const, type, packets };
}
