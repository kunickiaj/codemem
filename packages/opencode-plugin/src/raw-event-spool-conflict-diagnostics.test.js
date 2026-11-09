import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createRawEventDelivery } from "../.opencode/lib/raw-event-delivery.js";
import {
	loadRawEventSpoolEntries,
	resolveSpoolDirectory,
	retainRejectedRawEventSpoolEntry,
	writeRawEventSpoolEntry,
} from "../.opencode/lib/raw-event-spool.js";

// Inject only synthetic filesystem failures and a deterministic competing publisher.
const fault = vi.hoisted(() => ({ published: null, directoryError: null, directory: null }));
vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		mkdir: async (path, ...args) => {
			if (path === fault.directory && fault.directoryError) throw fault.directoryError;
			return actual.mkdir(path, ...args);
		},
		link: async (source, destination) => {
			if (fault.published !== null && destination.endsWith(".json")) {
				await actual.writeFile(destination, fault.published);
				throw Object.assign(new Error("synthetic competing publisher"), { code: "EEXIST" });
			}
			return actual.link(source, destination);
		},
	};
});

const SECRET = "SYNTHETIC_SENSITIVE_SENTINEL";
const eventId = `${SECRET}_event_id`;
const digest = createHash("sha256").update(eventId).digest("hex");
let home;
let directory;

const event = () => ({
	event_id: eventId,
	event_type: "user_prompt",
	session_id: `${SECRET}_session`,
	session_stream_id: `${SECRET}_stream`,
	opencode_session_id: `${SECRET}_opencode`,
	started_at: 10,
	ts_wall_ms: 20,
	ts_mono_ms: 2,
	host_generation: "v2",
	capture_context: { synthetic: SECRET },
	cwd: `${SECRET}_cwd`,
	project: `${SECRET}_project`,
	source: `${SECRET}_source`,
	payload: {
		timestamp: 3,
		_adapter: { ts: 4, private_annotation: SECRET },
		_raw_spooled: false,
		args: { prompt: SECRET },
		[`${SECRET}_payload_key`]: SECRET,
	},
});

const write = (envelope, options = {}) =>
	writeRawEventSpoolEntry({ homeDir: home, envelope, ...options });
const activePath = () => join(directory, `${digest}.json`);

async function retain(envelope, serialized = JSON.stringify(envelope)) {
	await write(envelope, { serialized });
	const result = await retainRejectedRawEventSpoolEntry({
		homeDir: home,
		eventId,
		status: 400,
		reason: "invalid_payload",
	});
	return join(directory, result.receipt);
}

function delivery(buildEnvelope) {
	const hostLog = vi.fn(async () => {});
	const hostNotify = vi.fn(async () => {});
	const logLine = vi.fn(async () => {});
	const instance = createRawEventDelivery({
		enabled: true,
		spoolHome: home,
		isActive: () => true,
		buildEnvelope,
		logLine,
		hostLog,
		hostNotify,
		nextEventId: () => eventId,
		sessionStartedAt: () => 10,
		backoffMs: 10_000,
		statusCheckMs: 30_000,
		rawEventsStatusTimeoutMs: 100,
		rawEventsStatusUrl: "http://synthetic.invalid/status",
		rawEventsUrl: "http://synthetic.invalid/events",
		fetchRawEventsStatus: vi.fn(async () => new Response('{"ingest":{"available":true}}')),
		failureActions: { connection: "check viewer" },
	});
	return { ...instance, hostLog, hostNotify, logLine };
}

const input = (payload = {}) => ({ sessionID: `${SECRET}_session`, type: "user_prompt", payload });
const diagnostics = async (instance) => {
	const local = await readFile(join(home, ".codemem", "plugin.log"), "utf8");
	return `${local}\n${JSON.stringify([instance.hostLog.mock.calls, instance.hostNotify.mock.calls, instance.logLine.mock.calls])}`;
};

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "codemem-conflict-diagnostics-"));
	directory = resolveSpoolDirectory(home);
	fault.directory = directory;
	fault.directoryError = null;
	fault.published = null;
	vi.spyOn(Date, "now").mockReturnValue(1_000_000);
	vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new DOMException("synthetic timeout", "TimeoutError");
		}),
	);
});

afterEach(async () => {
	fault.directoryError = null;
	fault.published = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	await rm(home, { recursive: true, force: true });
});

