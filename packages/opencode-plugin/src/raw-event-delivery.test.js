import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createRawEventDelivery } from "../.opencode/lib/raw-event-delivery.js";

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
