import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticEventsRequestError, loadDiagnosticEvents } from "./diagnostics";

const originalFetch = globalThis.fetch;

function validResponse(overrides: Record<string, unknown> = {}) {
	return {
		contract_version: 1,
		items: [],
		next_cursor: null,
		redacted: true,
		generated_at: "2026-09-07T12:00:00.000Z",
		...overrides,
	};
}

function validEvent(overrides: Record<string, unknown> = {}) {
	return {
		id: "event-id",
		occurred_at: "2026-09-07T12:00:00.000Z",
		severity: "warning",
		subsystem: "capture",
		code: "capture_backlog_growing",
		message: "The capture queue is growing.",
		...overrides,
	};
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("diagnostics API", () => {
	it("encodes filters and sends an abortable no-store GET", async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify(validResponse()), { status: 200 }),
		);
		globalThis.fetch = fetchMock as typeof fetch;
		const controller = new AbortController();

		await loadDiagnosticEvents({
			limit: 50,
			cursor: "opaque cursor/+",
			severity: ["warning", "error"],
			subsystem: ["observer", "capture"],
			includeTechnical: true,
			signal: controller.signal,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/diagnostics/events?limit=50&cursor=opaque+cursor%2F%2B&severity=warning%2Cerror&subsystem=observer%2Ccapture&includeTechnical=1",
			{ cache: "no-store", method: "GET", signal: controller.signal },
		);
	});

	it("uses redacted defaults and accepts contract version 1", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify(validResponse()), { status: 200 }),
		) as typeof fetch;

		const response = await loadDiagnosticEvents();

		expect(response.contract_version).toBe(1);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"/api/diagnostics/events?includeTechnical=0",
			expect.objectContaining({ cache: "no-store", method: "GET" }),
		);
	});

	it("preserves the HTTP status for cursor recovery decisions", async () => {
		globalThis.fetch = vi.fn(async () => new Response(null, { status: 400 })) as typeof fetch;

		const request = loadDiagnosticEvents({ cursor: "stale" });

		await expect(request).rejects.toMatchObject({
			name: DiagnosticEventsRequestError.name,
			status: 400,
		});
	});

	it.each([
		validResponse({ contract_version: 2 }),
		validResponse({ items: null }),
		validResponse({ next_cursor: 3 }),
		validResponse({ redacted: "yes" }),
		validResponse({ generated_at: null }),
	])("rejects an unsupported top-level response shape", async (payload) => {
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify(payload), { status: 200 }),
		) as typeof fetch;

		await expect(loadDiagnosticEvents()).rejects.toThrow("Unsupported diagnostics response");
	});
});

describe("diagnostics API event validation", () => {
	it("accepts exact safe optional shapes and allowlisted recovery routes", async () => {
		const payload = validResponse({
			items: [
				validEvent({
					correlation: { kind: "operation", label: "Sync attempt" },
					recovery: {
						command: "codemem status",
						href: "#advanced/sync/diagnostics",
						label: "Open sync diagnostics",
					},
					technical_detail: { available: true, text: "Bounded detail" },
				}),
			],
		});
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify(payload), { status: 200 }),
		) as typeof fetch;

		await expect(loadDiagnosticEvents()).resolves.toMatchObject(payload);
	});

	it.each([
		validEvent({ id: "" }),
		validEvent({ id: "x".repeat(129) }),
		validEvent({ occurred_at: "not-a-date" }),
		validEvent({ severity: "critical" }),
		validEvent({ subsystem: "network" }),
		validEvent({ code: "" }),
		validEvent({ message: "x".repeat(2_001) }),
		validEvent({ raw_error: "private path" }),
	])("drops malformed required event fields", async (malformedEvent) => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify(validResponse({ items: [malformedEvent] })), {
					status: 200,
				}),
		) as typeof fetch;

		await expect(loadDiagnosticEvents()).resolves.toMatchObject({ items: [] });
	});

	it.each([
		validEvent({ recovery: { label: "Unsafe", href: "javascript:alert(1)" } }),
		validEvent({ recovery: { label: "External", href: "https://example.com" } }),
		validEvent({ recovery: { label: "Unknown", href: "#settings" } }),
		validEvent({ recovery: { label: "Health", href: "#health", extra: true } }),
		validEvent({ correlation: { kind: "peer", label: "Peer" } }),
		validEvent({ correlation: { kind: "session", label: "", secret: "value" } }),
		validEvent({ technical_detail: { available: false, text: "unexpected" } }),
		validEvent({ technical_detail: { available: true, text: "x".repeat(2_001) } }),
	])("drops unsafe optional event fields", async (malformedEvent) => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify(validResponse({ items: [malformedEvent] })), {
					status: 200,
				}),
		) as typeof fetch;

		await expect(loadDiagnosticEvents()).resolves.toMatchObject({ items: [] });
	});

	it("keeps valid server failure rows when another item fails validation", async () => {
		const observerFailure = validEvent({
			id: "observer-failure",
			severity: "error",
			subsystem: "observer",
			code: "observer_flush_failed",
			message: "Processing failed and queued events are waiting for retry.",
			recovery: { label: "Open Health", href: "#health" },
		});
		const payload = validResponse({
			items: [observerFailure, validEvent({ recovery: { label: "Unsafe", href: "#settings" } })],
		});
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify(payload), { status: 200 }),
		) as typeof fetch;

		await expect(loadDiagnosticEvents()).resolves.toMatchObject({ items: [observerFailure] });
	});
});
