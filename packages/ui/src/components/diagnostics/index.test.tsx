import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import staticHtml from "../../../static/index.html?raw";
import type { DiagnosticEvent, DiagnosticEventsResponse } from "../../lib/api";
import { DiagnosticEventsRequestError } from "../../lib/api/diagnostics";

const dialogControls = vi.hoisted(() => ({
	onCloseAutoFocus: undefined as undefined | ((event: { preventDefault: () => void }) => void),
	onOpenAutoFocus: undefined as undefined | ((event: { preventDefault: () => void }) => void),
	onOpenChange: undefined as undefined | ((open: boolean) => void),
}));

vi.mock("../primitives/radix-dialog", () => ({
	RadixDialog: (props: {
		children?: ComponentChildren;
		contentId: string;
		onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
		onOpenAutoFocus?: (event: { preventDefault: () => void }) => void;
		onOpenChange: (open: boolean) => void;
		open: boolean;
	}) => {
		dialogControls.onCloseAutoFocus = props.onCloseAutoFocus;
		dialogControls.onOpenAutoFocus = props.onOpenAutoFocus;
		dialogControls.onOpenChange = props.onOpenChange;
		return props.open ? (
			<div id={props.contentId} role="dialog">
				{props.children}
			</div>
		) : null;
	},
	RadixDialogTitle: (props: { children?: ComponentChildren; id?: string; tabIndex?: number }) => (
		<h2 {...props}>{props.children}</h2>
	),
}));

import {
	closeDiagnosticsDrawer,
	coordinatedRefreshDiagnosticsDrawer,
	initDiagnosticsEntryPoints,
	mountDiagnosticsDrawer,
	openDiagnosticsDrawer,
	recordViewerConnectionEvent,
} from ".";
import { resetViewerConnectionEventsForTests } from "./viewer-connection-events";

function event(id: string, overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
	return {
		id,
		occurred_at: "2026-09-07T12:00:00.000Z",
		severity: "warning",
		subsystem: "capture",
		code: "capture_backlog_growing",
		message: "The capture queue is growing.",
		...overrides,
	};
}

function response(
	items: DiagnosticEvent[] = [],
	nextCursor: string | null = null,
	generatedAt = "2026-09-07T12:00:01.000Z",
): DiagnosticEventsResponse {
	return {
		contract_version: 1,
		items,
		next_cursor: nextCursor,
		redacted: true,
		generated_at: generatedAt,
	};
}

function setup(loadEvents = vi.fn().mockResolvedValue(response())) {
	document.body.innerHTML = `
		<button aria-current="page" class="tab-btn" id="tabBtn-health">Health</button>
		<button class="tab-btn" id="tabBtn-advanced">Advanced</button>
		<button id="healthOpenDiagnostics">View diagnostics</button>
		<button id="syncOpenDiagnostics">Recent sync events</button>
		<button id="viewerReconnectDiagnostics">View connection diagnostics</button>
		<div id="diagnosticsDrawerMount"></div>
	`;
	const mount = document.getElementById("diagnosticsDrawerMount");
	if (!(mount instanceof HTMLElement)) throw new Error("diagnostics mount missing");
	act(() => mountDiagnosticsDrawer(mount, { loadEvents }));
	return { loadEvents, mount };
}

function button(label: string): HTMLButtonElement {
	const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === label,
	);
	if (!match) throw new Error(`button missing: ${label}`);
	return match;
}

afterEach(() => {
	const mount = document.getElementById("diagnosticsDrawerMount");
	if (mount) act(() => render(null, mount));
	document.body.innerHTML = "";
	dialogControls.onCloseAutoFocus = undefined;
	dialogControls.onOpenAutoFocus = undefined;
	dialogControls.onOpenChange = undefined;
	resetViewerConnectionEventsForTests();
	vi.restoreAllMocks();
});

