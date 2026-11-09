import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createRawEventDelivery } from "../.opencode/lib/raw-event-delivery.js";
import {
	resolveSpoolDirectory,
	retainRejectedRawEventSpoolEntry,
	writeRawEventSpoolEntry,
} from "../.opencode/lib/raw-event-spool.js";

// Publish a real competing file at the exact link boundary, without scheduling races.
const race = vi.hoisted(() => ({ bytes: null, before: null }));
vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		link: async (source, destination) => {
			if (race.bytes !== null && destination.endsWith(".json")) {
				await actual.writeFile(destination, race.bytes, { mode: 0o600 });
				race.before = await actual.stat(destination);
				throw Object.assign(new Error("synthetic publisher"), { code: "EEXIST" });
			}
			return actual.link(source, destination);
		},
	};
});

const PRIVATE = "SYNTHETIC_CONTEXT_PRIVATE";
const eventId = "synthetic-context-retry";
const digest = createHash("sha256").update(eventId).digest("hex");
const context = { cwd: "/synthetic/first", project: "synthetic-first", started_at: "2026-01-01" };
const later = { cwd: "/synthetic/second", project: "synthetic-second", started_at: "2026-01-02" };
let home;
let directory;

const event = () => ({
	event_id: eventId,
	session_id: "synthetic-session",
	session_stream_id: "synthetic-stream",
	opencode_session_id: "synthetic-host-session",
	event_type: "user_prompt",
	source: "opencode",
	ts_wall_ms: 10,
	ts_mono_ms: 2,
	...context,
	payload: { args: { prompt: PRIVATE }, _raw_spooled: false },
});
// Reverse key order and retain whitespace to detect replacement or reserialization.
const bytes = (body) =>
	` ${JSON.stringify(Object.fromEntries(Object.entries(body).reverse()), null, 2)}\n`;
const activePath = () => join(directory, `${digest}.json`);
const write = (body, options = {}) =>
	writeRawEventSpoolEntry({ homeDir: home, envelope: body, ...options });

async function seed(branch, body) {
	const serialized = bytes(body);
	if (branch === "publish") {
		race.bytes = serialized;
		return { path: activePath(), serialized, before: null };
	}
	await write(body, { serialized });
	let path = activePath();
	if (branch === "rejected") {
		const retained = await retainRejectedRawEventSpoolEntry({
			homeDir: home,
			eventId,
			status: 400,
			reason: "invalid_payload",
		});
		path = join(directory, retained.receipt);
	}
	return { path, serialized, before: await stat(path) };
}

async function expectUntouched(stored) {
	expect(await readFile(stored.path, "utf8")).toBe(stored.serialized);
	const after = await stat(stored.path);
	const before = stored.before ?? race.before;
	expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({
		ino: before.ino,
		mtimeMs: before.mtimeMs,
	});
	expect(await readdir(directory)).toEqual([stored.path.slice(directory.length + 1)]);
}

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "codemem-context-retry-"));
	directory = resolveSpoolDirectory(home);
	race.bytes = null;
	race.before = null;
	vi.spyOn(Date, "now").mockReturnValue(1_000_000);
	vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("synthetic offline")));
});

afterEach(async () => {
	race.bytes = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	await rm(home, { recursive: true, force: true });
});

const drifts = [
	["cwd"],
	["cwd", "project"],
	["started_at", "cwd"],
	["cwd", "project", "started_at"],
	["started_at"],
];
const matches = ["active", "rejected", "publish"].flatMap((branch) => [
	...drifts.map((keys) => [branch, keys.join("+"), false, keys]),
	[branch, "null-to-string", true, Object.keys(context)],
	[branch, "string-to-null", false, Object.keys(context)],
]);

