import type { Hono } from "hono";
import {
	createRelayHealthProbe,
	type RelayHealthEndpoint,
	type RelayHealthProbeObservation,
	type RelayHealthProbeOptions,
	verifiedRelayHealthTime,
} from "./relay-health-probe.js";
import type { RelayHealthPublication, RelayHealthPublisher } from "./relay-health-storage.js";

type Cohort = "probe-server" | "probe-client" | "real-client";
const ENDPOINTS: readonly RelayHealthEndpoint[] = ["catalogue", "members"];
const COHORTS: readonly Cohort[] = ["probe-server", "probe-client", "real-client"];
const WINDOW_MS = 60000;
const FRESH_MS = 50000;
const MAX_SAMPLES = 4096;

interface Window {
	durations: number[];
	failures: number;
	successAt: number | null;
	lastSuccessAt: number | null;
	badWindows: number;
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

function emptyWindow(): Window {
	return { durations: [], failures: 0, successAt: null, lastSuccessAt: null, badWindows: 0 };
}
function fresh(timestamp: number | null, now: number): timestamp is number {
	return timestamp !== null && timestamp <= now && timestamp + FRESH_MS > now;
}
function healthy(window: Window, now: number): boolean {
	const count = window.durations.length;
	if (!count || !fresh(window.successAt, now)) return false;
	return !badPerformance(window);
}
function badPerformance(window: Window): boolean {
	const count = window.durations.length;
	if (count < 20) return window.failures > 0 || window.durations.some((value) => value > 3000);
	const sorted = [...window.durations].sort((a, b) => a - b);
	return (
		(sorted[Math.ceil(count * 0.95) - 1] ?? Infinity) > 1000 || window.failures / count > 0.001
	);
}

/** One authority with one configured realm. No public observation ingestion surface. */
export class RelayHealthMonitor {
	private readonly windows = new Map<string, Window>();
	private readonly verified = new WeakMap<Request, { deviceId: string; groupId: string }>();
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
	private timer: ReturnType<typeof setInterval> | undefined;
	private publication: Promise<void> | undefined;
	private publicationRequested = false;
	private publishedState: RelayHealthPublication["state"] | null = null;

	constructor(private readonly options: RelayHealthOptions) {
		this.options = Object.freeze({ ...options });
		for (const endpoint of ENDPOINTS)
			for (const cohort of COHORTS) this.windows.set(`${endpoint}:${cohort}`, emptyWindow());
		this.probe = createRelayHealthProbe(options, (observation) => this.observeProbe(observation));
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
	private window(endpoint: RelayHealthEndpoint, cohort: Cohort): Window {
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
	private finishCohort(key: string, window: Window, end: number): boolean {
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
		window: Window,
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
		if (this.options.enabled && groupId === this.options.groupId)
			this.verified.set(request, { deviceId, groupId });
	}
	private endpoint(request: Request): RelayHealthEndpoint | null {
		if (request.method !== "GET") return null;
		const url = new URL(request.url);
		if ((url.searchParams.get("group_id") ?? "").trim() !== this.options.groupId) return null;
		if (url.pathname === "/v1/scopes") return "catalogue";
		return /^\/v1\/scopes\/[^/]+\/members$/.test(url.pathname) ? "members" : null;
	}
	private complete(
		request: Request,
		endpoint: RelayHealthEndpoint,
		started: number,
		status: number,
	): void {
		const principal = this.verified.get(request);
		this.verified.delete(request);
		// Admission health measures authenticated work, not callers exhausting a rate bucket.
		if (!principal || status === 401 || status === 403 || status === 429) return;
		const url = new URL(request.url);
		const synthetic =
			url.pathname === `/v1/scopes/${encodeURIComponent(this.options.syntheticScopeId)}/members`;
		const probe =
			principal?.deviceId === this.options.probeDeviceId && (endpoint === "catalogue" || synthetic);
		const success = status === 200;
		if (!success && status < 500) return;
		this.observe(endpoint, probe ? "probe-server" : "real-client", {
			endpoint,
			completedAt: this.options.clock(),
			durationMs: performance.now() - started,
			outcome: success ? "success" : "failure",
		});
	}
	/** Install before routes so timing includes auth, nonce, DB, serialization and close. */
	install(app: Hono): void {
		if (!this.options.enabled) return;
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
				try {
					this.complete(c.req.raw, endpoint, started, status);
				} catch {
					this.invalidateClock();
				}
				if (this.snapshot().state !== this.publishedState) await this.publish();
			}
		});
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
					// A newer state can match the previous publication while this write is in flight.
					if (this.snapshot().state !== snapshot.state) this.publicationRequested = true;
				} catch {
					this.trip();
					this.revision = null;
					this.publishedState = null;
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
	start(): void {
		if (!this.options.enabled || this.timer !== undefined) return;
		void this.runProbeCycle().catch(() => {
			this.trip();
		});
		this.timer = setInterval(() => {
			void this.runProbeCycle().catch(() => {
				this.trip();
			});
		}, 30000);
		this.timer.unref?.();
	}
	async stop(): Promise<boolean> {
		if (!this.options.enabled) return true;
		clearInterval(this.timer);
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
