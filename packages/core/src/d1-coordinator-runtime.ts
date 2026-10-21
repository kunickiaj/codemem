import {
	type CoordinatorAppBrowserAuthOptions,
	type CoordinatorRequestRateLimitOptions,
	type CoordinatorRequestVerifier,
	type CoordinatorRuntimeDeps,
	createCoordinatorApp,
} from "./coordinator-api.js";
import type { CoordinatorDeviceRevocationContext } from "./coordinator-device-revocation-route.js";
import { D1CoordinatorStore, type D1DatabaseLike } from "./d1-coordinator-store.js";

export interface CreateD1CoordinatorAppOptions {
	db: D1DatabaseLike;
	adminSecret?: string | null;
	now?: () => string;
	requestVerifier: CoordinatorRequestVerifier;
	requestRateLimit?: CoordinatorRequestRateLimitOptions;
	deviceRevocation?: CoordinatorDeviceRevocationContext;
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
		storeFactory: () => new D1CoordinatorStore(db),
		deviceRevocation: opts.deviceRevocation,
		runtime,
		requestVerifier: opts.requestVerifier,
		requestRateLimit: opts.requestRateLimit,
		browserAuth:
			opts.browserAuth?.kind === "ready"
				? { ...opts.browserAuth, storeFactory: () => new D1CoordinatorStore(db) }
				: opts.browserAuth,
	});
}
