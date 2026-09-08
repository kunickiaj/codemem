import type {
	DiagnosticEvent,
	DiagnosticEventSeverity,
	DiagnosticEventSubsystem,
	DiagnosticEventsResponse,
} from "../../lib/api/diagnostics";
import { MAX_VIEWER_CONNECTION_EVENTS } from "./viewer-connection-events";

export const PAGE_SIZE = 50;
export const MAX_ROWS = 200;

export type RequestMode = "replace" | "poll" | "older" | "technical";

export type DiagnosticsDrawerState = {
	open: boolean;
	severity: DiagnosticEventSeverity | "";
	subsystem: DiagnosticEventSubsystem | "";
	includeTechnical: boolean;
	paused: boolean;
	rows: DiagnosticEvent[];
	sessionRows: DiagnosticEvent[];
	queuedSessionRows: DiagnosticEvent[];
	queuedRows: DiagnosticEvent[];
	queuedNextCursor: string | null | undefined;
	nextCursor: string | null;
	generatedAt: string | null;
	loading: boolean;
	error: boolean;
	announcement: string;
	copyStatus: string;
	hiddenSessionIds: string[];
	queryRevision: number;
	pollRevision: number;
};

export type DiagnosticsDrawerAction =
	| {
			type: "open";
			severity: DiagnosticEventSeverity | "";
			subsystem: DiagnosticEventSubsystem | "";
			sessionRows: DiagnosticEvent[];
	  }
	| { type: "close" }
	| { type: "set_severity"; severity: DiagnosticEventSeverity | "" }
	| { type: "set_subsystem"; subsystem: DiagnosticEventSubsystem | "" }
	| { type: "reset_filters" }
	| { type: "set_paused"; paused: boolean }
	| { type: "reveal_technical" }
	| { type: "request_started"; mode: RequestMode }
	| {
			type: "request_succeeded";
			mode: RequestMode;
			response: DiagnosticEventsResponse;
			readingOlder: boolean;
	  }
	| { type: "request_failed"; mode: RequestMode; restartQuery: boolean }
	| { type: "show_queued" }
	| { type: "session_event_recorded"; event: DiagnosticEvent; readingOlder?: boolean }
	| { type: "refresh_session_rows"; events: DiagnosticEvent[]; readingOlder?: boolean }
	| { type: "clear_view"; sessionEvents: DiagnosticEvent[] }
	| { type: "set_copy_status"; status: string };

export function initialDiagnosticsDrawerState(): DiagnosticsDrawerState {
	return {
		open: false,
		severity: "",
		subsystem: "",
		includeTechnical: false,
		paused: false,
		rows: [],
		sessionRows: [],
		queuedSessionRows: [],
		queuedRows: [],
		queuedNextCursor: undefined,
		nextCursor: null,
		generatedAt: null,
		loading: false,
		error: false,
		announcement: "",
		copyStatus: "",
		hiddenSessionIds: [],
		queryRevision: 0,
		pollRevision: 0,
	};
}

export function visibleDiagnosticRows(state: DiagnosticsDrawerState): DiagnosticEvent[] {
	const matchingRows = [...state.sessionRows, ...state.rows]
		.filter((event) => matchesDiagnosticFilters(state, event))
		.sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at));
	return mergeUnique(matchingRows);
}

function matchesDiagnosticFilters(
	state: Pick<DiagnosticsDrawerState, "severity" | "subsystem">,
	event: DiagnosticEvent,
): boolean {
	if (state.severity && event.severity !== state.severity) return false;
	return !state.subsystem || event.subsystem === state.subsystem;
}

export function queuedDiagnosticRowCount(state: DiagnosticsDrawerState): number {
	const matchingSessionRows = state.queuedSessionRows.filter((event) =>
		matchesDiagnosticFilters(state, event),
	);
	return state.queuedRows.length + matchingSessionRows.length;
}

export function mergeUnique(events: DiagnosticEvent[], maximum = MAX_ROWS): DiagnosticEvent[] {
	const seen = new Set<string>();
	return events.filter((event) => {
		if (seen.has(event.id) || seen.size >= maximum) return false;
		seen.add(event.id);
		return true;
	});
}

function applyRequestFailure(
	state: DiagnosticsDrawerState,
	mode: RequestMode,
	restartQuery: boolean,
): DiagnosticsDrawerState {
	const restartPagination = mode === "older" && restartQuery;
	return {
		...state,
		includeTechnical: mode === "technical" ? false : state.includeTechnical,
		nextCursor: restartPagination ? null : state.nextCursor,
		loading: false,
		error: true,
		announcement: "",
		queryRevision: restartPagination ? state.queryRevision + 1 : state.queryRevision,
	};
}