describe("diagnostics drawer", () => {
	it("opens from Health unfiltered and Advanced filtered to sync", async () => {
		const { loadEvents } = setup();
		initDiagnosticsEntryPoints();

		act(() => button("View diagnostics").click());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(1));
		expect(loadEvents).toHaveBeenLastCalledWith(expect.objectContaining({ subsystem: undefined }));
		act(() => button("Close").click());

		act(() => button("Recent sync events").click());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(2));
		expect(loadEvents).toHaveBeenLastCalledWith(expect.objectContaining({ subsystem: ["sync"] }));
		expect(
			document.querySelector<HTMLSelectElement>('[aria-label="Diagnostic subsystem"]')?.value,
		).toBe("sync");
		expect(document.body.textContent).toContain("Showing sync events");

		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("No events match the recent retained window"),
		);
		expect(button("Reset filters")).toBeInstanceOf(HTMLButtonElement);
		act(() => button("Reset filters").click());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(3));
		expect(loadEvents).toHaveBeenLastCalledWith(expect.objectContaining({ subsystem: undefined }));
	});

	it("ships a reconnect action that opens seeded viewer-session evidence", async () => {
		expect(staticHtml).toContain('id="viewerReconnectDiagnostics"');
		setup();
		recordViewerConnectionEvent("connection_lost");
		initDiagnosticsEntryPoints();

		act(() => button("View connection diagnostics").click());

		await vi.waitFor(() => expect(document.body.textContent).toContain("viewer_connection_lost"));
		expect(
			document.querySelector<HTMLSelectElement>('[aria-label="Diagnostic subsystem"]')?.value,
		).toBe("viewer");
	});

	it("focuses the title, aborts on close, and restores trigger focus", async () => {
		let requestSignal: AbortSignal | undefined;
		const loadEvents = vi.fn(
			(options: { signal?: AbortSignal }) =>
				new Promise<DiagnosticEventsResponse>(() => {
					requestSignal = options.signal;
				}),
		);
		setup(loadEvents);
		const trigger = button("View diagnostics");
		trigger.focus();

		act(() => openDiagnosticsDrawer({ trigger }));
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(1));
		act(() => dialogControls.onOpenAutoFocus?.({ preventDefault: vi.fn() }));
		expect(document.activeElement?.id).toBe("diagnosticsDrawerTitle");

		act(() => button("Close").click());
		expect(requestSignal?.aborted).toBe(true);
		act(() => dialogControls.onCloseAutoFocus?.({ preventDefault: vi.fn() }));
		expect(document.activeElement).toBe(trigger);
		expect(document.getElementById("diagnosticsDrawer")).toBeNull();
	});

	it("restores focus to Health when the invoking control no longer exists", async () => {
		setup();
		const transientTrigger = document.createElement("button");
		document.body.appendChild(transientTrigger);
		act(() => openDiagnosticsDrawer({ trigger: transientTrigger }));
		await vi.waitFor(() => expect(document.getElementById("diagnosticsDrawer")).not.toBeNull());
		transientTrigger.remove();

		act(() => button("Close").click());
		act(() => dialogControls.onCloseAutoFocus?.({ preventDefault: vi.fn() }));

		expect(document.activeElement?.id).toBe("tabBtn-health");
	});
});

describe("diagnostics drawer fallback focus and dismiss", () => {
	it("falls back to the current Advanced tab when the trigger becomes hidden", async () => {
		setup();
		document.getElementById("tabBtn-health")?.removeAttribute("aria-current");
		document.getElementById("tabBtn-advanced")?.setAttribute("aria-current", "page");
		const hiddenParent = document.createElement("div");
		const trigger = document.createElement("button");
		hiddenParent.appendChild(trigger);
		document.body.appendChild(hiddenParent);
		act(() => openDiagnosticsDrawer({ trigger }));
		await vi.waitFor(() => expect(document.getElementById("diagnosticsDrawer")).not.toBeNull());
		hiddenParent.hidden = true;

		act(() => button("Close").click());
		act(() => dialogControls.onCloseAutoFocus?.({ preventDefault: vi.fn() }));

		expect(document.activeElement?.id).toBe("tabBtn-advanced");
	});

	it("closes through the Radix open-change callback", async () => {
		let requestSignal: AbortSignal | undefined;
		const loadEvents = vi.fn(
			(options: { signal?: AbortSignal }) =>
				new Promise<DiagnosticEventsResponse>(() => {
					requestSignal = options.signal;
				}),
		);
		setup(loadEvents);
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.getElementById("diagnosticsDrawer")).not.toBeNull());

		act(() => dialogControls.onOpenChange?.(false));

		expect(requestSignal?.aborted).toBe(true);
		expect(document.getElementById("diagnosticsDrawer")).toBeNull();
	});
});

