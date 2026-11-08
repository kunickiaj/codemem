import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as deliveryModule from "../.opencode/lib/raw-event-delivery.js";
import * as spool from "../.opencode/lib/raw-event-spool.js";

vi.mock("../.opencode/lib/raw-event-spool.js", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		writeRawEventSpoolEntry: vi.fn(actual.writeRawEventSpoolEntry),
		retainRejectedRawEventSpoolEntry: vi.fn(actual.retainRejectedRawEventSpoolEntry),
	};
});

const homes = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

// Pin the client's recognized messages independently of the classifier implementation.
const validationErrors = [
	"source must be string",
	"source is required",
	"source must use 1-64 letters, digits, dots, underscores, or hyphens",
	"session_stream_id must be string",
	"session_id must be string",
	"stream_id must be string",
	"opencode_session_id must be string",
	"conflicting session id fields",
	"invalid session id",
	"event source conflicts with request source",
	"session id required",
	"event_type must be string",
	"event_type required",
	"event_type has invalid syntax",
	"event_id must be string",
	"event_id required",
	"event_id has invalid syntax",
	"event_seq must be int",
	"ts_wall_ms must be number",
	"ts_mono_ms must be number",
	"payload must be an object",
	"cwd must be string",
	"project must be string",
	"started_at must be string",
	"events must be a list",
	"event must be an object",
];

test.each(validationErrors)("terminal classifier accepts exact route validation: %s", (error) => {
	// Arrange
	const input = { status: 400, responseBody: { error }, outgoingBytes: 100 };
	// Act
	const result = deliveryModule.classifyRawEventTerminalRejection(input);
	// Assert
	expect(result).toEqual({ status: 400, reason: "invalid_payload" });
});

test.each(
	[
		null,
		[],
		"event_id required",
		{},
		{ error: null },
		{ error: 400 },
		{ error: { message: "event_id required" } },
		{ error: ["event_id required"] },
		{ error: "invalid raw event request" },
		{ error: "host_generation must be string" },
		{ error: "invalid identity_target" },
		{ error: "invalid db_path" },
		{ error: "unknown validation failure" },
		{ error: " event_id required" },
		{ error: "event_id required\n" },
		{ error: "EVENT_ID REQUIRED" },
	].map((responseBody) => [responseBody]),
)("terminal classifier rejects ambiguous 400 body %j", (responseBody) => {
	// Arrange
	const input = { status: 400, responseBody, outgoingBytes: 100 };
	// Act
	const result = deliveryModule.classifyRawEventTerminalRejection(input);
	// Assert
	expect(result).toBeNull();
});

test.each([200, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503])(
	"terminal classifier excludes HTTP %i even with a known validation message",
	(status) => {
		// Arrange
		const input = { status, responseBody: { error: "event_id required" }, outgoingBytes: 100 };
		// Act
		const result = deliveryModule.classifyRawEventTerminalRejection(input);
		// Assert
		expect(result).toBeNull();
	},
);

test.each([
	[99, { error: "payload too large", max_bytes: 100 }],
	[100, { error: "payload too large", max_bytes: 100 }],
	[101, { error: "payload too large" }],
	[101, { error: "payload too large", max_bytes: "100" }],
	[101, { error: "payload too large", max_bytes: 0 }],
	[101, { error: "payload too large", max_bytes: -1 }],
	[101, { error: "payload too large", max_bytes: Number.NaN }],
	[101, { error: "payload too large", max_bytes: Number.POSITIVE_INFINITY }],
	[101, { error: "payload too large", max_bytes: Number.NEGATIVE_INFINITY }],
	[101, { error: { message: "payload too large" }, max_bytes: 100 }],
	[101, { error: "request too large", max_bytes: 100 }],
	[101, { error: "payload too large", content_length: 100 }],
	[101, null],
	[101, []],
	[101, {}],
])("terminal classifier excludes unproven 413 (%j, %j)", (outgoingBytes, responseBody) => {
	// Arrange
	const input = { status: 413, responseBody, outgoingBytes };
	// Act
	const result = deliveryModule.classifyRawEventTerminalRejection(input);
	// Assert
	expect(result).toBeNull();
});