test.each(matches)(
	"%s keeps first bytes for %s context drift",
	async (branch, name, nullFirst, keys) => {
		// Arrange: only explicitly typed context and delivery clocks may vary.
		const original = event();
		if (nullFirst) for (const key of keys) original[key] = null;
		const incoming = { ...original, ts_wall_ms: 999, ts_mono_ms: 88 };
		for (const key of keys) incoming[key] = name === "string-to-null" ? null : later[key];
		const stored = await seed(branch, original);
		// Act
		const result = await write(incoming);
		// Assert: canonical return values matter as much as the retained file.
		expect(result).toEqual({ eventId, serialized: stored.serialized });
		await expectUntouched(stored);
	},
);

test("publish race returns stored bytes even for delivery-time-only matches", async () => {
	// Arrange
	const original = event();
	const stored = await seed("publish", original);
	// Act
	const result = await write({ ...original, ts_wall_ms: 999 });
	// Assert
	expect(result.serialized).toBe(stored.serialized);
	await expectUntouched(stored);
});

const boundaries = [
	[
		"active",
		"incoming wrong cwd",
		(_a, b) => {
			b.cwd = 123;
		},
	],
	[
		"rejected",
		"stored wrong project",
		(a) => {
			a.project = [];
		},
	],
	[
		"publish",
		"incoming wrong start",
		(_a, b) => {
			b.started_at = {};
		},
	],
	[
		"active",
		"stored missing cwd",
		(a) => {
			delete a.cwd;
		},
	],
	[
		"rejected",
		"incoming missing project",
		(_a, b) => {
			delete b.project;
		},
	],
	[
		"publish",
		"stored missing start",
		(a) => {
			delete a.started_at;
		},
	],
	[
		"active",
		"capture changed",
		(a, b) => {
			a.capture_context = { id: PRIVATE };
			b.capture_context = { id: "changed" };
		},
	],
	[
		"rejected",
		"capture added",
		(_a, b) => {
			b.capture_context = { id: PRIVATE };
		},
	],
	[
		"publish",
		"capture removed",
		(a) => {
			a.capture_context = { id: PRIVATE };
		},
	],
	[
		"active",
		"host generation added",
		(_a, b) => {
			b.host_generation = PRIVATE;
		},
	],
	[
		"rejected",
		"payload args",
		(_a, b) => {
			b.payload.args.prompt = "changed";
		},
	],
	[
		"publish",
		"payload spool flag",
		(_a, b) => {
			b.payload._raw_spooled = true;
		},
	],
	[
		"active",
		"source",
		(_a, b) => {
			b.source = PRIVATE;
		},
	],
	[
		"rejected",
		"session stream",
		(_a, b) => {
			b.session_stream_id = PRIVATE;
		},
	],
	[
		"publish",
		"session",
		(_a, b) => {
			b.session_id = PRIVATE;
		},
	],
	[
		"active",
		"event type",
		(_a, b) => {
			b.event_type = PRIVATE;
		},
	],
	[
		"rejected",
		"unknown key",
		(_a, b) => {
			b[PRIVATE] = PRIVATE;
		},
	],
];

test.each(boundaries)(
	"%s rejects context drift plus %s without private diagnostics",
	async (branch, _name, mutate) => {
		// Arrange: a valid context difference must not hide any other difference.
		const original = event();
		const incoming = { ...structuredClone(original), ...later };
		mutate(original, incoming);
		const stored = await seed(branch, original);
		// Act
		const error = await write(incoming).catch((caught) => caught);
		// Assert
		expect(error).toMatchObject({
			code: "raw_event_spool_conflict",
			spoolStage: branch === "publish" ? "publish" : "existing_entry",
			spoolConflict: { branch: `${branch}_comparison`, reason: "field_mismatch" },
		});
		const diagnostic = JSON.stringify(error.spoolConflict);
		for (const secret of [PRIVATE, home, digest, context.cwd, later.cwd, context.started_at]) {
			expect(diagnostic).not.toContain(secret);
		}
		await expectUntouched(stored);
	},
);

