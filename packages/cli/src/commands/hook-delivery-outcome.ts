export type HookDeliveryOutcome =
	| { outcome: "accepted" }
	| { outcome: "retryable" }
	| { outcome: "terminal"; status: 400; reason: "invalid_payload" }
	| { outcome: "terminal"; status: 413; reason: "payload_too_large" };

export type SpoolHandlerResult = boolean | HookDeliveryOutcome;

export function classifyNativeHookHttpFailure({
	status,
	responseBody,
	outgoingBytes,
	redirected = false,
}: {
	status: number;
	responseBody: unknown;
	outgoingBytes: number;
	redirected?: boolean;
}): Extract<HookDeliveryOutcome, { outcome: "terminal" }> | null {
	if (
		redirected ||
		!responseBody ||
		typeof responseBody !== "object" ||
		Array.isArray(responseBody)
	)
		return null;
	const body = responseBody as Record<string, unknown>;
	const fields = Object.keys(body).sort().join();
	if (status === 400 && fields === "error" && body.error === "invalid session id") {
		return { outcome: "terminal", status: 400, reason: "invalid_payload" };
	}
	if (
		status === 413 &&
		fields === "error,max_bytes" &&
		body.error === "payload too large" &&
		typeof body.max_bytes === "number" &&
		Number.isSafeInteger(body.max_bytes) &&
		body.max_bytes > 0 &&
		Number.isSafeInteger(outgoingBytes) &&
		outgoingBytes > body.max_bytes
	) {
		return { outcome: "terminal", status: 413, reason: "payload_too_large" };
	}
	return null;
}

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