test.each([100, 100.5])("terminal classifier accepts a proven 413 above %f bytes", (max_bytes) => {
	// Arrange
	const input = {
		status: 413,
		responseBody: { error: "payload too large", max_bytes },
		outgoingBytes: 101,
	};
	// Act
	const result = deliveryModule.classifyRawEventTerminalRejection(input);
	// Assert
	expect(result).toEqual({ status: 413, reason: "payload_too_large" });
});

function envelope(eventId = "private-event", payload = { text: "private-payload" }) {
	return { event_id: eventId, session_id: "private-session", event_type: "user_prompt", payload };
}

async function fixture(overrides = {}) {
	vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
	const home = await mkdtemp(join(tmpdir(), "codemem-terminal-"));
	homes.push(home);
	const logs = {
		logLine: vi.fn(async () => {}),
		hostLog: vi.fn(async () => {}),
		hostNotify: vi.fn(async () => {}),
	};
	const buildEnvelope = vi.fn(({ payload, captureContext, startedAt }) => ({
		...envelope("private-event", payload),
		capture_context: captureContext,
		started_at: startedAt,
	}));
	const delivery = deliveryModule.createRawEventDelivery({
		backoffMs: 30_000,
		buildEnvelope,
		classifyViewerFailure: () => "connection",
		cwd: home,
		discardResponseBody: () => {},
		enabled: true,
		failureActions: { connection: "repair capture" },
		fetchRawEventsStatus: async () => new Response('{"ingest":{"available":true}}'),
		identityTarget: { workspace_id: "private-target" },
		isActive: () => true,
		nextEventId: () => "private-event",
		projectName: "synthetic",
		promptPackDbPath: join(home, "private-target.sqlite"),
		rawEventsStatusTimeoutMs: 1000,
		rawEventsStatusUrl: "http://synthetic.invalid/status",
		rawEventsUrl: "http://synthetic.invalid/events",
		sessionStartedAt: () => "private-start",
		spoolHome: home,
		statusCheckMs: 30_000,
		...logs,
		...overrides,
	});
	return { home, delivery, logs, buildEnvelope };
}

const rejectedResponse = () => new Response('{"error":"event_id required"}', { status: 400 });
const deliverInput = (payload = {}) => ({
	sessionID: "private-session",
	type: "user_prompt",
	payload,
});
const activeEntries = async (home) =>
	(await spool.loadRawEventSpoolEntries({ homeDir: home })).entries;
const receipts = (home) => spool.listRejectedRawEventSpoolEntries({ homeDir: home });

function expectPrivateLogs(logs, home) {
	const text = JSON.stringify(Object.values(logs).flatMap((mock) => mock.mock.calls));
	expect(text).not.toMatch(
		/private-event|private-session|private-payload|private-target|private-capture|private-exception/,
	);
	expect(text).not.toContain(home);
}

test("terminal drains retain twenty exact receipts, then deliver entry twenty-one without resends", async () => {
	// Arrange: explicit mtimes avoid filesystem timestamp-resolution ordering.
	const { home, delivery, logs } = await fixture();
	const originals = new Map();
	for (let index = 0; index < 21; index++) {
		const body = envelope(`private-event-${index}`);
		const serialized = `${JSON.stringify(body, null, 2)}\n`;
		await spool.writeRawEventSpoolEntry({ homeDir: home, envelope: body, serialized });
		const name = `${createHash("sha256").update(body.event_id).digest("hex")}.json`;
		await utimes(join(spool.resolveSpoolDirectory(home), name), index + 1, index + 1);
		originals.set(body.event_id, serialized);
	}
	const fetchMock = vi.fn(async (_url, options) => {
		if (JSON.parse(options.body).event_id === "private-event-20")
			return new Response(null, { status: 204 });
		return rejectedResponse();
	});
	vi.stubGlobal("fetch", fetchMock);
	// Act / Assert: each drain gets its own bounded slice.
	await delivery.drainSpool();
	expect(fetchMock).toHaveBeenCalledTimes(20);
	expect((await activeEntries(home)).map((entry) => entry.eventId)).toEqual(["private-event-20"]);
	const retained = await receipts(home);
	expect(retained).toHaveLength(20);
	for (const receipt of retained) {
		const bytes = await readFile(join(spool.resolveSpoolDirectory(home), receipt.receipt), "utf8");
		expect(bytes).toBe(originals.get(JSON.parse(bytes).event_id));
		expect(receipt).toMatchObject({ status: 400, reason: "invalid_payload" });
	}
	await delivery.drainSpool();
	expect(fetchMock).toHaveBeenCalledTimes(21);
	expect(await activeEntries(home)).toHaveLength(0);
	await delivery.drainSpool();
	expect(fetchMock).toHaveBeenCalledTimes(21);
	expect(await receipts(home)).toEqual(retained);
	expectPrivateLogs(logs, home);
});

