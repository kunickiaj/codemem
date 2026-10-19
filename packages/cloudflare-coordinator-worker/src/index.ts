import type { D1DatabaseLike } from "@codemem/core/internal/cloudflare-coordinator";
import {
	admitCoordinatorBrowserAuthSetup,
	authSchemaUpgradeResponse,
	type CoordinatorBrowserAuthOptions,
	type CoordinatorBrowserAuthResult,
	type CoordinatorBrowserAuthSnapshot,
	type CreateD1CoordinatorAppOptions,
	captureCoordinatorBrowserAuthOptions,
	coordinatorBrowserAuthDeviceRoutes,
	createCoordinatorBrowserAuth,
	createCoordinatorOwnerEnrollmentHttp,
	createD1AuthLinkBackend,
	createD1CoordinatorApp,
	createInMemoryRequestRateLimiter,
	D1CoordinatorStore,
	importBrowserCsrfKey,
	importOwnerEnrollmentAdmissionKey,
	maintainCoordinatorBrowserAuth,
} from "@codemem/core/internal/cloudflare-coordinator";
import {
	type CloudflareBrowserAuthEnv,
	captureCloudflareBrowserAuthEnv,
} from "./browser-auth-env.js";
import { handleOwnerEntrypoint } from "./owner-entrypoint.js";
import { verifyCloudflareCoordinatorRequest } from "./request-verifier.js";

export interface CloudflareCoordinatorEnv extends CloudflareBrowserAuthEnv {
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

function coordinatorAdminSecret(
	env: CloudflareCoordinatorEnv,
	opts: CreateCloudflareCoordinatorWorkerOptions,
): string | null {
	if (opts.adminSecret) return opts.adminSecret(env);
	return String(env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET ?? "").trim() || null;
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
				adminSecret: coordinatorAdminSecret(env, opts),
				now: opts.now,
				requestVerifier: verifyCloudflareCoordinatorRequest,
			});
			return app.fetch(request);
		},
	};
}

async function authenticationUnavailable(
	request: Request,
	env: CloudflareCoordinatorEnv,
	opts: CreateCloudflareCoordinatorWorkerOptions,
	dependencies: { deviceLimiter: ReturnType<typeof createInMemoryRequestRateLimiter> },
): Promise<Response> {
	try {
		if (!env.COORDINATOR_DB) return jsonResponse({ error: "missing_d1_binding" }, 500);
		return await createD1CoordinatorApp({
			db: env.COORDINATOR_DB,
			adminSecret: coordinatorAdminSecret(env, opts),
			now: opts.now,
			requestVerifier: verifyCloudflareCoordinatorRequest,
			requestRateLimit: { limiter: dependencies.deviceLimiter },
			browserAuth: { kind: "unavailable" },
		}).fetch(request);
	} catch {
		return jsonResponse({ error: "coordinator_unavailable" }, 503);
	}
}

function createBrowserAuthSetup(snapshot: CoordinatorBrowserAuthSnapshot) {
	const limiter = createInMemoryRequestRateLimiter();
	let browserStore: D1CoordinatorStore | undefined;
	let completed: CoordinatorBrowserAuthResult | undefined;
	return async (
		request: Request,
		db: D1DatabaseLike,
	): Promise<CoordinatorBrowserAuthResult | Response> => {
		if (completed) return completed;
		const admission = admitCoordinatorBrowserAuthSetup(
			snapshot,
			request,
			limiter,
			request.headers.get("CF-Connecting-IP")?.trim() ?? "",
		);
		if (admission instanceof Response) return admission;
		const deviceRoutes = coordinatorBrowserAuthDeviceRoutes(snapshot);
		if (admission !== true && deviceRoutes) return { ok: true, auth: deviceRoutes };
		browserStore ??= new D1CoordinatorStore(db);
		// Each cold request owns its I/O; refusals and transient failures remain retryable.
		const result = await createCoordinatorBrowserAuth(snapshot, browserStore, limiter);
		if (
			result.ok ||
			(result.error !== "coordinator_auth_schema_upgrade_required" &&
				result.error !== "browser_auth_store_unavailable")
		)
			completed ??= result;
		if (!result.ok && result.error === "coordinator_auth_schema_upgrade_required")
			return authSchemaUpgradeResponse();
		return result;
	};
}

