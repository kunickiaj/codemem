import {
	type CoordinatorAppBrowserAuthOptions,
	type CoordinatorRequestRateLimitOptions,
	type CoordinatorRequestVerifier,
	type CoordinatorRuntimeDeps,
	createCoordinatorApp,
} from "./coordinator-api.js";
import type { CoordinatorDeviceRevocationContext } from "./coordinator-device-revocation-route.js";
import type { CoordinatorRelayAdmissionRuntimeOptions } from "./coordinator-relay-admission-route.js";
import { D1CoordinatorStore, type D1DatabaseLike } from "./d1-coordinator-store.js";
import {
	RelayHealthMonitor,
	type RelayHealthRuntimeOptions,
	type RelayHealthServerHook,
} from "./relay-health.js";
import { d1RelayHealthPublisher } from "./relay-health-storage.js";

export interface CreateD1CoordinatorAppOptions {
	db: D1DatabaseLike;
	adminSecret?: string | null;
	now?: () => string;
	requestVerifier: CoordinatorRequestVerifier;
	requestRateLimit?: CoordinatorRequestRateLimitOptions;
	deviceRevocation?: CoordinatorDeviceRevocationContext;
	relayAdmission?: CoordinatorRelayAdmissionRuntimeOptions;
	relayHealth?: RelayHealthRuntimeOptions;
	/**
	 * Instrumentation only, for a runtime whose monitor lives elsewhere, such as a
	 * Worker that forwards samples to a Durable Object. Ignored when `relayHealth` is enabled.
	 */
	relayHealthInstrumentation?: RelayHealthServerHook;
	recipientInviteCoordinatorId?: string;
	browserAuth?:
		| Exclude<CoordinatorAppBrowserAuthOptions, { kind: "ready" }>
		| Omit<Extract<CoordinatorAppBrowserAuthOptions, { kind: "ready" }>, "storeFactory">;
}

export function createD1CoordinatorApp(
	opts: CreateD1CoordinatorAppOptions,
): ReturnType<typeof createCoordinatorApp> {
	const db = opts.db;
	const runtime: CoordinatorRuntimeDeps = {
		adminSecret: () => String(opts.adminSecret ?? "").trim() || null,
		now: opts.now ?? (() => new Date().toISOString()),
	};
	return createCoordinatorApp({
		relayHealth: createD1HealthMonitor(opts.relayHealth, db) ?? opts.relayHealthInstrumentation,
		storeFactory: () => new D1CoordinatorStore(db),
		deviceRevocation: opts.deviceRevocation,
		recipientInviteCoordinatorId: opts.recipientInviteCoordinatorId,
		runtime,
		requestVerifier: opts.requestVerifier,
		requestRateLimit: opts.requestRateLimit,
		relayAdmission: opts.relayAdmission
			? {
					...opts.relayAdmission,
					open: () => ({
						database: {
							query: async (sql, values) =>
								(
									await db
										.prepare(sql)
										.bind(...values)
										.all()
								).results,
							insertReturning: (sql, values) =>
								db
									.prepare(sql)
									.bind(...values)
									.first(),
						},
						close: () => {},
					}),
				}
			: undefined,
		browserAuth:
			opts.browserAuth?.kind === "ready"
				? { ...opts.browserAuth, storeFactory: () => new D1CoordinatorStore(db) }
				: opts.browserAuth,
	});
}

function createD1HealthMonitor(
	options: RelayHealthRuntimeOptions | undefined,
	db: D1DatabaseLike,
): RelayHealthMonitor | undefined {
	if (!options?.enabled) return undefined;
	const monitor = new RelayHealthMonitor({
		...options,
		publish: d1RelayHealthPublisher(db, options),
	});
	options.onMonitor(monitor);
	return monitor;
}