function delivery(runtimeContext) {
	const hostLog = vi.fn(async () => {});
	const hostNotify = vi.fn(async () => {});
	const logLine = vi.fn(async () => {});
	const buildEnvelope = vi.fn(({ payload, nowMs }) => ({
		...event(),
		...runtimeContext,
		ts_wall_ms: nowMs,
		payload,
	}));
	const instance = createRawEventDelivery({
		enabled: true,
		spoolHome: home,
		isActive: () => true,
		buildEnvelope,
		classifyViewerFailure: () => "connection",
		hostLog,
		hostNotify,
		logLine,
		nextEventId: () => eventId,
		sessionStartedAt: () => runtimeContext.started_at,
		backoffMs: 1_000,
		statusCheckMs: 30_000,
		rawEventsStatusTimeoutMs: 100,
		rawEventsStatusUrl: "http://synthetic.invalid/status",
		rawEventsUrl: "http://synthetic.invalid/events",
		fetchRawEventsStatus: vi.fn(async () => new Response('{"ingest":{"available":true}}')),
		failureActions: { connection: "check viewer" },
	});
	return { ...instance, hostLog, hostNotify, logLine, buildEnvelope };
}
const input = (payload) => ({ sessionID: "synthetic-session", type: "user_prompt", payload });

test("two delivery instances durably retry and second posts first captured body after backoff", async () => {
	// Arrange: separate runtime caches share only the synthetic home and event identity.
	const first = delivery(context);
	const second = delivery(later);
	const firstPayload = { args: { prompt: PRIVATE } };
	const secondPayload = structuredClone(firstPayload);
	expect(await first.deliver(input(firstPayload))).toBe(true);
	const stored = await readFile(activePath(), "utf8");
	vi.mocked(Date.now).mockReturnValue(1_000_100);
	// Act
	const durable = await second.deliver(input(secondPayload));
	const duringBackoff = await second.deliver(input(secondPayload));
	vi.mocked(Date.now).mockReturnValue(1_002_000);
	vi.mocked(fetch).mockResolvedValue(new Response("{}"));
	const delivered = await second.deliver(input(secondPayload));
	// Assert: this exercises the second WeakMap, not drainSpool's disk replay.
	expect(durable).toBe(true);
	expect(duringBackoff).toBe(true);
	expect(delivered).toBe(true);
	expect(fetch).toHaveBeenCalledTimes(3);
	expect(fetch.mock.calls.at(-1)[1].body).toBe(stored);
	expect(second.buildEnvelope).toHaveBeenCalledOnce();
	expect(secondPayload._raw_enqueued).toBe(true);
	expect(second.hostNotify).not.toHaveBeenCalled();
	expect(second.hostLog.mock.calls).toEqual(
		expect.arrayContaining([
			[expect.objectContaining({ extra: expect.objectContaining({ delivery: "spool" }) })],
		]),
	);
	expect(JSON.stringify(second.logLine.mock.calls)).not.toContain("raw_events.spool.write_failed");
	expect(JSON.stringify(second.hostLog.mock.calls)).not.toContain("queued in memory");
	expect(await readdir(directory)).toEqual([]);
});

test("second delivery instance reports a real body conflict as memory-only without altering first bytes", async () => {
	// Arrange
	const first = delivery(context);
	const second = delivery(later);
	await first.deliver(input({ args: { prompt: PRIVATE } }));
	const stored = await readFile(activePath(), "utf8");
	const payload = { args: { prompt: "different synthetic prompt" } };
	// Act
	const durable = await second.deliver(input(payload));
	// Assert
	expect(durable).toBe(false);
	expect(payload).not.toHaveProperty("_raw_spooled");
	expect(await readFile(activePath(), "utf8")).toBe(stored);
	expect(second.hostNotify).toHaveBeenCalled();
	expect(second.hostLog.mock.calls).toEqual(
		expect.arrayContaining([
			[expect.objectContaining({ extra: expect.objectContaining({ delivery: "memory" }) })],
		]),
	);
	const diagnostic = await readFile(join(home, ".codemem", "plugin.log"), "utf8");
	expect(diagnostic).toContain("fields=");
	expect(diagnostic).toContain("payload.args");
	expect(diagnostic).not.toContain(PRIVATE);
});

