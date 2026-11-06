import { WorkerEntrypoint } from "cloudflare:workers";
import type { RelayHealthClockStamp } from "@codemem/core/internal/cloudflare-coordinator";
import { createConfiguredCloudflareCoordinatorWorker } from "../src/index.js";
import { RelayHealth } from "../src/relay-health-object.js";

let coordinatorWorker = createConfiguredCloudflareCoordinatorWorker();

export function relayHealthCoordinatorWorker() {
	return coordinatorWorker;
}

/** Retain durable health state while starting a new ephemeral coordinator isolate. */
export function resetRelayHealthCoordinatorWorker() {
	coordinatorWorker = createConfiguredCloudflareCoordinatorWorker();
}

/**
 * Shared between the test file and the objects, which run in one isolate. The
 * health object reads `enabled` and `settings` in its constructor, as a deploy
 * would refresh env.
 */
export interface RelayHealthTestState {
	enabled: boolean;
	/** Health env values: probe device, probe key and synthetic scopes. */
	settings: Record<string, string>;
	/** Fake UTC for the monitors, so alarms can step through minutes. */
	now?: number;
	/** The coordinator loopback answers 503, as an outage would. */
	failProbe: boolean;
	/** Only probes for this group get 503. */
	failGroup?: string;
	/** Runs before the loopback serves a probe request. */
	onProbe?: (url: URL) => Promise<void>;
	/** Observes only the loopback response status, without retaining signed requests. */
	onProbeResponse?: (status: number) => void;
	/** Holds forwarded samples until resolved. */
	sampleGate?: Promise<void>;
	samples: number;
	alarms: number;
}
export function relayHealthTestState(): RelayHealthTestState {
	const scope = globalThis as { __relayHealthTest?: RelayHealthTestState };
	scope.__relayHealthTest ??= {
		enabled: true,
		settings: {},
		failProbe: false,
		samples: 0,
		alarms: 0,
	};
	return scope.__relayHealthTest;
}

/** The env the coordinator sees with relay and relay health on. */
export function relayHealthWorkerEnv(env: Readonly<Record<string, unknown>>) {
	return {
		...env,
		CODEMEM_RELAY_ENABLED: "true",
		RELAY_HEALTH: env.RELAY_HEALTH_TEST,
		RELAY_REALM: env.RELAY_REALM_LOOPBACK_TEST,
		...relayHealthTestState().settings,
	};
}

/**
 * Test-only coordinator entrypoint with relay and health on. Production config
 * keeps relay off, so the pool cannot reach the real default handler with it on.
 * Everything behind it, including D1, auth and instrumentation, is production code.
 */
export class RelayCoordinatorEnabledTest extends WorkerEntrypoint<Record<string, unknown>> {
	override async fetch(request: Request): Promise<Response> {
		const state = relayHealthTestState();
		const url = new URL(request.url);
		await state.onProbe?.(url);
		if (state.failProbe || url.searchParams.get("group_id") === state.failGroup)
			return new Response(null, { status: 503 });
		const response = await relayHealthCoordinatorWorker().fetch(
			request,
			relayHealthWorkerEnv(this.env),
			this.ctx,
		);
		state.onProbeResponse?.(response.status);
		return response;
	}
}

/** Test-only health object. The production Wrangler config never binds it. */
export class RelayHealthTestObject extends RelayHealth {
	constructor(ctx: DurableObjectState, env: Readonly<Record<string, unknown>>) {
		const state = relayHealthTestState();
		super(ctx, state.enabled ? relayHealthWorkerEnv(env) : env);
	}
	protected override clock(): RelayHealthClockStamp {
		const now = relayHealthTestState().now;
		return now === undefined ? super.clock() : { ...super.clock(), utcMs: now };
	}
	protected override probeTarget(): Fetcher | null {
		const exports = this.ctx.exports as { RelayCoordinatorEnabledTest?: Fetcher };
		return exports.RelayCoordinatorEnabledTest ?? null;
	}
	override async alarm(): Promise<void> {
		await super.alarm();
		relayHealthTestState().alarms += 1;
	}
	/**
	 * Coordinator instrumentation stamps samples with the real clock. Restamp them
	 * with the fake clock, as if both clocks were the same host clock.
	 */
	override async recordServerSample(value: unknown): Promise<void> {
		const state = relayHealthTestState();
		await state.sampleGate;
		const sample = value as { observation?: { completedAt?: { utcMs?: number } } };
		const stamp = sample.observation?.completedAt;
		if (stamp && state.now !== undefined) stamp.utcMs = state.now;
		await super.recordServerSample(value);
		state.samples += 1;
	}
}
