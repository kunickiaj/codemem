import type { RawEventIngestSession, RawEventSweeper } from "@codemem/core";

export function nudgeRawEventSessions(
	sweeper: RawEventSweeper | null | undefined,
	sessions: Iterable<RawEventIngestSession>,
): void {
	for (const session of sessions) {
		try {
			sweeper?.nudge(session.streamId, session.source);
		} catch {
			// A failed nudge must not block later validated sessions.
		}
	}
}

export async function flushRawEventBoundarySessions(
	sweeper: RawEventSweeper | null | undefined,
	sessions: Iterable<RawEventIngestSession>,
): Promise<void> {
	for (const session of sessions) {
		try {
			await sweeper?.flushBoundary(session.streamId, session.source);
		} catch {
			// Boundary extraction remains best-effort, matching the legacy CLI path.
		}
	}
}

export function isClaudeBoundaryEnvelope(envelope: object): boolean {
	const record = envelope as Record<string, unknown>;
	if (
		String(record.source ?? "")
			.trim()
			.toLowerCase() !== "claude"
	)
		return false;
	const payload = record.payload;
	if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return false;
	const adapter = (payload as Record<string, unknown>)._adapter;
	if (adapter == null || typeof adapter !== "object" || Array.isArray(adapter)) return false;
	const meta = (adapter as Record<string, unknown>).meta;
	if (meta == null || typeof meta !== "object" || Array.isArray(meta)) return false;
	const hookEventName = (meta as Record<string, unknown>).hook_event_name;
	return hookEventName === "SessionEnd" || hookEventName === "Stop";
}