test.each([
	"unknown",
	"malformed",
	"nested",
	"target",
	"content-length",
	"auth",
	"timeout",
	"rate-limit",
])(
	"nonterminal %s rejection keeps its entry and continues within the loaded batch",
	async (kind) => {
		// Arrange
		const { home, delivery } = await fixture();
		await spool.writeRawEventSpoolEntry({ homeDir: home, envelope: envelope("first") });
		await spool.writeRawEventSpoolEntry({ homeDir: home, envelope: envelope("second") });
		const responses = {
			unknown: [400, '{"error":"invalid raw event request"}'],
			malformed: [400, "{"],
			nested: [400, '{"error":{"message":"event_id required"}}'],
			target: [400, '{"error":"invalid identity_target"}'],
			"content-length": [413, '{"error":"payload too large"}'],
			auth: [401, '{"error":"event_id required"}'],
			timeout: [408, "{}"],
			"rate-limit": [429, "{}"],
		};
		const [status, body] = responses[kind];
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(body, { status, headers: { "Content-Length": "1" } }))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		// Act
		await delivery.drainSpool();
		// Assert
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(await activeEntries(home)).toHaveLength(1);
		expect(await receipts(home)).toHaveLength(0);
	},
);

test.each(["transport", 409, 500, 503])(
	"%s stops the batch and activates drain backoff",
	async (failure) => {
		// Arrange
		const { home, delivery } = await fixture();
		await spool.writeRawEventSpoolEntry({ homeDir: home, envelope: envelope("first") });
		await spool.writeRawEventSpoolEntry({ homeDir: home, envelope: envelope("second") });
		const fetchMock = vi.fn(async () => {
			if (failure === "transport") throw new Error("private-exception");
			return new Response("{}", { status: failure });
		});
		vi.stubGlobal("fetch", fetchMock);
		// Act
		await delivery.drainSpool();
		await delivery.drainSpool();
		// Assert
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(await activeEntries(home)).toHaveLength(2);
		expect(await receipts(home)).toHaveLength(0);
	},
);

test("live terminal rejection saves cached untargeted capture bytes and permits the next healthy delivery", async () => {
	// Arrange
	const { home, delivery, buildEnvelope, logs } = await fixture();
	const payload = { text: "private-payload" };
	delivery.setCaptureContext(payload, { actor: "private-capture" });
	delivery.setStartedAt(payload, "capture-start");
	let outgoing;
	const fetchMock = vi.fn(async (_url, options) => {
		outgoing = options.body;
		payload.text = "mutated-after-capture";
		return rejectedResponse();
	});
	vi.stubGlobal("fetch", fetchMock);
	// Act
	const saved = await delivery.deliver(deliverInput(payload));
	const retained = await receipts(home);
	const bytes = await readFile(
		join(spool.resolveSpoolDirectory(home), retained[0]?.receipt || "missing"),
		"utf8",
	);
	fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
	buildEnvelope.mockImplementationOnce(({ payload }) => envelope("healthy-event", payload));
	const healthy = await delivery.deliver(deliverInput({ text: "healthy" }));
	// Assert
	expect(saved).toBe(true);
	expect(healthy).toBe(true);
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(buildEnvelope).toHaveBeenCalledTimes(2);
	expect(bytes).toBe(
		JSON.stringify({
			...envelope("private-event", { text: "private-payload" }),
			capture_context: { actor: "private-capture" },
			started_at: "capture-start",
		}),
	);
	expect(JSON.parse(outgoing)).toMatchObject({
		db_path: join(home, "private-target.sqlite"),
		identity_target: { workspace_id: "private-target" },
	});
	expect(bytes).not.toMatch(/db_path|identity_target|mutated-after-capture|_raw_spooled/);
	expect(payload._raw_enqueued).not.toBe(true);
	expect(await receipts(home)).toHaveLength(1);
	expectPrivateLogs(logs, home);
});

