import { DurableObject } from "cloudflare:workers";
import {
	aggregateRelayHealthAuthority,
	type D1DatabaseLike,
	d1RelayHealthPublisher,
	ensureD1RelayHealthRows,
	type RelayHealthClockStamp,
	RelayHealthMonitor,
	type RelayHealthPublication,
	type RelayHealthServerSample,
} from "@codemem/core/internal/cloudflare-coordinator";
import {
	createProbeSigner,
	RELAY_HEALTH_INTERVAL_MS,
	type RelayHealthConfig,
	readRelayHealthConfig,
	relayHealthClock,
} from "./relay-health-config.js";

/** Alarms run at least once, so a repeat inside this gap skips its probe. */
const MIN_CYCLE_GAP_MS = RELAY_HEALTH_INTERVAL_MS - 1000;
/**
 * Saved windows older than two minutes are discarded on load. A restart after
 * such a gap repeats the five-window recovery, like a new Node monitor.
 */
const MAX_RESTORE_GAP_MS = 2 * 60_000;
const AUTHORITY_KEY = "authority";
const CYCLE_KEY = "cycle";
const stateKey = (groupId: string) => `state:${groupId}`;

type Monitors = ReadonlyMap<string, RelayHealthMonitor>;

const ENDPOINTS = new Set(["catalogue", "members"]);
const COHORTS = new Set(["probe-server", "real-client"]);
const OUTCOMES = new Set(["success", "failure", "denied"]);

/** Rebuilds a sample from RPC input, keeping only the fields the monitor reads. */
function parseSample(value: unknown): RelayHealthServerSample | null {
	const sample = value as Partial<RelayHealthServerSample> | null;
	const observation = sample?.observation;
	const stamp = observation?.completedAt;
	if (
		typeof sample?.groupId !== "string" ||
		!COHORTS.has(String(sample.cohort)) ||
		!ENDPOINTS.has(String(observation?.endpoint)) ||
		!OUTCOMES.has(String(observation?.outcome)) ||
		typeof observation?.durationMs !== "number" ||
		typeof stamp?.utcMs !== "number" ||
		typeof stamp.verified !== "boolean" ||
		typeof stamp.maxErrorMs !== "number" ||
		typeof stamp.resolutionMs !== "number"
	)
		return null;
	const { utcMs, verified, maxErrorMs, resolutionMs } = stamp;
	return {
		groupId: sample.groupId,
		cohort: sample.cohort as RelayHealthServerSample["cohort"],
		observation: {
			endpoint: observation.endpoint as RelayHealthServerSample["observation"]["endpoint"],
			outcome: observation.outcome as RelayHealthServerSample["observation"]["outcome"],
			durationMs: observation.durationMs,
			completedAt: { utcMs, verified, maxErrorMs, resolutionMs },
		},
	};
}

/**
 * Coordinator-side owner of relay readiness: one instance per Worker, outside
 * every relay realm object. It runs one RelayHealthMonitor per configured group
 * from a 30 s alarm, keeps their windows in its own storage between alarms, and
 * publishes authority and realm readiness to COORDINATOR_DB.
 *
 * The probe reaches the Worker's own default handler through `ctx.exports`,
 * because a Worker cannot fetch its own workers.dev URL. That measures the
 * coordinator's handling of a real v2 request, but not the public HTTPS path.
 */
export class RelayHealth extends DurableObject<Record<string, never>> {
	private readonly config: RelayHealthConfig | null;
	private readonly db: D1DatabaseLike | null;
	private monitors: Promise<Monitors> | null = null;
	private publications: Promise<unknown> = Promise.resolve();
	private inAlarm = false;

	constructor(ctx: DurableObjectState, env: Readonly<Record<string, unknown>>) {
		// The base class keeps no env. Only the validated config and the D1 binding remain.
		super(ctx, {});
		this.config = readRelayHealthConfig(env);
		this.db = (env.COORDINATOR_DB as D1DatabaseLike | undefined) ?? null;
	}

	/** Arms an immediate alarm unless one is set. False when health is not configured. */
	async ensureScheduled(): Promise<boolean> {
		if (!this.config || !this.db) return false;
		// getAlarm() reads null while the handler runs, and the handler re-arms itself.
		if (!this.inAlarm && (await this.ctx.storage.getAlarm()) === null)
			await this.ctx.storage.setAlarm(Date.now());
		return true;
	}

	/**
	 * Re-arms first, then probes. A storage failure before the next alarm is set
	 * propagates, because the platform retries an alarm only when it throws, and
	 * a swallowed failure would leave no alarm at all. After re-arming, probe and
	 * publication failures are caught, so retries never stack on the cadence.
	 * With relay off or unconfigured it returns without re-arming, which leaves no
	 * recurring alarm. A repeated delivery within the gap, including a platform
	 * retry after a scheduling failure, skips its probe and keeps the cadence.
	 */
	override async alarm(): Promise<void> {
		const { config, db } = this;
		if (!config || !db) return;
		this.inAlarm = true;
		try {
			if (!(await this.scheduleNextCycle())) return;
			try {
				await this.runCycles(config, db);
			} catch {
				// A failed cycle has already tripped its monitor. The next alarm tries again.
			}
		} finally {
			this.inAlarm = false;
		}
	}

