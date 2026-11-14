import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayServer } from "./relay-server.js";
import type { RelayServerDiagnostic } from "./relay-server-diagnostic.js";
import {
	control,
	data,
	fakeSocket,
	SESSION,
	serverFixture,
	settle,
	terminal,
} from "./relay-server-test-fixtures.js";
import * as proof from "./relay-service-proof.js";

let f: Awaited<ReturnType<typeof serverFixture>>;
let events: RelayServerDiagnostic[];
const emptyDirection = {
	queuedFrames: 0,
	queuedBytes: 0,
	writes: 0,
	credit: 0,
	nextGrant: 16384,
	waiting: false,
	ended: false,
	pendingEnd: false,
	endForwarded: false,
};
const readyConnection = {
	phase: "ready",
	pending: false,
	closing: false,
	physicalClosed: false,
	restored: false,
	held: 0,
	writes: 0,
	registrationRemainingMs: 900000,
};
beforeEach(async () => {
	vi.useFakeTimers();
	events = [];
	f = await serverFixture({}, { onDiagnostic: (event) => events.push(event) });
});
afterEach(() => {
	f.dispose();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("relay abort diagnostics", () => {
	it("reports a peer abort once, with only allowlisted metadata and the textual-session hash", async () => {
		const { a, b } = await f.route();
		await control(b.events, "CLOSE", { mode: "abort" });
		a.events.closed();
		b.events.closed("worker_peer_error");
		f.server.close();
		expect(events).toEqual([
			{
				event: "route_abort",
				trace: createHash("sha256").update(SESSION, "utf8").digest("hex").slice(0, 16),
				reason: "peer_abort",
				site: "peer_abort",
				side: "target",
				accepted: true,
				bytes: 0,
				frames: 0,
				queuedFrames: 0,
				pendingWrites: 0,
				waitingDirections: 0,
				remainingMs: 45000,
				queuedBytes: 0,
				directions: [emptyDirection, emptyDirection],
				source: readyConnection,
				target: readyConnection,
			},
		]);
		expect(events[0]?.trace).not.toBe(
			createHash("sha256").update(Buffer.from(SESSION, "hex")).digest("hex").slice(0, 16),
		);
	});

	it("retains the host origin through a later physical error and reentrant close", async () => {
		const { a, b } = await f.route();
		a.events.closing?.("worker_operator_disable");
		a.events.closing?.("worker_peer_error");
		a.close.mockImplementation(() => a.events.closed("worker_peer_close"));
		a.events.closed("worker_peer_error");
		b.events.closed();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			site: "worker_operator_disable",
			reason: "socket_teardown",
			side: "source",
		});
		expect(f.server.counters()).toMatchObject({ sockets: 0, routes: 0, queuedBytes: 0 });
	});

	it("preserves the original socket branch before quota cancellation reenters teardown", async () => {
		const { a, b } = await f.route();
		f.quota.reserve.mockImplementationOnce(async (_request, signal) => {
			signal.addEventListener("abort", () => a.events.closed("worker_peer_error"), { once: true });
			return await new Promise<"reserved">(() => {});
		});
		const pending = control(a.events, "CLOSE", { mode: "end" });
		await settle();
		a.events.closed("worker_peer_close");
		await pending;
		b.events.closed();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ site: "worker_peer_close", side: "source" });
	});

	it("keeps a host close origin when a pending write fails before physical teardown", async () => {
		const { a, b } = await f.route();
		a.events.binary(data(21));
		await settle();
		f.clock.now = 750;
		const bufferCalls = [a.bufferedBytes.mock.calls.length, b.bufferedBytes.mock.calls.length];
		b.events.closing?.("worker_control_oversize");
		expect([a.bufferedBytes.mock.calls.length, b.bufferedBytes.mock.calls.length]).toEqual(
			bufferCalls,
		);
		f.clock.now = 2000;
		b.written(new Error("unique-private-later-write-marker"));
		b.events.closed("worker_peer_error");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			site: "worker_control_oversize",
			reason: "protocol",
			side: "target",
			pendingWrites: data(21).length,
			remainingMs: 44250,
			queuedBytes: data(21).length,
			directions: [
				{
					...emptyDirection,
					writes: data(21).length,
					credit: 16384 - data(21).length,
					nextGrant: 32768,
				},
				emptyDirection,
			],
			source: { ...readyConnection, registrationRemainingMs: 899250 },
			target: {
				...readyConnection,
				writes: data(21).length,
				registrationRemainingMs: 899250,
			},
		});
	});

	it("distinguishes accepted route expiry", async () => {
		const { a, b } = await f.route();
		f.clock.now = 45000;
		await vi.advanceTimersByTimeAsync(45000);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			site: "route_expired",
			reason: "route_expired",
			side: null,
			remainingMs: 0,
		});
		expect(terminal(a).at(-1)).toMatchObject({ type: "CLOSE", body: { mode: "abort" } });
		expect(terminal(b).at(-1)).toMatchObject({ type: "CLOSE", body: { mode: "abort" } });
	});
});

