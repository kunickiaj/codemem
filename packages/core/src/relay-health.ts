import type { Hono } from "hono";
import {
	createRelayHealthProbe,
	type RelayHealthClockStamp,
	type RelayHealthEndpoint,
	type RelayHealthProbeObservation,
	type RelayHealthProbeOptions,
	verifiedRelayHealthTime,
} from "./relay-health-probe.js";
import type { RelayHealthPublication, RelayHealthPublisher } from "./relay-health-storage.js";

type Cohort = "probe-server" | "probe-client" | "real-client";
export type RelayHealthServerCohort = Exclude<Cohort, "probe-client">;
const ENDPOINTS: readonly RelayHealthEndpoint[] = ["catalogue", "members"];
const COHORTS: readonly Cohort[] = ["probe-server", "probe-client", "real-client"];
const WINDOW_MS = 60000;
const FRESH_MS = 50000;
const MAX_SAMPLES = 4096;

export interface RelayHealthWindow {
	durations: number[];
	failures: number;
	successAt: number | null;
	lastSuccessAt: number | null;
	badWindows: number;
}
/** One authenticated server observation, produced by coordinator instrumentation. */
export interface RelayHealthServerSample {
	readonly groupId: string;
	readonly cohort: RelayHealthServerCohort;
	readonly observation: RelayHealthProbeObservation;
}
/** What instrumentation saw for one matched request. A fault means classification threw. */
export interface RelayHealthServerEvent {
	readonly sample: RelayHealthServerSample | null;
	readonly fault: boolean;
}
export interface RelayHealthInstrumentationOptions {
	/** Instrumented group IDs mapped to each group's synthetic probe scope. */
	readonly groups: ReadonlyMap<string, string>;
	readonly probeDeviceId: string;
	readonly clock: () => RelayHealthClockStamp;
}
/** The part of a monitor the coordinator app calls. */
export interface RelayHealthServerHook {
	verifiedGroupMember(request: Request, deviceId: string, groupId: string): void;
	install(app: Hono): void;
}
/** Persistable monitor state. Timers, in-flight cycles and the monotonic cycle guard are excluded. */
export interface RelayHealthState {
	readonly version: 1;
	readonly windows: Readonly<Record<string, RelayHealthWindow>>;
	readonly windowStart: number | null;
	readonly fullWindow: boolean;
	readonly tripped: boolean;
	readonly healthyWindows: number;
	readonly clockValid: boolean;
	readonly revision: number | null;
	readonly lastNow: number | null;
	readonly publishedState: RelayHealthPublication["state"] | null;
}
export interface RelayHealthSnapshot extends RelayHealthPublication {
	readonly revision: number | null;
	readonly validUntilMs: number | null;
	readonly healthyWindows: number;
	readonly samples: number;
}
export interface RelayHealthOptions extends RelayHealthProbeOptions {
	readonly enabled: boolean;
	readonly publish: RelayHealthPublisher;
}
export interface RelayHealthRuntimeOptions extends Omit<RelayHealthOptions, "publish"> {
	readonly authorityId: string;
	/** Receives a stopped monitor. The owner explicitly starts and stops maintenance. */
	readonly onMonitor: (monitor: RelayHealthMonitor) => void;
}

function emptyWindow(): RelayHealthWindow {
	return { durations: [], failures: 0, successAt: null, lastSuccessAt: null, badWindows: 0 };
}
function fresh(timestamp: number | null, now: number): timestamp is number {
	return timestamp !== null && timestamp <= now && timestamp + FRESH_MS > now;
}
function healthy(window: RelayHealthWindow, now: number): boolean {
	const count = window.durations.length;
	if (!count || !fresh(window.successAt, now)) return false;
	return !badPerformance(window);
}
function badPerformance(window: RelayHealthWindow): boolean {
	const count = window.durations.length;
	if (count < 20) return window.failures > 0 || window.durations.some((value) => value > 3000);
	const sorted = [...window.durations].sort((a, b) => a - b);
	return (
		(sorted[Math.ceil(count * 0.95) - 1] ?? Infinity) > 1000 || window.failures / count > 0.001
	);
}

const nullableNumber = (value: unknown): value is number | null =>
	value === null || (typeof value === "number" && Number.isFinite(value));

function isWindow(value: unknown): value is RelayHealthWindow {
	if (!value || typeof value !== "object") return false;
	const window = value as Record<string, unknown>;
	return (
		Array.isArray(window.durations) &&
		window.durations.length <= MAX_SAMPLES &&
		window.durations.every((duration) => typeof duration === "number" && duration >= 0) &&
		Number.isSafeInteger(window.failures) &&
		Number.isSafeInteger(window.badWindows) &&
		nullableNumber(window.successAt) &&
		nullableNumber(window.lastSuccessAt)
	);
}