test.each(["multibyte", "target-overhead", "equal", "below"])(
	"413 proof uses full outgoing UTF-8 bytes: %s",
	async (kind) => {
		// Arrange
		const { home, delivery } = await fixture();
		const payload = { text: "😀漢字".repeat(30) };
		let sentBytes;
		let maxBytes;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, options) => {
				sentBytes = Buffer.byteLength(options.body, "utf8");
				const { db_path: _db, identity_target: _target, ...untargeted } = JSON.parse(options.body);
				const limits = {
					multibyte: options.body.length,
					"target-overhead": Buffer.byteLength(JSON.stringify(untargeted)),
					equal: sentBytes,
					below: sentBytes + 1,
				};
				maxBytes = limits[kind];
				return new Response(JSON.stringify({ error: "payload too large", max_bytes: maxBytes }), {
					status: 413,
					headers: { "Content-Length": "1" },
				});
			}),
		);
		// Act
		const result = await delivery.deliver(deliverInput(payload));
		// Assert
		expect(result).toBe(true);
		const terminal = sentBytes > maxBytes;
		expect(await receipts(home)).toHaveLength(Number(terminal));
		expect(await activeEntries(home)).toHaveLength(Number(!terminal));
		expect(payload._raw_enqueued).not.toBe(true);
	},
);

test("terminal persistence failure leaves the event in memory without claiming a saved receipt", async () => {
	// Arrange
	const { home, delivery, logs } = await fixture();
	const payload = { text: "private-payload" };
	vi.mocked(spool.writeRawEventSpoolEntry).mockRejectedValueOnce(new Error("private-exception"));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => rejectedResponse()),
	);
	// Act
	const result = await delivery.deliver(deliverInput(payload));
	// Assert
	expect(result).toBe(false);
	expect(await receipts(home)).toHaveLength(0);
	expect(payload._raw_enqueued).not.toBe(true);
	expect(payload._raw_spooled).not.toBe(true);
	expect(JSON.stringify(logs.hostLog.mock.calls)).toMatch(/memory/);
	expectPrivateLogs(logs, home);
});

test.each(["retain-failed", "retained-lock-release", "failed-lock-release"])(
	"terminal %s preserves the durable copy and reports the actual outcome",
	async (failure) => {
		// Arrange
		const { home, delivery, logs } = await fixture();
		const actual = await vi.importActual("../.opencode/lib/raw-event-spool.js");
		vi.mocked(spool.retainRejectedRawEventSpoolEntry).mockImplementationOnce(async (options) => {
			// Retention must receive an existing durable copy, never the mutated caller payload.
			expect((await activeEntries(home))[0].envelope.payload).toEqual({ text: "private-payload" });
			if (failure === "retained-lock-release")
				return {
					...(await actual.retainRejectedRawEventSpoolEntry(options)),
					lock: "release_failed",
				};
			const error = new Error("private-exception");
			if (failure === "failed-lock-release") error.lock = "release_failed";
			throw error;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => rejectedResponse()),
		);
		const payload = { text: "private-payload" };
		// Act
		const result = await delivery.deliver(deliverInput(payload));
		// Assert
		expect(result).toBe(true);
		expect(payload._raw_enqueued).not.toBe(true);
		const retained = failure === "retained-lock-release";
		expect(await receipts(home)).toHaveLength(Number(retained));
		expect(await activeEntries(home)).toHaveLength(Number(!retained));
		const diagnostics = JSON.stringify(Object.values(logs).flatMap((mock) => mock.mock.calls));
		if (retained) expect(diagnostics).toMatch(/release_failed/);
		else expect(diagnostics).toMatch(/retain_failed|retention_failed/);
		if (failure === "failed-lock-release") expect(diagnostics).toMatch(/release_failed/);
		const outcomes = logs.hostLog.mock.calls.map(([entry]) => entry.extra?.outcome);
		expect(outcomes).toContain(retained ? "retained" : "retain_failed");
		if (!retained) expect(outcomes).not.toContain("retained");
		expectPrivateLogs(logs, home);
	},
);