describe("diagnostics drawer automatic refresh", () => {
	it("pauses coordinated refresh and fetches immediately on resume", async () => {
		const { loadEvents } = setup(vi.fn().mockResolvedValue(response([event("one")])));
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(1));

		act(() => button("Pause updates").click());
		await coordinatedRefreshDiagnosticsDrawer();
		expect(loadEvents).toHaveBeenCalledTimes(1);
		expect(document.body.textContent).toContain("Updates are paused");

		act(() => button("Resume updates").click());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(2));
	});

	it("preserves loaded history and its cursor when resuming updates", async () => {
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce(response([event("newest")], "older-one"))
			.mockResolvedValueOnce(response([event("older")], "older-two"))
			.mockResolvedValueOnce(response([event("new-after-resume"), event("newest")]))
			.mockResolvedValueOnce(response([]));
		setup(loadEvents);
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(button("Load older").disabled).toBe(false));
		act(() => button("Load older").click());
		await vi.waitFor(() => expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(2));

		act(() => button("Pause updates").click());
		act(() => button("Resume updates").click());

		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(3));
		expect(loadEvents.mock.calls[2]?.[0].cursor).toBeUndefined();
		await vi.waitFor(() => expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(3));
		expect(button("Load older").disabled).toBe(false);
		act(() => button("Load older").click());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(4));
		expect(loadEvents.mock.calls[3]?.[0]).toEqual(expect.objectContaining({ cursor: "older-two" }));
	});

	it("does not run coordinated refresh while the page is hidden", async () => {
		const { loadEvents } = setup(vi.fn().mockResolvedValue(response([event("one")])));
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(1));
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

		await coordinatedRefreshDiagnosticsDrawer();

		expect(loadEvents).toHaveBeenCalledTimes(1);
	});
});

describe("diagnostics drawer paused actions", () => {
	it("holds viewer-session events until updates resume", async () => {
		setup(vi.fn().mockResolvedValue(response()));
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(button("Pause updates").disabled).toBe(false));
		act(() => button("Pause updates").click());

		act(() => recordViewerConnectionEvent("connection_lost"));

		expect(document.body.textContent).not.toContain("viewer_connection_lost");
		act(() => button("Resume updates").click());
		await vi.waitFor(() => expect(document.body.textContent).toContain("viewer_connection_lost"));
	});

	it("keeps held viewer-session events hidden during paused retry", async () => {
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce(response())
			.mockRejectedValueOnce(new Error("refresh failed"))
			.mockResolvedValue(response());
		setup(loadEvents);
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(button("Pause updates").disabled).toBe(false));
		await act(async () => coordinatedRefreshDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
		act(() => button("Pause updates").click());
		act(() => recordViewerConnectionEvent("connection_lost"));

		act(() => button("Retry").click());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(3));

		expect(document.body.textContent).not.toContain("viewer_connection_lost");
	});

	it("allows retry and filter requests while paused", async () => {
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce(response([event("one")]))
			.mockRejectedValueOnce(new Error("refresh failed"))
			.mockResolvedValue(response([event("two")]));
		setup(loadEvents);
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(1));
		await act(async () => coordinatedRefreshDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
		act(() => button("Pause updates").click());

		act(() => button("Retry").click());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(3));
		const severity = document.querySelector<HTMLSelectElement>(
			'[aria-label="Diagnostic severity"]',
		);
		if (!severity) throw new Error("severity filter missing");
		severity.value = "error";
		act(() => {
			severity.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(4));
		expect(loadEvents).toHaveBeenLastCalledWith(expect.objectContaining({ severity: ["error"] }));
	});

	it("clears loading when pausing an in-flight initial request", async () => {
		let requestSignal: AbortSignal | undefined;
		const loadEvents = vi.fn(
			(options: { signal?: AbortSignal }) =>
				new Promise<DiagnosticEventsResponse>(() => {
					requestSignal = options.signal;
				}),
		);
		setup(loadEvents);
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.querySelector(".diagnostics-loading")).not.toBeNull());

		act(() => button("Pause updates").click());

		expect(requestSignal?.aborted).toBe(true);
		expect(document.querySelector(".diagnostics-loading")).toBeNull();
		expect(document.body.textContent).toContain("Updates are paused");
	});
});

