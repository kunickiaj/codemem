import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createRawEventDelivery } from "../.opencode/lib/raw-event-delivery.js";
import {
	loadRawEventSpoolEntries,
	writeRawEventSpoolEntry,
} from "../.opencode/lib/raw-event-spool.js";

const homes = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const mismatch = {
	error: {
		code: "viewer_identity_mismatch",
		message: "private-response-text",
		actual: { home: "private-home", embedding_offline: false },
	},
};

async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "codemem-delivery-identity-"));
	homes.push(home);
	let sequence = 0;
	const hostLog = vi.fn();
	const hostNotify = vi.fn();
	const status = vi.fn(
		async () => new Response(JSON.stringify({ ingest: { available: true } }), { status: 200 }),
	);
	const options = {
		backoffMs: 1_000,
		buildEnvelope: () => ({
			event_id: `event-${++sequence}`,
			event_type: "user_prompt",
			session_id: "session-1",
			payload: { prompt_text: "private-prompt" },
		}),
		classifyViewerFailure: (body) =>
			body?.error?.code === "viewer_identity_mismatch" ? "identity" : "connection",
		cwd: home,
		discardResponseBody: () => {},
		enabled: true,
		failureActions: { identity: "restart with matching settings", connection: "check viewer" },
		fetchRawEventsStatus: status,
		hostLog,
		hostNotify,
		identityTarget: { embedding_offline: true },
		isActive: () => true,
		logLine: vi.fn(),
		projectName: "synthetic",
		promptPackDbPath: join(home, "mem.sqlite"),
		rawEventsStatusTimeoutMs: 100,
		rawEventsStatusUrl: "http://viewer/status",
		rawEventsUrl: "http://viewer/events",
		sessionStartedAt: () => 1,
		spoolHome: home,
		statusCheckMs: 30_000,
	};
	const post = vi.fn(async () => new Response(JSON.stringify(mismatch), { status: 409 }));
	vi.stubGlobal("fetch", post);
	return { home, options, post, status, hostLog, hostNotify };
}

const event = () => ({ sessionID: "session-1", type: "user_prompt", payload: {} });

test("identity rejection pauses delivery and drains while preserving subsequent events", async () => {
	const { home, options, post, status, hostNotify } = await fixture();
	const delivery = createRawEventDelivery(options);
	expect(await delivery.deliver(event())).toBe(true);
	const saved = (await loadRawEventSpoolEntries({ homeDir: home })).entries[0].serialized;
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
	expect(await delivery.deliver(event())).toBe(true);
	await delivery.drainSpool();
	expect(post).toHaveBeenCalledOnce();
	expect(status).toHaveBeenCalledOnce();
	const entries = (await loadRawEventSpoolEntries({ homeDir: home })).entries;
	expect(entries).toHaveLength(2);
	expect(entries.find((entry) => entry.eventId === "event-1").serialized).toBe(saved);
	expect(hostNotify).toHaveBeenCalledOnce();
	expect(hostNotify.mock.calls[0][0].message).toMatch(/identity mismatch.*CODEMEM_.*restart/i);
});

test("startup drain reports identity mismatch without quarantining or deleting saved events", async () => {
	const { home, options, post, hostLog, hostNotify } = await fixture();
	await writeRawEventSpoolEntry({
		homeDir: home,
		envelope: { event_id: "saved-event", payload: { prompt_text: "private-prompt" } },
	});
	await writeRawEventSpoolEntry({
		homeDir: home,
		envelope: { event_id: "second-saved-event", payload: {} },
	});
	const saved = (await loadRawEventSpoolEntries({ homeDir: home })).entries;
	const delivery = createRawEventDelivery(options);
	await delivery.drainSpool();
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
	await delivery.drainSpool();
	expect(post).toHaveBeenCalledOnce();
	expect(hostNotify).toHaveBeenCalledOnce();
	expect(hostLog).toHaveBeenCalledWith(
		expect.objectContaining({
			extra: expect.objectContaining({ category: "identity", code: "viewer_identity_mismatch" }),
		}),
	);
	const diagnostic = await readFile(join(home, ".codemem", "plugin.log"), "utf8");
	expect(diagnostic).toContain("viewer_identity_mismatch");
	expect(diagnostic).toMatch(/restart/i);
	expect(JSON.stringify([diagnostic, hostLog.mock.calls, hostNotify.mock.calls])).not.toMatch(
		/private-response-text|private-home|private-prompt|saved-event/,
	);
	const after = (await loadRawEventSpoolEntries({ homeDir: home })).entries;
	expect(after.map((entry) => entry.serialized).sort()).toEqual(
		saved.map((entry) => entry.serialized).sort(),
	);
});