test("413 for a longer runtime copy leaves the shorter canonical body active for the next retry", async () => {
	// Arrange: the rejected request exceeds the limit only because its cwd differs.
	const first = delivery(context);
	const second = delivery({ ...context, cwd: `/synthetic/${"long".repeat(1_000)}` });
	const payload = { args: { prompt: PRIVATE } };
	await first.deliver(input(structuredClone(payload)));
	const stored = await readFile(activePath(), "utf8");
	const before = await stat(activePath());
	const maxBytes = Buffer.byteLength(stored, "utf8") + 1;
	vi.mocked(fetch).mockResolvedValueOnce(
		new Response(JSON.stringify({ error: "payload too large", max_bytes: maxBytes }), {
			status: 413,
		}),
	);
	// Act
	const durable = await second.deliver(input(payload));
	const filesAfterRejection = await readdir(directory);
	const postAfterRejection = fetch.mock.calls.at(-1)[1].body;
	const retainedBody = await readFile(join(directory, filesAfterRejection[0]), "utf8");
	const detailsAfterRejection = await stat(join(directory, filesAfterRejection[0]));
	const callsAfterRejection = fetch.mock.calls.length;
	vi.mocked(fetch).mockResolvedValue(new Response("{}"));
	const delivered = await second.deliver(input(payload));
	// Assert: adopting canonical bytes must not mark this payload terminally retained.
	expect(durable).toBe(true);
	expect(Buffer.byteLength(postAfterRejection, "utf8")).toBeGreaterThan(maxBytes);
	expect(Buffer.byteLength(stored, "utf8")).toBeLessThan(maxBytes);
	expect(callsAfterRejection).toBe(2);
	expect(filesAfterRejection).toEqual([`${digest}.json`]);
	expect(retainedBody).toBe(stored);
	expect(detailsAfterRejection.ino).toBe(before.ino);
	expect(detailsAfterRejection.mtimeMs).toBe(before.mtimeMs);
	expect(delivered).toBe(true);
	expect(fetch).toHaveBeenCalledTimes(3);
	expect(fetch.mock.calls.at(-1)[1].body).toBe(stored);
	expect(payload._raw_enqueued).toBe(true);
	expect(second.buildEnvelope).toHaveBeenCalledOnce();
	expect(second.logLine.mock.calls.flat().join("\n")).not.toContain("raw_events.spool.retained");
	expect(await readdir(directory)).toEqual([]);
});

test.each([
	[413, "payload too large", false, "payload_too_large"],
	[400, "payload must be an object", true, "invalid_payload"],
])(
	"HTTP %i retains canonical bytes when the rejection still applies",
	async (status, error, drift, reason) => {
		// Arrange: unchanged-byte 413 and context-drift 400 keep terminal retention.
		const first = delivery(context);
		const second = delivery(drift ? later : context);
		const payload = { args: { prompt: PRIVATE } };
		await first.deliver(input(structuredClone(payload)));
		const stored = await readFile(activePath(), "utf8");
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify({ error, max_bytes: 1 }), { status }),
		);
		// Act
		const durable = await second.deliver(input(payload));
		const repeated = await second.deliver(input(payload));
		// Assert: retained payloads must not be posted again.
		expect(durable).toBe(true);
		expect(repeated).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(2);
		const receipt = `rejected-${digest}-${status}-${reason}.json`;
		expect(await readdir(directory)).toEqual([receipt]);
		expect(await readFile(join(directory, receipt), "utf8")).toBe(stored);
		expect(payload).not.toHaveProperty("_raw_enqueued");
	},
);
