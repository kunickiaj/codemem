import type {
	DiagnosticEvent,
	DiagnosticEventsResponse,
	LoadDiagnosticEventsOptions,
	loadDiagnosticEvents,
} from "../../lib/api/diagnostics";
import { MAX_ROWS, mergeUnique, PAGE_SIZE } from "./state";

type EventLoader = typeof loadDiagnosticEvents;
const MAX_POLL_PAGES = Math.ceil(MAX_ROWS / PAGE_SIZE);

type PollCatchupOptions = {
	loadEvents: EventLoader;
	request: LoadDiagnosticEventsOptions;
	existingRows: DiagnosticEvent[];
	existingNextCursor: string | null;
};

export async function loadPollCatchup(
	options: PollCatchupOptions,
): Promise<DiagnosticEventsResponse> {
	const knownOrderingTimestamps = new Map(
		options.existingRows.map((event) => [event.id, event.occurred_at]),
	);
	let request = options.request;
	let combined: DiagnosticEventsResponse | null = null;
	let pageCount = 0;

	while (true) {
		const response = await options.loadEvents(request);
		pageCount += 1;
		const items = mergeUnique([...(combined?.items ?? []), ...response.items]);
		combined = { ...response, items };
		const reachedKnownRow = response.items.some(
			(event) => knownOrderingTimestamps.get(event.id) === event.occurred_at,
		);
		if (knownOrderingTimestamps.size === 0 || reachedKnownRow) {
			const mergedRows = mergeUnique([...items, ...options.existingRows], MAX_ROWS + 1);
			const preservesExistingCursor = reachedKnownRow && mergedRows.length <= MAX_ROWS;
			return {
				...combined,
				next_cursor: preservesExistingCursor ? options.existingNextCursor : response.next_cursor,
			};
		}
		if (!response.next_cursor || items.length >= MAX_ROWS || pageCount >= MAX_POLL_PAGES) {
			return combined;
		}
		request = {
			...options.request,
			cursor: response.next_cursor,
			limit: Math.min(PAGE_SIZE, MAX_ROWS - items.length),
		};
	}
}
