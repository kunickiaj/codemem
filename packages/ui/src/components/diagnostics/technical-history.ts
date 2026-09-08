import type {
	DiagnosticEvent,
	DiagnosticEventsResponse,
	LoadDiagnosticEventsOptions,
	loadDiagnosticEvents,
} from "../../lib/api/diagnostics";
import { MAX_ROWS, mergeUnique, PAGE_SIZE } from "./state";

type EventLoader = typeof loadDiagnosticEvents;

type TechnicalHistoryOptions = {
	loadEvents: EventLoader;
	request: LoadDiagnosticEventsOptions;
	existingRows: DiagnosticEvent[];
};

export async function loadTechnicalHistory(
	options: TechnicalHistoryOptions,
): Promise<DiagnosticEventsResponse> {
	const targetIds = new Set(options.existingRows.map((event) => event.id));
	let request = options.request;
	let combined: DiagnosticEventsResponse | null = null;
	let pageCount = 0;

	while (true) {
		const response = await options.loadEvents(request);
		pageCount += 1;
		const items = mergeUnique([...(combined?.items ?? []), ...response.items]);
		combined = { ...response, items };
		const loadedIds = new Set(items.map((event) => event.id));
		if ([...targetIds].every((id) => loadedIds.has(id))) return combined;
		if (!response.next_cursor || items.length >= MAX_ROWS || pageCount * PAGE_SIZE >= MAX_ROWS) {
			throw new Error("Technical diagnostic history could not be refreshed completely.");
		}
		request = {
			...options.request,
			cursor: response.next_cursor,
			limit: Math.min(PAGE_SIZE, MAX_ROWS - items.length),
		};
	}
}
