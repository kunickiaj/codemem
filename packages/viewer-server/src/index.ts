/**
 * @codemem/server — HTTP server (viewer, sync, API).
 *
 * Single HTTP server handling viewer routes and sync daemon.
 * Shares one better-sqlite3 connection between viewer and sync.
 * Embedding inference runs in a worker_thread (lazy-started).
 *
 * Entry: `codemem serve`
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	DeviceIdentityCoordinatorEvidence,
	GetUpdateStatusOptions,
	ObserverClient,
	UpdateStatus,
} from "@codemem/core";
import { MemoryStore, type RawEventSweeper, resolveDbPath, VERSION } from "@codemem/core";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { type AccountLinkOptions, createAccountGuard } from "./account/guard.js";
import type { createAccountOwnerRecoveryService } from "./account/owner-recovery-service.js";
import type { AccountStatusOptions } from "./account/status.js";
import { originGuard, preflightHandler } from "./middleware.js";
import type { RawEventInbox } from "./raw-event-inbox.js";
import {
	createInMemoryRequestRateLimiter,
	type InMemoryRequestRateLimiter,
} from "./request-rate-limit.js";
import { accountOperationRoutes } from "./routes/account-operations.js";
import { accountOwnerRecoveryRoutes } from "./routes/account-owner-recovery.js";
import { accountStatusRoutes } from "./routes/account-status.js";
import { type ConfigRouteOptions, configRoutes } from "./routes/config.js";
import { diagnosticsRoutes } from "./routes/diagnostics.js";
import { fileContextRoutes } from "./routes/file-context.js";
import { healthRoutes } from "./routes/health.js";
import { memoryRoutes } from "./routes/memory.js";
import { memoryToolRoutes } from "./routes/memory-tools.js";
import { observerStatusRoutes } from "./routes/observer-status.js";
import { packTransportRoutes } from "./routes/pack.js";
import { rawEventsRoutes } from "./routes/raw-events.js";
import { statsRoutes } from "./routes/stats.js";
import { type SyncRoutesOptions, syncProtocolRoutes, syncRoutes } from "./routes/sync.js";
import { type ViewerTargetStore, viewerTargetQueryGuard } from "./routes/target-validation.js";
import {
	type LegacyTeamCompletionDependencies,
	type LegacyTeamConfiguredGroupSnapshotLoader,
	TEAM_SETUP_ROUTE_PREFIX,
	teamSetupRoutes,
} from "./routes/team-setup.js";
import { updateStatusRoutes } from "./routes/update-status.js";

export type {
	AccountContext,
	AccountContextReader,
	AccountContextReaderOptions,
	AccountContextResult,
	AccountProfile,
	AccountSetup,
} from "./account/context.js";
export { createAccountContextReader } from "./account/context.js";
export type { AccountLinkOptions } from "./account/guard.js";
export type {
	AccountLinkFailure,
	AccountLinkOperationV1,
	AccountLinkRegistry,
	AccountLinkRegistryOptions,
	AccountLinkStartResult,
} from "./account/link-registry.js";
export { createAccountLinkRegistry } from "./account/link-registry.js";
export type { AccountOwnerRecoveryServiceOptions } from "./account/owner-recovery-service.js";
export { createAccountOwnerRecoveryService } from "./account/owner-recovery-service.js";
export {
	type AccountRebindResult,
	createAccountRebindRunner,
	resumeAccountRebind,
} from "./account/rebind.js";
export type { AccountLinkViewV1, AccountStatusOptions } from "./account/status.js";
export type {
	AdvancePendingProjectSharesResult,
	AdvanceProjectShareOperationResult,
	ReconcileRecipientPolicyProjectsResult,
} from "./application/coordinator-maintenance.js";
export {
	advancePendingProjectSharesOperation,
	reconcileRecipientPolicyProjectsOperation,
} from "./application/coordinator-maintenance.js";
export type { RawEventInbox, RawEventInboxEntry, RawEventInboxStatus } from "./raw-event-inbox.js";
export {
	createViewerRawEventInbox,
	FileRawEventInbox,
	resolveRawEventInboxDirectory,
} from "./raw-event-inbox.js";
export type {
	RecipientPolicyReconciliationReadModel,
	RecipientPolicyReconciliationReadState,
	ReconcileConfiguredCoordinatorEnrollmentResult,
} from "./routes/sync.js";
export {
	advancePendingProjectShares,
	advanceProjectShareOperation,
	createRecipientPolicyReconcilerEffects,
	listRecipientPolicyReconciliationStatus,
	recipientPolicyCapabilityFromStatus,
	reconcileConfiguredCoordinatorEnrollment,
	reconcileRecipientPolicyProjects,
} from "./routes/sync.js";
export type {
	LegacyTeamSetupActionBlockedReasonV1,
	LegacyTeamSetupActionGateV1,
	LegacyTeamSetupCandidateSummaryV1,
	LegacyTeamSetupDetailResponseV1,
	LegacyTeamSetupDeviceV1,
	LegacyTeamSetupErrorResponseV1,
	LegacyTeamSetupFinishResponseV1,
	LegacyTeamSetupIdentityChoiceV1,
	LegacyTeamSetupMutationResponseV1,
	LegacyTeamSetupPendingCandidateSummaryV1,
	LegacyTeamSetupProjectV1,
	LegacyTeamSetupSummaryResponseV1,
	LegacyTeamSetupViewerAccessDeltaV1,
	LegacyTeamSetupViewV1,
} from "./routes/team-setup.js";
export { VERSION };

/** Shared store instance — SQLite WAL mode handles concurrent reads safely. */
let sharedStore: MemoryStore | null = null;
let sharedStoreClosePromise: Promise<void> | null = null;

