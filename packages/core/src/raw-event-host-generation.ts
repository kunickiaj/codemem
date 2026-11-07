export function isV2Event(event: Record<string, unknown>): boolean {
	return event.codemem_host_generation === "v2";
}

/** Keep a host upgrade from mixing V1 and V2 credentials in one flush range. */
export function oneHostGeneration(events: Record<string, unknown>[]): Record<string, unknown>[] {
	if (events.length === 0) return events;
	const generation = isV2Event(events[0] ?? {});
	const transition = events.findIndex((event) => isV2Event(event) !== generation);
	return transition > 0 ? events.slice(0, transition) : events;
}
