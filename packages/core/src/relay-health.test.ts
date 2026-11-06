import { type Context, Hono, type MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayHealthMonitor } from "./relay-health.js";
import type { RelayHealthPublication } from "./relay-health-storage.js";
import { healthCatalogue, healthFixture, healthMembers } from "./relay-health-test-fixtures.js";

function setup(enabled = true) {
	const f = healthFixture();
	let monotonic = 0;
	vi.spyOn(performance, "now").mockImplementation(() => monotonic);
	let revision = 0;
	const publish = vi.fn(
		async (_value: RelayHealthPublication): Promise<number | null> => ++revision,
	);
	const onTrip = vi.fn();
	const monitor = new RelayHealthMonitor({ ...f.options, enabled, publish, onTrip });
	const app = new Hono();
	let device = "device-a";
	let status = 200;
	let verified = true;
	let duration = 5;
	monitor.install(app);
	app.get("*", (c) => {
		if (verified) monitor.verifiedGroupMember(c.req.raw, device, "group-a");
		monotonic += duration;
		return new Response(
			JSON.stringify(c.req.path.endsWith("/members") ? healthMembers : healthCatalogue),
			{ status, headers: { "content-type": "application/json" } },
		);
	});
	f.fetcher.mockImplementation(async (url, init) => app.request(String(url), init));
	const setTime = (now: number) => {
		monotonic = now - 120000;
		f.setNow(now);
	};
	const recover = async () => {
		for (let now = 120000; now <= 480000; now += 30000) {
			setTime(now);
			await monitor.runProbeCycle();
		}
	};
	const request = (path = "/v1/scopes?group_id=group-a") =>
		app.request(`https://coordinator.example.test${path}`);
	return {
		...f,
		monitor,
		publish,
		onTrip,
		setTime,
		recover,
		request,
		route: (options: {
			device?: string;
			status?: number;
			verified?: boolean;
			duration?: number;
		}) => {
			device = options.device ?? "device-a";
			status = options.status ?? 200;
			verified = options.verified ?? true;
			duration = options.duration ?? 5;
		},
	};
}
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("coordinator-owned relay health", () => {
	it("starts conservatively and recovers only after five full healthy minutes", async () => {
		// Arrange
		const f = setup();
		// Act
		const initial = f.monitor.snapshot();
		await f.recover();
		const recovered = f.monitor.snapshot();
		// Assert
		expect(initial).toMatchObject({ state: "tripped", healthyWindows: 0, observedAtMs: null });
		expect(f.publish.mock.calls[0]?.[0]).toMatchObject({ state: "tripped", observedAtMs: null });
		expect(recovered).toMatchObject({
			state: "ready",
			healthyWindows: 5,
			observedAtMs: 480000,
			validUntilMs: 530000,
		});
		expect(recovered.revision).toBeGreaterThan(0);
	});
	it("requires fresh members even when catalogue requests succeed", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		f.setTime(530000);
		// Act
		await f.request();
		const snapshot = f.monitor.snapshot();
		// Assert
		expect(snapshot.state).toBe("paused");
		expect(snapshot.observedAtMs).toBeNull();
	});
	it("uses the oldest required completion time rather than the latest probe receipt", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		f.setTime(490000);
		f.route({ device: "real-device" });
		await f.request();
		f.route({});
		f.setTime(510000);
		// Act
		await f.monitor.runProbeCycle();
		const snapshot = f.monitor.snapshot();
		// Assert
		expect(snapshot).toMatchObject({ state: "ready", observedAtMs: 490000, validUntilMs: 540000 });
	});
	it("pauses on stale data and resumes on fresh full-path observations without a new trip", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		f.setTime(530000);
		const stale = f.monitor.snapshot();
		// Act
		await f.monitor.runProbeCycle();
		// Assert
		expect(stale.state).toBe("paused");
		expect(f.monitor.snapshot().state).toBe("ready");
	});
	it.each([401, 403])(
		"does not count authorization denial %s as success or failure",
		async (status) => {
			// Arrange
			const f = setup();
			f.route({ status });
			// Act
			await f.monitor.runProbeCycle();
			// Assert
			expect(f.monitor.snapshot()).toMatchObject({
				samples: 0,
				observedAtMs: null,
				state: "tripped",
			});
		},
	);
	it("ignores unverified successful responses and other realms", async () => {
		// Arrange
		const f = setup();
		f.route({ verified: false });
		// Act
		await f.request();
		await f.request("/v1/scopes?group_id=other");
		// Assert
		expect(f.monitor.snapshot()).toMatchObject({ samples: 0, observedAtMs: null });
	});
	it.each([
		{ verified: false, status: 429 },
		{ verified: false, status: 500 },
		{ verified: true, status: 429 },
	])("ignores requests outside trusted system health: %j", async ({ verified, status }) => {
		// Arrange
		const f = setup();
		await f.recover();
		const before = f.monitor.snapshot();
		f.route({ device: "real-device", status, verified });
		// Act
		await f.request();
		// Assert
		expect(f.monitor.snapshot()).toMatchObject({ state: "ready", samples: before.samples });
	});
	it("pauses a verified low-volume failure immediately and trips only at window close", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		f.route({ device: "real-device", status: 500 });
		// Act
		await f.request();
		const pending = f.monitor.snapshot();
		f.setTime(540000);
		const completed = f.monitor.snapshot();
		f.route({});
		for (let now = 540000; now < 840000; now += 30000) {
			f.setTime(now);
			await f.monitor.runProbeCycle();
		}
		const recovering = f.monitor.snapshot();
		f.setTime(840000);
		await f.monitor.runProbeCycle();
		// Assert
		expect(pending.state).toBe("paused");
		expect(completed.state).toBe("tripped");
		expect(recovering).toMatchObject({ state: "tripped", healthyWindows: 4 });
		expect(f.monitor.snapshot()).toMatchObject({ state: "ready", healthyWindows: 5 });
	});
	it("accepts a low-volume real-client success within three seconds", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		f.route({ device: "real-device", duration: 3000 });
		// Act
		await f.request();
		// Assert
		expect(f.monitor.snapshot().state).toBe("ready");
	});
	it("trips when a low-volume real-client completion exceeds three seconds", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		f.route({ device: "real-device", duration: 3001 });
		// Act
		await f.request();
		const pending = f.monitor.snapshot();
		f.setTime(540000);
		// Assert
		expect(pending.state).toBe("paused");
		expect(f.monitor.snapshot().state).toBe("tripped");
	});
});