test("a proven 413 during drain retains the event and continues to healthy entries", async () => {
	// Arrange
	const { home, delivery, logs } = await fixture();
	const rejected = envelope("oversized", { text: "😀".repeat(100) });
	await spool.writeRawEventSpoolEntry({ homeDir: home, envelope: rejected });
	await spool.writeRawEventSpoolEntry({ homeDir: home, envelope: envelope("healthy") });
	const fetchMock = vi.fn(async (_url, options) => {
		if (JSON.parse(options.body).event_id === "healthy") return new Response(null, { status: 204 });
		return new Response(
			JSON.stringify({
				error: "payload too large",
				max_bytes: Buffer.byteLength(options.body) - 1,
			}),
			{ status: 413 },
		);
	});
	vi.stubGlobal("fetch", fetchMock);
	// Act
	await delivery.drainSpool();
	await delivery.drainSpool();
	// Assert
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(await activeEntries(home)).toHaveLength(0);
	expect(await receipts(home)).toEqual([
		expect.objectContaining({ status: 413, reason: "payload_too_large" }),
	]);
	expectPrivateLogs(logs, home);
});

test("a failed retain during drain keeps the active copy without delaying a healthy entry", async () => {
	// Arrange
	const { home, delivery, logs } = await fixture();
	await spool.writeRawEventSpoolEntry({ homeDir: home, envelope: envelope("rejected") });
	await spool.writeRawEventSpoolEntry({ homeDir: home, envelope: envelope("healthy") });
	vi.mocked(spool.retainRejectedRawEventSpoolEntry).mockRejectedValueOnce(
		new Error("private-exception"),
	);
	const fetchMock = vi.fn(async (_url, options) => {
		if (JSON.parse(options.body).event_id === "healthy") return new Response(null, { status: 204 });
		return rejectedResponse();
	});
	vi.stubGlobal("fetch", fetchMock);
	// Act
	await delivery.drainSpool();
	const afterFailure = await activeEntries(home);
	await delivery.drainSpool();
	// Assert
	expect(afterFailure.map((entry) => entry.eventId)).toEqual(["rejected"]);
	expect(fetchMock).toHaveBeenCalledTimes(3);
	expect(await activeEntries(home)).toHaveLength(0);
	expect(await receipts(home)).toHaveLength(1);
	expect(logs.hostLog.mock.calls.map(([entry]) => entry.extra?.outcome)).toEqual([
		"retain_failed",
		"retained",
	]);
	expectPrivateLogs(logs, home);
});

test("validation-shaped status-check errors do not classify an unposted event as terminal", async () => {
	// Arrange
	const { home, delivery } = await fixture({
		fetchRawEventsStatus: async () => rejectedResponse(),
	});
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	// Act
	const result = await delivery.deliver(deliverInput());
	// Assert
	expect(result).toBe(true);
	expect(fetchMock).not.toHaveBeenCalled();
	expect(await activeEntries(home)).toHaveLength(1);
	expect(await receipts(home)).toHaveLength(0);
});