test("a runtime deactivated during POST saves the event without a late identity warning", async () => {
	const { home, options, post, hostLog, hostNotify } = await fixture();
	let active = true;
	post.mockImplementation(async () => {
		active = false;
		return new Response(JSON.stringify(mismatch), { status: 409 });
	});
	const delivery = createRawEventDelivery({ ...options, isActive: () => active });
	expect(await delivery.deliver(event())).toBe(true);
	expect((await loadRawEventSpoolEntries({ homeDir: home })).entries).toHaveLength(1);
	expect(hostLog).not.toHaveBeenCalled();
	expect(hostNotify).not.toHaveBeenCalled();
});

test("a fresh runtime drains saved events after the environment is repaired", async () => {
	const { home, options, post } = await fixture();
	const delivery = createRawEventDelivery(options);
	await delivery.deliver(event());
	const firstBody = JSON.parse(post.mock.calls[0][1].body);
	post.mockImplementation(async () => new Response(null, { status: 202 }));
	await delivery.drainSpool();
	expect(post).toHaveBeenCalledOnce();
	await createRawEventDelivery(options).drainSpool();
	expect(post).toHaveBeenCalledTimes(2);
	expect(JSON.parse(post.mock.calls[1][1].body)).toEqual(firstBody);
	expect((await loadRawEventSpoolEntries({ homeDir: home })).entries).toHaveLength(0);
});

test("a full spool still reports unsaved events while identity delivery is paused", async () => {
	const { home, options, post, hostNotify } = await fixture();
	const delivery = createRawEventDelivery({ ...options, spoolMaxEntries: 1 });
	expect(await delivery.deliver(event())).toBe(true);
	expect(await delivery.deliver(event())).toBe(false);
	expect(post).toHaveBeenCalledOnce();
	expect((await loadRawEventSpoolEntries({ homeDir: home })).entries).toHaveLength(1);
	expect(hostNotify).toHaveBeenCalledWith(
		expect.objectContaining({ message: expect.stringContaining("retry spool is full") }),
	);
});

test("a delivery waiting on status does not POST after another delivery pauses capture", async () => {
	const { home, options, post, status } = await fixture();
	let releaseStatus;
	status.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				releaseStatus = resolve;
			}),
	);
	const delivery = createRawEventDelivery(options);
	const waiting = delivery.deliver(event());
	await delivery.deliver(event());
	releaseStatus(new Response(JSON.stringify({ ingest: { available: true } }), { status: 200 }));
	expect(await waiting).toBe(true);
	expect(post).toHaveBeenCalledOnce();
	expect((await loadRawEventSpoolEntries({ homeDir: home })).entries).toHaveLength(2);
});

test.each([
	[409, { error: { code: "unrelated_conflict" } }],
	[409, { error: "viewer_identity_mismatch" }],
	[503, mismatch],
])("HTTP %i without an explicit identity 409 remains retryable (%j)", async (status, body) => {
	const { options, post, hostNotify } = await fixture();
	post.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
	const delivery = createRawEventDelivery(options);
	await delivery.deliver(event());
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
	post.mockImplementation(async () => new Response(null, { status: 202 }));
	await delivery.drainSpool();
	expect(post).toHaveBeenCalledTimes(2);
	expect(hostNotify).not.toHaveBeenCalled();
});
