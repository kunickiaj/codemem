import type { CachedUsagePayload, UsageEventSummary } from "../../lib/state";

export function selectPackUsage(
	payload: CachedUsagePayload,
	preferFiltered: boolean,
): UsageEventSummary {
	let events = payload.events_global || [];
	if (preferFiltered) events = payload.events_filtered || [];
	else if (payload.events) events = payload.events;
	return events.find((event) => event.event === "pack") || {};
}