test.each(["retained", "retained-lock-release"])(
	"live retained retry skips POST after %s and does not delay a healthy event",
	async (outcome) => {
		// Arrange: an unnecessary retry would create transport backoff for the healthy event.
		const { home, delivery, buildEnvelope, logs } = await fixture();
		const payload = { text: "private-payload" };
		const healthyPayload = { text: "healthy" };
		if (outcome === "retained-lock-release") {
			const actual = await vi.importActual("../.opencode/lib/raw-event-spool.js");
			vi.mocked(spool.retainRejectedRawEventSpoolEntry).mockImplementationOnce(async (options) => ({
				...(await actual.retainRejectedRawEventSpoolEntry(options)),
				lock: "release_failed",
			}));
		}
		const sentIds = [];
		const fetchMock = vi.fn(async (_url, options) => {
			const { event_id } = JSON.parse(options.body);
			sentIds.push(event_id);
			if (event_id === "healthy-event") return new Response(null, { status: 204 });
			if (sentIds.filter((id) => id === "private-event").length > 1) {
				throw new Error("private-exception unnecessary retry");
			}
			return rejectedResponse();
		});
		vi.stubGlobal("fetch", fetchMock);
		// Act
		const first = await delivery.deliver(deliverInput(payload));
		const before = await receipts(home);
		const receiptPath = join(spool.resolveSpoolDirectory(home), before[0].receipt);
		const originalBytes = await readFile(receiptPath, "utf8");
		const repeated = await delivery.deliver(deliverInput(payload));
		buildEnvelope.mockImplementationOnce(({ payload }) => envelope("healthy-event", payload));
		const healthy = await delivery.deliver(deliverInput(healthyPayload));
		// Assert: durable retention is not an ingest acknowledgement.
		expect(first).toBe(true);
		expect(repeated).toBe(true);
		expect(healthy).toBe(true);
		expect.soft(sentIds).toEqual(["private-event", "healthy-event"]);
		expect.soft(healthyPayload._raw_enqueued).toBe(true);
		expect.soft(await activeEntries(home)).toHaveLength(0);
		expect(payload._raw_enqueued).not.toBe(true);
		expect(buildEnvelope).toHaveBeenCalledTimes(2);
		expect(await receipts(home)).toEqual(before);
		expect(await readFile(receiptPath, "utf8")).toBe(originalBytes);
		if (outcome === "retained-lock-release") {
			expect(logs.hostLog.mock.calls.map(([entry]) => entry.extra?.outcome)).toContain(
				"lock_release_failed",
			);
		}
		expectPrivateLogs(logs, home);
	},
);

test("live retained retry still POSTs after failed retention and then retains the same payload", async () => {
	// Arrange
	const { home, delivery, logs } = await fixture();
	const payload = { text: "private-payload" };
	vi.mocked(spool.retainRejectedRawEventSpoolEntry).mockRejectedValueOnce(
		new Error("private-exception"),
	);
	const fetchMock = vi.fn(async () => rejectedResponse());
	vi.stubGlobal("fetch", fetchMock);
	// Act
	const first = await delivery.deliver(deliverInput(payload));
	const activeBeforeRetry = await activeEntries(home);
	const receiptsBeforeRetry = await receipts(home);
	const repeated = await delivery.deliver(deliverInput(payload));
	const retained = await receipts(home);
	// Assert: saving the active copy alone must not suppress a retry.
	expect(first).toBe(true);
	expect(activeBeforeRetry).toHaveLength(1);
	expect(receiptsBeforeRetry).toHaveLength(0);
	expect(repeated).toBe(true);
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(await activeEntries(home)).toHaveLength(0);
	expect(retained).toHaveLength(1);
	expect(await readFile(join(spool.resolveSpoolDirectory(home), retained[0].receipt), "utf8")).toBe(
		activeBeforeRetry[0].serialized,
	);
	expect(payload._raw_enqueued).not.toBe(true);
	expect(logs.hostLog.mock.calls.map(([entry]) => entry.extra?.outcome)).toEqual([
		"retain_failed",
		"retained",
	]);
	expectPrivateLogs(logs, home);
});