function replaceQueryState(
	state: DiagnosticsDrawerState,
	changes: Partial<Pick<DiagnosticsDrawerState, "severity" | "subsystem">>,
): DiagnosticsDrawerState {
	return {
		...state,
		...changes,
		rows: [],
		queuedRows: [],
		queuedNextCursor: undefined,
		nextCursor: null,
		generatedAt: null,
		loading: false,
		error: false,
		announcement: "",
		copyStatus: "",
		queryRevision: state.queryRevision + 1,
	};
}

function reconcilePolledRow(
	current: DiagnosticEvent,
	incoming: DiagnosticEvent | undefined,
	preservePosition: boolean,
): DiagnosticEvent {
	if (!incoming) return current;
	if (!preservePosition) return incoming;
	return { ...incoming, occurred_at: current.occurred_at };
}

function applyPollResponse(
	state: DiagnosticsDrawerState,
	response: DiagnosticEventsResponse,
	readingOlder: boolean,
): DiagnosticsDrawerState {
	const incomingById = new Map(response.items.map((event) => [event.id, event]));
	const currentById = new Map(state.rows.map((event) => [event.id, event]));
	const newRows = response.items.filter((event) => !currentById.has(event.id));
	if (!state.rows.length) {
		return {
			...state,
			rows: response.items.slice(0, MAX_ROWS),
			queuedNextCursor: undefined,
			nextCursor: response.next_cursor,
		};
	}
	if (!readingOlder) {
		const rows = mergeUnique([...response.items, ...state.rows]);
		return {
			...state,
			rows,
			queuedRows: [],
			queuedNextCursor: undefined,
			nextCursor: response.next_cursor,
		};
	}
	const relocatedRows = response.items.filter((event) => {
		const current = currentById.get(event.id);
		return current !== undefined && current.occurred_at !== event.occurred_at;
	});
	const queuedUpdates = mergeUnique([...newRows, ...relocatedRows]);
	const queuedIds = new Set(queuedUpdates.map((event) => event.id));
	const rows = state.rows.map((event) =>
		reconcilePolledRow(event, incomingById.get(event.id), queuedIds.has(event.id)),
	);
	const queuedRows = mergeUnique([...queuedUpdates, ...state.queuedRows]);
	return {
		...state,
		rows,
		queuedRows,
		queuedNextCursor: response.next_cursor,
		announcement:
			queuedRows.length > 0 ? `${queuedRows.length} new diagnostic events are waiting.` : "",
	};
}

function applyResponse(
	state: DiagnosticsDrawerState,
	action: Extract<DiagnosticsDrawerAction, { type: "request_succeeded" }>,
): DiagnosticsDrawerState {
	const base = {
		...state,
		generatedAt: action.response.generated_at,
		loading: false,
		error: false,
		announcement: "",
	};
	if (action.mode === "replace") {
		return {
			...base,
			rows: action.response.items.slice(0, MAX_ROWS),
			queuedRows: [],
			queuedNextCursor: undefined,
			nextCursor: action.response.next_cursor,
		};
	}
	if (action.mode === "older") {
		return {
			...base,
			rows: mergeUnique([...state.rows, ...action.response.items]),
			queuedNextCursor: state.queuedRows.length ? state.queuedNextCursor : undefined,
			nextCursor: action.response.next_cursor,
		};
	}
	if (action.mode === "technical") {
		const incomingById = new Map(action.response.items.map((event) => [event.id, event]));
		return {
			...base,
			rows: state.rows.map((event) => reconcilePolledRow(event, incomingById.get(event.id), true)),
			queuedRows: state.queuedRows.map((event) =>
				reconcilePolledRow(event, incomingById.get(event.id), true),
			),
			nextCursor: state.nextCursor,
		};
	}
	return applyPollResponse(base, action.response, action.readingOlder);
}

function reduceDrawerQueryAction(
	state: DiagnosticsDrawerState,
	action: DiagnosticsDrawerAction,
): DiagnosticsDrawerState | null {
	if (action.type === "open") {
		return {
			...initialDiagnosticsDrawerState(),
			open: true,
			severity: action.severity,
			subsystem: action.subsystem,
			sessionRows: action.sessionRows,
			queryRevision: state.queryRevision + 1,
		};
	}
	if (action.type === "close") return initialDiagnosticsDrawerState();
	if (action.type === "set_severity") {
		return replaceQueryState(state, { severity: action.severity });
	}
	if (action.type === "set_subsystem") {
		return replaceQueryState(state, { subsystem: action.subsystem });
	}
	if (action.type === "reset_filters") {
		return replaceQueryState(state, { severity: "", subsystem: "" });
	}
	if (action.type === "set_paused") {
		return {
			...state,
			loading: action.paused ? false : state.loading,
			paused: action.paused,
			pollRevision: action.paused ? state.pollRevision : state.pollRevision + 1,
		};
	}
	if (action.type === "reveal_technical") {
		return {
			...state,
			includeTechnical: true,
		};
	}
	return null;
}