function createBrowserAuthWorker(
	opts: CreateCloudflareCoordinatorWorkerOptions,
	snapshot: CoordinatorBrowserAuthSnapshot,
) {
	const setup = createBrowserAuthSetup(snapshot);
	const deviceLimiter = createInMemoryRequestRateLimiter();
	let pinnedDb: D1DatabaseLike | undefined;
	function pinBinding(env: CloudflareCoordinatorEnv): D1DatabaseLike | undefined {
		const db = env.COORDINATOR_DB;
		if (!db || (pinnedDb && pinnedDb !== db)) return undefined;
		pinnedDb ??= db;
		return pinnedDb;
	}
	return {
		async fetch(request: Request, env: CloudflareCoordinatorEnv): Promise<Response> {
			let dispatched = false;
			try {
				if (!env.COORDINATOR_DB) return jsonResponse({ error: "missing_d1_binding" }, 500);
				const db = pinBinding(env);
				if (!db) return authenticationUnavailable(request, env, opts, { deviceLimiter });
				const result = await setup(request, db);
				if (result instanceof Response) return result;
				const app = createD1CoordinatorApp({
					db,
					adminSecret: coordinatorAdminSecret(env, opts),
					now: opts.now,
					requestVerifier: verifyCloudflareCoordinatorRequest,
					requestRateLimit: { limiter: deviceLimiter },
					browserAuth: browserRuntimeOptions(result),
				});
				dispatched = true;
				return await app.fetch(request);
			} catch {
				if (dispatched) return jsonResponse({ error: "coordinator_unavailable" }, 503);
				return authenticationUnavailable(request, env, opts, { deviceLimiter });
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

function browserRuntimeOptions(
	result: CoordinatorBrowserAuthResult,
): CreateD1CoordinatorAppOptions["browserAuth"] {
	if (result.ok)
		return {
			kind: "ready",
			auth: result.auth,
			clientKey: (context) => context.req.raw.headers.get("CF-Connecting-IP")?.trim() || null,
		};
	return {
		kind: "unavailable",
		error: result.error === "coordinator_auth_schema_upgrade_required" ? result.error : undefined,
	};
}

export function createCloudflareCoordinatorWorker(
	opts: CreateCloudflareCoordinatorWorkerOptions = {},
) {
	if (!opts.browserAuth) return createLegacyCloudflareCoordinatorWorker(opts);
	const snapshot = captureCoordinatorBrowserAuthOptions(opts.browserAuth);
	if (snapshot.kind === "disabled") {
		return {
			...createLegacyCloudflareCoordinatorWorker(opts),
			scheduled(
				_controller: ScheduledController,
				env: CloudflareCoordinatorEnv,
				ctx: ExecutionContext,
			): void {
				if (!env.COORDINATOR_DB) return;
				ctx.waitUntil(
					maintainCoordinatorBrowserAuth(snapshot, new D1CoordinatorStore(env.COORDINATOR_DB)),
				);
			},
		};
	}
	return createBrowserAuthWorker(opts, snapshot);
}

function sameBindings(first: readonly unknown[], second: readonly unknown[]): boolean {
	return first.length === second.length && first.every((value, index) => value === second[index]);
}

async function createWorkerFromSettings(
	settings: Extract<ReturnType<typeof captureCloudflareBrowserAuthEnv>, { kind: "enabled" }>,
	db: D1DatabaseLike,
	ownerLimiter: ReturnType<typeof createInMemoryRequestRateLimiter>,
) {
	const csrfKey = await importBrowserCsrfKey(settings.csrfKeyBytes);
	const admissionKey = settings.ownerEnrollmentEnabled
		? await importOwnerEnrollmentAdmissionKey(settings.csrfKeyBytes)
		: undefined;
	const browserAuth: CoordinatorBrowserAuthOptions = {
		config: settings.config,
		csrfKey,
		ownerEnrollment: admissionKey
			? async (input) =>
					createCoordinatorOwnerEnrollmentHttp({
						...input,
						mode: "production",
						backend: createD1AuthLinkBackend(db),
						admissionKey,
					})
			: undefined,
	};
	if (captureCoordinatorBrowserAuthOptions(browserAuth).kind !== "enabled")
		throw new Error("browser_auth_config_invalid");
	const underlying = createCloudflareCoordinatorWorker({ browserAuth });
	const pin = {
		coordinatorId: String(settings.config.coordinatorId),
		origin: new URL(String(settings.config.redirectUri)).origin,
		issuer: String(settings.config.issuer),
		revision: String(settings.config.revision),
	};
	return {
		...underlying,
		async fetch(request: Request, env: CloudflareCoordinatorEnv): Promise<Response> {
			if (admissionKey) {
				const handled = await handleOwnerEntrypoint(request, {
					key: admissionKey,
					pin,
					db,
					limiter: ownerLimiter,
					adminSecret: String(env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET ?? "").trim() || null,
				});
				if (handled) return handled;
			}
			return underlying.fetch(request, env);
		},
	};
}

/** Capture configured authentication once; only settled setup crosses requests. */
export function createConfiguredCloudflareCoordinatorWorker() {
	let captured: readonly unknown[] | undefined;
	let completed: ReturnType<typeof createCloudflareCoordinatorWorker> | undefined;
	const ownerLimiter = createInMemoryRequestRateLimiter();
	const deviceLimiter = createInMemoryRequestRateLimiter();
	async function configured(env: CloudflareCoordinatorEnv) {
		const bindings = [
			env.COORDINATOR_DB,
			env.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG,
			env.CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET,
			env.CODEMEM_COORDINATOR_BROWSER_CSRF_KEY,
		];
		// Removing or disabling config after capture is drift, not an initial legacy rollout.
		if (captured && !sameBindings(captured, bindings)) return null;
		const settings = captureCloudflareBrowserAuthEnv(env);
		if (settings.kind === "disabled") return disabledWorker(settings);
		if (settings.kind === "invalid") return null;
		if (completed) return completed;
		const db = env.COORDINATOR_DB;
		if (!db) return null;
		const worker = await createWorkerFromSettings(settings, db, ownerLimiter);
		if (captured && !sameBindings(captured, bindings)) return null;
		captured ??= bindings;
		completed ??= worker;
		return completed;
	}
	return {
		async fetch(request: Request, env: CloudflareCoordinatorEnv): Promise<Response> {
			let dispatched = false;
			try {
				const worker = await configured(env);
				if (!worker) return await authenticationUnavailable(request, env, {}, { deviceLimiter });
				dispatched = true;
				return await worker.fetch(request, env);
			} catch {
				if (dispatched) return jsonResponse({ error: "coordinator_unavailable" }, 503);
				return authenticationUnavailable(request, env, {}, { deviceLimiter });
			}
		},
		scheduled(
			controller: ScheduledController,
			env: CloudflareCoordinatorEnv,
			ctx: ExecutionContext,
		): void {
			const settings = captureCloudflareBrowserAuthEnv(env);
			if (settings.kind === "disabled") {
				runWorkerScheduled(disabledWorker(settings), controller, env, ctx);
				return;
			}
			ctx.waitUntil(
				configured(env)
					.then((worker) => runWorkerScheduled(worker, controller, env, ctx))
					.catch(() => undefined),
			);
		},
	};
}

function runWorkerScheduled(
	worker: ReturnType<typeof createCloudflareCoordinatorWorker> | null,
	controller: ScheduledController,
	env: CloudflareCoordinatorEnv,
	ctx: ExecutionContext,
): void {
	if (worker && "scheduled" in worker && typeof worker.scheduled === "function")
		worker.scheduled(controller, env, ctx);
}

function disabledWorker(
	settings: Extract<ReturnType<typeof captureCloudflareBrowserAuthEnv>, { kind: "disabled" }>,
) {
	return createCloudflareCoordinatorWorker({
		browserAuth: { config: { enabled: false, coordinatorId: settings.coordinatorId } },
	});
}

export default createConfiguredCloudflareCoordinatorWorker();