describe("diagnostics drawer updates and pagination", () => {
	it("replaces mutable fields for a known event id during polling", async () => {
		const refreshedEvent = event("one", {
			occurred_at: "2026-09-07T12:00:04.000Z",
			severity: "error",
			code: "capture_backlog_blocked",
			message: "The capture queue is blocked.",
		});
		const generatedAt = "2026-09-07T12:00:05.000Z";
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce(response([event("one")], "older"))
			.mockResolvedValueOnce(response([refreshedEvent], null, generatedAt));
		setup(loadEvents);
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.body.textContent).toContain("capture_backlog_growing"));
		const list = document.querySelector<HTMLElement>(".diagnostics-event-list");
		if (!list) throw new Error("event list missing");
		list.scrollTop = 100;

		await act(async () => coordinatedRefreshDiagnosticsDrawer());

		expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(1);
		expect(document.body.textContent).toContain("capture_backlog_blocked");
		expect(document.body.textContent).toContain("The capture queue is blocked.");
		expect(document.body.textContent).not.toContain("capture_backlog_growing");
		expect(document.querySelector(".diagnostics-generated-at")?.textContent).toContain(
			new Date(generatedAt).toLocaleTimeString(),
		);
	});

	it("queues polled events while reading older rows and shows them on request", async () => {
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce(response([event("one")], "older"))
			.mockResolvedValueOnce(response([event("two"), event("one")]));
		setup(loadEvents);
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.body.textContent).toContain("capture_backlog_growing"));
		const list = document.querySelector<HTMLElement>(".diagnostics-event-list");
		if (!list) throw new Error("event list missing");
		list.scrollTop = 100;

		await act(async () => coordinatedRefreshDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.body.textContent).toContain("Show 1 new event"));
		expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(1);

		act(() => button("Show 1 new event").click());
		expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(2);
	});
});

describe("diagnostics drawer queued row details", () => {
	it("does not offer filtered-out queued session events", async () => {
		setup(vi.fn().mockResolvedValue(response([event("sync", { subsystem: "sync" })])));
		act(() => openDiagnosticsDrawer({ subsystem: "sync" }));
		await vi.waitFor(() => expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(1));
		const list = document.querySelector<HTMLElement>(".diagnostics-event-list");
		if (!list) throw new Error("event list missing");
		list.scrollTop = 100;

		act(() => recordViewerConnectionEvent("connection_lost"));

		expect(document.body.textContent).not.toContain("Show 1 new event");
		expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(1);
	});

	it("loads and reconciles technical details for queued server events", async () => {
		const known = event("known");
		const queued = event("queued");
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce(response([known], "older"))
			.mockResolvedValueOnce(response([queued, known], "older"))
			.mockResolvedValueOnce(
				response(
					[{ ...known, technical_detail: { available: true, text: "known detail" } }],
					"technical-next",
				),
			)
			.mockResolvedValueOnce(
				response([{ ...queued, technical_detail: { available: true, text: "queued detail" } }]),
			);
		setup(loadEvents);
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(1));
		const list = document.querySelector<HTMLElement>(".diagnostics-event-list");
		if (!list) throw new Error("event list missing");
		list.scrollTop = 100;
		await act(async () => coordinatedRefreshDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.body.textContent).toContain("Show 1 new event"));

		act(() => button("Reveal technical details").click());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(4));
		expect(loadEvents.mock.calls[3]?.[0]).toEqual(
			expect.objectContaining({ cursor: "technical-next", includeTechnical: true }),
		);
		act(() => button("Show 1 new event").click());

		expect(document.body.textContent).toContain("queued detail");
	});
});

