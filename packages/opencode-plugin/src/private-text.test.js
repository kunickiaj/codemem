import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ingestRawEvents, MemoryStore } from "../../core/src/index.ts";
import { createDelegationContext } from "../.opencode/lib/delegation-context.js";
import {
	sanitizeRawEventEnvelope,
	stripPrivate,
	stripPrivateValues,
} from "../.opencode/lib/private-text.mjs";
import { createRawEventDelivery } from "../.opencode/lib/raw-event-delivery.js";
import { loadRawEventSpoolEntries } from "../.opencode/lib/raw-event-spool.js";
import { __testUtils } from "../.opencode/lib/runtime.js";

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

/** Every byte the plugin wrote under its home directory. */
async function persistedBytes(home) {
	const files = await readdir(home, { recursive: true, withFileTypes: true });
	const texts = await Promise.all(
		files
			.filter((entry) => entry.isFile())
			.map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
	);
	return texts.join("\n");
}

test("spools only routing fields and cleaned content, and drops a marked capture context", async () => {
	const home = await mkdtemp(join(tmpdir(), "codemem-spool-allowlist-"));
	const delivery = failedViewerDelivery(home, () => ({
		session_stream_id: "child",
		session_id: "child",
		event_id: "allowlist-event",
		event_type: "user_prompt",
		ts_wall_ms: 1,
		notes: "unknown field <private>SECRET</private>",
		payload: { type: "user_prompt", prompt_text: "ask <private>SECRET</private> now" },
		capture_context: { version: 1, requested_agent: "explore<private>SECRET</private>" },
	}));
	try {
		await delivery.deliver({ sessionID: "child", type: "user_prompt", payload: {} });
		const bytes = await persistedBytes(home);
		const { entries } = await loadRawEventSpoolEntries({ homeDir: home });

		expect(bytes).not.toContain("SECRET");
		expect(JSON.parse(entries[0].serialized)).toEqual({
			session_stream_id: "child",
			session_id: "child",
			event_id: "allowlist-event",
			event_type: "user_prompt",
			ts_wall_ms: 1,
			payload: { type: "user_prompt", prompt_text: "ask  now" },
		});
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

/** The provenance the plugin records for a brief delegated to the `explore` agent. */
async function delegatedBriefContext(brief) {
	const binding = createDelegationContext({
		readSession: async () => ({ id: "child", parentID: "parent" }),
		readMessage: async (_session, id) => ({
			info: { id, sessionID: "child", role: "user", agent: "explore", time: { created: 201 } },
			parts: [{ id: "part-1", sessionID: "child", messageID: id, type: "text", text: brief }],
		}),
		now: () => 200,
	});
	binding.observe({
		type: "message.part.updated",
		properties: {
			part: {
				type: "tool",
				tool: "task",
				callID: "call-1",
				sessionID: "parent",
				messageID: "parent-message",
				state: {
					status: "running",
					time: { start: 200 },
					input: { subagent_type: "explore", description: "Inspect", prompt: brief },
					metadata: { parentSessionId: "parent", sessionId: "child" },
				},
			},
		},
	});
	return binding.resolve({
		sessionID: "child",
		messageID: "msg-1",
		text: brief,
	});
}

test("keeps delegated-brief attribution for a brief with a private block through spool and ingest", async () => {
	const brief = "Inspect the queue <private>SECRET</private> and report.";
	const captureContext = await delegatedBriefContext(brief);
	expect(captureContext).toMatchObject({ origin: "delegated_brief" });
	const envelope = __testUtils.buildRawEventEnvelope({
		sessionID: "child",
		type: "user_prompt",
		payload: { type: "user_prompt", prompt_number: 1, prompt_text: brief },
		nextEventId: () => "brief-event",
		nowMs: 123,
		nowMono: 1,
		cwd: null,
		project: null,
		startedAt: null,
		captureContext,
	});
	const home = await mkdtemp(join(tmpdir(), "codemem-spool-brief-"));
	const store = new MemoryStore(join(home, "mem.sqlite"));
	try {
		await failedViewerDelivery(home, () => envelope).deliver({
			sessionID: "child",
			type: "user_prompt",
			payload: {},
		});
		const { entries } = await loadRawEventSpoolEntries({ homeDir: home });
		expect(entries[0].serialized).not.toContain("SECRET");
		ingestRawEvents(store, JSON.parse(entries[0].serialized));

		const row = store.db
			.prepare("SELECT capture_context_json FROM raw_events WHERE event_id = 'brief-event'")
			.get();
		expect(JSON.parse(row.capture_context_json)).toMatchObject({
			origin: "delegated_brief",
			brief_sha256: createHash("sha256").update("Inspect the queue  and report.").digest("hex"),
		});
	} finally {
		store.close();
		await rm(home, { recursive: true, force: true });
	}
});