describe("relay health thresholds and lifecycle", () => {
	it("excludes an overloaded minute from the five full healthy recovery windows", async () => {
		// Arrange: fill a healthy real-client window while both probe paths remain fresh.
		const f = setup();
		await f.recover();
		f.setTime(510000);
		await f.monitor.runProbeCycle();
		f.setTime(539000);
		f.route({ device: "real-device", duration: 0 });
		for (let i = 0; i < 4096; i++) await f.request();
		const atCapacity = f.monitor.snapshot();
		// Act: the rejected overflow sample must invalidate this recovery minute.
		f.setTime(539999);
		f.route({ device: "real-device", status: 500, duration: 0 });
		await f.request();
		const overloaded = f.monitor.snapshot();
		f.route({});
		const recovery = [];
		for (let now = 540000; now <= 840000; now += 30000) {
			f.setTime(now);
			await f.monitor.runProbeCycle();
			if (now % 60000 === 0) recovery.push(f.monitor.snapshot());
		}
		// Assert: overload contributes zero, then exactly five healthy minutes restore readiness.
		expect(atCapacity).toMatchObject({ state: "ready", healthyWindows: 5 });
		expect(overloaded).toMatchObject({ state: "tripped", healthyWindows: 0 });
		expect(recovery).toMatchObject([
			{ state: "tripped", healthyWindows: 0 },
			{ state: "tripped", healthyWindows: 1 },
			{ state: "tripped", healthyWindows: 2 },
			{ state: "tripped", healthyWindows: 3 },
			{ state: "tripped", healthyWindows: 4 },
			{ state: "ready", healthyWindows: 5 },
		]);
	});
	it("allows a first failure followed by 999 successes without entering trip recovery", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		f.route({ device: "real-device", status: 500 });
		// Act
		await f.request();
		const first = f.monitor.snapshot();
		f.route({ device: "real-device" });
		for (let i = 0; i < 999; i++) await f.request();
		const complete = f.monitor.snapshot();
		f.setTime(540000);
		const next = f.monitor.snapshot();
		// Assert
		expect(first.state).toBe("paused");
		expect(complete.state).toBe("ready");
		expect(next.state).not.toBe("tripped");
	});
	it("trips after two high-volume failure windows even with fast successful responses", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		const window = async () => {
			f.route({ device: "real-device" });
			for (let i = 0; i < 20; i++) await f.request();
			f.route({ device: "real-device", status: 500 });
			await f.request();
		};
		await window();
		f.setTime(540000);
		const first = f.monitor.snapshot();
		// Act
		await window();
		f.setTime(600000);
		const second = f.monitor.snapshot();
		// Assert
		expect(first.state).not.toBe("tripped");
		expect(second.state).toBe("tripped");
	});
	it("allows exactly 0.1 percent failures in high-volume windows", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		// Act
		for (const end of [540000, 600000]) {
			f.route({ device: "real-device" });
			for (let i = 0; i < 999; i++) await f.request();
			f.route({ device: "real-device", status: 500 });
			await f.request();
			f.setTime(end);
			f.monitor.snapshot();
		}
		// Assert
		expect(f.monitor.snapshot().state).not.toBe("tripped");
	});
	it("requires two consecutive high-volume bad p95 windows to trip", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		f.route({ device: "real-device", duration: 1001 });
		for (let i = 0; i < 20; i++) await f.request();
		f.setTime(540000);
		const first = f.monitor.snapshot();
		// Act
		for (let i = 0; i < 20; i++) await f.request();
		f.setTime(600000);
		const second = f.monitor.snapshot();
		// Assert
		expect(first.state).not.toBe("tripped");
		expect(second.state).toBe("tripped");
	});
	it("accepts p95 exactly one second in a high-volume real-client window", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		f.route({ device: "real-device", duration: 1000 });
		// Act
		for (let i = 0; i < 20; i++) await f.request();
		const snapshot = f.monitor.snapshot();
		// Assert
		expect(snapshot.state).toBe("ready");
	});
});