/** Get (or create) the shared store instance. Exported so the sweeper can share it. */
export function getStore(): MemoryStore {
	if (!sharedStore) {
		sharedStore = new MemoryStore(resolveDbPath());
	}
	return sharedStore;
}

/** Close a synchronous-only shared store. Async pack owners use closeStoreAsync(). */
export function closeStore(): void {
	sharedStore?.close();
	sharedStore = null;
}

/** Drain semantic work before closing SQLite and releasing the shared store. */
export function closeStoreAsync(): Promise<void> {
	if (sharedStoreClosePromise) return sharedStoreClosePromise;
	if (!sharedStore) return Promise.resolve();
	const store = sharedStore;
	sharedStoreClosePromise = store.closeAsync().then(() => {
		if (sharedStore === store) sharedStore = null;
		sharedStoreClosePromise = null;
	});
	return sharedStoreClosePromise;
}

/**
 * Create the Hono app with all viewer routes.
 * Exported for testing — pass a custom store factory to inject test DBs.
 */
export interface AppOptions {
	accountLink?: AccountLinkOptions &
		AccountStatusOptions & {
			ownerRecovery?: ReturnType<typeof createAccountOwnerRecoveryService>;
		};
	storeFactory?: () => MemoryStore;
	rawEventInbox?: RawEventInbox | null;
	rawEventTarget?: ViewerTargetStore;
	sweeper?: RawEventSweeper | null;
	observer?: ObserverClient | null;
	getObserver?: () => ObserverClient | null;
	scheduleObserverApply?: ConfigRouteOptions["scheduleObserverApply"];
	getObserverApplyStatus?: ConfigRouteOptions["getObserverApplyStatus"];
	getUpdateStatus?: (options: GetUpdateStatusOptions) => Promise<UpdateStatus>;
	loadDeviceIdentityCoordinatorEvidence?: () => Promise<DeviceIdentityCoordinatorEvidence>;
	loadLegacyTeamConfiguredGroupSnapshots?: LegacyTeamConfiguredGroupSnapshotLoader;
	teamSetupCompletionDependencies?: LegacyTeamCompletionDependencies | null;
	readCoordinatorConfig?: SyncRoutesOptions["readCoordinatorConfig"];
	renameCoordinatorGroup?: SyncRoutesOptions["renameCoordinatorGroup"];
	syncRequestRateLimit?: {
		limiter?: InMemoryRequestRateLimiter;
		readLimit?: number;
		mutationLimit?: number;
		unauthenticatedReadLimit?: number;
		unauthenticatedMutationLimit?: number;
	};
	getSyncRuntimeStatus?: () => {
		phase:
			| "starting"
			| "running"
			| "stopping"
			| "error"
			| "disabled"
			| "rebootstrapping"
			| "needs_attention"
			| null;
		detail?: string | null;
	} | null;
}

function registerStaticRoutes(app: Hono): void {
	const staticRoot =
		process.env.CODEMEM_VIEWER_STATIC_DIR ?? join(import.meta.dirname ?? ".", "../static");

	app.use("/assets/*", async (c, next) => {
		c.header("Cache-Control", "no-cache");
		await next();
	});
	app.use(
		"/assets/*",
		serveStatic({
			root: staticRoot,
			rewriteRequestPath: (path) => path.replace(/^\/assets/, ""),
			precompressed: true,
		}),
	);

	const indexPath = join(staticRoot, "index.html");
	if (!existsSync(indexPath)) {
		throw new Error(
			`Viewer assets missing at ${indexPath}. Run \`pnpm build\` from the repo root before starting the viewer.`,
		);
	}
	const indexHtml = readFileSync(indexPath, "utf-8");
	app.get("*", (c) => {
		if (c.req.path.startsWith("/api/")) {
			return c.json({ error: "not found" }, 404);
		}
		c.header("Cache-Control", "no-store");
		return c.html(indexHtml);
	});
}

function registerConfigRoutes(
	app: Hono,
	opts: AppOptions | undefined,
	sweeper: RawEventSweeper | null,
): void {
	app.route(
		"/",
		configRoutes({
			getSweeper: () => sweeper,
			scheduleObserverApply: opts?.scheduleObserverApply,
			getObserverApplyStatus: opts?.getObserverApplyStatus,
		}),
	);
}

