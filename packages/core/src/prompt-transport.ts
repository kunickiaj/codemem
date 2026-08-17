export interface PromptTransportProtocolRange {
	minSupportedProtocolVersion: number;
	protocolVersion: number;
}

/** Current prompt-transport protocol range implemented by this release. */
export const PROMPT_TRANSPORT_PROTOCOL_RANGE = {
	minSupportedProtocolVersion: 1,
	protocolVersion: 1,
} as const satisfies PromptTransportProtocolRange;

export type PromptTransportDisposition = "fallback" | "local_fallback" | "terminal";

export type PromptTransportFailure =
	| {
			kind:
				| "profile_absent"
				| "profile_malformed"
				| "protocol_range_mismatch"
				| "network_unavailable"
				| "network_timeout"
				| "network_reset"
				| "viewer_restart"
				| "malformed_response";
	  }
	| { kind: "database_mismatch" | "runtime_identity_mismatch" }
	| { kind: "invalid_request"; compatibleProfile: boolean }
	| { kind: "policy_failure" | "authorization_failure" }
	| { kind: "viewer_contract_unsupported"; compatibleProfile: boolean };

function isProtocolVersion(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

/**
 * Normalize a current/minimum pair into a closed supported range.
 *
 * A missing minimum is interpreted as an older single-version profile. Any
 * explicitly malformed minimum remains invalid instead of being silently
 * widened.
 */
export function normalizePromptTransportProtocolRange(
	protocolVersion: unknown,
	minSupportedProtocolVersion?: unknown,
): PromptTransportProtocolRange | null {
	if (!isProtocolVersion(protocolVersion)) return null;
	const minimum =
		minSupportedProtocolVersion === undefined ? protocolVersion : minSupportedProtocolVersion;
	if (!isProtocolVersion(minimum) || minimum > protocolVersion) return null;
	return {
		minSupportedProtocolVersion: minimum,
		protocolVersion,
	};
}

/** Return true when two closed protocol-version ranges overlap. */
export function arePromptTransportProtocolRangesCompatible(
	left: PromptTransportProtocolRange,
	right: PromptTransportProtocolRange,
): boolean {
	return (
		left.minSupportedProtocolVersion <= right.protocolVersion &&
		right.minSupportedProtocolVersion <= left.protocolVersion
	);
}

/** Classify whether a prompt transport failure may use local compatibility fallback. */
export function classifyPromptTransportFailure(
	failure: PromptTransportFailure,
): PromptTransportDisposition {
	switch (failure.kind) {
		case "database_mismatch":
		case "runtime_identity_mismatch":
			return "local_fallback";
		case "invalid_request":
			return failure.compatibleProfile ? "terminal" : "fallback";
		case "policy_failure":
		case "authorization_failure":
			return "terminal";
		case "viewer_contract_unsupported":
			return failure.compatibleProfile ? "terminal" : "fallback";
		default:
			return "fallback";
	}
}