describe("relay fault diagnostics", () => {
	it.each(["denied", "unknown", "exception", "timeout"] as const)(
		"reports the existing collapsed traffic quota failure for %s",
		async (outcome) => {
			const { a } = await f.route();
			f.quota.reserve.mockImplementationOnce(async () => {
				if (outcome === "exception") throw new Error("unique-private-exception-marker");
				if (outcome === "timeout") return await new Promise<"reserved">(() => {});
				return outcome;
			});
			a.events.binary(data(29));
			await settle();
			if (outcome === "timeout") await vi.advanceTimersByTimeAsync(3000);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				site: "traffic_quota",
				reason: "quota_unavailable",
				side: "source",
				queuedFrames: 1,
				bytes: data(29).length,
				queuedBytes: data(29).length,
				directions: [
					{ ...emptyDirection, queuedFrames: 1, queuedBytes: data(29).length },
					emptyDirection,
				],
				source: { held: data(29).length },
			});
			expect(f.server.counters()).toMatchObject({
				routes: 0,
				queuedBytes: 0,
				trafficQuotaAborts: 1,
			});
		},
	);

	it.each(["callback", "throw"] as const)("distinguishes a DATA send %s failure", async (mode) => {
		const { a, b } = await f.route();
		if (mode === "throw")
			b.sendBinary.mockImplementationOnce(() => {
				throw new Error("unique-private-send-marker");
			});
		a.events.binary(data());
		await settle();
		if (mode === "callback") b.written(new Error("unique-private-callback-marker"));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			site: mode === "throw" ? "data_send_exception" : "data_write_callback",
			reason: "send_failed",
			side: "target",
		});
	});

	it("isolates a throwing callback without changing replies, cleanup or counters", async () => {
		f.dispose();
		f = await serverFixture(
			{},
			{
				onDiagnostic: () => {
					throw new Error("unique-private-sink-marker");
				},
			},
		);
		const { a, b } = await f.route();
		a.events.binary(data(23));
		await settle();
		b.written();
		await control(a.events, "CLOSE", { mode: "abort" });
		expect(terminal(a)).toEqual([
			{ v: 1, type: "CLOSE", session: SESSION, body: { mode: "abort" } },
		]);
		expect(terminal(b)).toEqual(terminal(a));
		expect(f.server.counters()).toEqual({
			sockets: 2,
			pendingSockets: 0,
			routes: 0,
			queuedBytes: 0,
			trafficQuotaAborts: 0,
		});
	});

	it("does not hash or build diagnostics when the callback is absent", async () => {
		f.dispose();
		f = await serverFixture();
		const { b } = await f.route();
		const digest = vi.spyOn(proof, "relayBodyDigest");
		const clock = vi.spyOn(f.clock, "monotonicMs");
		const buffers = b.bufferedBytes.mock.calls.length;
		b.events.closing?.("worker_control_oversize");
		expect(clock).not.toHaveBeenCalled();
		expect(digest).not.toHaveBeenCalled();
		expect(b.bufferedBytes.mock.calls).toHaveLength(buffers);
		await control(b.events, "CLOSE", { mode: "abort" });
		expect(digest).not.toHaveBeenCalled();
		expect(f.server.counters()).toMatchObject({ routes: 0, queuedBytes: 0 });
	});
});

describe("relay diagnostic privacy and normal completion", () => {
	it("leaves successful bidirectional DATA and normal END replies unchanged and silent", async () => {
		const { a, b } = await f.route();
		a.events.binary(data(5));
		b.events.binary(data(7));
		await settle();
		a.written();
		b.written();
		await control(a.events, "CLOSE", { mode: "end" });
		await control(b.events, "CLOSE", { mode: "end" });
		expect(a.binaries).toEqual([data(7)]);
		expect(b.binaries).toEqual([data(5)]);
		expect(terminal(a)).toEqual([{ v: 1, type: "CLOSE", session: SESSION, body: { mode: "end" } }]);
		expect(terminal(b)).toEqual(terminal(a));
		expect(events).toEqual([]);
		expect(f.server.counters()).toMatchObject({ routes: 0, queuedBytes: 0, trafficQuotaAborts: 0 });
	});

	it("reports restored orphan aborts once without snapshot identities or packet contents", async () => {
		const snapshots: unknown[] = [];
		const original = createRelayServer({
			...f.options,
			onRegistration: (_socket, snapshot) => snapshots.push(snapshot),
		});
		// Obtain a real signed registration snapshot from the existing fixture.
		const socket = fakeSocket();
		const registered = original.adopt(socket);
		if (!registered) throw new Error("Fixture adoption failed");
		const wrapped = Object.assign(socket, { events: registered });
		const request = await f.registration(wrapped);
		await control(registered, "REGISTER", request.body, request.session);
		original.close();
		const restored = f.server.restore(fakeSocket(), {
			...(snapshots[0] as object),
			deviceId: "unique-private-device-marker",
		});
		if (!restored) throw new Error("Fixture restore failed");
		restored.binary(data(19));
		await settle();
		restored.binary(data(19));
		await settle();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: "orphan_abort",
			site: "restored_route_lost",
			reason: "restored_route_lost",
			side: null,
			remainingMs: null,
			queuedBytes: 0,
			directions: null,
			source: null,
			target: null,
		});
		const serialized = JSON.stringify(events);
		for (const marker of [
			"unique-private-device-marker",
			SESSION,
			f.source.keyId,
			f.options.namespace.authorityId,
			f.options.namespace.groupId,
			f.options.namespace.relayAudienceId,
		])
			expect(serialized).not.toContain(marker);
	});
});