describe("relay health clock and publication receipts", () => {
	it("uses a monotonic cycle limit even if UTC advances", async () => {
		// Arrange
		const f = setup();
		await f.monitor.runProbeCycle();
		// Act
		f.setNow(999999);
		await f.monitor.runProbeCycle();
		// Assert
		expect(f.fetcher).toHaveBeenCalledTimes(2);
	});
	it("limits traffic to two cycles and four requests in a minute", async () => {
		// Arrange
		const f = setup();
		// Act
		await f.monitor.runProbeCycle();
		f.setTime(149999);
		await f.monitor.runProbeCycle();
		f.setTime(150000);
		await f.monitor.runProbeCycle();
		f.setTime(179999);
		await f.monitor.runProbeCycle();
		// Assert
		expect(f.fetcher).toHaveBeenCalledTimes(4);
	});
	it.each([null, 0, NaN])(
		"fails closed on an invalid durable receipt %s without retry",
		async (receipt) => {
			// Arrange
			const f = setup();
			f.publish.mockResolvedValue(receipt);
			f.fetcher.mockImplementation(async () => new Response(null, { status: 403 }));
			// Act
			await f.monitor.runProbeCycle();
			// Assert
			expect(f.monitor.snapshot()).toMatchObject({ state: "tripped", revision: null });
			expect(f.publish).toHaveBeenCalledTimes(2);
		},
	);
	it("pauses when UTC moves backwards or loses verification", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		// Act
		f.setNow(479999);
		const backwards = f.monitor.snapshot();
		f.clock.mockReturnValue({ utcMs: 480000, verified: false, maxErrorMs: 1, resolutionMs: 1 });
		const unknown = f.monitor.snapshot();
		// Assert
		expect(backwards).toMatchObject({ state: "paused", observedAtMs: null });
		expect(unknown).toMatchObject({ state: "paused", observedAtMs: null });
	});
	it("stops explicitly and publishes a conservative state", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		// Act
		const stopped = await f.monitor.stop();
		// Assert
		expect(stopped).toBe(true);
		expect(f.monitor.snapshot().state).toBe("tripped");
		expect(f.publish).toHaveBeenLastCalledWith(
			expect.objectContaining({ state: "tripped", observedAtMs: null }),
		);
	});
});

