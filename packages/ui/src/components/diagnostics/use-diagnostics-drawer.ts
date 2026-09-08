import { useEffect, useReducer, useRef } from "preact/hooks";
import {
	type DiagnosticEventSeverity,
	type DiagnosticEventSubsystem,
	DiagnosticEventsRequestError,
	type DiagnosticEventsResponse,
	type DiagnosticRecoveryHref,
	type LoadDiagnosticEventsOptions,
	type loadDiagnosticEvents,
} from "../../lib/api/diagnostics";
import { loadPollCatchup } from "./poll-catchup";
import {
	type DiagnosticsDrawerAction,
	type DiagnosticsDrawerState,
	diagnosticsDrawerReducer,
	initialDiagnosticsDrawerState,
	MAX_ROWS,
	mergeUnique,
	PAGE_SIZE,
	type RequestMode,
} from "./state";
import { loadTechnicalHistory } from "./technical-history";

type EventLoader = typeof loadDiagnosticEvents;
type RequestReason = "routine" | "retry";
type RequestRunner = (mode: RequestMode, reason?: RequestReason) => Promise<void>;

export type OpenDiagnosticsDrawerOptions = {
	severity?: DiagnosticEventSeverity;
	subsystem?: DiagnosticEventSubsystem;
	trigger?: HTMLElement | null;
};

export type DiagnosticsDrawerDependencies = {
	loadEvents?: EventLoader;
};

function requestOptions(
	mode: RequestMode,
	state: ReturnType<typeof initialDiagnosticsDrawerState>,
	signal: AbortSignal,
): LoadDiagnosticEventsOptions {
	const remaining = MAX_ROWS - state.rows.length;
	return {
		limit: mode === "older" ? Math.max(1, Math.min(PAGE_SIZE, remaining)) : PAGE_SIZE,
		cursor: mode === "older" ? (state.nextCursor ?? undefined) : undefined,
		severity: state.severity ? [state.severity] : undefined,
		subsystem: state.subsystem ? [state.subsystem] : undefined,
		includeTechnical: state.includeTechnical,
		signal,
	};
}

async function loadForMode(
	loadEvents: EventLoader,
	mode: RequestMode,
	state: DiagnosticsDrawerState,
	signal: AbortSignal,
): Promise<DiagnosticEventsResponse> {
	const request = requestOptions(mode, state, signal);
	if (mode === "technical") {
		return loadTechnicalHistory({
			loadEvents,
			request,
			// Every retained row must be covered; the bounded loader fails
			// (re-enabling reveal) rather than silently skipping the oldest rows.
			existingRows: mergeUnique(
				[...state.queuedRows, ...state.rows],
				state.queuedRows.length + state.rows.length,
			),
		});
	}
	if (mode !== "poll") return loadEvents(request);
	return loadPollCatchup({
		loadEvents,
		request,
		existingRows: state.rows,
		existingNextCursor: state.nextCursor,
	});
}

function shouldRestartQuery(mode: RequestMode, error: unknown): boolean {
	return mode === "older" && error instanceof DiagnosticEventsRequestError && error.status === 400;
}

function isReadingOlder(listRef: { current: HTMLDivElement | null }): boolean {
	return listRef.current !== null && listRef.current.scrollTop > 24;
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

const FOCUSABLE_SELECTOR = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[tabindex]:not([tabindex="-1"])',
].join(",");

function isUsableFocusTarget(element: HTMLElement | null): element is HTMLElement {
	if (!element?.isConnected || !element.matches(FOCUSABLE_SELECTOR)) return false;
	if (element.matches(':disabled, [aria-disabled="true"]')) return false;
	let current: HTMLElement | null = element;
	while (current) {
		if (current.hidden || current.inert || current.hasAttribute("inert")) return false;
		if (current.getAttribute("aria-hidden") === "true") return false;
		const style = getComputedStyle(current);
		if (
			style.display === "none" ||
			style.visibility === "hidden" ||
			style.visibility === "collapse" ||
			style.opacity === "0"
		) {
			return false;
		}
		current = current.parentElement;
	}
	return true;
}

function currentTabFocusTarget(): HTMLElement | null {
	const currentTab = document.querySelector<HTMLElement>('.tab-btn[aria-current="page"]');
	return isUsableFocusTarget(currentTab) ? currentTab : null;
}

function recoveryTabFocusTarget(href: DiagnosticRecoveryHref): HTMLElement | null {
	const tabId = href === "#health" ? "health" : "advanced";
	return document.getElementById(`tabBtn-${tabId}`);
}

function restoreDrawerFocus(
	event: { preventDefault: () => void },
	openerRef: { current: HTMLElement | null },
	recoveryNavigationRef: { current: boolean },
): void {
	event.preventDefault();
	if (recoveryNavigationRef.current) {
		recoveryNavigationRef.current = false;
		openerRef.current = null;
		return;
	}
	const target = openerRef.current;
	if (isUsableFocusTarget(target)) target.focus();
	else currentTabFocusTarget()?.focus();
	openerRef.current = null;
}

type DrawerActionContext = {
	state: DiagnosticsDrawerState;
	dispatch: (action: DiagnosticsDrawerAction) => void;
	abortRequest: () => void;
	runRequest: RequestRunner;
	openerRef: { current: HTMLElement | null };
	recoveryNavigationRef: { current: boolean };
	listRef: { current: HTMLDivElement | null };
};