function isRelayHealthState(value: unknown): value is RelayHealthState {
	if (!value || typeof value !== "object") return false;
	const state = value as Record<string, unknown>;
	const windows = state.windows as Record<string, unknown> | null;
	const keys = ENDPOINTS.flatMap((endpoint) => COHORTS.map((cohort) => `${endpoint}:${cohort}`));
	return (
		state.version === 1 &&
		!!windows &&
		typeof windows === "object" &&
		Object.keys(windows).length === keys.length &&
		keys.every((key) => isWindow(windows[key])) &&
		nullableNumber(state.windowStart) &&
		typeof state.fullWindow === "boolean" &&
		typeof state.tripped === "boolean" &&
		Number.isSafeInteger(state.healthyWindows) &&
		typeof state.clockValid === "boolean" &&
		(state.revision === null || Number.isSafeInteger(state.revision)) &&
		nullableNumber(state.lastNow) &&
		(state.publishedState === null ||
			["ready", "paused", "tripped"].includes(String(state.publishedState)))
	);
}

/**
 * Times authenticated catalogue and member reads and classifies each into a server
 * cohort. The sink decides where samples go, so a monitor can record them locally
 * and a Worker can forward them to the isolate that owns the monitor.
 */
export class RelayHealthInstrumentation implements RelayHealthServerHook {
	private readonly verified = new WeakMap<Request, { deviceId: string; groupId: string }>();

	constructor(
		private readonly options: RelayHealthInstrumentationOptions,
		private readonly sink: (event: RelayHealthServerEvent) => void | Promise<void>,
	) {
		this.options = Object.freeze({ ...options });
	}
	/** Called only after the existing normal enrollment proof and nonce check succeed. */
	verifiedGroupMember(request: Request, deviceId: string, groupId: string): void {
		if (this.options.groups.has(groupId)) this.verified.set(request, { deviceId, groupId });
	}
	private endpoint(request: Request): RelayHealthEndpoint | null {
		if (request.method !== "GET") return null;
		const url = new URL(request.url);
		if (!this.options.groups.has((url.searchParams.get("group_id") ?? "").trim())) return null;
		if (url.pathname === "/v1/scopes") return "catalogue";
		return /^\/v1\/scopes\/[^/]+\/members$/.test(url.pathname) ? "members" : null;
	}
	private complete(
		request: Request,
		endpoint: RelayHealthEndpoint,
		started: number,
		status: number,
	): RelayHealthServerSample | null {
		const principal = this.verified.get(request);
		this.verified.delete(request);
		// Admission health measures authenticated work, not callers exhausting a rate bucket.
		if (!principal || status === 401 || status === 403 || status === 429) return null;
		const url = new URL(request.url);
		const scopeId = this.options.groups.get(principal.groupId) ?? "";
		const synthetic = url.pathname === `/v1/scopes/${encodeURIComponent(scopeId)}/members`;
		const probe =
			principal.deviceId === this.options.probeDeviceId && (endpoint === "catalogue" || synthetic);
		const success = status === 200;
		if (!success && status < 500) return null;
		return {
			groupId: principal.groupId,
			cohort: probe ? "probe-server" : "real-client",
			observation: {
				endpoint,
				completedAt: this.options.clock(),
				durationMs: performance.now() - started,
				outcome: success ? "success" : "failure",
			},
		};
	}
	install(app: Hono): void {
		app.use("*", async (c, next) => {
			const endpoint = this.endpoint(c.req.raw);
			if (!endpoint) {
				await next();
				return;
			}
			const started = performance.now();
			let status = 500;
			try {
				await next();
				status = c.res.status;
			} finally {
				let event: RelayHealthServerEvent;
				try {
					event = { sample: this.complete(c.req.raw, endpoint, started, status), fault: false };
				} catch {
					event = { sample: null, fault: true };
				}
				await this.sink(event);
			}
		});
	}
}

/** One authority with one configured realm. No public observation ingestion surface. */
export class RelayHealthMonitor {
	private readonly windows = new Map<string, RelayHealthWindow>();
	private readonly instrumentation: RelayHealthInstrumentation;
	private readonly probe: (signal?: AbortSignal) => Promise<void>;
	private windowStart: number | null = null;
	private fullWindow = false;
	private tripped = true;
	private healthyWindows = 0;
	private clockValid = false;
	private revision: number | null = null;
	private lastNow: number | null = null;
	private lastCycle = -Infinity;
	private running = false;
	private suspended = false;
	private cycleAbort: AbortController | undefined;
	private activeCycle: Promise<RelayHealthSnapshot> | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private publication: Promise<void> | undefined;
	private publicationRequested = false;
	private publishedState: RelayHealthPublication["state"] | null = null;
	private publishedObservedAtMs: number | null = null;