describe("diagnostics drawer queued promotion", () => {
	it("removes queued events when a top-of-list poll promotes them", async () => {
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce(response([event("one")], "older"))
			.mockResolvedValue(response([event("two"), event("one")]));
		setup(loadEvents);
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(1));
		const list = document.querySelector<HTMLElement>(".diagnostics-event-list");
		if (!list) throw new Error("event list missing");
		list.scrollTop = 100;
		await act(async () => coordinatedRefreshDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.body.textContent).toContain("Show 1 new event"));

		list.scrollTop = 0;
		await act(async () => coordinatedRefreshDiagnosticsDrawer());

		expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(2);
		expect(document.body.textContent).not.toContain("Show 1 new event");
	});

	it("keeps stale rows on failure and retries without exposing exception text", async () => {
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce(response([event("one")]))
			.mockRejectedValueOnce(new Error("private database path"))
			.mockResolvedValueOnce(response([event("two")]));
		setup(loadEvents);
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(1));

		await act(async () => coordinatedRefreshDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
		expect(document.body.textContent).toContain("Showing stale events");
		expect(document.body.textContent).not.toContain("private database path");
		expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("");

		act(() => button("Retry").click());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(3));
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull());
	});

	it("reloads the first page when an older-page cursor is rejected", async () => {
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce(response([event("one")], "stale-cursor"))
			.mockRejectedValueOnce(new DiagnosticEventsRequestError(400, "Bad Request"))
			.mockResolvedValueOnce(
				response([event("two", { message: "Fresh diagnostics page." })], "fresh-cursor"),
			);
		setup(loadEvents);
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(button("Load older").disabled).toBe(false));

		act(() => button("Load older").click());

		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(3));
		expect(loadEvents.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({ cursor: "stale-cursor" }),
		);
		expect(loadEvents.mock.calls[2]?.[0].cursor).toBeUndefined();
		await vi.waitFor(() => expect(document.body.textContent).toContain("Fresh diagnostics page."));
		expect(document.querySelector('[role="alert"]')).toBeNull();
	});
});

describe("diagnostics drawer retry history", () => {
	it("polls on retry so stale older history remains visible", async () => {
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce(
				response([
					event("newest", { message: "Newest retained event." }),
					event("older", {
						occurred_at: "2026-09-07T11:00:00.000Z",
						message: "Older retained event.",
					}),
				]),
			)
			.mockRejectedValueOnce(new Error("refresh failed"))
			.mockResolvedValueOnce(response([event("recovered", { message: "Recovered event." })]));
		setup(loadEvents);
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(2));
		await act(async () => coordinatedRefreshDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());

		act(() => button("Retry").click());

		await vi.waitFor(() => expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(3));
		expect(document.body.textContent).toContain("Newest retained event.");
		expect(document.body.textContent).toContain("Older retained event.");
		expect(document.body.textContent).toContain("Recovered event.");
	});
});

