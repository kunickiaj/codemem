export type HookDeliveryOutcome =
	| { outcome: "accepted" }
	| { outcome: "retryable" }
	| { outcome: "terminal"; status: 400; reason: "invalid_payload" }
	| { outcome: "terminal"; status: 413; reason: "payload_too_large" };

export type SpoolHandlerResult = boolean | HookDeliveryOutcome;

export function normalizeHookDeliveryOutcome(value: unknown): HookDeliveryOutcome {
	if (value === true) return { outcome: "accepted" };
	if (value === false || value === null || typeof value !== "object" || Array.isArray(value)) {
		return { outcome: "retryable" };
	}
	const result = value as Record<string, unknown>;
	if (result.outcome === "accepted") return { outcome: "accepted" };
	if (result.outcome === "terminal") {
		if (result.status === 400 && result.reason === "invalid_payload") {
			return { outcome: "terminal", status: 400, reason: "invalid_payload" };
		}
		if (result.status === 413 && result.reason === "payload_too_large") {
			return { outcome: "terminal", status: 413, reason: "payload_too_large" };
		}
	}
	return { outcome: "retryable" };
}