describe("relay health publication races", () => {
	it("publishes paused after an in-flight ready commit when a verified failure restores the previous paused state", async () => {
		// Arrange: client observations stay fresh while the server path expires.
		const f = setup();
		await f.recover();
		const durableStates: RelayHealthPublication["state"][] = [];
		let revision = f.monitor.snapshot().revision ?? 0;
		const readyCommit = Promise.withResolvers<void>();
		const readyStarted = Promise.withResolvers<void>();
		let holdReady = false;
		f.publish.mockImplementation(async (value) => {
			if (holdReady && value.state === "ready") {
				readyStarted.resolve();
				await readyCommit.promise;
			}
			durableStates.push(value.state);
			return ++revision;
		});
		f.fetcher.mockImplementation(async (url) =>
			Response.json(String(url).includes("/members") ? healthMembers : healthCatalogue),
		);
		f.setTime(510000);
		await f.monitor.runProbeCycle();
		f.setTime(530000);
		await f.request();
		const before = f.publish.mock.calls.length;
		holdReady = true;
		// Act: a member-path success starts READY, but a concurrent verified 500 restores PAUSED.
		const request = f.request("/v1/scopes/scope-a/members?group_id=group-a");
		await readyStarted.promise;
		const inFlightTarget = f.publish.mock.calls.at(-1)?.[0].state;
		f.route({ device: "real-device", status: 500 });
		await f.request();
		const duringCommit = f.monitor.snapshot();
		const lastCompletedState = durableStates.at(-1);
		readyCommit.resolve();
		await request;
		const afterCommit = f.monitor.snapshot();
		const statesAfterCommit = durableStates.slice(-2);
		const writesAfterCommit = f.publish.mock.calls.length;
		f.route({ device: "real-device" });
		await f.request();
		// Assert: the last completed PAUSED receipt must not hide the concurrent transition.
		expect(lastCompletedState).toBe("paused");
		expect(inFlightTarget).toBe("ready");
		expect(duringCommit.state).toBe("paused");
		expect(afterCommit.state).toBe("paused");
		expect(statesAfterCommit).toEqual(["ready", "paused"]);
		expect(writesAfterCommit).toBe(before + 2);
		expect(f.publish).toHaveBeenCalledTimes(writesAfterCommit);
	});
});

describe("relay health publication ownership", () => {
	it("publishes paused when a verified failure arrives between drain completion and ownership cleanup", async () => {
		// Arrange: capture the real middleware with a single await at the framework boundary.
		const f = setup();
		await f.recover();
		let middleware: MiddlewareHandler | undefined;
		f.monitor.install({
			use: (_path: string, handler: MiddlewareHandler) => {
				middleware = handler;
			},
		} as unknown as Hono);
		if (!middleware) throw new Error("missing installed health middleware");
		const request = new Request("https://coordinator.example.test/v1/scopes?group_id=group-a");
		f.monitor.verifiedGroupMember(request, "real-device", "group-a");
		const context = {
			req: { raw: request },
			res: new Response(null, { status: 500 }),
		} as unknown as Context;
		const nextGate = Promise.withResolvers<void>();
		const readyReceipt = Promise.withResolvers<number>();
		const readyStarted = Promise.withResolvers<void>();
		const durableStates: RelayHealthPublication["state"][] = [];
		let revision = f.monitor.snapshot().revision ?? 0;
		let pendingReady: RelayHealthPublication | undefined;
		f.publish.mockImplementation((value) => {
			if (!pendingReady) {
				pendingReady = value;
				readyStarted.resolve();
				return readyReceipt.promise;
			}
			durableStates.push(value.state);
			return Promise.resolve(++revision);
		});
		const before = f.publish.mock.calls.length;
		f.setTime(510000);
		const cycle = f.monitor.runProbeCycle();
		await readyStarted.promise;
		const failure = middleware(context, () => nextGate.promise);
		// Act: storage commits READY, then the failure continues in the same turn.
		if (!pendingReady) throw new Error("missing deferred ready publication");
		durableStates.push(pendingReady.state);
		readyReceipt.resolve(++revision);
		nextGate.resolve();
		await Promise.all([cycle, failure]);
		// Assert: no later request or probe is needed to publish the current pause.
		expect(pendingReady.state).toBe("ready");
		expect(f.monitor.snapshot().state).toBe("paused");
		expect(durableStates).toEqual(["ready", "paused"]);
		expect(f.publish).toHaveBeenCalledTimes(before + 2);
	});
});

