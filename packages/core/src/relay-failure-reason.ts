import { PeerHttpExchangeError } from "./peer-http-policy.js";

/**
 * Stable local reason codes for relay route failures. They are recorded only in local results and
 * attempt history. Relay control frames still carry no failure reason, and peers never see these.
 * docs/relay-runtime.md documents each code and the operator's next action.
 */
export const RELAY_FAILURE_REASONS = [
	"relay_disabled",
	"relay_peer_revoked",
	"relay_unavailable",
	"relay_admission_failed",
	"relay_rejected",
	"relay_aborted",
	"relay_frame_invalid",
	"relay_handshake_failed",
	"relay_record_invalid",
	"relay_expired",
] as const;

export type RelayFailureReason = (typeof RELAY_FAILURE_REASONS)[number];

/** An error raised where a relay failure originates, tagged with its local reason. */
export class RelayFailure extends Error {
	constructor(
		readonly reason: RelayFailureReason,
		message: string,
	) {
		super(message);
		this.name = "RelayFailure";
	}
}

/**
 * Maps an error to its reason. Untagged errors take `fallback`, which callers choose from the
 * route phase they know, because Noise and stream errors arrive without a relay tag.
 */
export function relayFailureReason(
	error: unknown,
	fallback: RelayFailureReason,
): RelayFailureReason {
	if (error instanceof RelayFailure) return error.reason;
	if (
		error instanceof PeerHttpExchangeError &&
		(error.code === "deadline" || error.code === "cancelled")
	)
		return "relay_expired";
	return fallback;
}

/** Tags an untagged error with `fallback`, keeping its message. Tagged errors pass through. */
export function asRelayFailure(error: unknown, fallback: RelayFailureReason): RelayFailure {
	if (error instanceof RelayFailure) return error;
	const message = error instanceof Error ? error.message : "Relay peer connection failed";
	return new RelayFailure(relayFailureReason(error, fallback), message);
}

/** Keeps the first recorded reason. Later, repeated, or reordered failures cannot replace it. */
export function createRelayFailureRecorder() {
	let first: RelayFailureReason | undefined;
	return {
		record(reason: RelayFailureReason): void {
			first ??= reason;
		},
		reason(): RelayFailureReason | undefined {
			return first;
		},
	};
}
