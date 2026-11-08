import { sanitizeRelayServerDiagnostic } from "@codemem/core/internal/relay-host";

/** Serializes decision fields only. Request metadata never enters this logger. */
export function logRelayDecision(value: unknown): void {
	try {
		const diagnostic = sanitizeRelayServerDiagnostic(value);
		if (!diagnostic) return;
		const entry = {
			event: "codemem.relay.decision",
			decision: diagnostic.event,
			route_id: diagnostic.sessionId,
			...(diagnostic.reason ? { reason: diagnostic.reason } : {}),
		};
		console.log(JSON.stringify(entry));
	} catch {
		// A failed log write must not change admission, forwarding, or route cleanup.
	}
}
