import {
	RelayHealthInstrumentation,
	type RelayHealthServerSample,
} from "@codemem/core/internal/cloudflare-coordinator";
import {
	RELAY_HEALTH_OBJECT_NAME,
	readRelayHealthConfig,
	relayHealthClock,
} from "./relay-health-config.js";
import type { RelayHealth } from "./relay-health-object.js";

export interface RelayHealthWorkerEnv {
	readonly RELAY_HEALTH?: DurableObjectNamespace<RelayHealth>;
}
export type RelayHealthContext = Pick<ExecutionContext, "waitUntil">;

const SCOPE_READ = /^\/v1\/scopes(?:\/[^/]+\/members)?$/;

/**
 * Per-isolate budget for forwarded real-client samples: one per second with a
 * burst of ten. Each forwarded sample costs one Durable Object request. Probe
 * samples are never dropped, because readiness needs them.
 */
export class RelayHealthSampleBudget {
	private tokens = 10;
	private refilledAt: number | null = null;

	constructor(private readonly now: () => number = Date.now) {}

	take(): boolean {
		const now = this.now();
		const elapsed = this.refilledAt === null ? 0 : Math.max(0, now - this.refilledAt);
		this.refilledAt = now;
		this.tokens = Math.min(10, this.tokens + elapsed / 1000);
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}
}
const sampleBudget = new RelayHealthSampleBudget();

function healthStub(env: RelayHealthWorkerEnv) {
	const namespace = env.RELAY_HEALTH;
	return namespace?.get(namespace.idFromName(RELAY_HEALTH_OBJECT_NAME));
}

/**
 * Instrumentation for one coordinator request, or undefined when the request is
 * not a scope read or health is not configured. Samples go to the health object
 * through `waitUntil`, so the response never waits for that object.
 */
export function relayHealthInstrumentation(
	request: Request,
	env: RelayHealthWorkerEnv,
	ctx: RelayHealthContext | undefined,
	budget: RelayHealthSampleBudget = sampleBudget,
): RelayHealthInstrumentation | undefined {
	if (!ctx || request.method !== "GET" || !SCOPE_READ.test(new URL(request.url).pathname))
		return undefined;
	const config = readRelayHealthConfig(env as Readonly<Record<string, unknown>>);
	const stub = config ? healthStub(env) : undefined;
	if (!config || !stub) return undefined;
	const forward = (sample: RelayHealthServerSample) => {
		if (sample.cohort === "real-client" && !budget.take()) return;
		ctx.waitUntil(stub.recordServerSample(sample).catch(() => undefined));
	};
	return new RelayHealthInstrumentation(
		{ groups: config.scopes, probeDeviceId: config.probeDeviceId, clock: relayHealthClock },
		({ sample }) => {
			if (sample) forward(sample);
		},
	);
}

export type RelayHealthStart = "scheduled" | "not_configured" | "unavailable";

/** Arms the health alarm if none is set. The relay admission setup route calls this. */
export async function startRelayHealth(env: RelayHealthWorkerEnv): Promise<RelayHealthStart> {
	const stub = healthStub(env);
	if (!stub || !readRelayHealthConfig(env as Readonly<Record<string, unknown>>))
		return "not_configured";
	try {
		return (await stub.ensureScheduled()) ? "scheduled" : "not_configured";
	} catch {
		return "unavailable";
	}
}
