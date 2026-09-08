import type { DiagnosticEvent } from "../../lib/api/diagnostics";

export type ViewerConnectionEventKind =
	| "connection_lost"
	| "reconnect_requested"
	| "connection_restored";

export const MAX_VIEWER_CONNECTION_EVENTS = 20;

const EVENT_PRESENTATION: Record<
	ViewerConnectionEventKind,
	Pick<DiagnosticEvent, "code" | "message" | "severity" | "subsystem">
> = {
	connection_lost: {
		code: "viewer_connection_lost",
		message: "The viewer connection was interrupted. Automatic recovery started.",
		severity: "warning",
		subsystem: "viewer",
	},
	reconnect_requested: {
		code: "viewer_reconnect_requested",
		message: "A viewer reconnection check was requested.",
		severity: "info",
		subsystem: "viewer",
	},
	connection_restored: {
		code: "viewer_connection_restored",
		message: "The viewer connection and page data were restored.",
		severity: "info",
		subsystem: "viewer",
	},
};

let activeIncident = false;
let eventSequence = 0;
let sessionEvents: DiagnosticEvent[] = [];
const listeners = new Set<(event: DiagnosticEvent) => void>();

export function getViewerConnectionEvents(): DiagnosticEvent[] {
	return [...sessionEvents];
}

export function recordViewerConnectionEvent(kind: ViewerConnectionEventKind): void {
	if (!Object.hasOwn(EVENT_PRESENTATION, kind)) return;
	const presentation = EVENT_PRESENTATION[kind];
	if (kind === "connection_lost" && activeIncident) return;
	if (kind === "reconnect_requested" && sessionEvents[0]?.code === presentation.code) return;
	if (kind === "connection_restored" && !activeIncident) return;

	const occurredAt = new Date().toISOString();
	const event: DiagnosticEvent = {
		id: `viewer-session-${Date.now()}-${++eventSequence}`,
		occurred_at: occurredAt,
		...presentation,
	};
	sessionEvents = [event, ...sessionEvents].slice(0, MAX_VIEWER_CONNECTION_EVENTS);
	if (kind === "connection_lost") activeIncident = true;
	if (kind === "connection_restored") activeIncident = false;
	for (const listener of listeners) listener(event);
}

export function subscribeToViewerConnectionEvents(
	listener: (event: DiagnosticEvent) => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function resetViewerConnectionEventsForTests(): void {
	activeIncident = false;
	eventSequence = 0;
	sessionEvents = [];
}