describe("diagnostics drawer local evidence controls", () => {
	it("keeps viewer events buffered before a paused clear hidden after resume", async () => {
		setup(vi.fn().mockResolvedValue(response()));
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(button("Pause updates").disabled).toBe(false));
		act(() => button("Pause updates").click());
		act(() => recordViewerConnectionEvent("connection_lost"));

		act(() => button("Clear view").click());
		act(() => button("Resume updates").click());

		await vi.waitFor(() => expect(button("Pause updates").disabled).toBe(false));
		expect(document.body.textContent).not.toContain("viewer_connection_lost");
		act(() => recordViewerConnectionEvent("reconnect_requested"));
		expect(document.body.textContent).toContain("viewer_reconnect_requested");
	});

	it("keeps cleared session rows hidden until reopen while allowing later evidence", async () => {
		recordViewerConnectionEvent("connection_lost");
		const { loadEvents } = setup(vi.fn().mockResolvedValue(response([event("one")], "cursor")));
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(2));

		act(() => button("Clear view").click());

		expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(0);
		expect(document.body.textContent).toContain("Not loaded yet");
		await act(async () => coordinatedRefreshDiagnosticsDrawer());
		expect(document.body.textContent).not.toContain("viewer_connection_lost");
		expect(document.body.textContent).toContain("capture_backlog_growing");
		for (const [options] of loadEvents.mock.calls) {
			expect(options).not.toHaveProperty("method");
		}
		act(() => recordViewerConnectionEvent("reconnect_requested"));
		expect(document.body.textContent).toContain("viewer_reconnect_requested");
		act(() => button("Close").click());
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.body.textContent).toContain("viewer_connection_lost"));

		expect(loadEvents).toHaveBeenCalledTimes(3);
		act(() => button("Close").click());
		await Promise.resolve();
	});

	it("warns and copies only visible redacted presentation fields", async () => {
		const sensitiveEvent = event("opaque-id", {
			recovery: { label: "Open Health", href: "#health", command: "private command" },
			correlation: { kind: "session", label: "Safe session label" },
			technical_detail: { available: true, text: "private technical detail" },
		});
		const hiddenEvent = event("hidden-id", {
			subsystem: "sync",
			message: "hidden sync message",
		});
		const queuedEvent = event("queued-id", { message: "queued capture message" });
		setup(
			vi
				.fn()
				.mockResolvedValueOnce(
					response([{ ...sensitiveEvent, technical_detail: { available: false } }, hiddenEvent]),
				)
				.mockResolvedValueOnce(response([sensitiveEvent, hiddenEvent]))
				.mockResolvedValueOnce(response([queuedEvent, sensitiveEvent, hiddenEvent]))
				.mockResolvedValue(response([sensitiveEvent, hiddenEvent])),
		);
		const confirm = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		act(() => openDiagnosticsDrawer({ subsystem: "capture" }));
		await vi.waitFor(() => expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(1));
		act(() => button("Reveal technical details").click());
		await vi.waitFor(() => expect(document.body.textContent).toContain("private technical detail"));
		const list = document.querySelector<HTMLElement>(".diagnostics-event-list");
		if (!list) throw new Error("event list missing");
		list.scrollTop = 100;
		await act(async () => coordinatedRefreshDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.body.textContent).toContain("Show 1 new event"));

		await act(async () => button("Copy visible redacted events").click());

		expect(confirm).toHaveBeenCalledWith(expect.stringContaining("sensitive operational context"));
		const copied = String(writeText.mock.calls[0]?.[0]);
		expect(copied).toContain('"recovery_label": "Open Health"');
		expect(copied).toContain('"correlation_label": "Safe session label"');
		expect(copied).not.toContain("opaque-id");
		expect(copied).not.toContain("private command");
		expect(copied).not.toContain("private technical detail");
		expect(copied).not.toContain("hidden sync message");
		expect(copied).not.toContain("queued capture message");
		expect(document.body.textContent).toContain("Visible redacted events copied.");

		const severity = document.querySelector<HTMLSelectElement>(
			'[aria-label="Diagnostic severity"]',
		);
		if (!severity) throw new Error("severity filter missing");
		severity.value = "warning";
		act(() => {
			severity.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(document.body.textContent).not.toContain("Visible redacted events copied.");
	});

	it("reports clipboard failure without exposing copied content", async () => {
		setup(vi.fn().mockResolvedValue(response([event("one")])));
		vi.spyOn(globalThis, "confirm").mockReturnValue(true);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: vi.fn().mockRejectedValue(new Error("clipboard denied")) },
		});
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(1));

		await act(async () => button("Copy visible redacted events").click());

		expect(document.body.textContent).toContain(
			"Visible events could not be copied. Check clipboard permission and try again.",
		);
		expect(document.body.textContent).not.toContain("clipboard denied");
	});
});

