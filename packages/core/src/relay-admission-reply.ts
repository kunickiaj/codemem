import {
	decodeRelayCheckPacket,
	getRelayAdmissionTimeBudget,
	type RelayCheckPacket,
} from "./relay-admission-codec.js";
import type { RelayAdmissionDecision } from "./relay-admission-decision.js";
import type { RelayAdmissionReadinessStamp } from "./relay-admission-readiness.js";
import { relayExact, relayInteger, relayJson, relayRequire } from "./relay-control-codec.js";
import { relayBodyDigest } from "./relay-service-proof.js";

export interface RelayAdmissionReply {
	readonly decidedAtMs: number;
	readonly remainingMs: number;
	readonly health: RelayAdmissionReadinessStamp;
}
function readHealth(health: unknown, decidedAtMs: number): RelayAdmissionReadinessStamp {
	relayRequire(relayExact(health, ["revision", "state", "observedAtMs", "validUntilMs"]));
	relayRequire(
		relayInteger(health.revision) &&
			health.state === "ready" &&
			relayInteger(health.observedAtMs) &&
			relayInteger(health.validUntilMs) &&
			health.validUntilMs === health.observedAtMs + 50_000 &&
			health.observedAtMs <= decidedAtMs + 10_000 &&
			health.validUntilMs > decidedAtMs,
	);
	return {
		revision: health.revision,
		state: "ready",
		observedAtMs: health.observedAtMs,
		validUntilMs: health.validUntilMs,
	};
}
export function encodeRelayAdmissionReply(decision: RelayAdmissionDecision | null): Uint8Array {
	if (!decision) return new TextEncoder().encode('{"v":1,"eligible":false}');
	const common = {
		packetDigest: decision.proof.packetDigest,
		requestNonce: decision.receipt.nonce,
	};
	let reply: object;
	if (decision.kind === "registration") {
		reply = {
			v: 1,
			registered: true,
			role: "registration",
			...common,
			deviceId: decision.proof.signer.deviceId,
			keyId: decision.proof.signer.keyId,
			decidedAtMs: decision.receipt.decidedAtMs,
			remainingMs: decision.socketExpiresInMs,
			health: decision.readiness,
		};
	} else {
		const check = decodeRelayCheckPacket(decision.packet);
		relayRequire(check.kind === "admission");
		reply = {
			v: 1,
			eligible: true,
			role: check.value.role,
			...common,
			decidedAtMs: decision.receipt.decidedAtMs,
			routeNotAfter: check.value.routeNotAfter,
			remainingMs: decision.remainingMs,
			health: decision.readiness,
		};
	}
	const bytes = new TextEncoder().encode(JSON.stringify(reply));
	relayRequire(readRelayAdmissionReply(bytes, decision.packet) !== null);
	return bytes;
}
/** Only call with bytes from this request's trusted coordinator transport. Never portable approval. */
export function readRelayAdmissionReply(
	bytes: Uint8Array,
	packet: RelayCheckPacket,
): RelayAdmissionReply | null {
	try {
		const check = decodeRelayCheckPacket(packet);
		const value = relayJson(bytes, 1024);
		const common = [
			"v",
			"role",
			"packetDigest",
			"requestNonce",
			"decidedAtMs",
			"remainingMs",
			"health",
		];
		const fields =
			check.kind === "registration"
				? [...common, "registered", "deviceId", "keyId"]
				: [...common, "eligible", "routeNotAfter"];
		relayRequire(
			relayExact(value, fields) &&
				value.v === 1 &&
				value.packetDigest === relayBodyDigest(check.bodyBytes) &&
				value.requestNonce === check.nonce &&
				relayInteger(value.decidedAtMs),
		);
		const { decidedAtMs, remainingMs, health } = value;
		relayRequire(
			check.value.createdAt * 1000 <= decidedAtMs + 5000 &&
				decidedAtMs < check.value.admitBefore * 1000,
		);
		if (check.kind === "registration") {
			relayRequire(
				value.registered === true &&
					value.role === "registration" &&
					value.deviceId === check.value.deviceId &&
					value.keyId === check.value.keyId &&
					remainingMs === 900_000,
			);
		} else {
			relayRequire(
				value.eligible === true &&
					value.role === check.value.role &&
					value.routeNotAfter === check.value.routeNotAfter &&
					remainingMs === getRelayAdmissionTimeBudget(check.value, decidedAtMs).remainingMs,
			);
		}
		relayRequire(relayInteger(remainingMs, 900_000) && remainingMs > 0);
		return {
			decidedAtMs,
			remainingMs,
			health: readHealth(health, decidedAtMs),
		};
	} catch {
		return null;
	}
}
