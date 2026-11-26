import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	sanitizeRawEventEnvelope,
	stripPrivate,
	stripPrivateValues,
} from "../.opencode/lib/private-text.mjs";
import { createRawEventDelivery } from "../.opencode/lib/raw-event-delivery.js";
import { loadRawEventSpoolEntries } from "../.opencode/lib/raw-event-spool.js";

// The same vectors core's lexer is tested with.
const { vectors } = JSON.parse(
	readFileSync(new URL("../../core/src/private-text-vectors.json", import.meta.url), "utf8"),
);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("plugin private-text lexer", () => {
	test.each(vectors)("handles $name", ({ input, expected }) => {
		expect(stripPrivate(input)).toBe(expected);
	});

	test("scans each value of an object on its own and drops a marked key", () => {
		expect(
			stripPrivateValues({ a: "x <private>open", b: "kept", "<private>k</private>": "gone", n: 3 }),
		).toEqual({ a: "x ", b: "kept", n: 3 });
	});

	test("leaves routing fields of an envelope exactly as built", () => {
		const envelope = {
			session_stream_id: "<private>s</private>",
			event_id: "event-1",
			event_type: "user_prompt",
			payload: { prompt_text: "ask <private>SECRET</private> now" },
			cwd: "/work/<private>SECRET</private>",
		};

		expect(sanitizeRawEventEnvelope(envelope)).toEqual({
			...envelope,
			payload: { prompt_text: "ask  now" },
			cwd: "/work/",
		});
	});
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
		nextEventId: () => "private-event",
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

test("writes no private text to the retry spool during a viewer outage", async () => {
	const home = await mkdtemp(join(tmpdir(), "codemem-spool-private-"));
	const delivery = failedViewerDelivery(home, () => ({
		event_id: "private-event",
		event_type: "user_prompt",
		session_id: "session-1",
		ts_wall_ms: 1,
		payload: { prompt_text: "ask <PRIVATE note='a > b'>SECRET</private> now" },
		cwd: "/work/<private>SECRET",
	}));
	try {
		expect(
			await delivery.deliver({ sessionID: "session-1", type: "user_prompt", payload: {} }),
		).toBe(true);
		const { entries } = await loadRawEventSpoolEntries({ homeDir: home });

		expect(entries).toHaveLength(1);
		expect(entries[0].serialized).not.toContain("SECRET");
		expect(JSON.parse(entries[0].serialized)).toMatchObject({
			event_id: "private-event",
			payload: { prompt_text: "ask  now" },
			cwd: "/work/",
		});
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