function reduceDrawerRequestAction(
	state: DiagnosticsDrawerState,
	action: DiagnosticsDrawerAction,
): DiagnosticsDrawerState | null {
	if (action.type === "request_started") {
		return { ...state, loading: action.mode !== "poll" };
	}
	if (action.type === "request_succeeded") return applyResponse(state, action);
	if (action.type === "request_failed") {
		return applyRequestFailure(state, action.mode, action.restartQuery);
	}
	return null;
}

function receiveSessionRows(
	state: DiagnosticsDrawerState,
	events: DiagnosticEvent[],
	readingOlder = false,
): DiagnosticsDrawerState {
	if (state.paused || !state.open) return state;
	const allowed = events.filter((event) => !state.hiddenSessionIds.includes(event.id));
	if (!readingOlder) {
		return {
			...state,
			sessionRows: mergeUnique(
				[...allowed, ...state.queuedSessionRows, ...state.sessionRows],
				MAX_VIEWER_CONNECTION_EVENTS,
			),
			queuedSessionRows: [],
		};
	}
	const known = new Set(state.sessionRows.map((event) => event.id));
	const queuedSessionRows = mergeUnique(
		[...allowed.filter((event) => !known.has(event.id)), ...state.queuedSessionRows],
		MAX_VIEWER_CONNECTION_EVENTS,
	);
	return { ...state, queuedSessionRows };
}

function reduceDrawerLocalAction(
	state: DiagnosticsDrawerState,
	action: DiagnosticsDrawerAction,
): DiagnosticsDrawerState | null {
	if (action.type === "session_event_recorded") {
		return receiveSessionRows(state, [action.event], action.readingOlder);
	}
	if (action.type === "refresh_session_rows") {
		return receiveSessionRows(state, action.events, action.readingOlder);
	}
	if (action.type === "clear_view") {
		const hiddenSessionIds = [
			...new Set([
				...action.sessionEvents.map((event) => event.id),
				...state.queuedSessionRows.map((event) => event.id),
				...state.sessionRows.map((event) => event.id),
				...state.hiddenSessionIds,
			]),
		].slice(0, MAX_VIEWER_CONNECTION_EVENTS);
		return {
			...state,
			rows: [],
			sessionRows: [],
			queuedSessionRows: [],
			queuedRows: [],
			queuedNextCursor: undefined,
			nextCursor: null,
			generatedAt: null,
			loading: false,
			error: false,
			announcement: "Diagnostics view cleared.",
			copyStatus: "",
			hiddenSessionIds,
		};
	}
	if (action.type === "set_copy_status") {
		return { ...state, copyStatus: action.status };
	}
	if (action.type !== "show_queued") return null;
	return showQueuedRows(state);
}

function showQueuedRows(state: DiagnosticsDrawerState): DiagnosticsDrawerState {
	const mergedRows = mergeUnique([...state.queuedRows, ...state.rows], MAX_ROWS + 1);
	const rowsWereTrimmed = mergedRows.length > MAX_ROWS;
	const useQueuedCursor = rowsWereTrimmed && state.queuedNextCursor !== undefined;
	return {
		...state,
		rows: mergedRows.slice(0, MAX_ROWS),
		sessionRows: mergeUnique(
			[...state.queuedSessionRows, ...state.sessionRows],
			MAX_VIEWER_CONNECTION_EVENTS,
		),
		queuedSessionRows: [],
		queuedRows: [],
		queuedNextCursor: undefined,
		nextCursor: useQueuedCursor ? state.queuedNextCursor : state.nextCursor,
		announcement: "",
	};
}

export function diagnosticsDrawerReducer(
	state: DiagnosticsDrawerState,
	action: DiagnosticsDrawerAction,
): DiagnosticsDrawerState {
	const queryState = reduceDrawerQueryAction(state, action);
	if (queryState) return queryState;
	const requestState = reduceDrawerRequestAction(state, action);
	if (requestState) return requestState;
	return reduceDrawerLocalAction(state, action) ?? state;
}