test.each(["active", "rejected"])(
	"accepts delivery-time-only duplicates of %s entries without rewriting copied bytes",
	async (branch) => {
		// Arrange: retain deliberately noncanonical JSON so reserialization is observable.
		const original = event();
		const serialized = ` ${JSON.stringify(original, null, 2)}\n`;
		let path = activePath();
		if (branch === "rejected") path = await retain(original, serialized);
		else await write(original, { serialized });
		// Act
		const result = await write({ ...original, ts_wall_ms: 99, ts_mono_ms: 9 });
		// Assert
		expect(result.serialized).toBe(serialized);
		expect(await readFile(path, "utf8")).toBe(serialized);
		const loaded = await loadRawEventSpoolEntries({ homeDir: home });
		expect(loaded.entries).toHaveLength(branch === "active" ? 1 : 0);
	},
);

test("same-object delivery retry reuses cached bytes after setting _raw_spooled", async () => {
	// Arrange: the builder includes the mutable payload in its serialized envelope.
	const payload = { args: { prompt: SECRET } };
	const buildEnvelope = vi.fn(({ payload: body }) => ({ ...event(), payload: body }));
	const instance = delivery(buildEnvelope);
	await instance.deliver(input(payload));
	const first = await readFile(activePath(), "utf8");
	// Act
	const result = await instance.deliver(input(payload));
	// Assert
	expect(result).toBe(true);
	expect(payload._raw_spooled).toBe(true);
	expect(buildEnvelope).toHaveBeenCalledOnce();
	expect(await readFile(activePath(), "utf8")).toBe(first);
	expect(JSON.parse(first).payload).not.toHaveProperty("_raw_spooled");
	expect(fetch).toHaveBeenCalledOnce();
});

test.each(["active", "rejected"])(
	"rejects a distinct payload for a retained %s event without changing its bytes",
	async (branch) => {
		// Arrange
		const original = event();
		const serialized = ` ${JSON.stringify(original, null, 2)}\n`;
		let path = activePath();
		if (branch === "rejected") path = await retain(original, serialized);
		else await write(original, { serialized });
		const incoming = {
			...original,
			payload: { ...original.payload, args: { prompt: `${SECRET}_changed` } },
		};
		const instance = delivery(() => incoming);
		// Act
		const result = await instance.deliver(input());
		const diagnostic = await diagnostics(instance);
		// Assert
		expect(result).toBe(false);
		expect(diagnostic).toContain("stage=existing_entry code=conflict category=persistence");
		expect(diagnostic).toContain(
			`branch=${branch}_comparison reason=field_mismatch fields=payload.args`,
		);
		expect(diagnostic).not.toContain(SECRET);
		expect(diagnostic).not.toContain(digest);
		expect(diagnostic).not.toContain(home);
		expect(await readFile(path, "utf8")).toBe(serialized);
		if (branch === "rejected")
			await expect(readFile(activePath())).rejects.toMatchObject({ code: "ENOENT" });
	},
);

const allowedPaths = [
	"started_at",
	"host_generation",
	"capture_context",
	"session_stream_id",
	"session_id",
	"stream_id",
	"opencode_session_id",
	"cwd",
	"project",
	"source",
	"event_type",
	"payload.timestamp",
	"payload._adapter.ts",
	"payload._raw_spooled",
	"payload.args",
];

test.each(allowedPaths)("reports only the allowlisted changed path %s", async (path) => {
	// Arrange: sentinel content must never become part of the diagnostic schema.
	const original = event();
	await write(original);
	const incoming = structuredClone(original);
	const parts = path.split(".");
	let parent = incoming;
	for (const key of parts.slice(0, -1)) parent = parent[key];
	// cwd/project become wrong-typed. For started_at, the stored numeric 10
	// keeps the incoming string a conflict because both contexts must be valid.
	parent[parts.at(-1)] = ["cwd", "project"].includes(path) ? 123 : `${SECRET}_changed`;
	// Act
	const error = await write(incoming).catch((caught) => caught);
	// Assert
	expect(error).toMatchObject({ code: "raw_event_spool_conflict", spoolStage: "existing_entry" });
	expect(error.spoolConflict).toEqual({
		branch: "active_comparison",
		reason: "field_mismatch",
		fields: [path],
		other: false,
	});
	expect(JSON.stringify(error.spoolConflict)).not.toContain(SECRET);
	expect(await readFile(activePath(), "utf8")).toBe(JSON.stringify(original));
});