function createDrawerActions(context: DrawerActionContext) {
	const { state, dispatch, abortRequest, runRequest, openerRef, recoveryNavigationRef, listRef } =
		context;
	return {
		open(options: OpenDiagnosticsDrawerOptions = {}) {
			abortRequest();
			recoveryNavigationRef.current = false;
			openerRef.current = options.trigger ?? (document.activeElement as HTMLElement | null);
			dispatch({
				type: "open",
				severity: options.severity ?? "",
				subsystem: options.subsystem ?? "",
			});
		},
		close() {
			abortRequest();
			dispatch({ type: "close" });
		},
		navigateToRecovery(href: DiagnosticRecoveryHref) {
			abortRequest();
			recoveryNavigationRef.current = true;
			dispatch({ type: "close" });
			queueMicrotask(() => {
				window.location.hash = href;
				setTimeout(() => recoveryTabFocusTarget(href)?.focus(), 0);
			});
		},
		refresh: () => runRequest("poll"),
		retry: () => runRequest(state.rows.length > 0 ? "poll" : "replace", "retry"),
		loadOlder: () => runRequest("older"),
		setSeverity(severity: DiagnosticEventSeverity | "") {
			abortRequest();
			dispatch({ type: "set_severity", severity });
		},
		setSubsystem(subsystem: DiagnosticEventSubsystem | "") {
			abortRequest();
			dispatch({ type: "set_subsystem", subsystem });
		},
		resetFilters() {
			abortRequest();
			dispatch({ type: "reset_filters" });
		},
		togglePaused() {
			if (!state.paused) abortRequest();
			dispatch({ type: "set_paused", paused: !state.paused });
		},
		revealTechnical() {
			abortRequest();
			dispatch({ type: "reveal_technical" });
		},
		showQueued() {
			dispatch({ type: "show_queued" });
			if (listRef.current) listRef.current.scrollTop = 0;
		},
		restoreFocus(event: { preventDefault: () => void }) {
			restoreDrawerFocus(event, openerRef, recoveryNavigationRef);
		},
	};
}

function useRequestRefs(state: DiagnosticsDrawerState) {
	const stateRef = useRef(state);
	const requestRef = useRef<{
		controller: AbortController;
		generation: number;
	} | null>(null);
	const generationRef = useRef(0);
	stateRef.current = state;
	return { stateRef, requestRef, generationRef };
}

function useQueryRequests(state: DiagnosticsDrawerState, runRequest: RequestRunner) {
	const runnerRef = useRef(runRequest);
	runnerRef.current = runRequest;
	useEffect(() => {
		if (!state.open) return;
		void runnerRef.current("replace");
	}, [state.open, state.queryRevision]);
	useEffect(() => {
		if (!state.open || state.pollRevision === 0) return;
		void runnerRef.current("poll");
	}, [state.open, state.pollRevision]);
	useEffect(() => {
		if (!state.open || !state.includeTechnical) return;
		void runnerRef.current("technical");
	}, [state.includeTechnical, state.open]);
}

export function useDiagnosticsDrawer(loadEvents: EventLoader) {
	const [state, dispatch] = useReducer(diagnosticsDrawerReducer, initialDiagnosticsDrawerState());
	const { stateRef, requestRef, generationRef } = useRequestRefs(state);
	const openerRef = useRef<HTMLElement | null>(null);
	const recoveryNavigationRef = useRef(false);
	const listRef = useRef<HTMLDivElement | null>(null);

	function abortRequest() {
		generationRef.current += 1;
		requestRef.current?.controller.abort();
		requestRef.current = null;
	}

	function shouldSkipRequest(mode: RequestMode, reason: RequestReason): boolean {
		const current = stateRef.current;
		if (!current.open) return true;
		if (mode !== "poll") return false;
		if (requestRef.current !== null) return true;
		if (reason === "retry") return false;
		return current.paused || document.visibilityState === "hidden";
	}

	async function runRequest(mode: RequestMode, reason: RequestReason = "routine"): Promise<void> {
		if (shouldSkipRequest(mode, reason)) return;
		const controller = new AbortController();
		requestRef.current?.controller.abort();
		const generation = ++generationRef.current;
		requestRef.current = { controller, generation };
		dispatch({ type: "request_started", mode });
		try {
			const current = stateRef.current;
			const response = await loadForMode(loadEvents, mode, current, controller.signal);
			if (generation !== generationRef.current) return;
			dispatch({
				type: "request_succeeded",
				mode,
				response,
				readingOlder: isReadingOlder(listRef),
			});
		} catch (error) {
			if (generation !== generationRef.current || isAbortError(error)) return;
			dispatch({
				type: "request_failed",
				mode,
				restartQuery: shouldRestartQuery(mode, error),
			});
		} finally {
			if (generation === generationRef.current) requestRef.current = null;
		}
	}

	useQueryRequests(state, runRequest);
	const actions = createDrawerActions({
		state,
		dispatch,
		abortRequest,
		runRequest,
		openerRef,
		recoveryNavigationRef,
		listRef,
	});
	return { state, listRef, ...actions };
}