function registerAccountRoutes(app: Hono, options?: AppOptions["accountLink"]): void {
	if (!options) return;
	const account = createAccountGuard(options);
	app.use("*", account.middleware);
	app.route("/", account.routes);
	if (options.ownerRecovery) app.route("/", accountOwnerRecoveryRoutes(options.ownerRecovery));
	if (options.readContext)
		app.route("/", accountStatusRoutes({ ...options, readContext: options.readContext }));
	if (options.readContext && options.registry)
		app.route(
			"/",
			accountOperationRoutes({
				...options,
				readContext: options.readContext,
				registry: options.registry,
			}),
		);
}

export function createApp(opts?: AppOptions) {
	const storeFactory = opts?.storeFactory ?? getStore;
	const sweeper = opts?.sweeper ?? null;
	const getObserver = opts?.getObserver ?? (() => opts?.observer ?? null);
	const getSyncRuntimeStatus = opts?.getSyncRuntimeStatus ?? (() => null);
	let invalidateTeamSetupSummary = () => {};
	const app = new Hono();
	registerAccountRoutes(app, opts?.accountLink);

	// CORS / origin guard
	app.use("*", preflightHandler());
	app.use("*", originGuard({ unsafeGetPathPrefixes: [TEAM_SETUP_ROUTE_PREFIX] }));

	// Optional db_path / identity_target query guard — targeted clients (pi native tools)
	// re-send the target on every operation so a mismatch rejects before the handler runs.
	// Clients that omit targets (UI, MCP, curl) are unaffected.
	const viewerTargetGuard = viewerTargetQueryGuard(storeFactory);
	app.use("/api/memories/*", viewerTargetGuard);
	app.use("/api/memory", viewerTargetGuard);
	app.use("/api/pi/sessions/search", viewerTargetGuard);

	// API routes
	app.route("/", healthRoutes(storeFactory));
	app.route("/", diagnosticsRoutes(storeFactory));
	app.route("/", statsRoutes(storeFactory));
	app.route("/", memoryRoutes(storeFactory));
	app.route("/", memoryToolRoutes(storeFactory));
	app.route("/", packTransportRoutes(storeFactory));
	app.route("/", fileContextRoutes(storeFactory));
	app.route(
		"/",
		observerStatusRoutes({
			getStore: storeFactory,
			getSweeper: () => sweeper,
			getObserver,
		}),
	);
	registerConfigRoutes(app, opts, sweeper);
	app.route("/", rawEventsRoutes(storeFactory, sweeper, opts?.rawEventInbox, opts?.rawEventTarget));
	app.route(
		"/",
		syncRoutes(storeFactory, getSyncRuntimeStatus, {
			loadDeviceIdentityCoordinatorEvidence: opts?.loadDeviceIdentityCoordinatorEvidence,
			onRecipientPolicyTeamRenamed: () => invalidateTeamSetupSummary(),
			readCoordinatorConfig: opts?.readCoordinatorConfig,
			renameCoordinatorGroup: opts?.renameCoordinatorGroup,
		}),
	);
	app.route(
		"/",
		teamSetupRoutes({
			getStore: storeFactory,
			loadLegacyTeamConfiguredGroupSnapshots: opts?.loadLegacyTeamConfiguredGroupSnapshots,
			completionDependencies: opts?.teamSetupCompletionDependencies,
			readCoordinatorConfig: opts?.readCoordinatorConfig,
			registerSummaryInvalidator: (invalidate) => {
				invalidateTeamSetupSummary = invalidate;
			},
		}),
	);
	app.route("/", updateStatusRoutes({ getUpdateStatus: opts?.getUpdateStatus }));

	registerStaticRoutes(app);

	return app;
}

/**
 * Create the Hono app for peer-to-peer sync protocol routes only.
 *
 * This app is bound to a separate network-accessible listener
 * (default 0.0.0.0:7337) so remote peers can reach the sync
 * endpoints without exposing the viewer UI or local API routes.
 *
 * No CORS/origin guard is applied — sync requests are authenticated
 * via cryptographic signature verification instead.
 */
export function createSyncApp(opts?: AppOptions) {
	const storeFactory = opts?.storeFactory ?? getStore;
	const requestRateLimit = opts?.syncRequestRateLimit ?? {};
	const rateLimiter = requestRateLimit.limiter ?? createInMemoryRequestRateLimiter();
	const readLimit = Math.max(1, Math.trunc(requestRateLimit.readLimit ?? 120));
	const mutationLimit = Math.max(1, Math.trunc(requestRateLimit.mutationLimit ?? 30));
	const app = new Hono();
	app.route(
		"/",
		syncProtocolRoutes(storeFactory, {
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

	// Catch-all — return generic 404 to avoid fingerprinting the server.
	app.all("*", (c) => c.json({ error: "not found" }, 404));

	return app;
}

// No auto-start — the CLI's `serve` command owns server startup.