test.each(["active", "rejected"])(
	"uses a fixed other indicator for unknown keys in %s comparisons",
	async (branch) => {
		// Arrange: include hostile names at the envelope, payload, and adapter levels.
		const original = event();
		if (branch === "rejected") await retain(original);
		else await write(original);
		const incoming = structuredClone(original);
		incoming[`${SECRET}_envelope_key`] = SECRET;
		incoming.payload[`${SECRET}_payload_key`] = `${SECRET}_changed`;
		incoming.payload._adapter[`${SECRET}_adapter_key`] = SECRET;
		const instance = delivery(() => incoming);
		// Act
		const result = await instance.deliver(input());
		const diagnostic = await diagnostics(instance);
		// Assert
		expect(result).toBe(false);
		expect(diagnostic).toContain(`branch=${branch}_comparison reason=field_mismatch other=true`);
		expect(diagnostic).not.toContain(" fields=");
		expect(diagnostic).not.toContain(SECRET);
		expect(diagnostic).not.toContain(digest);
	},
);

const containerCases = ["payload", "payload._adapter"].flatMap((path) =>
	["missing", "added", "null", "scalar", "array"].flatMap((shape) =>
		["active", "rejected"].map((branch) => [path, shape, branch]),
	),
);

test.each(containerCases)(
	"reports the literal %s container for a %s container in a retained %s event",
	async (path, shape, branch) => {
		// Arrange: changing a container must not expose its former or incoming contents.
		const original = event();
		const incoming = structuredClone(original);
		const parts = path.split(".");
		const key = parts.at(-1);
		const oldParent = parts.length === 1 ? original : original.payload;
		const newParent = parts.length === 1 ? incoming : incoming.payload;
		if (shape === "added") delete oldParent[key];
		else if (shape === "missing") delete newParent[key];
		else if (shape === "null") newParent[key] = null;
		else if (shape === "array") newParent[key] = [{ [SECRET]: SECRET }];
		else newParent[key] = `${SECRET}_scalar`;
		const serialized = ` ${JSON.stringify(original, null, 2)}\n`;
		let retainedPath = activePath();
		if (branch === "rejected") retainedPath = await retain(original, serialized);
		else await write(original, { serialized });
		const instance = delivery(() => incoming);
		// Act
		const error = await write(incoming).catch((caught) => caught);
		const result = await instance.deliver(input());
		const diagnostic = await diagnostics(instance);
		// Assert: the entire diagnostic contains only the fixed schema and literal path.
		expect(error.spoolConflict).toEqual({
			branch: `${branch}_comparison`,
			reason: "field_mismatch",
			fields: [path],
			other: true,
		});
		expect(result).toBe(false);
		expect(diagnostic).toContain(
			`branch=${branch}_comparison reason=field_mismatch fields=${path} other=true`,
		);
		expect(diagnostic).not.toContain(SECRET);
		expect(diagnostic).not.toContain(digest);
		expect(diagnostic).not.toContain(home);
		expect(await readFile(retainedPath, "utf8")).toBe(serialized);
	},
);

test.each(["payload", "payload._adapter"])(
	"keeps unknown keys inside %s private without reporting a container mismatch",
	async (path) => {
		// Arrange: isolate the unknown nested key from every other kind of mismatch.
		const original = event();
		await write(original);
		const incoming = structuredClone(original);
		const parent = path === "payload" ? incoming.payload : incoming.payload._adapter;
		parent[`${SECRET}_unknown_key`] = `${SECRET}_value`;
		const instance = delivery(() => incoming);
		// Act
		const error = await write(incoming).catch((caught) => caught);
		const result = await instance.deliver(input());
		const diagnostic = await diagnostics(instance);
		// Assert
		expect(error.spoolConflict).toEqual({
			branch: "active_comparison",
			reason: "field_mismatch",
			fields: [],
			other: true,
		});
		expect(result).toBe(false);
		expect(diagnostic).toContain("branch=active_comparison reason=field_mismatch other=true");
		expect(diagnostic).not.toContain(" fields=");
		expect(diagnostic).not.toContain(SECRET);
	},
);

test.each([
	["active", `{"${SECRET}":`, "active_comparison", "invalid_json", "conflict"],
	["active", "null", "active_comparison", "invalid_shape", "conflict"],
	["active", "[]", "active_comparison", "invalid_shape", "conflict"],
	["rejected", `{"${SECRET}":`, "rejected_identity", "invalid_json", "other"],
	["rejected", "null", "rejected_identity", "invalid_shape", "other"],
	["rejected", "[]", "rejected_identity", "invalid_shape", "other"],
	[
		"rejected",
		JSON.stringify({ event_id: `${SECRET}_different_id` }),
		"rejected_identity",
		"identity_mismatch",
		"conflict",
	],
])(
	"classifies %s malformed/foreign retained data as %s %s %s %s",
	async (branch, serialized, expectedBranch, reason, code) => {
		// Arrange: corrupt only the synthetic retained fixture after initial publication.
		const original = event();
		let path = activePath();
		if (branch === "rejected") path = await retain(original);
		else await write(original);
		await writeFile(path, serialized);
		const instance = delivery(() => original);
		// Act
		const result = await instance.deliver(input());
		const diagnostic = await diagnostics(instance);
		// Assert
		expect(result).toBe(false);
		expect(diagnostic).toContain(
			`stage=existing_entry code=${code} category=persistence branch=${expectedBranch} reason=${reason}`,
		);
		expect(diagnostic).not.toContain(SECRET);
		expect(diagnostic).not.toContain(digest);
		expect(diagnostic).not.toContain(home);
		expect(await readFile(path, "utf8")).toBe(serialized);
	},
);