describe("diagnostics drawer filters and pagination", () => {
	it("refetches for filters and technical reveal, then bounds older pagination", async () => {
		const firstPage = Array.from({ length: 50 }, (_, index) => event(`first-${index}`));
		const olderPage = Array.from({ length: 250 }, (_, index) =>
			event(`older-${index}`, { severity: "error" }),
		);
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce(response(firstPage, "cursor-one"))
			.mockResolvedValueOnce(response([event("error", { severity: "error" })], "cursor-filter"))
			.mockResolvedValueOnce(
				response(
					[
						event("error", {
							severity: "error",
							technical_detail: { available: true, text: "bounded detail" },
						}),
					],
					null,
				),
			)
			.mockResolvedValueOnce(response(olderPage, "cursor-two"));
		setup(loadEvents);
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(1));

		const severity = document.querySelector<HTMLSelectElement>(
			'[aria-label="Diagnostic severity"]',
		);
		if (!severity) throw new Error("severity filter missing");
		severity.value = "error";
		act(() => {
			severity.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(2));
		expect(loadEvents).toHaveBeenLastCalledWith(expect.objectContaining({ severity: ["error"] }));

		await vi.waitFor(() => expect(button("Reveal technical details").disabled).toBe(false));
		act(() => button("Reveal technical details").click());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(3));
		expect(loadEvents).toHaveBeenLastCalledWith(
			expect.objectContaining({ includeTechnical: true }),
		);
		await vi.waitFor(() => expect(document.body.textContent).toContain("bounded detail"));

		act(() => button("Load older").click());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(4));
		expect(loadEvents.mock.calls[3]?.[0]).toEqual(
			expect.objectContaining({ cursor: "cursor-filter", includeTechnical: true }),
		);
		await vi.waitFor(() =>
			expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(200),
		);
	});
});

describe("diagnostics drawer recovery navigation", () => {
	it("closes and resets before following an allowlisted recovery hash", async () => {
		window.location.hash = "";
		const recoveryEvent = event("recovery", {
			subsystem: "sync",
			recovery: { href: "#health", label: "Open Health" },
		});
		const { loadEvents } = setup(vi.fn().mockResolvedValue(response([recoveryEvent])));
		act(() => openDiagnosticsDrawer({ subsystem: "sync" }));
		await vi.waitFor(() => expect(document.querySelector("a.diagnostics-recovery")).not.toBeNull());
		const recoveryLink = document.querySelector<HTMLAnchorElement>("a.diagnostics-recovery");
		if (!recoveryLink) throw new Error("recovery link missing");

		act(() => recoveryLink.click());

		expect(document.getElementById("diagnosticsDrawer")).toBeNull();
		await vi.waitFor(() => expect(window.location.hash).toBe("#health"));
		await vi.waitFor(() => expect(document.activeElement?.id).toBe("tabBtn-health"));
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(2));
		expect(loadEvents).toHaveBeenLastCalledWith(
			expect.objectContaining({ includeTechnical: false, subsystem: undefined }),
		);
	});

	it("can be closed externally when reconnecting", async () => {
		setup();
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.getElementById("diagnosticsDrawer")).not.toBeNull());

		act(() => closeDiagnosticsDrawer());

		expect(document.getElementById("diagnosticsDrawer")).toBeNull();
	});

	it("does not render anchors for unknown or missing recovery hrefs", async () => {
		const unknownHref = {
			...event("unknown"),
			recovery: { href: "javascript:alert(1)", label: "Unsafe" },
		} as unknown as DiagnosticEvent;
		const commandOnly = event("command", {
			recovery: { command: "codemem status", label: "Inspect status" },
		});
		setup(vi.fn().mockResolvedValue(response([unknownHref, commandOnly])));
		act(() => openDiagnosticsDrawer());
		await vi.waitFor(() => expect(document.querySelectorAll(".diagnostics-event")).toHaveLength(2));

		expect(document.querySelector("a.diagnostics-recovery")).toBeNull();
		expect(document.body.textContent).toContain("codemem status");
	});
});