	/** Sets the next alarm. False when this delivery repeats a recent cycle. */
	private async scheduleNextCycle(): Promise<boolean> {
		const now = Date.now();
		const last = await this.ctx.storage.get<number>(CYCLE_KEY);
		if (last !== undefined && now >= last && now - last < MIN_CYCLE_GAP_MS) {
			await this.ctx.storage.setAlarm(last + RELAY_HEALTH_INTERVAL_MS);
			return false;
		}
		await this.ctx.storage.put(CYCLE_KEY, now);
		await this.ctx.storage.setAlarm(now + RELAY_HEALTH_INTERVAL_MS);
		return true;
	}

	/**
	 * Producer link for coordinator instrumentation in other isolates. A sample
	 * stamped later than this object's clock is clamped to it, which only makes
	 * it older. Each call also re-arms a missing alarm.
	 */
	async recordServerSample(value: unknown): Promise<void> {
		const { config, db } = this;
		if (!config || !db) return;
		try {
			const sample = parseSample(value);
			const monitor = sample && (await this.loadMonitors(config, db)).get(sample.groupId);
			if (!sample || !monitor) return;
			const completedAt = sample.observation.completedAt;
			const utcMs = Math.min(completedAt.utcMs, this.clock().utcMs);
			await monitor.recordServerSample({
				...sample,
				observation: { ...sample.observation, completedAt: { ...completedAt, utcMs } },
			});
			await this.persist(config, sample.groupId, monitor);
			await this.ensureScheduled();
		} catch {
			// A dropped sample can delay a trip or a recovery by one cycle at most.
		}
	}

	/** Tests replace the clock. Production uses the host clock as verified UTC. */
	protected clock(): RelayHealthClockStamp {
		return relayHealthClock();
	}

	/** The Worker's own default handler, through the `ctx.exports` loopback. */
	protected probeTarget(): Fetcher | null {
		return (this.ctx.exports as { default?: Fetcher } | undefined)?.default ?? null;
	}

	private async runCycles(config: RelayHealthConfig, db: D1DatabaseLike): Promise<void> {
		const monitors = await this.loadMonitors(config, db);
		if ([...monitors.values()].some((monitor) => monitor.exportState().revision === null))
			await this.serialize(() =>
				ensureD1RelayHealthRows(db, config.relay.authorityId, [...monitors.keys()]),
			);
		for (const [groupId, monitor] of monitors) {
			await monitor.runScheduledCycle();
			await this.persist(config, groupId, monitor);
		}
	}

	private loadMonitors(config: RelayHealthConfig, db: D1DatabaseLike): Promise<Monitors> {
		this.monitors ??= this.createMonitors(config, db).catch((error: unknown) => {
			this.monitors = null;
			throw error;
		});
		return this.monitors;
	}

	private async createMonitors(config: RelayHealthConfig, db: D1DatabaseLike): Promise<Monitors> {
		const sameAuthority =
			(await this.ctx.storage.get<string>(AUTHORITY_KEY)) === config.relay.authorityId;
		const sign = createProbeSigner(config.probeDeviceId, config.probeKey);
		const fetch = ((input: string, init?: RequestInit) => {
			const target = this.probeTarget();
			if (!target) return Promise.reject(new Error("relay_health_probe_target"));
			// A service binding fetch rejects redirect "error", so send manual. A 3xx is a failure.
			return target.fetch(String(input), { ...init, redirect: "manual" });
		}) as typeof globalThis.fetch;
		const monitors = new Map<string, RelayHealthMonitor>();
		// Every realm publication must also bump the authority row. It carries the
		// aggregate of every group, so one group's trip never denies the others.
		const authority = (groupId: string, value: RelayHealthPublication) =>
			aggregateRelayHealthAuthority(
				[...monitors].map(([other, monitor]) => (other === groupId ? value : monitor.snapshot())),
			);
		for (const [groupId, syntheticScopeId] of config.scopes) {
			const publish = d1RelayHealthPublisher(
				db,
				{ authorityId: config.relay.authorityId, groupId },
				{ authority: (value) => authority(groupId, value) },
			);
			const monitor = new RelayHealthMonitor({
				enabled: true,
				coordinatorOrigin: config.origin,
				groupId,
				syntheticScopeId,
				probeDeviceId: config.probeDeviceId,
				clock: () => this.clock(),
				sign,
				fetch,
				publish: (value) => this.serialize(() => publish(value)),
			});
			if (sameAuthority)
				monitor.importState(await this.ctx.storage.get(stateKey(groupId)), {
					maxGapMs: MAX_RESTORE_GAP_MS,
				});
			monitors.set(groupId, monitor);
		}
		return monitors;
	}

	private persist(config: RelayHealthConfig, groupId: string, monitor: RelayHealthMonitor) {
		return this.ctx.storage.put({
			[AUTHORITY_KEY]: config.relay.authorityId,
			[stateKey(groupId)]: monitor.exportState(),
		});
	}

	/** One D1 readiness writer at a time, so publications never race on the authority revision. */
	private serialize<T>(work: () => Promise<T>): Promise<T> {
		const run = this.publications.then(work);
		this.publications = run.catch(() => undefined);
		return run;
	}
}
