import type { MemoryStore } from "@codemem/core";
import { Hono } from "hono";
import {
	createInMemoryRequestRateLimiter,
	type InMemoryRequestRateLimiter,
} from "./request-rate-limit.js";
import { syncProtocolRoutes } from "./routes/sync.js";
import { getStore } from "./shared-store.js";

export interface SyncAppOptions {
	storeFactory?: () => MemoryStore;
	syncChannelPeerPin?: (request: Request) => string | null;
	syncRequestRateLimit?: {
		limiter?: InMemoryRequestRateLimiter;
		readLimit?: number;
		mutationLimit?: number;
		unauthenticatedReadLimit?: number;
		unauthenticatedMutationLimit?: number;
	};
}

/** Keep the network listener limited to signature-authenticated peer protocol routes. */
export function createSyncApp(opts?: SyncAppOptions) {
	const storeFactory = opts?.storeFactory ?? getStore;
	const requestRateLimit = opts?.syncRequestRateLimit ?? {};
	const rateLimiter = requestRateLimit.limiter ?? createInMemoryRequestRateLimiter();
	const readLimit = Math.max(1, Math.trunc(requestRateLimit.readLimit ?? 120));
	const mutationLimit = Math.max(1, Math.trunc(requestRateLimit.mutationLimit ?? 30));
	const app = new Hono();
	app.route(
		"/",
		syncProtocolRoutes(storeFactory, {
			syncChannelPeerPin: opts?.syncChannelPeerPin,
			routeRateLimit: {
				limiter: rateLimiter,
				readLimit,
				mutationLimit,
				unauthenticatedReadLimit: Math.max(
					1,
					Math.trunc(requestRateLimit.unauthenticatedReadLimit ?? Math.min(20, readLimit)),
				),
				unauthenticatedMutationLimit: Math.max(
					1,
					Math.trunc(requestRateLimit.unauthenticatedMutationLimit ?? Math.min(10, mutationLimit)),
				),
			},
		}),
	);

	// Return a generic response for paths outside the peer protocol.
	app.all("*", (c) => c.json({ error: "not found" }, 404));
	return app;
}