	constructor(private readonly options: RelayHealthOptions) {
		this.options = Object.freeze({ ...options });
		for (const endpoint of ENDPOINTS)
			for (const cohort of COHORTS) this.windows.set(`${endpoint}:${cohort}`, emptyWindow());
		this.probe = createRelayHealthProbe(options, (observation) => this.observeProbe(observation));
		this.instrumentation = new RelayHealthInstrumentation(
			{
				groups: new Map([[options.groupId, options.syntheticScopeId]]),
				probeDeviceId: options.probeDeviceId,
				clock: options.clock,
			},
			(event) => this.afterServerRequest(event),
		);
	}
	private clock(): number | null {
		try {
			const now = verifiedRelayHealthTime(this.options.clock());
			if (now !== null && (this.lastNow === null || now >= this.lastNow)) {
				this.lastNow = now;
				this.clockValid = true;
				return now;
			}
		} catch {
			/* A missing clock proof cannot renew readiness. */
		}
		this.invalidateClock();
		return null;
	}
	private invalidateClock(): void {
		this.clockValid = false;
		this.healthyWindows = 0;
		this.fullWindow = false;
		for (const window of this.windows.values()) {
			window.lastSuccessAt = null;
			window.successAt = null;
		}
	}
	private trip(): void {
		this.tripped = true;
		this.healthyWindows = 0;
	}
	private window(endpoint: RelayHealthEndpoint, cohort: Cohort): RelayHealthWindow {
		const window = this.windows.get(`${endpoint}:${cohort}`);
		if (!window) throw new Error("relay_health_internal_cohort");
		return window;
	}
	private finishWindow(end: number): void {
		let allHealthy = this.fullWindow;
		for (const [key, window] of this.windows)
			if (!this.finishCohort(key, window, end)) allHealthy = false;
		if (allHealthy && this.clockValid) {
			this.healthyWindows = Math.min(5, this.healthyWindows + 1);
			if (this.healthyWindows === 5) this.tripped = false;
		} else this.healthyWindows = 0;
	}
	private finishCohort(key: string, window: RelayHealthWindow, end: number): boolean {
		const count = window.durations.length;
		if (key.endsWith(":real-client") && count === 0) {
			window.badWindows = 0;
			return true;
		}
		const bad = badPerformance(window);
		window.badWindows = count >= 20 && bad ? window.badWindows + 1 : 0;
		if (window.badWindows >= 2 || (count > 0 && count < 20 && bad)) this.trip();
		return healthy(window, end);
	}
	private advance(now: number): void {
		const start = Math.floor(now / WINDOW_MS) * WINDOW_MS;
		if (this.windowStart === null) {
			this.windowStart = start;
			return;
		}
		if (start === this.windowStart) return;
		if (start > this.windowStart + WINDOW_MS) this.fullWindow = false;
		this.finishWindow(this.windowStart + WINDOW_MS);
		if (start > this.windowStart + WINDOW_MS) this.healthyWindows = 0;
		for (const window of this.windows.values()) {
			window.durations = [];
			window.failures = 0;
			window.successAt = null;
			if (start > this.windowStart + WINDOW_MS) window.badWindows = 0;
		}
		this.windowStart = start;
		this.fullWindow = true;
	}
	private observe(
		endpoint: RelayHealthEndpoint,
		cohort: Cohort,
		observation: RelayHealthProbeObservation,
	): void {
		if (this.suspended) return;
		const now = this.clock();
		const completedAt = verifiedRelayHealthTime(observation.completedAt);
		if (now === null || !fresh(completedAt, now)) {
			this.invalidateClock();
			return;
		}
		this.advance(now);
		if (observation.outcome === "denied") return;
		const window = this.window(endpoint, cohort);
		this.addSample(window, completedAt, observation);
	}
	private addSample(
		window: RelayHealthWindow,
		completedAt: number,
		observation: RelayHealthProbeObservation,
	): void {
		const duration = observation.durationMs;
		if (!Number.isFinite(duration) || duration < 0 || window.durations.length >= MAX_SAMPLES) {
			this.fullWindow = false;
			this.trip();
			return;
		}
		const failure = observation.outcome === "failure" || duration > 3000;
		// Delayed producer delivery must not count towards a newer recovery minute.
		if (this.windowStart !== null && completedAt < this.windowStart) {
			if (failure) this.trip();
			else window.lastSuccessAt = Math.max(window.lastSuccessAt ?? 0, completedAt);
			return;
		}
		window.durations.push(duration);
		if (failure) {
			window.failures++;
		} else {
			window.successAt = Math.max(window.successAt ?? 0, completedAt);
			window.lastSuccessAt = Math.max(window.lastSuccessAt ?? 0, completedAt);
		}
	}
	private observeProbe(observation: RelayHealthProbeObservation): void {
		this.observe(observation.endpoint, "probe-client", observation);
	}
	/** Called only after the existing normal enrollment proof and nonce check succeed. */
	verifiedGroupMember(request: Request, deviceId: string, groupId: string): void {
		if (this.options.enabled) this.instrumentation.verifiedGroupMember(request, deviceId, groupId);
	}
	/** Install before routes so timing includes auth, nonce, DB, serialization and close. */
	install(app: Hono): void {
		if (this.options.enabled) this.instrumentation.install(app);
	}
	private async afterServerRequest(event: RelayHealthServerEvent): Promise<void> {
		if (event.fault) this.invalidateClock();
		else if (event.sample)
			this.observe(
				event.sample.observation.endpoint,
				event.sample.cohort,
				event.sample.observation,
			);
		if (this.snapshot().state !== this.publishedState) await this.publish();
	}
	/**
	 * Trusted internal producer link for an owner whose instrumentation runs elsewhere,
	 * such as another Worker isolate. The sample keeps its own completion time.
	 */
	async recordServerSample(sample: RelayHealthServerSample): Promise<void> {
		if (!this.options.enabled || sample.groupId !== this.options.groupId) return;
		await this.afterServerRequest({ sample, fault: false });
		// A forwarded probe sample can land after its cycle published. Publish again
		// when it advances a ready stamp, so readiness does not lag a cycle behind.
		const snapshot = this.snapshot();
		if (
			sample.cohort === "probe-server" &&
			snapshot.state === "ready" &&
			snapshot.observedAtMs !== this.publishedObservedAtMs
		)
			await this.publish();
	}
	snapshot(): RelayHealthSnapshot {
		const now = this.clock();
		if (now !== null) this.advance(now);
		const required = ENDPOINTS.flatMap((endpoint) => [
			this.window(endpoint, "probe-server").lastSuccessAt,
			this.window(endpoint, "probe-client").lastSuccessAt,
		]);
		for (const endpoint of ENDPOINTS) {
			const real = this.window(endpoint, "real-client");
			if (real.durations.length > 0) required.push(real.lastSuccessAt);
		}
		const observedAtMs =
			now !== null && this.clockValid && required.every((value) => fresh(value, now))
				? Math.min(...(required as number[]))
				: null;
		let state: RelayHealthPublication["state"] = "paused";
		const lowVolumeFailure = [...this.windows.values()].some(
			(window) =>
				window.durations.length > 0 && window.durations.length < 20 && badPerformance(window),
		);
		if (this.tripped) state = "tripped";
		else if (this.options.enabled && !this.suspended && observedAtMs !== null && !lowVolumeFailure)
			state = "ready";
		return {
			revision: this.revision,
			state,
			observedAtMs,
			validUntilMs: observedAtMs === null ? null : observedAtMs + FRESH_MS,
			healthyWindows: this.healthyWindows,
			samples: [...this.windows.values()].reduce((sum, window) => sum + window.durations.length, 0),
		};
	}
	private publish(): Promise<void> {
		this.publicationRequested = true;
		if (this.publication) return this.publication;
		// Establish ownership before the drain can finish or fail synchronously.
		this.publication = Promise.resolve().then(() => this.drainPublications());
		return this.publication;
	}
	private async drainPublications(): Promise<void> {
		try {
			while (this.publicationRequested) {
				this.publicationRequested = false;
				try {
					const snapshot = this.snapshot();
					const revision = await this.options.publish(snapshot);
					if (!Number.isSafeInteger(revision) || revision === null || revision < 1)
						throw new Error("relay_health_receipt_invalid");
					this.revision = revision;
					this.publishedState = snapshot.state;
					this.publishedObservedAtMs = snapshot.observedAtMs;
					// A newer state can match the previous publication while this write is in flight.
					if (this.snapshot().state !== snapshot.state) this.publicationRequested = true;
				} catch {
					this.trip();
					this.revision = null;
					this.publishedState = null;
					this.publishedObservedAtMs = null;
					this.invalidateClock();
					this.publicationRequested = false;
					return;
				}
			}
		} finally {
			// Release ownership before settling the promise so a tail request starts a new drain.
			this.publication = undefined;
		}
	}
	runProbeCycle(): Promise<RelayHealthSnapshot> {
		const monotonicNow = performance.now();
		if (!this.options.enabled || this.running || monotonicNow - this.lastCycle < 30000)
			return Promise.resolve(this.snapshot());
		this.lastCycle = monotonicNow;
		return this.startCycle();
	}
	/**
	 * Runs one cycle now, for an owner that schedules cycles itself instead of
	 * calling start(), such as a Durable Object alarm. The owner enforces the
	 * 30 s cadence, because a fresh object has no monotonic history.
	 */
	runScheduledCycle(): Promise<RelayHealthSnapshot> {
		if (!this.options.enabled || this.running) return Promise.resolve(this.snapshot());
		return this.startCycle();
	}
	private startCycle(): Promise<RelayHealthSnapshot> {
		this.suspended = false;
		this.running = true;
		this.cycleAbort = new AbortController();
		this.activeCycle = this.runCycle(this.cycleAbort.signal);
		return this.activeCycle;
	}
	private async runCycle(signal: AbortSignal): Promise<RelayHealthSnapshot> {
		try {
			// Publish the conservative startup state before any positive observation.
			if (this.publishedState === null) await this.publish();
			if (!signal.aborted) await this.probe(signal);
		} catch {
			this.invalidateClock();
		}
		await this.publish();
		this.running = false;
		return this.snapshot();
	}
	/** Window and publication state for an owner that persists the monitor between cycles. */
	exportState(): RelayHealthState {
		const windows: Record<string, RelayHealthWindow> = {};
		for (const [key, window] of this.windows)
			windows[key] = { ...window, durations: [...window.durations] };
		return {
			version: 1,
			windows,
			windowStart: this.windowStart,
			fullWindow: this.fullWindow,
			tripped: this.tripped,
			healthyWindows: this.healthyWindows,
			clockValid: this.clockValid,
			revision: this.revision,
			lastNow: this.lastNow,
			publishedState: this.publishedState,
		};
	}
	/**
	 * Restores exported state into a new, idle monitor. Returns false and keeps the
	 * conservative startup state when the value does not have the exported shape,
	 * or when `maxGapMs` is set and the state was last updated longer ago than that
	 * by the verified clock. A restart after such a gap must repeat the five-window
	 * recovery, as a new Node monitor does.
	 */
	importState(value: unknown, options: { readonly maxGapMs?: number } = {}): boolean {
		if (this.running || !isRelayHealthState(value)) return false;
		if (options.maxGapMs !== undefined && !this.withinGap(value.lastNow, options.maxGapMs))
			return false;
		for (const [key, window] of Object.entries(value.windows))
			this.windows.set(key, { ...window, durations: [...window.durations] });
		this.windowStart = value.windowStart;
		this.fullWindow = value.fullWindow;
		this.tripped = value.tripped;
		this.healthyWindows = value.healthyWindows;
		this.clockValid = value.clockValid;
		this.revision = value.revision;
		this.lastNow = value.lastNow;
		this.publishedState = value.publishedState;
		return true;
	}
	private withinGap(lastNow: number | null, maxGapMs: number): boolean {
		let now: number | null = null;
		try {
			now = verifiedRelayHealthTime(this.options.clock());
		} catch {
			/* No clock proof, so the gap is unknown. */
		}
		return now !== null && lastNow !== null && now >= lastNow && now - lastNow <= maxGapMs;
	}
	start(): void {
		if (!this.options.enabled || this.timer !== undefined) return;
		this.scheduleMaintenance(30000);
		void this.runProbeCycle().catch(() => {
			this.trip();
		});
	}
	private scheduleMaintenance(delayMs: number): void {
		this.timer = setTimeout(() => {
			if (this.timer === undefined) return;
			const remaining = 30000 - (performance.now() - this.lastCycle);
			this.scheduleMaintenance(remaining > 0 ? remaining : 30000);
			if (remaining <= 0)
				void this.runProbeCycle().catch(() => {
					this.trip();
				});
		}, Math.ceil(delayMs));
		this.timer.unref?.();
	}
	async stop(): Promise<boolean> {
		if (!this.options.enabled) return true;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.suspended = true;
		this.trip();
		this.invalidateClock();
		this.cycleAbort?.abort();
		await this.activeCycle;
		await this.publish();
		return this.publishedState === "tripped" && this.revision !== null;
	}
}
