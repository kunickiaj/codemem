import type { D1DatabaseLike } from "@codemem/core/internal/cloudflare-coordinator";
import {
	type CoordinatorBrowserAuthOptions,
	type CoordinatorBrowserAuthResult,
	type CoordinatorBrowserAuthSnapshot,
	captureCoordinatorBrowserAuthOptions,
	coordinatorBrowserAuthUnavailableResponse,
	createCoordinatorBrowserAuth,
	createD1CoordinatorApp,
	createInMemoryRequestRateLimiter,
	D1CoordinatorStore,
	maintainCoordinatorBrowserAuth,
} from "@codemem/core/internal/cloudflare-coordinator";
import { verifyCloudflareCoordinatorRequest } from "./request-verifier.js";

export interface CloudflareCoordinatorEnv {
	COORDINATOR_DB?: D1DatabaseLike;
	CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET?: string;
}

export interface CreateCloudflareCoordinatorWorkerOptions {
	now?: () => string;
	adminSecret?: (env: CloudflareCoordinatorEnv) => string | null;
	browserAuth?: CoordinatorBrowserAuthOptions;
}

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function createLegacyCloudflareCoordinatorWorker(
	opts: CreateCloudflareCoordinatorWorkerOptions = {},
) {
	return {
		async fetch(request: Request, env: CloudflareCoordinatorEnv): Promise<Response> {
			if (!env.COORDINATOR_DB) {
				return jsonResponse({ error: "missing_d1_binding" }, 500);
			}
			const app = createD1CoordinatorApp({
				db: env.COORDINATOR_DB,
				adminSecret: opts.adminSecret
					? opts.adminSecret(env)
					: String(env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET ?? "").trim() || null,
				now: opts.now,
				requestVerifier: verifyCloudflareCoordinatorRequest,
			});
			return app.fetch(request);
		},
	};
}

function createBrowserAuthWorker(
	opts: CreateCloudflareCoordinatorWorkerOptions,
	snapshot: CoordinatorBrowserAuthSnapshot,
) {
	const browserLimiter = createInMemoryRequestRateLimiter();
	const deviceLimiter = createInMemoryRequestRateLimiter();
	let pinnedDb: D1DatabaseLike | undefined;
	let browserStore: D1CoordinatorStore | undefined;
	let completed: CoordinatorBrowserAuthResult | undefined;
	function pinBinding(env: CloudflareCoordinatorEnv): D1DatabaseLike | undefined {
		const db = env.COORDINATOR_DB;
		if (!db || (pinnedDb && pinnedDb !== db)) return undefined;
		if (!pinnedDb) {
			pinnedDb = db;
			browserStore = new D1CoordinatorStore(db);
		}
		return pinnedDb;
	}
	return {
		async fetch(request: Request, env: CloudflareCoordinatorEnv): Promise<Response> {
			try {
				if (!env.COORDINATOR_DB) return jsonResponse({ error: "missing_d1_binding" }, 500);
				const db = pinBinding(env);
				if (!db || !browserStore) return coordinatorBrowserAuthUnavailableResponse();
				if (!completed) {
					// Each cold request owns its discovery promise. Only settled results cross requests.
					const result = await createCoordinatorBrowserAuth(snapshot, browserStore, browserLimiter);
					completed ??= result;
				}
				const app = createD1CoordinatorApp({
					db,
					adminSecret: opts.adminSecret
						? opts.adminSecret(env)
						: String(env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET ?? "").trim() || null,
					now: opts.now,
					requestVerifier: verifyCloudflareCoordinatorRequest,
					requestRateLimit: { limiter: deviceLimiter },
					browserAuth: completed.ok
						? {
								kind: "ready",
								auth: completed.auth,
								clientKey: (context) =>
									context.req.raw.headers.get("CF-Connecting-IP")?.trim() || null,
							}
						: { kind: "unavailable" },
				});
				return await app.fetch(request);
			} catch {
				return coordinatorBrowserAuthUnavailableResponse();
			}
		},
		scheduled(
			_controller: ScheduledController,
			env: CloudflareCoordinatorEnv,
			ctx: ExecutionContext,
		): void {
			const db = pinBinding(env);
			if (!db) return;
			ctx.waitUntil(maintainCoordinatorBrowserAuth(snapshot, new D1CoordinatorStore(db)));
		},
	};
}

export function createCloudflareCoordinatorWorker(
	opts: CreateCloudflareCoordinatorWorkerOptions = {},
) {
	if (!opts.browserAuth) return createLegacyCloudflareCoordinatorWorker(opts);
	const snapshot = captureCoordinatorBrowserAuthOptions(opts.browserAuth);
	if (snapshot.kind === "disabled") return createLegacyCloudflareCoordinatorWorker(opts);
	return createBrowserAuthWorker(opts, snapshot);
}

export default createCloudflareCoordinatorWorker();