describe("relay health maintenance ownership", () => {
	it("reports uncertain shutdown when an in-flight ready publication fails without retry", async () => {
		// Arrange: refresh client observations without refreshing the installed server path.
		const f = setup();
		await f.recover();
		f.fetcher.mockImplementation(async (url) =>
			Response.json(String(url).includes("/members") ? healthMembers : healthCatalogue),
		);
		f.setTime(510000);
		await f.monitor.runProbeCycle();
		f.setTime(530000);
		await f.request();
		let rejectReady: (reason: Error) => void = () => {
			throw new Error("missing deferred publication");
		};
		let readyStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			readyStarted = resolve;
		});
		f.publish.mockImplementationOnce(
			() =>
				new Promise<number>((_resolve, reject) => {
					rejectReady = reject;
					readyStarted();
				}),
		);
		const before = f.publish.mock.calls.length;
		// Act
		const request = f.request("/v1/scopes/scope-a/members?group_id=group-a");
		await started;
		const stopping = f.monitor.stop();
		rejectReady(new Error("commit outcome unknown"));
		await request;
		const stopped = await stopping;
		// Assert
		expect(stopped).toBe(false);
		expect(f.publish).toHaveBeenCalledTimes(before + 1);
		expect(f.monitor.snapshot()).toMatchObject({ state: "tripped", revision: null });
	});
	it("stops a disabled monitor successfully without publishing", async () => {
		// Arrange
		const f = setup(false);
		// Act
		const stopped = await f.monitor.stop();
		// Assert
		expect(stopped).toBe(true);
		expect(f.publish).not.toHaveBeenCalled();
	});
	it("starts once, runs maintenance at thirty seconds, and clears its timer on stop", async () => {
		// Arrange
		vi.useFakeTimers();
		const f = setup();
		// Act
		f.monitor.start();
		f.monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		f.setTime(150000);
		await vi.advanceTimersByTimeAsync(30000);
		await f.monitor.stop();
		f.setTime(180000);
		await vi.advanceTimersByTimeAsync(30000);
		// Assert
		expect(f.fetcher).toHaveBeenCalledTimes(4);
		expect(f.monitor.snapshot().state).toBe("tripped");
	});
	it("retries maintenance after the remaining millisecond and cancels it on stop", async () => {
		// Arrange: timer deadlines and the monotonic clock advance independently.
		vi.useFakeTimers();
		const f = setup();
		f.route({ duration: 0 });
		f.monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		// Act: the first callback is late, so the next callback is one millisecond early.
		f.setTime(150001);
		await vi.advanceTimersByTimeAsync(30000);
		f.setTime(180000);
		await vi.advanceTimersByTimeAsync(30000);
		const beforeDue = f.fetcher.mock.calls.length;
		f.setTime(180001);
		await vi.advanceTimersByTimeAsync(1);
		const afterDue = f.fetcher.mock.calls.length;
		// Stop while the following callback is also one millisecond early.
		f.setTime(210000);
		await vi.advanceTimersByTimeAsync(29999);
		await f.monitor.stop();
		const beforeStop = f.fetcher.mock.calls.length;
		f.setTime(210001);
		await vi.advanceTimersByTimeAsync(1);
		const afterStop = f.fetcher.mock.calls.length;
		f.setTime(240001);
		await vi.advanceTimersByTimeAsync(30000);
		const whileStopped = f.fetcher.mock.calls.length;
		f.monitor.start();
		f.monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		const afterRestart = f.fetcher.mock.calls.length;
		await f.monitor.stop();
		// Assert: never probe early, wait only the remainder, and retain one timer owner.
		expect.soft(beforeDue).toBe(4);
		expect.soft(afterDue).toBe(6);
		expect(afterStop).toBe(beforeStop);
		expect(whileStopped).toBe(beforeStop);
		expect(afterRestart).toBe(beforeStop + 2);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("does not start requests or instrument responses while disabled", async () => {
		// Arrange
		const f = setup(false);
		// Act
		f.monitor.start();
		await f.monitor.runProbeCycle();
		await f.request();
		// Assert
		expect(f.fetcher).not.toHaveBeenCalled();
		expect(f.monitor.snapshot()).toMatchObject({ samples: 0, state: "tripped" });
	});
});

describe("relay health trip reasons", () => {
	it("records why it tripped, including the window that caused it", async () => {
		// Arrange
		const f = setup();
		await f.recover();
		f.route({ device: "real-device", duration: 3001 });
		// Act
		await f.request();
		f.setTime(540000);
		const snapshot = f.monitor.snapshot();
		// Assert: the snapshot and the host hook carry the cohort and sample detail.
		expect(snapshot.lastTrip).toMatchObject({
			reason: "window_bad",
			cohort: "catalogue:real-client",
			samples: 1,
			failures: 1,
			maxDurationMs: 3001,
		});
		expect(f.onTrip).toHaveBeenLastCalledWith(snapshot.lastTrip);
		// The reason survives a state export and import.
		const restored = new RelayHealthMonitor({ ...f.options, publish: async () => 1 });
		expect(restored.importState(f.monitor.exportState())).toBe(true);
		expect(restored.snapshot().lastTrip).toEqual(snapshot.lastTrip);
	});
});
