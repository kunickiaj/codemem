import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createRawEventDelivery } from "../.opencode/lib/raw-event-delivery.js";
import { loadRawEventSpoolEntries } from "../.opencode/lib/raw-event-spool.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test("uses the delivery start time in the exact serialized envelope", async () => {
	const home = await mkdtemp(join(tmpdir(), "codemem-delivery-"));
	const buildEnvelope = vi.fn(({ nowMs }) => ({ event_id: "event-1", now_ms: nowMs }));
	vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValue(200);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 204 })),
	);
	const delivery = createRawEventDelivery({
		backoffMs: 1_000,
		buildEnvelope,
		classifyFallbackResult: () => ({ cause: "failed", retryable: false }),
		classifyViewerFailure: () => "connection",
		cwd: home,
		discardResponseBody: () => {},
		enabled: true,
		failureActions: { connection: "restart" },
		fetchRawEventsStatus: async () =>
			new Response(JSON.stringify({ ingest: { available: true } }), { status: 200 }),
		hostLog: async () => {},
		hostNotify: null,
		identityTarget: null,
		isActive: () => true,
		logLine: async () => {},
		nextEventId: () => "event-1",
		projectName: "project",
		promptPackDbPath: join(home, "mem.sqlite"),
		queueViaCli: async () => ({ exitCode: 0 }),
		rawEventsStatusTimeoutMs: 5_000,
		rawEventsStatusUrl: "http://viewer/status",
		rawEventsUrl: "http://viewer/events",
		sessionStartedAt: () => 50,
		spoolHome: home,
		statusCheckMs: 30_000,
	});

	try {
		await delivery.deliver({ sessionID: "session-1", type: "prompt", payload: {} });
		expect(buildEnvelope).toHaveBeenCalledWith(expect.objectContaining({ nowMs: 100 }));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("does not drain retained events while viewer transport backoff is active", async () => {
	const home = await mkdtemp(join(tmpdir(), "codemem-delivery-backoff-"));
	const fetchMock = vi.fn(async () => {
		throw new Error("viewer unavailable");
	});
	vi.stubGlobal("fetch", fetchMock);
	const delivery = createRawEventDelivery({
		backoffMs: 30_000,
		buildEnvelope: () => ({ event_id: "event-backoff", payload: {} }),
		classifyViewerFailure: () => "connection",
		cwd: home,
		discardResponseBody: () => {},
		enabled: true,
		failureActions: { connection: "restart" },
		fetchRawEventsStatus: async () =>
			new Response(JSON.stringify({ ingest: { available: true } }), { status: 200 }),
		hostLog: async () => {},
		hostNotify: null,
		identityTarget: null,
		isActive: () => true,
		logLine: async () => {},
		nextEventId: () => "event-backoff",
		projectName: "project",
		promptPackDbPath: join(home, "mem.sqlite"),
		rawEventsStatusTimeoutMs: 5_000,
		rawEventsStatusUrl: "http://viewer/status",
		rawEventsUrl: "http://viewer/events",
		sessionStartedAt: () => 50,
		spoolHome: home,
		statusCheckMs: 30_000,
	});

	try {
		await delivery.deliver({ sessionID: "session-backoff", type: "prompt", payload: {} });
		expect(fetchMock).toHaveBeenCalledOnce();
		await delivery.drainSpool();
		expect(fetchMock).toHaveBeenCalledOnce();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

function failedViewerDelivery(home, buildEnvelope) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new DOMException("synthetic timeout", "TimeoutError");
		}),
	);
	return createRawEventDelivery({
		backoffMs: 10_000,
		buildEnvelope,
		classifyViewerFailure: () => "connection",
		cwd: home,
		discardResponseBody: () => {},
		enabled: true,
		failureActions: { connection: "check viewer" },
		fetchRawEventsStatus: async () =>
			new Response(JSON.stringify({ ingest: { available: true } }), { status: 200 }),
		hostLog: async () => {},
		hostNotify: null,
		identityTarget: null,
		isActive: () => true,
		logLine: async () => {},
		nextEventId: () => "same-event-id",
		projectName: "synthetic",
		promptPackDbPath: join(home, "mem.sqlite"),
		rawEventsStatusTimeoutMs: 100,
		rawEventsStatusUrl: "http://viewer/status",
		rawEventsUrl: "http://viewer/events",
		sessionStartedAt: () => 1,
		spoolHome: home,
		statusCheckMs: 30_000,
	});
}

test("reuses an already durable event when only delivery timestamps changed", async () => {
	const home = await mkdtemp(join(tmpdir(), "codemem-spool-timestamp-"));
	let stamp = 0;
	const delivery = failedViewerDelivery(home, () => ({
		event_id: "same-event-id",
		event_type: "user_prompt",
		session_id: "session-1",
		ts_wall_ms: ++stamp,
		ts_mono_ms: stamp / 10,
		payload: { prompt_text: "same semantic event" },
	}));
	try {
		expect(
			await delivery.deliver({ sessionID: "session-1", type: "user_prompt", payload: {} }),
		).toBe(true);
		const first = (await loadRawEventSpoolEntries({ homeDir: home })).entries[0].serialized;
		expect(
			await delivery.deliver({ sessionID: "session-1", type: "user_prompt", payload: {} }),
		).toBe(true);
		const after = await loadRawEventSpoolEntries({ homeDir: home });
		expect(after.entries).toHaveLength(1);
		expect(after.entries[0].serialized).toBe(first);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("still rejects a duplicate ID with different event content", async () => {
	const home = await mkdtemp(join(tmpdir(), "codemem-spool-semantic-conflict-"));
	let stamp = 0;
	const delivery = failedViewerDelivery(home, () => ({
		event_id: "same-event-id",
		event_type: "user_prompt",
		session_id: "session-1",
		ts_wall_ms: ++stamp,
		ts_mono_ms: stamp / 10,
		payload: { prompt_text: stamp === 1 ? "first content" : "different content" },
	}));
	try {
		expect(
			await delivery.deliver({ sessionID: "session-1", type: "user_prompt", payload: {} }),
		).toBe(true);
		const first = (await loadRawEventSpoolEntries({ homeDir: home })).entries[0].serialized;
		expect(
			await delivery.deliver({ sessionID: "session-1", type: "user_prompt", payload: {} }),
		).toBe(false);
		expect((await loadRawEventSpoolEntries({ homeDir: home })).entries[0].serialized).toBe(first);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
