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
	MemoryStore,
	ObserverClient,
	UpdateStatus,
} from "@codemem/core";
import { type RawEventSweeper, VERSION } from "@codemem/core";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { type AccountLinkOptions, createAccountGuard } from "./account/guard.js";
import type { createAccountOwnerRecoveryService } from "./account/owner-recovery-service.js";
import type { AccountStatusOptions } from "./account/status.js";
import { originGuard, preflightHandler } from "./middleware.js";
import type { PromptPackTimingOptions } from "./prompt-pack-timings.js";
import type { RawEventInbox } from "./raw-event-inbox.js";
import { accountOperationRoutes } from "./routes/account-operations.js";
import { accountOwnerRecoveryRoutes } from "./routes/account-owner-recovery.js";
import { accountStatusRoutes } from "./routes/account-status.js";
import { type ConfigRouteOptions, configRoutes } from "./routes/config.js";
import { diagnosticsRoutes } from "./routes/diagnostics.js";
import { fileContextRoutes } from "./routes/file-context.js";
import { healthRoutes } from "./routes/health.js";
import { memoryRoutes } from "./routes/memory.js";
import {
	MEMORY_TOOL_CALL_CAPABILITY,
	type MemoryToolCallFn,
	memoryToolCallRoutes,
} from "./routes/memory-tool-call.js";
import { memoryToolRoutes } from "./routes/memory-tools.js";
import { observerStatusRoutes } from "./routes/observer-status.js";
import { packTransportRoutes } from "./routes/pack.js";
import { rawEventsRoutes } from "./routes/raw-events.js";
import { statsRoutes } from "./routes/stats.js";
import { type SyncRoutesOptions, syncRoutes } from "./routes/sync.js";
import { type ViewerTargetStore, viewerTargetQueryGuard } from "./routes/target-validation.js";
import {
	type LegacyTeamCompletionDependencies,
	type LegacyTeamConfiguredGroupSnapshotLoader,
	TEAM_SETUP_ROUTE_PREFIX,
	teamSetupRoutes,
} from "./routes/team-setup.js";
import { updateStatusRoutes } from "./routes/update-status.js";
import { getStore } from "./shared-store.js";
import { createSyncApp as createPeerSyncApp, type SyncAppOptions } from "./sync-app.js";
import { type ViewerAuthorityOptions, viewerAuthorityGuard } from "./viewer-authority.js";

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
export type { PromptPackTimingOptions, PromptPackTimingReport } from "./prompt-pack-timings.js";
export type { RawEventInbox, RawEventInboxEntry, RawEventInboxStatus } from "./raw-event-inbox.js";
export {
	createViewerRawEventInbox,
	FileRawEventInbox,
	resolveRawEventInboxDirectory,
} from "./raw-event-inbox.js";
export {
	createViewerRelayReachability,
	type RelayLogLevel,
	type ViewerRelayReachability,
	type ViewerRelayReachabilityOptions,
} from "./relay-reachability.js";
export {
	MEMORY_TOOL_CALL_CAPABILITY,
	type MemoryToolCaller,
	type MemoryToolCallFn,
	memoryToolCallRoutes,
} from "./routes/memory-tool-call.js";
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
export { closeStore, closeStoreAsync, getStore } from "./shared-store.js";
export type { ViewerAuthorityOptions } from "./viewer-authority.js";
export { VERSION };

/**
 * Create the Hono app with all viewer routes.
 * Exported for testing — pass a custom store factory to inject test DBs.
 */
export interface AppOptions extends SyncAppOptions {
	/**
	 * Trusted listener context for loopback Host validation. Defaults to accountLink's
	 * callback, which the CLI always supplies with the actual bound port. Without
	 * either callback, embedding callers own authority validation. External binds
	 * retain their existing requirement for authentication outside this app.
	 */
	viewerAuthority?: ViewerAuthorityOptions;
	accountLink?: AccountLinkOptions &
		AccountStatusOptions & {
			ownerRecovery?: ReturnType<typeof createAccountOwnerRecoveryService>;
		};
	/**
	 * Runs memory tools for thin hosts. `codemem serve` supplies it; when absent
	 * the route is not mounted and the profile does not advertise the capability.
	 */
	memoryToolCall?: MemoryToolCallFn;
	/** Optional content-free prompt timings. The environment opt-in applies when omitted. */
	promptPackTimings?: PromptPackTimingOptions;
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
	syncReachability?: SyncRoutesOptions["syncReachability"];
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

/**
 * Prompt-pack transport plus, when `codemem serve` supplies a handler, the
 * thin-host memory-tool route. The profile advertises the route only when it
 * is mounted, so older clients and test apps see no capability.
 */
function registerThinHostRoutes(
	app: Hono,
	storeFactory: () => MemoryStore,
	call: MemoryToolCallFn | undefined,
	timings?: PromptPackTimingOptions,
): void {
	if (call) app.route("/", memoryToolCallRoutes(storeFactory, call));
	const capabilities = call ? [MEMORY_TOOL_CALL_CAPABILITY] : [];
	app.route("/", packTransportRoutes(storeFactory, { capabilities, timings }));
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

function registerViewerBoundary(app: Hono, opts?: AppOptions): void {
	const options = opts?.accountLink;
	const account = options ? createAccountGuard(options) : null;
	if (account) app.use("*", account.middleware);
	app.use("*", viewerAuthorityGuard(opts?.viewerAuthority ?? options));
	if (!options || !account) return;
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

function registerViewerTargetGuards(options: { app: Hono; storeFactory: () => MemoryStore }): void {
	const { app, storeFactory } = options;
	// Targeted clients re-send the target on every operation. Untargeted clients
	// retain the same routes without an additional database or identity query.
	const viewerTargetGuard = viewerTargetQueryGuard(storeFactory);
	app.use("/api/memories/*", viewerTargetGuard);
	app.use("/api/memory", viewerTargetGuard);
	app.use("/api/memory/:id/context", (c, next) => {
		c.header("Cache-Control", "no-store");
		return viewerTargetGuard(c, next);
	});
	app.use("/api/pi/sessions/search", viewerTargetGuard);
}

export function createApp(opts?: AppOptions) {
	const storeFactory = opts?.storeFactory ?? getStore;
	const sweeper = opts?.sweeper ?? null;
	const getObserver = opts?.getObserver ?? (() => opts?.observer ?? null);
	let invalidateTeamSetupSummary = () => {};
	const app = new Hono();
	registerViewerBoundary(app, opts);

	// CORS / origin guard
	app.use("*", preflightHandler());
	app.use("*", originGuard({ unsafeGetPathPrefixes: [TEAM_SETUP_ROUTE_PREFIX] }));

	registerViewerTargetGuards({ app, storeFactory });

	// API routes
	app.route("/", healthRoutes(storeFactory));
	app.route("/", diagnosticsRoutes(storeFactory));
	app.route("/", statsRoutes(storeFactory));
	app.route("/", memoryRoutes(storeFactory));
	app.route("/", memoryToolRoutes(storeFactory));
	registerThinHostRoutes(app, storeFactory, opts?.memoryToolCall, opts?.promptPackTimings);
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
		syncRoutes(storeFactory, opts?.getSyncRuntimeStatus, {
			syncReachability: opts?.syncReachability,
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

/** Preserve the public server options while transport adapters use the narrower factory. */
export function createSyncApp(opts?: AppOptions) {
	return createPeerSyncApp(opts);
}

// No auto-start — the CLI's `serve` command owns server startup.