test("reports a publish comparison conflict without replacing the competing copy", async () => {
	// Arrange: inject the competing copy only after the initial existence check.
	const original = event();
	fault.published = ` ${JSON.stringify(original, null, 2)}\n`;
	const incoming = { ...original, started_at: 99 };
	const instance = delivery(() => incoming);
	// Act
	const result = await instance.deliver(input());
	const diagnostic = await diagnostics(instance);
	// Assert
	expect(result).toBe(false);
	expect(diagnostic).toContain(
		"stage=publish code=conflict category=persistence branch=publish_comparison reason=field_mismatch fields=started_at",
	);
	expect(diagnostic).not.toContain(SECRET);
	expect(diagnostic).not.toContain(digest);
	expect(await readFile(activePath(), "utf8")).toBe(fault.published);
});

test("accepts a competing publication when only top-level delivery times changed", async () => {
	// Arrange
	const original = event();
	fault.published = ` ${JSON.stringify(original, null, 2)}\n`;
	// Act
	const result = await write({ ...original, ts_wall_ms: 999, ts_mono_ms: 99 });
	// Assert
	expect(result.eventId).toBe(eventId);
	expect(await readFile(activePath(), "utf8")).toBe(fault.published);
});

test.each([
	{ branch: `${SECRET}_branch`, reason: "field_mismatch" },
	{ branch: "active_comparison", reason: `${SECRET}_reason` },
	{
		branch: "active_comparison",
		reason: "field_mismatch",
		fields: [`${SECRET}_key`, { toString: () => SECRET }],
		other: SECRET,
	},
	{
		branch: "active_comparison",
		reason: "field_mismatch",
		fields: [
			`payload.${SECRET}`,
			`payload._adapter.${SECRET}`,
			"payload._adapter_extra",
			{ toString: () => "payload" },
		],
	},
	{ branch: "active_comparison", reason: "field_mismatch", fields: `${SECRET}_fields`, other: 1 },
	{
		get branch() {
			throw new Error(SECRET);
		},
	},
])(
	"sanitizes unrecognized foreign error annotations at the delivery boundary (%#)",
	async (annotation) => {
		// Arrange: filesystem errors may carry arbitrary annotations and messages.
		fault.directoryError = Object.assign(new Error(`${SECRET}_error_message`), {
			code: `${SECRET}_code`,
			spoolConflict: annotation,
			[SECRET]: SECRET,
		});
		const instance = delivery(() => event());
		// Act
		const result = await instance.deliver(input());
		const diagnostic = await diagnostics(instance);
		// Assert
		expect(result).toBe(false);
		expect(diagnostic).toContain("stage=directory code=other category=persistence");
		expect(diagnostic).not.toContain(SECRET);
		expect(diagnostic).not.toContain(" fields=");
		expect(diagnostic).not.toContain(" other=true");
	},
);

test("rebuilds recognized foreign annotations using only literal allowlisted fields", async () => {
	// Arrange: mix valid paths with injected names, values, duplicates, and extra keys.
	fault.directoryError = Object.assign(new Error(`${SECRET}_error_message`), {
		code: "EIO",
		spoolConflict: {
			branch: "active_comparison",
			reason: "field_mismatch",
			fields: [
				"payload.args",
				SECRET,
				"started_at",
				"payload.args",
				"payload.args.private",
				"ts_wall_ms",
				"payload._adapter",
				"payload",
			],
			other: true,
			[SECRET]: SECRET,
			values: [SECRET],
		},
	});
	const instance = delivery(() => event());
	// Act
	const result = await instance.deliver(input());
	const diagnostic = await diagnostics(instance);
	// Assert
	expect(result).toBe(false);
	expect(diagnostic).toContain(
		"stage=directory code=EIO category=persistence branch=active_comparison reason=field_mismatch fields=started_at,payload,payload._adapter,payload.args other=true",
	);
	expect(diagnostic).not.toContain(SECRET);
	expect(diagnostic).not.toContain(digest);
	expect(diagnostic).not.toContain(home);
});
