const EVENTS = [
	"route_opened",
	"route_forwarded",
	"route_accepted",
	"route_rejected",
	"route_closed",
] as const;

const REASONS = [
	"source_registration_unavailable",
	"admission_context_invalid",
	"source_binding_mismatch",
	"duplicate_session",
	"route_capacity",
	"device_route_capacity",
	"parallel_route",
	"open_quota_rejected",
	"admission_check_failed",
	"source_registration_lost",
	"route_expired",
	"target_registration_absent",
	"target_registration_expired_or_invalid",
	"target_key_mismatch",
	"target_is_source",
	"target_rejected",
	"route_aborted",
	"route_completed",
	"control_busy",
] as const;

export interface RelayServerDiagnostic {
	readonly event: (typeof EVENTS)[number];
	readonly sessionId: string;
	readonly reason?: (typeof REASONS)[number];
}

/** Copies only the temporary route identifier and finite diagnostic codes. */
export function sanitizeRelayServerDiagnostic(value: unknown): RelayServerDiagnostic | null {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
		const { event, sessionId, reason } = value as Record<string, unknown>;
		if (
			typeof event !== "string" ||
			!EVENTS.includes(event as RelayServerDiagnostic["event"]) ||
			typeof sessionId !== "string" ||
			!/^[0-9a-f]{32}$/.test(sessionId)
		)
			return null;
		if (
			reason !== undefined &&
			(typeof reason !== "string" ||
				!REASONS.includes(reason as NonNullable<RelayServerDiagnostic["reason"]>))
		)
			return null;
		const safe: RelayServerDiagnostic = {
			event: event as RelayServerDiagnostic["event"],
			sessionId,
		};
		if (reason === undefined) return safe;
		return { ...safe, reason: reason as NonNullable<RelayServerDiagnostic["reason"]> };
	} catch {
		// Untrusted accessors and proxies must not turn diagnostics into a host failure.
		return null;
	}
}
